import { realNow } from "@repo/clock";
import { withTenant, type Db, type Tx } from "@repo/db";
import { clients, collectionPolicies, policySteps } from "@repo/db/schema";
import {
  DEFAULT_POLICY_NAME,
  DEFAULT_STEPS,
  DomainError,
  isValidTimeZone,
  localParts,
  parseClock,
  plan,
  shiftDate,
  type StepSpec,
} from "@repo/domain";
import { reminderDraft } from "@repo/email";
import { and, asc, eq, isNull, ne } from "drizzle-orm";

import { audit, type Actor } from "./audit";
import { firmClock } from "./firm-clock";

export interface PolicySettings {
  name: string;
  /** `HH:MM`. */
  quietStart: string;
  quietEnd: string;
  sendWeekends: boolean;
  promiseGraceDays: number;
}

type StepRow = typeof policySteps.$inferSelect;
type PolicyRow = typeof collectionPolicies.$inferSelect;

const hhmm = (t: string) => t.slice(0, 5);

function view(policy: PolicyRow, steps: StepRow[]) {
  return {
    id: policy.id,
    name: policy.name,
    isDefault: policy.isDefault,
    quietStart: hhmm(policy.quietStart),
    quietEnd: hhmm(policy.quietEnd),
    sendWeekends: policy.sendWeekends,
    promiseGraceDays: policy.promiseGraceDays,
    steps: steps
      .filter((s) => s.policyId === policy.id && !s.archivedAt)
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        id: s.id,
        offsetDays: s.offsetDays,
        templateKey: s.templateKey,
        tone: s.tone,
        sendMode: s.sendMode,
        escalateNotifyFirm: s.escalateNotifyFirm,
      })),
  };
}

/** The firm's default policy, created on first use. New firms get it at creation; this covers older ones. */
export async function ensureDefaultPolicy(tx: Tx, tenantId: string, name = DEFAULT_POLICY_NAME) {
  const [existing] = await tx
    .select()
    .from(collectionPolicies)
    .where(and(eq(collectionPolicies.tenantId, tenantId), eq(collectionPolicies.isDefault, true)));
  if (existing) return existing;
  const [policy] = await tx
    .insert(collectionPolicies)
    .values({ tenantId, name, isDefault: true })
    .onConflictDoNothing()
    .returning();
  if (!policy) {
    // Lost a race with another request creating it.
    const [won] = await tx
      .select()
      .from(collectionPolicies)
      .where(
        and(eq(collectionPolicies.tenantId, tenantId), eq(collectionPolicies.isDefault, true)),
      );
    return won!;
  }
  await tx
    .insert(policySteps)
    .values(
      DEFAULT_STEPS.map((s, position) => ({ tenantId, policyId: policy.id, position, ...s })),
    );
  return policy;
}

export async function listPolicies(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    await ensureDefaultPolicy(tx, tenantId);
    const policies = await tx
      .select()
      .from(collectionPolicies)
      .orderBy(asc(collectionPolicies.createdAt));
    const steps = await tx.select().from(policySteps).where(isNull(policySteps.archivedAt));
    return policies.map((p) => view(p, steps));
  });
}

function checkSettings(settings: PolicySettings) {
  if (parseClock(settings.quietStart) >= parseClock(settings.quietEnd)) {
    throw new DomainError(
      "policy.invalid_window",
      "validation",
      "Reminders must start before they stop.",
    );
  }
}

function checkSteps(steps: readonly StepSpec[]) {
  if (steps.length === 0 || steps.length > 12) {
    throw new DomainError("policy.invalid_steps", "validation", "Add between 1 and 12 steps.");
  }
  if (new Set(steps.map((s) => s.offsetDays)).size !== steps.length) {
    throw new DomainError(
      "policy.duplicate_offset",
      "validation",
      "Two steps can't fire on the same day.",
    );
  }
}

async function writeSteps(
  tx: Tx,
  tenantId: string,
  policyId: string,
  wanted: readonly (StepSpec & { id?: string })[],
) {
  const ordered = [...wanted].sort((a, b) => a.offsetDays - b.offsetDays);
  const current = await tx
    .select()
    .from(policySteps)
    .where(and(eq(policySteps.policyId, policyId), isNull(policySteps.archivedAt)));
  const byId = new Map(current.map((s) => [s.id, s]));

  const keep = new Set<string>();
  const toInsert: Array<StepSpec & { position: number }> = [];
  ordered.forEach((s, position) => {
    const old = s.id ? byId.get(s.id) : undefined;
    const same =
      old &&
      old.position === position &&
      old.offsetDays === s.offsetDays &&
      old.templateKey === s.templateKey &&
      old.tone === s.tone &&
      old.sendMode === s.sendMode &&
      old.escalateNotifyFirm === s.escalateNotifyFirm;
    if (same) keep.add(old.id);
    else toInsert.push({ ...s, position });
  });

  // Jobs already planned keep pointing at the step they were planned from, so a changed or removed
  // step is archived rather than edited or deleted. Edits apply to invoices sent from now on.
  for (const s of current) {
    if (!keep.has(s.id)) {
      await tx.update(policySteps).set({ archivedAt: realNow() }).where(eq(policySteps.id, s.id));
    }
  }
  if (toInsert.length) {
    await tx.insert(policySteps).values(
      toInsert.map(({ id: _ignored, ...s }: StepSpec & { position: number; id?: string }) => ({
        tenantId,
        policyId,
        ...s,
      })),
    );
  }
}

export async function createPolicy(
  db: Db,
  actor: Actor,
  settings: PolicySettings,
  steps: readonly StepSpec[],
) {
  checkSettings(settings);
  checkSteps(steps);
  return withTenant(db, actor.tenantId, async (tx) => {
    await ensureDefaultPolicy(tx, actor.tenantId);
    const [policy] = await tx
      .insert(collectionPolicies)
      .values({ tenantId: actor.tenantId, ...settings })
      .returning();
    await writeSteps(tx, actor.tenantId, policy!.id, steps);
    await audit(
      tx,
      actor,
      "policy.created",
      { type: "policy", id: policy!.id },
      { after: settings },
    );
    return { id: policy!.id };
  });
}

export async function updatePolicy(
  db: Db,
  actor: Actor,
  policyId: string,
  settings: PolicySettings,
  steps: readonly (StepSpec & { id?: string })[],
) {
  checkSettings(settings);
  checkSteps(steps);
  await withTenant(db, actor.tenantId, async (tx) => {
    const [policy] = await tx
      .select()
      .from(collectionPolicies)
      .where(eq(collectionPolicies.id, policyId))
      .for("update");
    if (!policy) throw new DomainError("policy.not_found", "not_found", "Policy not found.");
    await tx.update(collectionPolicies).set(settings).where(eq(collectionPolicies.id, policyId));
    await writeSteps(tx, actor.tenantId, policyId, steps);
    await audit(
      tx,
      actor,
      "policy.updated",
      { type: "policy", id: policyId },
      {
        before: {
          name: policy.name,
          quietStart: hhmm(policy.quietStart),
          quietEnd: hhmm(policy.quietEnd),
        },
        after: { ...settings, steps: steps.length },
      },
    );
  });
}

export async function setDefaultPolicy(db: Db, actor: Actor, policyId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [policy] = await tx
      .select({ id: collectionPolicies.id })
      .from(collectionPolicies)
      .where(eq(collectionPolicies.id, policyId));
    if (!policy) throw new DomainError("policy.not_found", "not_found", "Policy not found.");
    // The partial unique index allows one default, so release the old one first.
    await tx
      .update(collectionPolicies)
      .set({ isDefault: false })
      .where(and(eq(collectionPolicies.isDefault, true), ne(collectionPolicies.id, policyId)));
    await tx
      .update(collectionPolicies)
      .set({ isDefault: true })
      .where(eq(collectionPolicies.id, policyId));
    await audit(tx, actor, "policy.default_set", { type: "policy", id: policyId });
  });
}

export async function deletePolicy(db: Db, actor: Actor, policyId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const [policy] = await tx
      .select()
      .from(collectionPolicies)
      .where(eq(collectionPolicies.id, policyId));
    if (!policy) throw new DomainError("policy.not_found", "not_found", "Policy not found.");
    if (policy.isDefault) {
      throw new DomainError(
        "policy.is_default",
        "conflict",
        "Choose another default policy before deleting this one.",
      );
    }
    try {
      await tx.update(clients).set({ policyId: null }).where(eq(clients.policyId, policyId));
      await tx.delete(policySteps).where(eq(policySteps.policyId, policyId));
      await tx.delete(collectionPolicies).where(eq(collectionPolicies.id, policyId));
    } catch (error) {
      // Steps that already produced reminders stay as history, which keeps the policy too.
      if ((error as { cause?: { code?: string } }).cause?.code === "23503") {
        throw new DomainError(
          "policy.in_use",
          "conflict",
          "This policy has already sent reminders, so it can't be deleted.",
        );
      }
      throw error;
    }
    await audit(
      tx,
      actor,
      "policy.deleted",
      { type: "policy", id: policyId },
      { before: { name: policy.name } },
    );
  });
}

/** Which policy governs a client: their own override, else the firm default. */
export async function policyFor(tx: Tx, tenantId: string, policyId: string | null) {
  const policy = policyId
    ? (await tx.select().from(collectionPolicies).where(eq(collectionPolicies.id, policyId)))[0]
    : undefined;
  const chosen = policy ?? (await ensureDefaultPolicy(tx, tenantId));
  const steps = await tx
    .select()
    .from(policySteps)
    .where(and(eq(policySteps.policyId, chosen.id), isNull(policySteps.archivedAt)))
    .orderBy(asc(policySteps.position));
  return { policy: chosen, steps };
}

/**
 * FR-9.11: when would each step fire for an invoice due `dueDate`, under these settings? Takes the policy as
 * typed (not stored), so the editor can preview unsaved changes. Uses the firm's clock, like a real send.
 */
export async function previewPolicy(
  db: Db,
  tenantId: string,
  input: {
    settings: PolicySettings;
    steps: readonly StepSpec[];
    /** Defaults to 30 days from the firm's today. */
    dueDate?: string;
    timezone?: string | null;
  },
) {
  checkSettings(input.settings);
  checkSteps(input.steps);
  const { firm, now, today } = await withTenant(db, tenantId, (tx) => firmClock(tx, tenantId));
  const dueDate = input.dueDate ?? shiftDate(today, 30);
  const timeZone = input.timezone || firm.timezone;
  if (!isValidTimeZone(timeZone)) {
    throw new DomainError("firm.invalid_timezone", "validation", "Choose a valid timezone.");
  }
  const ordered = [...input.steps].sort((a, b) => a.offsetDays - b.offsetDays);
  const plans = plan({
    dueDate,
    steps: ordered.map((s, i) => ({ id: String(i), offsetDays: s.offsetDays })),
    window: input.settings,
    timeZone,
    now,
  });
  return {
    dueDate,
    timezone: timeZone,
    steps: plans.map((p, i) => {
      const step = ordered[i]!;
      const local = localParts(p.nextRunAt, timeZone);
      return {
        offsetDays: step.offsetDays,
        tone: step.tone,
        sendMode: step.sendMode,
        plannedFor: p.plannedFor,
        action: p.action,
        sendAt: p.action === "schedule" ? p.nextRunAt.toISOString() : null,
        /** The wall-clock time in the client's timezone, e.g. `2026-06-15 08:00`. */
        localTime:
          p.action === "schedule"
            ? `${local.date} ${String(Math.floor(local.minutes / 60)).padStart(2, "0")}:${String(local.minutes % 60).padStart(2, "0")}`
            : null,
        subject: reminderDraft({
          clientName: "Client",
          number: "INV-0001",
          amountDueMinor: 100_000,
          dueDate,
          daysFromDue: step.offsetDays,
          templateKey: step.templateKey,
          tone: step.tone,
        }).subject,
      };
    }),
  };
}
