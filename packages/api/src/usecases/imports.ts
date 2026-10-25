import { withTenant, type Db } from "@repo/db";
import { clients, contacts, invoices } from "@repo/db/schema";
import {
  CsvError,
  DomainError,
  parseCsv,
  parseCsvDate,
  parseMoney,
  parseQuantity,
  toCsv,
} from "@repo/domain";
import { and, eq, isNotNull } from "drizzle-orm";

import type { Actor } from "./audit";
import { createClient } from "./clients";
import { createDraft } from "./invoices";

// FR-13: bring clients and open invoices in from a spreadsheet. Every run can be a dry run that writes nothing
// and reports each bad row with its reason. Re-running a file never duplicates (idempotent by reference).

export type ImportKind = "clients" | "invoices";

export const FIELDS: Record<
  ImportKind,
  Array<{ key: string; label: string; required: boolean; hints: string[] }>
> = {
  clients: [
    {
      key: "name",
      label: "Client name",
      required: true,
      hints: ["name", "client", "company", "customer"],
    },
    {
      key: "email",
      label: "Contact email",
      required: true,
      hints: ["email", "e-mail", "contact email"],
    },
    {
      key: "contactName",
      label: "Contact name",
      required: false,
      hints: ["contact name", "contact", "person"],
    },
    {
      key: "externalRef",
      label: "Your reference",
      required: false,
      hints: ["reference", "ref", "id", "external"],
    },
  ],
  invoices: [
    {
      key: "client",
      label: "Client (name or email)",
      required: true,
      hints: ["client", "customer", "email", "name"],
    },
    {
      key: "externalRef",
      label: "Invoice reference",
      required: true,
      hints: ["invoice", "reference", "ref", "number", "id"],
    },
    { key: "dueDate", label: "Due date", required: false, hints: ["due", "due date"] },
    {
      key: "description",
      label: "Line description",
      required: true,
      hints: ["description", "item", "line"],
    },
    { key: "quantity", label: "Quantity", required: false, hints: ["quantity", "qty"] },
    {
      key: "unitPrice",
      label: "Unit price ($)",
      required: true,
      hints: ["price", "unit price", "rate", "amount"],
    },
  ],
};

export const TEMPLATES: Record<ImportKind, string> = {
  clients: toCsv([
    ["name", "email", "contact name", "reference"],
    ["Initech", "bill@initech.example", "Bill Lumbergh", "C-001"],
  ]),
  invoices: toCsv([
    ["client", "invoice", "due date", "description", "quantity", "unit price"],
    ["bill@initech.example", "INV-2001", "2026-07-15", "Consulting", "10", "150.00"],
    ["bill@initech.example", "INV-2001", "2026-07-15", "Hosting", "1", "200.00"],
  ]),
};

/** Reads the header row and guesses which column is which, so the mapping step starts filled in. */
export function inspectCsv(kind: ImportKind, csv: string) {
  const rows = parseCsv(csv);
  const headers = rows[0] ?? [];
  const lower = headers.map((h) => h.trim().toLowerCase());
  const taken = new Set<number>();
  const suggested: Record<string, string> = {};
  for (const f of FIELDS[kind]) {
    const exact = lower.findIndex((h, i) => !taken.has(i) && f.hints.includes(h));
    const partial =
      exact >= 0
        ? exact
        : lower.findIndex((h, i) => !taken.has(i) && f.hints.some((x) => h.includes(x)));
    if (partial >= 0) {
      taken.add(partial);
      suggested[f.key] = headers[partial]!;
    }
  }
  return { headers, suggested, sample: rows.slice(1, 6), rowCount: Math.max(0, rows.length - 1) };
}

export interface RowIssue {
  /** The row's number as a spreadsheet shows it (the header is row 1). */
  row: number;
  reason: string;
}

export interface ImportReport {
  dryRun: boolean;
  total: number;
  /** Rows (or invoices, for the invoice import) that were or would be created. */
  created: number;
  /** Already imported earlier, or repeated in this file. */
  duplicates: RowIssue[];
  invalid: RowIssue[];
}

interface Table {
  headers: string[];
  rows: Array<{ row: number; cells: string[] }>;
}

function readTable(csv: string): Table {
  const all = parseCsv(csv);
  if (all.length < 2)
    throw new DomainError("import.empty", "validation", "The file has no data rows.");
  return { headers: all[0]!, rows: all.slice(1).map((cells, i) => ({ row: i + 2, cells })) };
}

function columnOf(table: Table, kind: ImportKind, mapping: Record<string, string>) {
  const index: Record<string, number> = {};
  for (const f of FIELDS[kind]) {
    const header = mapping[f.key];
    if (!header) {
      if (f.required)
        throw new DomainError("import.unmapped", "validation", `Choose a column for "${f.label}".`);
      continue;
    }
    const at = table.headers.indexOf(header);
    if (at < 0)
      throw new DomainError(
        "import.unmapped",
        "validation",
        `There is no column called "${header}".`,
      );
    index[f.key] = at;
  }
  return index;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function runImport(
  db: Db,
  actor: Actor,
  input: { kind: ImportKind; csv: string; mapping: Record<string, string>; dryRun: boolean },
): Promise<ImportReport> {
  let table: Table;
  try {
    table = readTable(input.csv);
  } catch (error) {
    if (error instanceof CsvError)
      throw new DomainError("import.bad_csv", "validation", error.message);
    throw error;
  }
  const col = columnOf(table, input.kind, input.mapping);
  return input.kind === "clients"
    ? importClients(db, actor, table, col, input.dryRun)
    : importInvoices(db, actor, table, col, input.dryRun);
}

const cell = (cells: string[], col: Record<string, number>, key: string) =>
  key in col ? (cells[col[key]!] ?? "").trim() : "";

async function importClients(
  db: Db,
  actor: Actor,
  table: Table,
  col: Record<string, number>,
  dryRun: boolean,
) {
  const report: ImportReport = {
    dryRun,
    total: table.rows.length,
    created: 0,
    duplicates: [],
    invalid: [],
  };
  const existing = await withTenant(db, actor.tenantId, (tx) =>
    tx.select({ ref: clients.externalRef }).from(clients).where(isNotNull(clients.externalRef)),
  );
  const seen = new Set(existing.map((e) => e.ref!.toLowerCase()));
  const todo: Array<{
    row: number;
    name: string;
    email: string;
    contactName: string;
    ref: string;
  }> = [];

  for (const { row, cells } of table.rows) {
    const name = cell(cells, col, "name");
    const email = cell(cells, col, "email").toLowerCase();
    if (!name) {
      report.invalid.push({ row, reason: "Client name is empty." });
      continue;
    }
    if (!EMAIL.test(email)) {
      report.invalid.push({ row, reason: `"${email || "(empty)"}" is not an email address.` });
      continue;
    }
    // With no reference column, the contact's email identifies the row.
    const ref = (cell(cells, col, "externalRef") || email).toLowerCase();
    if (seen.has(ref)) {
      report.duplicates.push({ row, reason: "Already imported." });
      continue;
    }
    seen.add(ref);
    todo.push({ row, name, email, contactName: cell(cells, col, "contactName") || name, ref });
  }

  report.created = todo.length;
  if (dryRun) return report;
  report.created = 0;
  for (const t of todo) {
    try {
      await createClient(
        db,
        actor,
        { name: t.name, externalRef: t.ref },
        { name: t.contactName, email: t.email },
      );
      report.created++;
    } catch (error) {
      if (error instanceof DomainError) report.invalid.push({ row: t.row, reason: error.message });
      else throw error;
    }
  }
  return report;
}

async function importInvoices(
  db: Db,
  actor: Actor,
  table: Table,
  col: Record<string, number>,
  dryRun: boolean,
) {
  const report: ImportReport = {
    dryRun,
    total: table.rows.length,
    created: 0,
    duplicates: [],
    invalid: [],
  };

  const { known, existingRefs } = await withTenant(db, actor.tenantId, async (tx) => {
    const byClient = await tx
      .select({ id: clients.id, name: clients.name, email: contacts.email })
      .from(clients)
      .leftJoin(contacts, eq(contacts.clientId, clients.id));
    const refs = await tx
      .select({ ref: invoices.externalRef })
      .from(invoices)
      .where(and(isNotNull(invoices.externalRef), eq(invoices.source, "csv_import")));
    return { known: byClient, existingRefs: new Set(refs.map((r) => r.ref!.toLowerCase())) };
  });
  const clientFor = (text: string) => {
    const t = text.toLowerCase();
    const hits = new Set(
      known.filter((k) => k.email === t || k.name.toLowerCase() === t).map((k) => k.id),
    );
    return hits.size === 1 ? [...hits][0]! : hits.size > 1 ? ("ambiguous" as const) : null;
  };

  interface Group {
    ref: string;
    firstRow: number;
    clientId: string;
    clientText: string;
    dueDate: string | null;
    items: Array<{ description: string; quantity: string; unitAmountMinor: number }>;
    bad: boolean;
  }
  const groups = new Map<string, Group>();

  for (const { row, cells } of table.rows) {
    const ref = cell(cells, col, "externalRef");
    const reasons: string[] = [];
    if (!ref) reasons.push("Invoice reference is empty.");
    const clientText = cell(cells, col, "client");
    const clientId = clientFor(clientText);
    if (!clientText) reasons.push("Client is empty.");
    else if (clientId === null)
      reasons.push(`No client matches "${clientText}". Import the client first.`);
    else if (clientId === "ambiguous")
      reasons.push(`More than one client matches "${clientText}". Use their email.`);
    const description = cell(cells, col, "description");
    if (!description) reasons.push("Line description is empty.");
    const qtyText = cell(cells, col, "quantity") || "1";
    if (!parseQuantity(qtyText)) reasons.push(`"${qtyText}" is not a valid quantity.`);
    const unit = parseMoney(cell(cells, col, "unitPrice"));
    if (unit === null) reasons.push(`"${cell(cells, col, "unitPrice")}" is not a valid price.`);
    const dueText = cell(cells, col, "dueDate");
    const due = dueText ? parseCsvDate(dueText) : null;
    if (dueText && !due) reasons.push(`"${dueText}" is not a date (use 2026-07-15 or 7/15/2026).`);

    if (reasons.length) {
      report.invalid.push({ row, reason: reasons.join(" ") });
      const earlier = ref ? groups.get(ref.toLowerCase()) : undefined;
      if (earlier) earlier.bad = true;
      continue;
    }
    const key = ref.toLowerCase();
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        ref,
        firstRow: row,
        clientId: clientId as string,
        clientText,
        dueDate: due,
        items: [{ description, quantity: qtyText, unitAmountMinor: unit! }],
        bad: false,
      });
    } else if (group.clientId !== clientId) {
      report.invalid.push({ row, reason: `Invoice ${ref} lists a different client on this line.` });
      group.bad = true;
    } else {
      group.items.push({ description, quantity: qtyText, unitAmountMinor: unit! });
    }
  }

  const todo: Group[] = [];
  for (const g of groups.values()) {
    // One bad line makes the whole invoice unsafe to create: a half-imported invoice has the wrong total.
    if (g.bad) {
      report.invalid.push({
        row: g.firstRow,
        reason: `Invoice ${g.ref} was skipped because one of its lines has a problem.`,
      });
    } else if (existingRefs.has(g.ref.toLowerCase())) {
      report.duplicates.push({ row: g.firstRow, reason: `Invoice ${g.ref} was already imported.` });
    } else todo.push(g);
  }

  report.created = todo.length;
  if (dryRun) return report;
  report.created = 0;
  for (const g of todo) {
    try {
      await createDraft(
        db,
        actor,
        { clientId: g.clientId, dueDate: g.dueDate, items: g.items },
        { source: "csv_import", externalRef: g.ref },
      );
      report.created++;
    } catch (error) {
      // A concurrent run created it first, or a value the database refused: report it, keep going.
      report.invalid.push({
        row: g.firstRow,
        reason:
          error instanceof DomainError ? error.message : `Invoice ${g.ref} could not be created.`,
      });
    }
  }
  return report;
}
