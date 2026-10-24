// Reading inbound mail: who is it from, which reminder is it answering, and what did the person write.

/** `Bill <bill@initech.test>` or `bill@initech.test` to the bare lowercase address. */
export function parseAddress(value: string): string {
  return bareAddress(value).toLowerCase();
}

const bareAddress = (value: string) => {
  const angle = /<([^>]+)>/.exec(value);
  return (angle ? angle[1]! : value).trim();
};

/** The reply token in `reply+TOKEN@inbound.example.com`, if any of the recipients is such an address. */
export function replyTokenFrom(recipients: readonly string[]): string | null {
  for (const r of recipients) {
    // Tokens are case-sensitive, so the address is not lowercased here.
    const m = /^reply\+([A-Za-z0-9_-]{8,64})@inbound\./i.exec(bareAddress(r));
    if (m) return m[1]!;
  }
  return null;
}

const QUOTE_HEADERS = [
  /^on .{5,200}wrote:\s*$/i, // Gmail, Apple Mail
  /^on .{5,200}$/i, // "On Mon, ... " split over lines; confirmed by the next line below
  /^-{2,}\s*original message\s*-{2,}\s*$/i,
  /^-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  /^_{5,}\s*$/, // Outlook rule
  /^from:\s.+$/i, // Outlook header block
  /^le .{5,200}a écrit\s*:\s*$/i,
  /^am .{5,200}schrieb .*:\s*$/i,
];
const SIGNATURE = /^(-- ?|—)\s*$/;
const MOBILE_SIGNATURE = /^sent from my (iphone|ipad|android|mobile|phone)/i;

/**
 * Keeps what the person actually wrote: drops quoted history (`>` lines, "On … wrote:", Outlook headers),
 * signature delimiters and "Sent from my iPhone". The raw body is kept elsewhere (FR-8.6).
 */
export function stripQuoted(text: string): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (SIGNATURE.test(trimmed) || MOBILE_SIGNATURE.test(trimmed)) break;
    // "On Mon, 3 Jun 2026 at 10:00, Bill <b@x> wrote:" may wrap onto the next line.
    const joined = `${trimmed} ${(lines[i + 1] ?? "").trim()}`.trim();
    if (/^on .{5,200}wrote:\s*$/i.test(trimmed) || /^on .{5,200}wrote:\s*$/i.test(joined)) break;
    if (QUOTE_HEADERS.some((re, idx) => idx !== 1 && re.test(trimmed))) break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}
