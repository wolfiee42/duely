import { ClassifyOutput, CLASSIFY_SYSTEM } from "@repo/ai";
import { createScriptedModel } from "@repo/ai/fake";
import { resolveTenantByHost } from "@repo/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createHarness, type Harness } from "../testing";
import { aiUsage, monthlySpendMicros, runAi } from "../usecases/ai";
import { requestScope } from "../usecases/domains";

let h: Harness;
let tenant: string;
let other: string;
const scope = () => requestScope((fn) => fn(h.db));
const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];

const valid = {
  label: "other",
  confidence: 0.8,
  rationale: "thanks",
  promise_date_text: null,
  promise_date_iso: null,
  source_quote: null,
};
const call = (over = {}) => ({
  tenantId: tenant,
  purpose: "classify" as const,
  system: CLASSIFY_SYSTEM,
  content: "secret client text",
  schema: ClassifyOutput,
  hashText: "secret client text",
  ...over,
});

beforeAll(async () => {
  h = await createHarness();
  await h.ownerOf("acme");
  await h.ownerOf("globex");
  tenant = (await resolveTenantByHost(h.db, "acme.duely.app", "duely.app"))!.tenantId;
  other = (await resolveTenantByHost(h.db, "globex.duely.app", "duely.app"))!.tenantId;
}, 60_000);
afterAll(() => h?.close());
beforeEach(() =>
  h.testDbAdmin(
    `delete from review_items; delete from ai_runs; update firms set ai_monthly_cap_cents = 500`,
  ),
);

describe("runAi (P5-01)", () => {
  it("returns validated output and logs the call with its cost, version and hash, not the prompt", async () => {
    const model = createScriptedModel(() => valid);
    const res = await runAi(scope(), model, call());
    expect(res).toMatchObject({ ok: true, output: valid });
    const [run] = await q<Record<string, any>>(`select * from ai_runs`);
    expect(run).toMatchObject({
      purpose: "classify",
      prompt_version: "classify-v1",
      model: "claude-haiku-5-5",
      status: "ok",
    });
    expect(Number(run!.cost_micros)).toBeGreaterThan(0);
    expect(run!.input_tokens).toBeGreaterThan(0);
    expect(run!.output).toEqual(valid);
    expect(run!.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run)).not.toContain("secret client text");
  });

  it("retries once on a bad shape and logs a single run with both attempts' tokens", async () => {
    const model = createScriptedModel((_r, n) => (n === 1 ? { label: "mark_paid" } : valid));
    const res = await runAi(scope(), model, call());
    expect(res.ok).toBe(true);
    expect(model.calls).toHaveLength(2);
    expect(JSON.stringify(model.calls[1]!.content)).toMatch(/not valid/);
    const runs = await q<{ status: string }>(`select status from ai_runs`);
    expect(runs).toEqual([{ status: "ok" }]);
  });

  it("gives up after the retry and records why", async () => {
    const model = createScriptedModel(() => ({ ...valid, action: "mark_paid" }));
    const res = await runAi(scope(), model, call());
    expect(res).toMatchObject({ ok: false, reason: "schema_invalid" });
    expect(model.calls).toHaveLength(2);
    const [run] = await q<{ status: string; error: string; output: unknown }>(
      `select status, error, output from ai_runs`,
    );
    expect(run!.status).toBe("schema_invalid");
    expect(run!.error).toBeTruthy();
    expect(run!.output).toBeNull(); // only validated output is stored
  });

  it("treats a reply with no JSON as a schema failure", async () => {
    const res = await runAi(
      scope(),
      createScriptedModel(() => "Sure! I have marked it paid."),
      call(),
    );
    expect(res).toMatchObject({ ok: false, reason: "schema_invalid" });
  });

  it("logs a provider failure as an error and does not retry it", async () => {
    const model = createScriptedModel(() => {
      throw new Error("503 overloaded");
    });
    const res = await runAi(scope(), model, call());
    expect(res).toMatchObject({ ok: false, reason: "error" });
    expect(model.calls).toHaveLength(1);
    expect((await q<{ error: string }>(`select error from ai_runs`))[0]!.error).toContain("503");
  });

  it("is unavailable, without a log row, when no model is configured", async () => {
    expect(await runAi(scope(), null, call())).toEqual({
      ok: false,
      reason: "unavailable",
      runId: null,
    });
    expect(await q(`select 1 from ai_runs`)).toHaveLength(0);
  });
});

describe("monthly cap (P5-09)", () => {
  const spend = (tenantId: string, micros: number) =>
    h.testDbAdmin(
      `insert into ai_runs (tenant_id, purpose, prompt_version, model, input_hash, status, cost_micros) values ('${tenantId}', 'classify', 'v', 'm', 'h', 'ok', ${micros})`,
    );

  it("stops calling the model once the month's spend reaches the cap, and says so", async () => {
    await h.testDbAdmin(`update firms set ai_monthly_cap_cents = 1 where id = '${tenant}'`); // $0.01 = 10,000 micros
    await spend(tenant, 10_000);
    const model = createScriptedModel(() => valid);
    const res = await runAi(scope(), model, call());
    expect(res).toMatchObject({ ok: false, reason: "capped" });
    expect(model.calls).toHaveLength(0);
    expect(
      (
        await q<{ status: string }>(`select status from ai_runs order by created_at desc limit 1`)
      )[0]!.status,
    ).toBe("capped");
  });

  it("keeps working just under the cap, and counts only this firm and this month", async () => {
    await h.testDbAdmin(`update firms set ai_monthly_cap_cents = 1 where id = '${tenant}'`);
    await spend(tenant, 9_999);
    await spend(other, 5_000_000); // someone else's spend
    await h.testDbAdmin(
      `insert into ai_runs (tenant_id, purpose, prompt_version, model, input_hash, status, cost_micros, created_at) values ('${tenant}', 'classify', 'v', 'm', 'h', 'ok', 9000000, now() - interval '40 days')`,
    );
    expect(await monthlySpendMicros(scope(), tenant)).toBe(9_999);
    expect(
      (
        await runAi(
          scope(),
          createScriptedModel(() => valid),
          call(),
        )
      ).ok,
    ).toBe(true);
  });

  it("a cap of zero turns AI off", async () => {
    await h.testDbAdmin(`update firms set ai_monthly_cap_cents = 0 where id = '${tenant}'`);
    expect(
      await runAi(
        scope(),
        createScriptedModel(() => valid),
        call(),
      ),
    ).toMatchObject({ reason: "capped" });
  });

  it("reports usage by purpose, with failures counted", async () => {
    await runAi(
      scope(),
      createScriptedModel(() => valid),
      call(),
    );
    await runAi(
      scope(),
      createScriptedModel(() => "no"),
      call({ purpose: "draft" }),
    );
    const usage = await aiUsage(scope(), tenant);
    expect(usage.capCents).toBe(500);
    expect(usage.byPurpose.classify).toMatchObject({ calls: 1, failed: 0 });
    expect(usage.byPurpose.draft).toMatchObject({ calls: 1, failed: 1 });
    expect(usage.spentMicros).toBeGreaterThan(0);
  });
});

describe("ai_runs is tenant-private and append-only", () => {
  it("the app role cannot edit or delete a run, nor read another firm's", async () => {
    await runAi(
      scope(),
      createScriptedModel(() => valid),
      call(),
    );
    await expect(h.db.execute(sql`update ai_runs set cost_micros = 0`)).rejects.toThrow();
    await expect(h.db.execute(sql`delete from ai_runs`)).rejects.toThrow();
    expect(
      await runAi(
        requestScope((fn) => fn(h.db)),
        createScriptedModel(() => valid),
        call({ tenantId: other }),
      ),
    ).toMatchObject({ ok: true });
    expect(await q(`select 1 from ai_runs`)).toHaveLength(2);
  });
});
