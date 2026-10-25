import type { ZodType } from "zod";

import { extractJson } from "./json";
import type { ContentPart, ModelClient } from "./types";

export type ValidatedResult<T> =
  | { ok: true; output: T; inputTokens: number; outputTokens: number; latencyMs: number }
  | {
      ok: false;
      reason: "schema_invalid" | "error";
      error: string;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
    };

function withNote(content: string | ContentPart[], note: string): string | ContentPart[] {
  return typeof content === "string"
    ? `${content}\n\n${note}`
    : [...content, { type: "text", text: note }];
}

/**
 * One model call whose reply must match `schema`. A reply that is not JSON, or has the wrong shape, gets one
 * automatic retry with a nudge (SPEC 5); a provider failure is not retried. Tokens add up across attempts.
 */
export async function callValidated<T>(
  model: ModelClient,
  request: { system: string; content: string | ContentPart[]; maxTokens: number },
  schema: ZodType<T>,
): Promise<ValidatedResult<T>> {
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      const response = await model.complete({
        ...request,
        content:
          attempt === 0
            ? request.content
            : withNote(
                request.content,
                "Your previous reply was not valid. Reply with ONLY the JSON object described.",
              ),
      });
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;
      latencyMs += response.latencyMs;
      text = response.text;
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        error: (error instanceof Error ? error.message : "error").slice(0, 300),
        inputTokens,
        outputTokens,
        latencyMs,
      };
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "not JSON";
      continue;
    }
    const checked = schema.safeParse(parsed);
    if (checked.success) {
      return { ok: true, output: checked.data, inputTokens, outputTokens, latencyMs };
    }
    lastError = checked.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  return {
    ok: false,
    reason: "schema_invalid",
    error: lastError.slice(0, 300),
    inputTokens,
    outputTokens,
    latencyMs,
  };
}
