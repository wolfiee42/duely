// SPEC 4.6. Integer arithmetic only: money is `bigint` minor units in the DB and a JS number here
// (safe far beyond any invoice), but intermediate products use BigInt so they cannot overflow.

/** Quantities carry 3 decimals, stored as thousandths (1.5 -> 1500). */
export type QuantityMilli = number;

const QTY = /^\d{1,9}(\.\d{1,3})?$/;

/** Parses user input such as "2", "1.5" or "0.125". Returns null if invalid or not positive. */
export function parseQuantity(input: string): QuantityMilli | null {
  const text = input.trim();
  if (!QTY.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const milli = Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
  return milli > 0 ? milli : null;
}

export function formatQuantity(milli: QuantityMilli): string {
  const whole = Math.trunc(milli / 1000);
  const frac = String(milli % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** `round_half_up(quantity * unit_amount_minor)` for one line. */
export function lineAmount(quantityMilli: QuantityMilli, unitAmountMinor: number): number {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0)
    throw new RangeError("quantity must be positive");
  if (!Number.isSafeInteger(unitAmountMinor) || unitAmountMinor < 0)
    throw new RangeError("unit amount must be >= 0");
  const product = BigInt(quantityMilli) * BigInt(unitAmountMinor);
  const amount = (product + 500n) / 1000n; // non-negative, so integer division floors: this is half-up
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("amount too large");
  return Number(amount);
}

export interface LineInput {
  quantityMilli: QuantityMilli;
  unitAmountMinor: number;
}

/** Invoice totals: each line is rounded on its own, then summed (no rounding of the sum). */
export function invoiceTotals(lines: readonly LineInput[]) {
  const amounts = lines.map((l) => lineAmount(l.quantityMilli, l.unitAmountMinor));
  const total = amounts.reduce((sum, a) => sum + a, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError("total too large");
  return { lineAmounts: amounts, subtotalMinor: total, totalMinor: total };
}

/** `floor(amount * platform_fee_bps / 10000)`. */
export function platformFee(amountMinor: number, feeBps: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
    throw new RangeError("amount must be >= 0");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000)
    throw new RangeError("fee bps out of range");
  return Number((BigInt(amountMinor) * BigInt(feeBps)) / 10_000n);
}

/** Display only. Never feed the result back into arithmetic. */
export function formatUsd(amountMinor: number): string {
  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const dollars = Math.trunc(abs / 100).toLocaleString("en-US");
  return `${negative ? "-" : ""}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
