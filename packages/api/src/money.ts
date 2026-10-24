// Client-safe: pure money helpers only. Browser code must import from "@repo/api/money" and never from
// "@repo/api", whose index pulls in the database driver and other server-only code.
export { formatUsd, invoiceTotals, lineAmount, parseQuantity } from "@repo/domain";
