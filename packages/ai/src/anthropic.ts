import Anthropic from "@anthropic-ai/sdk";

import type { ContentPart, ModelClient, ModelRequest } from "./types";

export const DEFAULT_MODEL = "claude-haiku-5-5";

function toBlocks(content: string | ContentPart[]): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part): Anthropic.ContentBlockParam => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.mediaType === "application/pdf") {
      return {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: part.base64 },
      };
    }
    return {
      type: "image",
      source: { type: "base64", media_type: part.mediaType, data: part.base64 },
    };
  });
}

/**
 * Claude through the official SDK. Effort is `low`: these are short extraction and classification jobs,
 * and the default thinking depth would cost more than the answer is worth.
 */
export function createAnthropicModel(apiKey: string, model: string = DEFAULT_MODEL): ModelClient {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
  return {
    name: model,
    async complete(request: ModelRequest) {
      const started = performance.now();
      const response = await client.messages.create({
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: toBlocks(request.content) }],
      });
      if (response.stop_reason === "refusal") throw new Error("model refused the request");
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Math.round(performance.now() - started),
      };
    },
  };
}
