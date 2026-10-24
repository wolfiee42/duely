import { formatUsd } from "@repo/domain";

// Firm-supplied text (names, notes) is escaped everywhere it is interpolated (SPEC 7).
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Only http(s) links are allowed into href attributes. */
function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsafe link");
  return escapeHtml(parsed.toString());
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

interface Brand {
  firmName: string;
  /** `#RRGGBB`; anything else falls back to the default so it cannot inject CSS. */
  brandColor: string;
}

const color = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : "#1F4FD8");

function layout(
  brand: Brand,
  heading: string,
  bodyHtml: string,
  cta?: { label: string; url: string },
) {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${safeUrl(cta.url)}" style="background:${color(brand.brandColor)};color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>${bodyHtml}${button}
<p style="color:#666;font-size:12px;margin-top:32px">Sent on behalf of ${escapeHtml(brand.firmName)}.</p></body></html>`;
}

export function invoiceEmail(
  input: Brand & {
    clientName: string;
    number: string;
    totalMinor: number;
    dueDate: string | null;
    portalUrl: string;
  },
): Rendered {
  const amount = formatUsd(input.totalMinor);
  const due = input.dueDate ? ` Payment is due ${input.dueDate}.` : "";
  const subject = `Invoice ${input.number} from ${input.firmName}`;
  return {
    subject,
    html: layout(
      input,
      `Invoice ${input.number}`,
      `<p>Hello ${escapeHtml(input.clientName)},</p><p>${escapeHtml(input.firmName)} sent you an invoice for <strong>${amount}</strong>.${escapeHtml(due)}</p>`,
      { label: "View and pay", url: input.portalUrl },
    ),
    text: `Hello ${input.clientName},\n\n${input.firmName} sent you invoice ${input.number} for ${amount}.${due}\n\nView and pay: ${input.portalUrl}\n`,
  };
}

export function receiptEmail(
  input: Brand & {
    clientName: string;
    number: string;
    amountMinor: number;
    portalUrl: string;
  },
): Rendered {
  const amount = formatUsd(input.amountMinor);
  return {
    subject: `Receipt for invoice ${input.number}`,
    html: layout(
      input,
      "Payment received",
      `<p>Hello ${escapeHtml(input.clientName)},</p><p>Thank you. We received your payment of <strong>${amount}</strong> for invoice ${escapeHtml(input.number)}.</p>`,
      { label: "View receipt", url: input.portalUrl },
    ),
    text: `Hello ${input.clientName},\n\nThank you. We received your payment of ${amount} for invoice ${input.number}.\n\nView receipt: ${input.portalUrl}\n`,
  };
}

export function magicLinkEmail(input: Brand & { url: string; minutes: number }): Rendered {
  return {
    subject: `Your sign-in link for ${input.firmName}`,
    html: layout(
      input,
      "Sign in",
      `<p>Use this link to view your invoices. It works once and expires in ${input.minutes} minutes.</p>`,
      { label: "Sign in", url: input.url },
    ),
    text: `Use this link to view your invoices. It works once and expires in ${input.minutes} minutes.\n\n${input.url}\n`,
  };
}
