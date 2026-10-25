// A small RFC 4180 reader: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, a BOM.
// Spreadsheet exports are the only input, so this does not guess at other delimiters.

export const MAX_CSV_BYTES = 1_000_000;
export const MAX_CSV_ROWS = 2_000;

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

export function parseCsv(input: string): string[][] {
  if (input.length > MAX_CSV_BYTES)
    throw new CsvError("That file is too large to import (1 MB limit).");
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // Blank lines (a single empty field) are not rows.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") endField();
    else if (c === "\n") endRow();
    else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else field += c;
    i++;
  }
  if (quoted) throw new CsvError("A quoted value is never closed.");
  if (field !== "" || row.length) endRow();
  if (rows.length > MAX_CSV_ROWS + 1)
    throw new CsvError(`Import up to ${MAX_CSV_ROWS} rows at a time.`);
  return rows;
}

/** Writes rows back out, quoting where needed. Used for the downloadable templates. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return `${rows.map((r) => r.map(cell).join(",")).join("\n")}\n`;
}

/** Dollars as typed in a spreadsheet (`1200`, `$1,200.50`) to cents; `null` if it is not a plain amount. */
export function parseMoney(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, "").replaceAll(",", "").trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}

/** `2026-07-01` or US `7/1/2026` to ISO; `null` if it is neither or not a real date. */
export function parseCsvDate(input: string): string | null {
  const s = input.trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [y, mo, d] = [+m[3]!, +m[1]!, +m[2]!];
  else return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
