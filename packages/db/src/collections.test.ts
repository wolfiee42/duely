import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createDb, withTenant, type Db, type Tx } from "./index";
import {
  clients,
  collectionPolicies,
  firms,
  invoices,
  messages,
  policySteps,
  reminderJobs,
  reviewItems,
  unroutedInbound,
} from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

// Phase 4 tables: tenant isolation (RLS and composite FKs), the job guard, and the policy constraints.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let testDb: TestDatabase;
let app: Db;
let system: Db;
const closers: Array<() => Promise<unknown>> = [];
const ids = {} as Record<
  string,
  { policy: string; step: string; invoice: string; client: string; job: string }
>;

async function pgError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { message: string; cause?: { message: string } };
    return e.cause?.message ?? e.message;
  }
  return null;
}

async function seed(tx: Tx, tenantId: string, slug: string) {
  await tx
    .insert(firms)
    .values({ id: tenantId, platformSlug: slug, legalName: slug, displayName: slug });
  const [policy] = await tx
    .insert(collectionPolicies)
    .values({ tenantId, name: "Standard", isDefault: true })
    .returning({ id: collectionPolicies.id });
  const [step] = await tx
    .insert(policySteps)
    .values({
      tenantId,
      policyId: policy!.id,
      position: 0,
      offsetDays: 0,
      templateKey: "due",
      tone: "friendly",
    })
    .returning({ id: policySteps.id });
  const [client] = await tx
    .insert(clients)
    .values({ tenantId, name: "Initech" })
    .returning({ id: clients.id });
  const [invoice] = await tx
    .insert(invoices)
    .values({ tenantId, clientId: client!.id, status: "sent", dueDate: "2026-07-01" })
    .returning({ id: invoices.id });
  const [job] = await tx
    .insert(reminderJobs)
    .values({
      tenantId,
      invoiceId: invoice!.id,
      stepId: step!.id,
      plannedFor: "2026-07-01",
      nextRunAt: new Date("2026-07-01T12:00:00Z"),
    })
    .returning({ id: reminderJobs.id });
  await tx.insert(reviewItems).values({ tenantId, kind: "dead_job", jobId: job!.id });
  ids[slug] = {
    policy: policy!.id,
    step: step!.id,
    invoice: invoice!.id,
    client: client!.id,
    job: job!.id,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const a = createDb(testDb.appUrl, { max: 6 });
  const s = createDb(testDb.systemUrl, { max: 2 });
  app = a.db;
  system = s.db;
  closers.push(a.close, s.close);
  await withTenant(app, A, (tx) => seed(tx, A, "acme"));
  await withTenant(app, B, (tx) => seed(tx, B, "globex"));
}, 60_000);
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
  await testDb?.drop();
});

describe("row-level security on collection tables", () => {
  it.each(["collection_policies", "policy_steps", "reminder_jobs", "review_items"])(
    "%s: a tenant sees only its own rows, and none without a tenant",
    async (table) => {
      const count = (db: Db | Tx) =>
        db.execute<{ n: number }>(sql.raw(`select count(*)::int n from ${table}`));
      expect((await withTenant(app, A, (tx) => count(tx)))[0]!.n).toBe(1);
      expect((await withTenant(app, B, (tx) => count(tx)))[0]!.n).toBe(1);
      expect((await count(app))[0]!.n).toBe(0);
    },
  );

  it("a tenant cannot write a row for another tenant", async () => {
    const error = await pgError(
      withTenant(app, A, (tx) =>
        tx.insert(collectionPolicies).values({ tenantId: B, name: "Sneaky" }),
      ),
    );
    expect(error).toMatch(/row-level security/);
  });

  it("cannot update or delete another tenant's job", async () => {
    await withTenant(app, A, async (tx) => {
      const updated = await tx
        .update(reminderJobs)
        .set({ lastError: "x" })
        .where(sql`id = ${ids.globex!.job}`)
        .returning({ id: reminderJobs.id });
      expect(updated).toEqual([]);
    });
  });
});

describe("composite foreign keys keep children inside their tenant", () => {
  it("a step cannot join another tenant's policy", async () => {
    const error = await pgError(
      withTenant(app, A, (tx) =>
        tx.insert(policySteps).values({
          tenantId: A,
          policyId: ids.globex!.policy,
          position: 9,
          offsetDays: 9,
          templateKey: "due",
          tone: "firm",
        }),
      ),
    );
    expect(error).toMatch(/foreign key/);
  });

  it("a job cannot point at another tenant's invoice or step", async () => {
    for (const patch of [
      { invoiceId: ids.globex!.invoice, stepId: ids.acme!.step },
      { invoiceId: ids.acme!.invoice, stepId: ids.globex!.step },
    ]) {
      const error = await pgError(
        withTenant(app, A, (tx) =>
          tx.insert(reminderJobs).values({
            tenantId: A,
            plannedFor: "2026-08-01",
            nextRunAt: new Date("2026-08-01T12:00:00Z"),
            ...patch,
          }),
        ),
      );
      expect(error).toMatch(/foreign key/);
    }
  });

  it("a client override cannot name another tenant's policy", async () => {
    const error = await pgError(
      withTenant(app, A, (tx) =>
        tx
          .update(clients)
          .set({ policyId: ids.globex!.policy })
          .where(sql`id = ${ids.acme!.client}`),
      ),
    );
    expect(error).toMatch(/foreign key/);
  });

  it("a message cannot be linked to another tenant's job, nor a review item to another's invoice", async () => {
    const msg = await pgError(
      withTenant(app, A, (tx) =>
        tx.insert(messages).values({
          tenantId: A,
          direction: "out",
          kind: "reminder",
          status: "draft",
          jobId: ids.globex!.job,
        }),
      ),
    );
    expect(msg).toMatch(/foreign key/);
    const item = await pgError(
      withTenant(app, A, (tx) =>
        tx.insert(reviewItems).values({
          tenantId: A,
          kind: "draft_approval",
          invoiceId: ids.globex!.invoice,
        }),
      ),
    );
    expect(item).toMatch(/foreign key/);
  });
});

describe("policy constraints", () => {
  it("allows one default policy per tenant", async () => {
    const error = await pgError(
      withTenant(app, A, (tx) =>
        tx.insert(collectionPolicies).values({ tenantId: A, name: "Second", isDefault: true }),
      ),
    );
    expect(error).toMatch(/one_default_policy/);
  });

  it("rejects an inverted sending window and an out-of-range grace period", async () => {
    for (const bad of [{ quietStart: "18:00", quietEnd: "09:00" }, { promiseGraceDays: 99 }]) {
      const error = await pgError(
        withTenant(app, A, (tx) =>
          tx.insert(collectionPolicies).values({ tenantId: A, name: "Bad", ...bad }),
        ),
      );
      expect(error).toMatch(/check constraint/);
    }
  });

  it("steps are unique by day among active ones, but an archived step frees its day", async () => {
    const step = (position: number, over = {}) => ({
      tenantId: A,
      policyId: ids.acme!.policy,
      position,
      offsetDays: 0,
      templateKey: "due" as const,
      tone: "firm" as const,
      ...over,
    });
    const dup = await pgError(withTenant(app, A, (tx) => tx.insert(policySteps).values(step(5))));
    expect(dup).toMatch(/policy_steps_offset/);
    await withTenant(app, A, async (tx) => {
      await tx
        .update(policySteps)
        .set({ archivedAt: new Date() })
        .where(sql`id = ${ids.acme!.step}`);
      await tx.insert(policySteps).values(step(0));
    });
  });
});

describe("reminder job guard", () => {
  const set = (id: string, status: string) =>
    pgError(
      withTenant(app, A, (tx) =>
        tx.execute(sql`update reminder_jobs set status = ${status} where id = ${id}`),
      ),
    );

  it("lets a waiting job move around, and a paused one come back", async () => {
    const id = ids.acme!.job;
    expect(await set(id, "claimed")).toBeNull();
    expect(await set(id, "skipped")).toBeNull();
    expect(await set(id, "scheduled")).toBeNull();
  });

  it.each(["sent", "cancelled", "dead"])("%s is final", async (final) => {
    // The unique (invoice, step) pair means each job needs its own step.
    const stepId = (
      await withTenant(app, A, (tx) =>
        tx
          .insert(policySteps)
          .values({
            tenantId: A,
            policyId: ids.acme!.policy,
            position: 20 + ["sent", "cancelled", "dead"].indexOf(final),
            offsetDays: 20 + ["sent", "cancelled", "dead"].indexOf(final),
            templateKey: "final",
            tone: "firm",
          })
          .returning({ id: policySteps.id }),
      )
    )[0]!.id;
    const id = (
      await withTenant(app, A, (tx) =>
        tx
          .insert(reminderJobs)
          .values({
            tenantId: A,
            invoiceId: ids.acme!.invoice,
            stepId,
            plannedFor: "2026-09-01",
            nextRunAt: new Date("2026-09-01T12:00:00Z"),
          })
          .returning({ id: reminderJobs.id }),
      )
    )[0]!.id;
    expect(await set(id, final)).toBeNull();
    expect(await set(id, "scheduled")).toMatch(/cannot change/);
    expect(await set(id, "claimed")).toMatch(/cannot change/);
  });
});

describe("unrouted inbound mail", () => {
  it("is for the system role only", async () => {
    const row = {
      providerMessageId: "in_1",
      fromEmail: "stranger@nowhere.test",
      subject: "Hello",
    };
    expect(await pgError(app.insert(unroutedInbound).values(row))).toMatch(/permission denied/);
    await system.insert(unroutedInbound).values(row);
    expect(await pgError(app.select().from(unroutedInbound))).toMatch(/permission denied/);
    expect(await system.select().from(unroutedInbound)).toHaveLength(1);
    // Duplicate provider ids are rejected, which is what makes redelivery safe.
    expect(await pgError(system.insert(unroutedInbound).values(row))).toMatch(/unique|duplicate/);
  });
});
