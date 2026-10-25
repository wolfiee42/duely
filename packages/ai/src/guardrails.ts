import { formatUsd } from "@repo/domain";

import type { DraftOutput } from "./schemas";

// SPEC 5.2, FR-11.7: a generated reminder must carry the slots, say nothing threatening, and contain no
// number or date the model made up. Anything that fails is replaced by the plain template.

export const REQUIRED_PLACEHOLDERS = [
  "{{amount}}",
  "{{due_date}}",
  "{{invoice_number}}",
  "{{portal_link}}",
] as const;

// Threats, legal claims and pressure tactics. Deliberately broad: a false positive costs a template draft.
const DISALLOWED =
  /\b(lawsuit|sue|suing|attorney|lawyer|legal action|legal proceedings|court|collections?|collection agency|debt collector|credit (report|bureau|score)|garnish\w*|lien|arrest\w*|police|prosecut\w*|criminal|fraud|blacklist\w*|penalt(y|ies)|late fees?|interest charges?|ruin|consequences)\b/i;

export function checkDraft(draft: DraftOutput): string[] {
  const problems: string[] = [];
  const text = `${draft.subject}\n${draft.body_text}`;
  for (const p of REQUIRED_PLACEHOLDERS) {
    if (!draft.body_text.includes(p) && !draft.subject.includes(p)) problems.push(`missing ${p}`);
  }
  const unknown = text
    .match(/\{\{[^}]*\}\}/g)
    ?.filter((p) => !(REQUIRED_PLACEHOLDERS as readonly string[]).includes(p));
  if (unknown?.length) problems.push(`unknown placeholder ${unknown[0]}`);
  const bad = DISALLOWED.exec(text);
  if (bad) problems.push(`disallowed wording "${bad[0]}"`);
  // No figures of its own: money, dates, invoice-looking numbers or links.
  const stripped = text.replaceAll(/\{\{[^}]*\}\}/g, "");
  if (/[$€£]\s?\d|\d\s?(usd|dollars)\b/i.test(stripped)) problems.push("states an amount");
  if (
    /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b/i.test(
      stripped,
    )
  )
    problems.push("states a date");
  if (/\b(inv|invoice)[-\s#]*\d+/i.test(stripped)) problems.push("states an invoice number");
  if (/https?:\/\/|www\./i.test(stripped)) problems.push("contains a link");
  return problems;
}

/**
 * Fills the slots from data. `{{portal_link}}` becomes the token the sender swaps for the client's own link at
 * send time, so no live link is ever stored.
 */
export function fillDraft(
  draft: DraftOutput,
  facts: { amountMinor: number; dueDate: string; invoiceNumber: string },
): { subject: string; body: string } {
  const fill = (s: string) =>
    s
      .replaceAll("{{amount}}", formatUsd(facts.amountMinor))
      .replaceAll("{{due_date}}", facts.dueDate)
      .replaceAll("{{invoice_number}}", facts.invoiceNumber)
      .replaceAll("{{portal_link}}", "{{portal_url}}");
  return { subject: fill(draft.subject), body: fill(draft.body_text) };
}
