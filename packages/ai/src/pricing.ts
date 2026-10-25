// Millionths of a dollar per million tokens, from Anthropic's published list prices (prompts up to 100K tokens).
const PER_MILLION_MICROS: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 100_000, output: 500_000 },
  "claude-sonnet-5-5": { input: 2_000_000, output: 10_000_000 },
  "claude-opus-5-5": { input: 4_000_000, output: 20_000_000 },
};
/** An unknown model is priced like the dearest one, so the cap errs on the side of stopping early. */
const FALLBACK = { input: 5_000_000, output: 25_000_000 };

/** Cost of one call in millionths of a dollar, rounded up. */
export function costMicros(model: string, inputTokens: number, outputTokens: number): number {
  const price = PER_MILLION_MICROS[model] ?? FALLBACK;
  return Math.ceil((inputTokens * price.input + outputTokens * price.output) / 1_000_000);
}
