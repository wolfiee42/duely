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

export interface ReminderInput {
  clientName: string;
  number: string;
  amountDueMinor: number;
  dueDate: string;
  /** Negative before the due date, positive after. */
  daysFromDue: number;
  templateKey: "pre_due" | "due" | "overdue" | "final";
  tone: "friendly" | "neutral" | "firm";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Where the invoice link goes in a stored reminder body; filled in when the email is sent. */
export const PORTAL_URL_TOKEN = "{{portal_url}}";

/**
 * The editable part of a reminder: a subject and a plain-text body for one policy step. The body holds
 * `{{portal_url}}` where the pay link goes. Reviewers can change the text before it is sent (FR-9.12).
 */
export function reminderDraft(input: ReminderInput): { subject: string; body: string } {
  const amount = formatUsd(input.amountDueMinor);
  const days = Math.abs(input.daysFromDue);
  const when =
    input.daysFromDue < 0
      ? `due in ${plural(days, "day")} (${input.dueDate})`
      : input.daysFromDue === 0
        ? `due today (${input.dueDate})`
        : `${plural(days, "day")} past due (due ${input.dueDate})`;

  const subject =
    input.templateKey === "final"
      ? `Final reminder: invoice ${input.number}`
      : input.templateKey === "overdue"
        ? `Invoice ${input.number} is past due`
        : input.templateKey === "due"
          ? `Invoice ${input.number} is due today`
          : `Invoice ${input.number} is due soon`;

  const lead = {
    friendly: "Just a friendly reminder that",
    neutral: "This is a reminder that",
    firm: "Our records show that",
  }[input.tone];
  const close = {
    friendly:
      "If you've already paid, thank you, and please ignore this note. Reply to this email if anything is unclear.",
    neutral:
      "If you've already paid, thank you. Reply to this email if you have a question or need to arrange a payment date.",
    firm: "Please pay as soon as you can. If there is a problem with this invoice, reply to this email so we can sort it out.",
  }[input.tone];

  return {
    subject,
    body: `Hello ${input.clientName},\n\n${lead} invoice ${input.number} for ${amount} is ${when}.\n\n${close}\n\nView and pay: ${PORTAL_URL_TOKEN}`,
  };
}

/** Turns a stored reminder (possibly edited by a person) into the email that is sent. Everything is escaped. */
export function renderReminder(
  input: Brand & { subject: string; body: string; portalUrl: string; unsubscribeUrl: string },
): Rendered {
  const text = input.body.replaceAll(PORTAL_URL_TOKEN, input.portalUrl);
  const paragraphs = input.body
    .split(/\n{2,}/)
    .filter((p) => !p.includes(PORTAL_URL_TOKEN))
    .map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`)
    .join("");
  const note = "Don't want these reminders?";
  return {
    subject: input.subject,
    html: layout(input, input.subject, paragraphs, {
      label: "View and pay",
      url: input.portalUrl,
    }).replace(
      "</body>",
      `<p style="color:#666;font-size:12px">${note} <a href="${safeUrl(input.unsubscribeUrl)}">Stop reminders</a></p></body>`,
    ),
    text: `${text}\n\n${note} ${input.unsubscribeUrl}\n`,
  };
}
