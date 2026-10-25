import {
  callValidated,
  costMicros,
  PROMPT_VERSIONS,
  type ContentPart,
  type ModelClient,
} from "@repo/ai";
import { realNow } from "@repo/clock";
import { aiRuns, firms } from "@repo/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import type { ZodType } from "zod";

import { audit, type Actor } from "./audit";
import type { TenantScope } from "./domains";
import { sha256Hex } from "./tokens";

// SPEC 5: every model call goes through here. Checks the monthly cap, calls the model, validates the reply
// against a strict schema (one automatic retry), logs it to `ai_runs`, and returns the validated output or a
// typed failure. Callers turn a failure into the manual path; nothing is ever skipped silently (FR-11.20).

export type AiPurpose = keyof typeof PROMPT_VERSIONS;

export type AiFailure = "unavailable" | "capped" | "schema_invalid" | "error";
export type AiResult<T> =
  | { ok: true; output: T; runId: string }
  | { ok: false; reason: AiFailure; runId: string | null };

export interface AiCall<T> {
  tenantId: string;
  purpose: AiPurpose;
  system: string;
  content: string | ContentPart[];
  schema: ZodType<T>;
  maxTokens?: number;
  invoiceId?: string | null;
  messageId?: string | null;
  /** What to hash for `input_hash`: the text part of the input, so a file is not stringified. */
  hashText: string;
}

/** First instant of the current month, UTC. The cap and the usage page both count from here. */
export function monthStart(now: Date = realNow()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function monthlySpendMicros(scope: TenantScope, tenantId: string): Promise<number> {
  return scope(tenantId, async (tx) => {
    const [row] = await tx
      .select({ total: sql<string>`coalesce(sum(${aiRuns.costMicros}), 0)` })
      .from(aiRuns)
      .where(and(eq(aiRuns.tenantId, tenantId), gte(aiRuns.createdAt, monthStart())));
    return Number(row?.total ?? 0);
  });
}

export async function runAi<T>(
  scope: TenantScope,
  model: ModelClient | null,
  call: AiCall<T>,
): Promise<AiResult<T>> {
  if (!model) return { ok: false, reason: "unavailable", runId: null };

  const promptVersion = PROMPT_VERSIONS[call.purpose];
  const inputHash = await sha256Hex(`${call.purpose}:${promptVersion}:${call.hashText}`);
  const base = {
    tenantId: call.tenantId,
    purpose: call.purpose,
    promptVersion,
    model: model.name,
    inputHash,
    invoiceId: call.invoiceId ?? null,
    messageId: call.messageId ?? null,
  };
  const log = (
    values: Partial<typeof aiRuns.$inferInsert> & {
      status: "ok" | "schema_invalid" | "error" | "capped";
    },
  ) =>
    scope(call.tenantId, async (tx) => {
      const [row] = await tx
        .insert(aiRuns)
        .values({ ...base, ...values })
        .returning({ id: aiRuns.id });
      return row!.id;
    });

  // 1. The cap. A firm that has spent its month's budget gets the manual path (FR-11.19).
  const [capCents, spent] = await Promise.all([
    scope(call.tenantId, async (tx) => {
      const [f] = await tx
        .select({ cap: firms.aiMonthlyCapCents })
        .from(firms)
        .where(eq(firms.id, call.tenantId));
      return f?.cap ?? 0;
    }),
    monthlySpendMicros(scope, call.tenantId),
  ]);
  if (spent >= capCents * 10_000) {
    return { ok: false, reason: "capped", runId: await log({ status: "capped" }) };
  }

  // 2. Call and validate, with one retry on a bad shape. Network is outside any transaction (D22).
  const result = await callValidated(
    model,
    { system: call.system, content: call.content, maxTokens: call.maxTokens ?? 1200 },
    call.schema,
  );
  const usage = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    costMicros: costMicros(model.name, result.inputTokens, result.outputTokens),
  };
  if (result.ok) {
    const runId = await log({ status: "ok", output: result.output as object, ...usage });
    return { ok: true, output: result.output, runId };
  }
  return {
    ok: false,
    reason: result.reason,
    runId: await log({ status: result.reason, error: result.error, ...usage }),
  };
}

/** This month's usage for the firm, for the usage page (FR-11.19). */
export async function aiUsage(scope: TenantScope, tenantId: string) {
  return scope(tenantId, async (tx) => {
    const rows = await tx
      .select({
        purpose: aiRuns.purpose,
        status: aiRuns.status,
        calls: sql<string>`count(*)`,
        cost: sql<string>`coalesce(sum(${aiRuns.costMicros}), 0)`,
        inputTokens: sql<string>`coalesce(sum(${aiRuns.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${aiRuns.outputTokens}), 0)`,
      })
      .from(aiRuns)
      .where(and(eq(aiRuns.tenantId, tenantId), gte(aiRuns.createdAt, monthStart())))
      .groupBy(aiRuns.purpose, aiRuns.status);
    const [firm] = await tx
      .select({ cap: firms.aiMonthlyCapCents, auto: firms.autoClassifyActions })
      .from(firms)
      .where(eq(firms.id, tenantId));
    const byPurpose: Record<string, { calls: number; costMicros: number; failed: number }> = {};
    let total = 0;
    for (const r of rows) {
      const entry = (byPurpose[r.purpose] ??= { calls: 0, costMicros: 0, failed: 0 });
      entry.calls += Number(r.calls);
      entry.costMicros += Number(r.cost);
      if (r.status !== "ok") entry.failed += Number(r.calls);
      total += Number(r.cost);
    }
    return {
      monthStart: monthStart().toISOString().slice(0, 10),
      spentMicros: total,
      capCents: firm?.cap ?? 0,
      autoActions: firm?.auto ?? false,
      byPurpose,
    };
  });
}

/** Owner-only: the monthly spending limit and whether clear replies may be acted on without a person (FR-11.19, 11.11). */
export async function updateAiSettings(
  scope: TenantScope,
  actor: Actor,
  input: { capCents?: number; autoActions?: boolean },
) {
  await scope(actor.tenantId, async (tx) => {
    const [before] = await tx
      .select({ cap: firms.aiMonthlyCapCents, auto: firms.autoClassifyActions })
      .from(firms)
      .where(eq(firms.id, actor.tenantId));
    await tx
      .update(firms)
      .set({
        ...(input.capCents === undefined ? {} : { aiMonthlyCapCents: input.capCents }),
        ...(input.autoActions === undefined ? {} : { autoClassifyActions: input.autoActions }),
        updatedAt: realNow(),
      })
      .where(eq(firms.id, actor.tenantId));
    await audit(
      tx,
      actor,
      "firm.ai_settings_changed",
      { type: "firm", id: actor.tenantId },
      {
        before: { capCents: before?.cap, autoActions: before?.auto },
        after: input,
      },
    );
  });
}
