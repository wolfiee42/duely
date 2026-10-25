import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createHarness, type Harness } from "../testing";

let h: Harness;
let acme: string;
let globex: string;
const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];

const run = (
  kind: "clients" | "invoices",
  csv: string,
  mapping: Record<string, string>,
  dryRun: boolean,
  cookie = acme,
) => h.staff("imports.run", { cookie, body: { kind, csv, mapping, dryRun } });

const CLIENTS = `name,email,contact name,reference
Initech,bill@initech.test,Bill Lumbergh,C-1
Globex Corp,hank@globex.test,Hank,C-2
,nobody@x.test,No Name,C-3
Bad Email,not-an-email,,C-4
"Quoted, Inc.",quoted@x.test,"Q ""The Boss""",C-5
`;
const clientMap = {
  name: "name",
  email: "email",
  contactName: "contact name",
  externalRef: "reference",
};

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
}, 60_000);
afterAll(() => h?.close());

describe("import setup (P6-03)", () => {
  it("guesses the column mapping from the headers, and offers a template", async () => {
    const res = await h.staff("imports.inspect", {
      cookie: acme,
      body: { kind: "clients", csv: CLIENTS },
    });
    expect(res.data.suggested).toEqual({
      name: "name",
      email: "email",
      contactName: "contact name",
      externalRef: "reference",
    });
    expect(res.data.rowCount).toBe(5);
    expect(res.data.sample).toHaveLength(5);
    const fields = await h.staff("imports.fields", { cookie: acme, input: { kind: "invoices" } });
    expect(fields.data.template.split("\n")[0]).toBe(
      "client,invoice,due date,description,quantity,unit price",
    );
    expect(
      fields.data.fields.filter((f: { required: boolean }) => f.required).length,
    ).toBeGreaterThan(2);
  });

  it("rejects an empty or broken file", async () => {
    expect(
      (
        await h.staff("imports.inspect", {
          cookie: acme,
          body: { kind: "clients", csv: 'a\n"oops' },
        })
      ).domainCode,
    ).toBe("import.bad_csv");
    expect((await run("clients", "name,email\n", clientMap, true)).domainCode).toBe("import.empty");
  });

  it("insists every required field is mapped to a real column", async () => {
    expect((await run("clients", CLIENTS, { name: "name" }, true)).domainCode).toBe(
      "import.unmapped",
    );
    expect((await run("clients", CLIENTS, { ...clientMap, email: "nope" }, true)).domainCode).toBe(
      "import.unmapped",
    );
  });
});

describe("importing clients", () => {
  it("a dry run reports every row's fate and writes nothing", async () => {
    const res = await run("clients", CLIENTS, clientMap, true);
    expect(res.data).toMatchObject({ dryRun: true, total: 5, created: 3, duplicates: [] });
    expect(res.data.invalid).toEqual([
      { row: 4, reason: "Client name is empty." },
      { row: 5, reason: '"not-an-email" is not an email address.' },
    ]);
    expect(await q(`select 1 from clients`)).toHaveLength(0);
  });

  it("imports the valid rows and says what it skipped", async () => {
    const res = await run("clients", CLIENTS, clientMap, false);
    expect(res.data).toMatchObject({ dryRun: false, created: 3 });
    expect(res.data.invalid).toHaveLength(2);
    const rows = await q<{ name: string; external_ref: string; email: string; contact: string }>(
      `select c.name, c.external_ref, k.email, k.name contact from clients c join contacts k on k.client_id = c.id order by c.name`,
    );
    expect(rows).toEqual([
      { name: "Globex Corp", external_ref: "c-2", email: "hank@globex.test", contact: "Hank" },
      {
        name: "Initech",
        external_ref: "c-1",
        email: "bill@initech.test",
        contact: "Bill Lumbergh",
      },
      {
        name: "Quoted, Inc.",
        external_ref: "c-5",
        email: "quoted@x.test",
        contact: 'Q "The Boss"',
      },
    ]);
  });

  it("running the same file again creates nothing new", async () => {
    const again = await run("clients", CLIENTS, clientMap, false);
    expect(again.data.created).toBe(0);
    expect(again.data.duplicates.map((d: { row: number }) => d.row)).toEqual([2, 3, 6]);
    expect(await q(`select 1 from clients`)).toHaveLength(3);
  });

  it("catches a repeated row inside one file", async () => {
    const csv = "name,email\nDupe Co,dupe@x.test\nDupe Co again,dupe@x.test\n";
    const res = await run("clients", csv, { name: "name", email: "email" }, false);
    expect(res.data).toMatchObject({ created: 1 });
    expect(res.data.duplicates).toEqual([{ row: 3, reason: "Already imported." }]);
  });

  it("keeps each firm's imports to itself", async () => {
    const res = await run("clients", CLIENTS, clientMap, false, globex);
    expect(res.data.created).toBe(3); // globex does not see acme's references
    expect((await q(`select 1 from clients`)).length).toBe(7);
  });
});

describe("importing invoices", () => {
  const INVOICES = `client,invoice,due date,description,quantity,unit price
bill@initech.test,INV-2001,2026-07-15,Consulting,10,150.00
bill@initech.test,INV-2001,2026-07-15,Hosting,1,"$200.00"
Globex Corp,INV-2002,7/20/2026,Support,,99.50
nobody@nowhere.test,INV-2003,2026-07-15,Work,1,10
bill@initech.test,INV-2004,tomorrow,Work,1,10
bill@initech.test,INV-2005,2026-07-15,Good line,1,10
bill@initech.test,INV-2005,2026-07-15,Bad line,x,10
`;
  const map = {
    client: "client",
    externalRef: "invoice",
    dueDate: "due date",
    description: "description",
    quantity: "quantity",
    unitPrice: "unit price",
  };

  it("groups lines into invoices and reports the ones it cannot create", async () => {
    const res = await run("invoices", INVOICES, map, true);
    expect(res.data).toMatchObject({ dryRun: true, total: 7, created: 2 });
    const reasons = Object.fromEntries(
      res.data.invalid.map((i: { row: number; reason: string }) => [i.row, i.reason]),
    );
    expect(reasons[5]).toMatch(/No client matches/);
    expect(reasons[6]).toMatch(/not a date/);
    expect(reasons[8]).toMatch(/not a valid quantity/);
    expect(
      res.data.invalid.some((i: { reason: string }) => /INV-2005 was skipped/.test(i.reason)),
    ).toBe(true);
    expect(await q(`select 1 from invoices`)).toHaveLength(0);
  });

  it("creates drafts only, with the right totals, due dates and provenance", async () => {
    const res = await run("invoices", INVOICES, map, false);
    expect(res.data.created).toBe(2);
    const rows = await q<{
      external_ref: string;
      status: string;
      source: string;
      total_minor: string;
      due_date: string;
      number: string | null;
    }>(
      `select external_ref, status, source, total_minor, due_date::text, number from invoices order by external_ref`,
    );
    expect(rows).toEqual([
      {
        external_ref: "INV-2001",
        status: "draft",
        source: "csv_import",
        total_minor: "170000",
        due_date: "2026-07-15",
        number: null,
      },
      {
        external_ref: "INV-2002",
        status: "draft",
        source: "csv_import",
        total_minor: "9950",
        due_date: "2026-07-20",
        number: null,
      },
    ]);
    expect(await q(`select 1 from invoice_items`)).toHaveLength(3);
    // Nothing is emailed by an import.
    expect(await q(`select 1 from messages where kind = 'invoice'`)).toHaveLength(0);
  });

  it("re-running it does not duplicate invoices", async () => {
    const res = await run("invoices", INVOICES, map, false);
    expect(res.data.created).toBe(0);
    expect(res.data.duplicates).toHaveLength(2);
    expect(await q(`select 1 from invoices`)).toHaveLength(2);
  });

  it("will not link to another firm's client", async () => {
    const res = await run(
      "invoices",
      "client,invoice,description,unit price\ndupe@x.test,X-1,Work,10\n",
      {
        client: "client",
        externalRef: "invoice",
        description: "description",
        unitPrice: "unit price",
      },
      true,
      globex,
    );
    expect(res.data.invalid[0].reason).toMatch(/No client matches/);
  });

  it("asks for a more specific client when a name is ambiguous", async () => {
    await run(
      "clients",
      "name,email\nTwin,one@twin.test\nTwin,two@twin.test\n",
      { name: "name", email: "email" },
      false,
    );
    const res = await run(
      "invoices",
      "client,invoice,description,unit price\nTwin,T-1,Work,10\n",
      {
        client: "client",
        externalRef: "invoice",
        description: "description",
        unitPrice: "unit price",
      },
      true,
    );
    expect(res.data.invalid[0].reason).toMatch(/More than one client/);
  });
});
