import { writeFileSync } from "node:fs";

import { createAnthropicModel, DEFAULT_MODEL } from "@repo/ai";
import { createHeuristicModel, createScriptedModel } from "@repo/ai/fake";
import { describe, expect, it } from "vite-plus/test";

import { formatReport, loadReplies, runEval, score } from "./classify-eval";

const replies = loadReplies();

describe("the labeled reply set", () => {
  it("has at least 40 replies, every class represented, unique ids and valid dates", () => {
    expect(replies.length).toBeGreaterThanOrEqual(40);
    expect(new Set(replies.map((r) => r.id)).size).toBe(replies.length);
    for (const label of ["promise", "dispute", "already_paid", "needs_human", "other"]) {
      expect(replies.filter((r) => r.label === label).length, label).toBeGreaterThanOrEqual(6);
    }
    for (const r of replies) {
      expect(r.body.trim(), r.id).not.toBe("");
      expect(Boolean(r.promise_date), r.id).toBe(r.label === "promise");
      if (r.promise_date) expect(r.promise_date, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(replies.filter((r) => r.id.startsWith("x")).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the scoring", () => {
  it("a model that always answers 'other' scores only the 'other' replies", async () => {
    const model = createScriptedModel(() => ({
      label: "other",
      confidence: 0.9,
      rationale: "x",
      promise_date_text: null,
      promise_date_iso: null,
      source_quote: null,
    }));
    const report = score(await runEval(model, replies));
    const others = replies.filter((r) => r.label === "other").length;
    expect(report.accuracy).toBeCloseTo(others / replies.length);
    expect(report.perClass.other!.recall).toBe(1);
    expect(report.perClass.promise!.recall).toBe(0);
    expect(report.perClass.promise!.precision).toBeNull(); // never predicted
    expect(report.confusion.promise!.other).toBe(
      replies.filter((r) => r.label === "promise").length,
    );
    expect(report.autoActions).toBe(0);
  });

  it("counts an unusable reply as wrong, and never as an action", async () => {
    const report = score(
      await runEval(
        createScriptedModel(() => "no idea"),
        replies,
      ),
    );
    expect(report.invalid).toBe(replies.length);
    expect(report.accuracy).toBe(0);
    expect(report.autoActions).toBe(0);
  });

  it("reports a wrong automatic action", async () => {
    // Claims everything is a confident dispute, quoting the first words of each email.
    const model = createScriptedModel((request) => {
      const body = /<email>\n([\s\S]*?)\n<\/email>/.exec(request.content as string)![1]!;
      return {
        label: "dispute",
        confidence: 0.99,
        rationale: "x",
        promise_date_text: null,
        promise_date_iso: null,
        source_quote: body.slice(0, 20),
      };
    });
    const report = score(await runEval(model, replies));
    expect(report.autoActions).toBeGreaterThan(0);
    expect(report.wrongAutoActions).toBe(
      report.autoActions - replies.filter((r) => r.label === "dispute").length,
    );
  });

  it("the offline heuristic model gets most replies right and verifies promise dates", async () => {
    const report = score(await runEval(createHeuristicModel(), replies));
    console.log(`\n${formatReport("fake-heuristic (offline baseline)", report)}\n`);
    expect(report.accuracy).toBeGreaterThan(0.6);
    expect(report.promiseDateAccuracy).toBeGreaterThan(0.5);
    expect(report.invalid).toBe(0);
  });
});

// `pnpm eval:classify`: the same set against the real model. Needs ANTHROPIC_API_KEY and costs a few cents.
describe.skipIf(!process.env.EVAL_LIVE)("live model", () => {
  it("classifies the labeled set", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    const name = process.env.AI_MODEL || DEFAULT_MODEL;
    const report = score(await runEval(createAnthropicModel(key, name), replies));
    const text = formatReport(name, report);
    console.log(`\n${text}\n`);
    writeFileSync(new URL("../../../../seed/eval/last-run.txt", import.meta.url), `${text}\n`);
    expect(report.total).toBe(replies.length);
  }, 600_000);
});
