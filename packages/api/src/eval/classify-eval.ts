import { readFileSync } from "node:fs";

import {
  callValidated,
  ClassifyOutput,
  CLASSIFY_LABELS,
  CLASSIFY_SYSTEM,
  classifyContent,
  costMicros,
  type ModelClient,
} from "@repo/ai";
import { stripQuoted } from "@repo/email";

import { decide } from "../usecases/classify";

// FR-11.14: the labeled replies in seed/eval/replies.jsonl, run through the real prompt, schema and
// code-side checks. `eval:classify` points this at a live model and prints the report for the README.

export interface EvalReply {
  id: string;
  received_at: string;
  timezone: string;
  body: string;
  label: (typeof CLASSIFY_LABELS)[number];
  promise_date: string | null;
}

export function loadReplies(
  path = new URL("../../../../seed/eval/replies.jsonl", import.meta.url),
): EvalReply[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalReply);
}

type Predicted = (typeof CLASSIFY_LABELS)[number] | "invalid";

export interface EvalRow {
  id: string;
  gold: EvalReply["label"];
  predicted: Predicted;
  confidence: number | null;
  decision: string;
  downgraded: string | null;
  goldDate: string | null;
  date: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
}

export async function runEval(
  model: ModelClient,
  replies: readonly EvalReply[],
  { concurrency = 4 }: { concurrency?: number } = {},
): Promise<EvalRow[]> {
  const rows: EvalRow[] = new Array(replies.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= replies.length) return;
      const r = replies[i]!;
      // Same preparation as production: the stripped reply is what the model reads.
      const body = stripQuoted(r.body) || r.body;
      const result = await callValidated(
        model,
        {
          system: CLASSIFY_SYSTEM,
          content: classifyContent({ body, receivedAt: r.received_at, timezone: r.timezone }),
          maxTokens: 500,
        },
        ClassifyOutput,
      );
      const base = {
        id: r.id,
        gold: r.label,
        goldDate: r.promise_date,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: costMicros(model.name, result.inputTokens, result.outputTokens),
        latencyMs: result.latencyMs,
      };
      if (!result.ok) {
        rows[i] = {
          ...base,
          predicted: "invalid",
          confidence: null,
          decision: "failed",
          downgraded: result.reason,
          date: null,
        };
        continue;
      }
      const c = decide({
        output: result.output,
        rawMessage: r.body,
        receivedAt: new Date(r.received_at),
        timeZone: r.timezone,
        autoActions: true, // measure the strictest setting: what would happen if a firm let it act alone
      });
      rows[i] = {
        ...base,
        predicted: result.output.label,
        confidence: result.output.confidence,
        decision: c.decision,
        downgraded: c.downgraded,
        date: c.promisedDate,
      };
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return rows;
}

export interface EvalReport {
  total: number;
  accuracy: number;
  invalid: number;
  perClass: Record<string, { precision: number | null; recall: number | null; support: number }>;
  confusion: Record<string, Record<string, number>>;
  promiseDateAccuracy: number | null;
  /** Actions taken with no person involved. */
  autoActions: number;
  /** Of those, how many were wrong (wrong label, or a promise on the wrong date). */
  wrongAutoActions: number;
  adversarialAccuracy: number | null;
  avgCostMicros: number;
  avgLatencyMs: number;
  totalCostMicros: number;
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function score(rows: readonly EvalRow[]): EvalReport {
  const classes = [...CLASSIFY_LABELS];
  const confusion: EvalReport["confusion"] = {};
  for (const g of classes)
    confusion[g] = Object.fromEntries([...classes, "invalid"].map((p) => [p, 0]));
  for (const r of rows) confusion[r.gold]![r.predicted]!++;

  const perClass: EvalReport["perClass"] = {};
  for (const c of classes) {
    const tp = confusion[c]![c]!;
    const predicted = rows.filter((r) => r.predicted === c).length;
    const support = rows.filter((r) => r.gold === c).length;
    perClass[c] = { precision: ratio(tp, predicted), recall: ratio(tp, support), support };
  }

  const promises = rows.filter((r) => r.gold === "promise");
  const auto = rows.filter((r) => r.decision === "auto_promise" || r.decision === "auto_dispute");
  const wrongAuto = auto.filter((r) =>
    r.decision === "auto_promise"
      ? r.gold !== "promise" || r.date !== r.goldDate
      : r.gold !== "dispute",
  );
  const adversarial = rows.filter((r) => r.id.startsWith("x"));
  const sum = (f: (r: EvalRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  return {
    total: rows.length,
    accuracy: ratio(rows.filter((r) => r.gold === r.predicted).length, rows.length) ?? 0,
    invalid: rows.filter((r) => r.predicted === "invalid").length,
    perClass,
    confusion,
    promiseDateAccuracy: ratio(
      promises.filter((r) => r.date === r.goldDate).length,
      promises.length,
    ),
    autoActions: auto.length,
    wrongAutoActions: wrongAuto.length,
    adversarialAccuracy: ratio(
      adversarial.filter((r) => r.gold === r.predicted).length,
      adversarial.length,
    ),
    avgCostMicros: rows.length ? sum((r) => r.costMicros) / rows.length : 0,
    avgLatencyMs: rows.length ? sum((r) => r.latencyMs) / rows.length : 0,
    totalCostMicros: sum((r) => r.costMicros),
  };
}

const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);

export function formatReport(model: string, report: EvalReport): string {
  const classes = Object.keys(report.perClass);
  const cols = [...classes, "invalid"];
  const lines = [
    `Reply classifier evaluation (${report.total} labeled replies, model ${model})`,
    "",
    `Accuracy:               ${pct(report.accuracy)}  (${report.invalid} unusable replies counted as wrong)`,
    `Promise date accuracy:  ${pct(report.promiseDateAccuracy)}  (the date our code verified, vs the labeled date)`,
    `Adversarial accuracy:   ${pct(report.adversarialAccuracy)}  (emails that try to steer the classifier)`,
    `Automatic actions:      ${report.autoActions}, of which wrong: ${report.wrongAutoActions}  (with automatic actions switched on)`,
    `Average cost per call:  $${(report.avgCostMicros / 1_000_000).toFixed(5)}  (total $${(report.totalCostMicros / 1_000_000).toFixed(4)})`,
    `Average latency:        ${Math.round(report.avgLatencyMs)} ms`,
    "",
    "Per class        precision   recall   support",
    ...classes.map((c) => {
      const p = report.perClass[c]!;
      return `${c.padEnd(16)} ${pct(p.precision).padStart(9)} ${pct(p.recall).padStart(8)} ${String(p.support).padStart(9)}`;
    }),
    "",
    "Confusion matrix (rows = labeled, columns = predicted)",
    `${"".padEnd(14)}${cols.map((c) => c.slice(0, 12).padStart(13)).join("")}`,
    ...classes.map(
      (g) =>
        `${g.padEnd(14)}${cols.map((c) => String(report.confusion[g]![c]).padStart(13)).join("")}`,
    ),
  ];
  return lines.join("\n");
}
