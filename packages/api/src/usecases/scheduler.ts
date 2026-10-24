import { realNow } from "@repo/clock";
import { withSystemTenant, type Db } from "@repo/db";
import { invoices, promises, reminderJobs, reviewItems } from "@repo/db/schema";
import { transition } from "@repo/domain";
import { and, eq, sql } from "drizzle-orm";

import type { QueuePort } from "../services";
import { audit } from "./audit";
import { firmClock } from "./firm-clock";
import { baseContext } from "./invoices";
import { replanInvoiceJobs } from "./reminders";

const SYSTEM = (tenantId: string) => ({ tenantId, type: "system" as const, id: null });

/** A claimed job that has not finished in this long is assumed lost and goes back in line. */
const STUCK_AFTER_SECONDS = 300;
/** Attempts before a job is declared dead and shown to the firm (FR-9.10). */
export const MAX_ATTEMPTS = 5;

/**
 * SPEC 4.2: claim due jobs with `FOR UPDATE SKIP LOCKED`, so two overlapping ticks never take the same job,
 * then hand each to the queue. `next_run_at` lives on the firm's clock (D6), hence the offset.
 */
export async function claimDueJobs(systemDb: Db, limit = 200) {
  const claimed = await systemDb.execute<{ id: string; tenant_id: string }>(sql`
    with due as (
      select j.id from reminder_jobs j
      join firms f on f.id = j.tenant_id
      where j.status = 'scheduled'
        and j.next_run_at <= now() + make_interval(secs => f.clock_offset_seconds)
      order by j.next_run_at
      limit ${limit}
      for update of j skip locked
    )
    update reminder_jobs j
       set status = 'claimed', claimed_at = now(), attempts = attempts + 1
      from due where j.id = due.id
    returning j.id, j.tenant_id`);
  return [...claimed].map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/**
 * Puts jobs stuck in `claimed`/`enqueued` back in line, or buries them once they have used up their attempts
 * (they then surface in the review queue). A repeat run of a job is safe: its message has a unique `job_id`.
 */
export async function reapStuckJobs(systemDb: Db) {
  const stuck = await systemDb.execute<{ id: string; tenant_id: string; attempts: number }>(sql`
    select id, tenant_id, attempts from reminder_jobs
     where status in ('claimed', 'enqueued')
       and claimed_at < now() - make_interval(secs => ${STUCK_AFTER_SECONDS})
     limit 200`);
  let requeued = 0;
  let dead = 0;
  for (const job of stuck) {
    const outcome = await withSystemTenant(systemDb, job.tenant_id, (tx) =>
      failJobInTx(tx, job.id, "timed out", job.attempts),
    );
    if (outcome === "dead") dead++;
    else if (outcome === "retry") requeued++;
  }
  return { requeued, dead };
}

type Tx = Parameters<Parameters<typeof withSystemTenant>[2]>[0];

async function failJobInTx(tx: Tx, jobId: string, error: string, attempts: number) {
  const [job] = await tx
    .select()
    .from(reminderJobs)
    .where(eq(reminderJobs.id, jobId))
    .for("update");
  if (!job || !["claimed", "enqueued"].includes(job.status)) return "noop" as const;
  if (attempts >= MAX_ATTEMPTS) {
    await tx
      .update(reminderJobs)
      .set({ status: "dead", lastError: error })
      .where(eq(reminderJobs.id, jobId));
    await tx.insert(reviewItems).values({
      tenantId: job.tenantId,
      kind: "dead_job",
      invoiceId: job.invoiceId,
      jobId,
      payload: { error, attempts },
    });
    return "dead" as const;
  }
  // Back off: 2, 4, 8 ... minutes, on the firm's clock.
  await tx.execute(sql`
    update reminder_jobs j
       set status = 'scheduled', last_error = ${error},
           next_run_at = now() + make_interval(secs => f.clock_offset_seconds + ${60 * 2 ** attempts})
      from firms f
     where j.id = ${jobId} and f.id = j.tenant_id`);
  return "retry" as const;
}

/** A processing error: retry later with backoff, or give up after `MAX_ATTEMPTS`. */
export async function recordJobFailure(systemDb: Db, jobId: string, error: string) {
  const [job] = await systemDb
    .select({ tenantId: reminderJobs.tenantId, attempts: reminderJobs.attempts })
    .from(reminderJobs)
    .where(eq(reminderJobs.id, jobId));
  if (!job) return "noop" as const;
  return withSystemTenant(systemDb, job.tenantId, (tx) =>
    failJobInTx(tx, jobId, error.slice(0, 500), job.attempts),
  );
}

/** SPEC 4.2 sweep 1: `sent|viewed` invoices whose due date has passed in the firm's local time become `overdue`. */
export async function overdueSweep(systemDb: Db, limit = 200) {
  const due = await systemDb.execute<{ id: string; tenant_id: string }>(sql`
    select i.id, i.tenant_id from invoices i
      join firms f on f.id = i.tenant_id
     where i.status in ('sent', 'viewed')
       and i.due_date < ((now() + make_interval(secs => f.clock_offset_seconds)) at time zone f.timezone)::date
     limit ${limit}`);
  let moved = 0;
  for (const row of due) {
    moved += await withSystemTenant(systemDb, row.tenant_id, async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, row.id))
        .for("update");
      if (!invoice || !["sent", "viewed"].includes(invoice.status)) return 0;
      const { today } = await firmClock(tx, row.tenant_id);
      const next = transition(
        { status: invoice.status },
        "DUE_PASSED",
        baseContext(invoice, today),
      );
      if (next.state.status === invoice.status) return 0;
      await tx
        .update(invoices)
        .set({ status: next.state.status, updatedAt: sql`now()` })
        .where(eq(invoices.id, row.id));
      return 1;
    });
  }
  return moved;
}

/**
 * SPEC 4.2 sweep 2: an active promise is broken once the firm's local date is past `promised_date + grace`
 * (FR-10.4). The invoice goes back to `overdue` and the schedule resumes; the firm sees it in the audit trail.
 */
export async function promiseSweep(systemDb: Db, limit = 200) {
  const due = await systemDb.execute<{ id: string; tenant_id: string }>(sql`
    select p.id, p.tenant_id from promises p
      join invoices i on i.id = p.invoice_id
      join clients c on c.id = i.client_id
      join firms f on f.id = p.tenant_id
      left join collection_policies cp on cp.id = c.policy_id
      left join collection_policies dp on dp.tenant_id = p.tenant_id and dp.is_default
     where p.status = 'active'
       and ((now() + make_interval(secs => f.clock_offset_seconds)) at time zone f.timezone)::date
           > p.promised_date + coalesce(cp.promise_grace_days, dp.promise_grace_days, 1)
     limit ${limit}`);
  let broken = 0;
  for (const row of due) {
    broken += await withSystemTenant(systemDb, row.tenant_id, async (tx) => {
      const [promise] = await tx
        .select()
        .from(promises)
        .where(and(eq(promises.id, row.id), eq(promises.status, "active")))
        .for("update");
      if (!promise) return 0;
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, promise.invoiceId))
        .for("update");
      const { today } = await firmClock(tx, row.tenant_id);
      await tx
        .update(promises)
        .set({ status: "broken", resolvedAt: realNow() })
        .where(eq(promises.id, promise.id));
      // Only a `promised` invoice returns by the state machine; one that is also disputed stays disputed.
      if (invoice!.status === "promised") {
        const next = transition({ status: "promised" }, "PROMISE_BROKEN", {
          ...baseContext(invoice!, today),
          hasActivePromise: true,
        });
        await tx
          .update(invoices)
          .set({ status: next.state.status, updatedAt: sql`now()` })
          .where(eq(invoices.id, invoice!.id));
        await replanInvoiceJobs(tx, row.tenant_id, invoice!.id);
      } else if (["sent", "viewed", "overdue"].includes(invoice!.status)) {
        await replanInvoiceJobs(tx, row.tenant_id, invoice!.id);
      }
      await audit(
        tx,
        SYSTEM(row.tenant_id),
        "promise.broken",
        { type: "invoice", id: invoice!.id },
        {
          after: { promisedDate: promise.promisedDate },
        },
      );
      return 1;
    });
  }
  return broken;
}

export interface TickResult {
  claimed: number;
  reaped: { requeued: number; dead: number };
  overdue: number;
  brokenPromises: number;
}

/** One scheduler tick (the jobs worker runs this every minute). Each step is independent of the others. */
export async function runTick(systemDb: Db, queue: QueuePort): Promise<TickResult> {
  const reaped = await reapStuckJobs(systemDb);
  const overdue = await overdueSweep(systemDb);
  const brokenPromises = await promiseSweep(systemDb);
  const claimed = await claimDueJobs(systemDb);
  for (const job of claimed) await queue.send({ type: "process_job", jobId: job.id });
  return { claimed: claimed.length, reaped, overdue, brokenPromises };
}
