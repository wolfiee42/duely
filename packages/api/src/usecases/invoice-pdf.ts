import { withTenant, type Db } from "@repo/db";
import { clients, firms, invoiceItems, invoices } from "@repo/db/schema";
import { DomainError, formatUsd } from "@repo/domain";
import { asc, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

// The standard fonts only cover WinAnsi. Anything else becomes "?" instead of throwing.
const winAnsi = (text: string) =>
  text.replace(/[^\x20-\x7e\xa0-\xff]/g, "?").replace(/[\r\n\t]+/g, " ");

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of winAnsi(text).split(" ")) {
    const attempt = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(attempt, size) <= maxWidth) {
      line = attempt;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

const hexColor = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/**
 * Loads exactly what the PDF shows, scoped by RLS and, for the portal, by `clientId`.
 * Drafts are only available to staff (`includeDraft`).
 */
async function load(
  db: Db,
  tenantId: string,
  invoiceId: string,
  scope: { clientId?: string; includeDraft: boolean },
) {
  return withTenant(db, tenantId, async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    const visible =
      invoice &&
      (!scope.clientId || invoice.clientId === scope.clientId) &&
      (scope.includeDraft || invoice.status !== "draft");
    if (!invoice || !visible)
      throw new DomainError("invoice.not_found", "not_found", "Invoice not found.");
    const [firm] = await tx.select().from(firms).where(eq(firms.id, tenantId));
    const [client] = await tx
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, invoice.clientId));
    const items = await tx
      .select()
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, invoiceId))
      .orderBy(asc(invoiceItems.position));
    return { invoice, firm: firm!, client: client!, items };
  });
}

export async function renderInvoicePdf(
  db: Db,
  tenantId: string,
  invoiceId: string,
  scope: { clientId?: string; includeDraft: boolean },
): Promise<Uint8Array> {
  const { invoice, firm, client, items } = await load(db, tenantId, invoiceId, scope);

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const accent = hexColor(
    /^#[0-9a-fA-F]{6}$/.test(firm.brandPrimary) ? firm.brandPrimary : "#1F4FD8",
  );
  const grey = rgb(0.4, 0.4, 0.4);
  const W = 595;
  const H = 842;
  const M = 48;

  let page = pdf.addPage([W, H]);
  let y = H - M;
  const text = (s: string, x: number, size = 10, f = font, color = rgb(0, 0, 0)) =>
    page.drawText(winAnsi(s), { x, y, size, font: f, color });
  const right = (s: string, xRight: number, size = 10, f = font) => {
    const t = winAnsi(s);
    page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y, size, font: f });
  };

  text(firm.displayName, M, 18, bold, accent);
  right(invoice.status === "draft" ? "DRAFT" : "INVOICE", W - M, 18, bold);
  y -= 26;
  if (firm.legalName !== firm.displayName) {
    text(firm.legalName, M, 9, font, grey);
    y -= 12;
  }
  right(invoice.number ?? "Not yet numbered", W - M, 11, bold);
  y -= 30;

  text("Bill to", M, 9, font, grey);
  right("Issued", W - M - 120, 9, font);
  right(invoice.issueDate ?? "-", W - M, 10);
  y -= 13;
  text(client.name, M, 11, bold);
  right("Due", W - M - 120, 9, font);
  right(invoice.dueDate ?? "-", W - M, 10);
  y -= 34;

  const colQty = 340;
  const colUnit = 430;
  const colAmt = W - M;
  const header = () => {
    page.drawLine({
      start: { x: M, y: y + 14 },
      end: { x: W - M, y: y + 14 },
      thickness: 1,
      color: accent,
    });
    text("Description", M, 9, bold);
    right("Qty", colQty, 9, bold);
    right("Unit price", colUnit, 9, bold);
    right("Amount", colAmt, 9, bold);
    y -= 18;
  };
  header();

  for (const item of items) {
    const lines = wrap(item.description, font, 10, colQty - M - 50);
    if (y - lines.length * 13 < M + 120) {
      page = pdf.addPage([W, H]);
      y = H - M;
      header();
    }
    right(String(Number(item.quantity)), colQty);
    right(formatUsd(item.unitAmountMinor), colUnit);
    right(formatUsd(item.amountMinor), colAmt);
    for (const line of lines) {
      text(line, M);
      y -= 13;
    }
    y -= 4;
  }

  y -= 6;
  page.drawLine({
    start: { x: 330, y: y + 14 },
    end: { x: W - M, y: y + 14 },
    thickness: 0.5,
    color: grey,
  });
  const total = (label: string, amount: string, f = font) => {
    text(label, 330, 10, f);
    right(amount, colAmt, 10, f);
    y -= 16;
  };
  total("Subtotal", formatUsd(invoice.subtotalMinor));
  total("Total", formatUsd(invoice.totalMinor), bold);
  if (invoice.paidMinor > 0) {
    total("Paid", formatUsd(invoice.paidMinor));
    total("Balance due", formatUsd(Math.max(invoice.totalMinor - invoice.paidMinor, 0)), bold);
  }
  if (invoice.notes) {
    y -= 14;
    text("Notes", M, 9, font, grey);
    y -= 13;
    for (const line of wrap(invoice.notes, font, 10, W - 2 * M)) {
      text(line, M);
      y -= 13;
    }
  }

  pdf.setTitle(`Invoice ${invoice.number ?? "draft"}`);
  pdf.setProducer("Duely");
  return pdf.save();
}
