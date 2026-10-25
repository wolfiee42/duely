import { resolveDateText } from "@repo/domain";

import type { ModelClient, ModelRequest, ModelResponse } from "./types";

// Offline models. Default test runs and fake services mode never reach a real model.

export interface ScriptedModel extends ModelClient {
  calls: ModelRequest[];
}

const tokensOf = (s: string) => Math.ceil(s.length / 4);

/** Replies with whatever `reply` returns (an object is sent as JSON). Throw from `reply` to simulate an outage. */
export function createScriptedModel(
  reply: (request: ModelRequest, callNumber: number) => string | object | Promise<string | object>,
  name = "claude-haiku-5-5",
): ScriptedModel {
  const calls: ModelRequest[] = [];
  return {
    name,
    calls,
    async complete(request): Promise<ModelResponse> {
      calls.push(request);
      const out = await reply(request, calls.length);
      const text = typeof out === "string" ? out : JSON.stringify(out);
      const input =
        request.system +
        (typeof request.content === "string" ? request.content : JSON.stringify(request.content));
      return { text, inputTokens: tokensOf(input), outputTokens: tokensOf(text), latencyMs: 5 };
    },
  };
}

const textOf = (r: ModelRequest) =>
  typeof r.content === "string"
    ? r.content
    : r.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");

function classify(user: string) {
  const body = /<email>\n([\s\S]*?)\n<\/email>/.exec(user)?.[1] ?? "";
  const received = /Message received: (.+)/.exec(user)?.[1] ?? "";
  const tz = /Client timezone: (.+)/.exec(user)?.[1] ?? "UTC";
  const lower = body.toLowerCase();
  const sentence = (re: RegExp) =>
    body
      .split(/(?<=[.!?])\s+|\n+/)
      .find((s) => re.test(s.toLowerCase()))
      ?.trim() ?? null;

  const paidRe =
    /\b(already paid|have paid|i paid|we paid|payment (was|has been) (sent|made)|sent (the )?payment|paid (it|this|that))\b/;
  const disputeRe =
    /\b(dispute|incorrect|wrong|overcharg\w*|do not owe|don't owe|never ordered|not what we agreed)\b/;
  if (paidRe.test(lower)) {
    return {
      label: "already_paid",
      confidence: 0.9,
      rationale: "Says the invoice was paid.",
      promise_date_text: null,
      promise_date_iso: null,
      source_quote: sentence(paidRe),
    };
  }
  if (disputeRe.test(lower)) {
    return {
      label: "dispute",
      confidence: 0.9,
      rationale: "Disputes the invoice.",
      promise_date_text: null,
      promise_date_iso: null,
      source_quote: sentence(disputeRe),
    };
  }
  const when =
    /\b(tomorrow|today|next [a-z]+day|(?:mon|tues|wednes|thurs|fri|satur|sun)day|in \d+ (?:days?|weeks?)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?)\b/.exec(
      lower,
    );
  if (when && /\b(pay|payment|transfer|send|settle)\b/.test(lower)) {
    const iso = received ? resolveDateText(when[0], new Date(received), tz) : null;
    return {
      label: "promise",
      confidence: 0.9,
      rationale: "Commits to pay on a date.",
      promise_date_text: when[0],
      promise_date_iso: iso,
      source_quote: sentence(new RegExp(when[0])),
    };
  }
  if (/\b(out of office|automatic reply|thank you|thanks)\b/.test(lower) && !/\?/.test(lower)) {
    return {
      label: "other",
      confidence: 0.8,
      rationale: "Courtesy or automatic reply.",
      promise_date_text: null,
      promise_date_iso: null,
      source_quote: null,
    };
  }
  return {
    label: "needs_human",
    confidence: 0.7,
    rationale: "Needs a person to read it.",
    promise_date_text: null,
    promise_date_iso: null,
    source_quote: null,
  };
}

/**
 * A rule-based stand-in that answers each prompt by its `PURPOSE:` line. Good enough to exercise the whole
 * flow locally and in E2E; the real accuracy is measured with `eval:classify` against a live model.
 */
export function createHeuristicModel(): ModelClient {
  return {
    name: "fake-heuristic",
    async complete(request): Promise<ModelResponse> {
      const purpose = /PURPOSE: (\w+)/.exec(request.system)?.[1];
      const user = textOf(request);
      let reply: object;
      if (purpose === "classify") reply = classify(user);
      else if (purpose === "draft") {
        reply = {
          subject: "A reminder about invoice {{invoice_number}}",
          body_text:
            "Hello,\n\nA quick note that invoice {{invoice_number}} for {{amount}} is due on {{due_date}}. If it has already been taken care of, thank you.\n\nView and pay:\n{{portal_link}}",
        };
      } else if (purpose === "risk_explain") {
        reply = {
          explanation: "This client has a history that raises the chance of a late payment.",
        };
      } else {
        reply = {
          client_name: "Initech",
          invoice_number: "A-1001",
          issue_date: null,
          due_date: null,
          currency: "USD",
          items: [
            { description: "Consulting", quantity: 2, unit_amount_minor: 50_000 },
            { description: "Hosting", quantity: 1, unit_amount_minor: 20_000 },
          ],
          stated_total_minor: 120_000,
          field_confidence: {
            client_name: 0.95,
            invoice_number: 0.9,
            issue_date: 0.3,
            due_date: 0.4,
            items: 0.9,
            stated_total_minor: 0.95,
          },
        };
      }
      const text = JSON.stringify(reply);
      return { text, inputTokens: tokensOf(user), outputTokens: tokensOf(text), latencyMs: 1 };
    },
  };
}
