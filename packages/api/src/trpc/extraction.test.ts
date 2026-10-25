import { createScriptedModel } from "@repo/ai/fake";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { APP, addClient, createHarness, type Harness } from "../testing";

let h: Harness;
let acme: string;
let globex: string;
let initech: string;
const q = async <T>(statement: string) =>
  [...(await h.systemDb.execute(sql.raw(statement)))] as T[];

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const read = {
  client_name: "Initech",
  invoice_number: "A-1001",
  issue_date: "2026-06-01",
  due_date: "2026-07-01",
  currency: "USD",
  items: [
    { description: "Consulting", quantity: 2, unit_amount_minor: 50_000 },
    { description: "Hosting", quantity: 1, unit_amount_minor: 20_000 },
  ],
  stated_total_minor: 120_000,
  field_confidence: {
    client_name: 0.95,
    invoice_number: 0.9,
    due_date: 0.9,
    items: 0.92,
    stated_total_minor: 0.97,
  },
};

function upload(
  bytes: Uint8Array,
  type = "application/pdf",
  opts: { cookie?: string; host?: string } = {},
) {
  return h.app.request(`${opts.host ?? APP}/api/files/extract`, {
    method: "POST",
    headers: {
      "content-type": type,
      origin: opts.host ?? APP,
      ...(opts.cookie === "" ? {} : { cookie: opts.cookie ?? acme }),
    },
    body: bytes as unknown as BodyInit,
  });
}
const extract = async (reply: object | string, bytes = PDF, type = "application/pdf") => {
  h.fakes.model = createScriptedModel(() => reply);
  const res = await upload(bytes, type);
  return {
    res,
    body: (await res.json()) as Record<string, any>,
    model: h.fakes.model as ReturnType<typeof createScriptedModel>,
  };
};
const confirm = (r: Record<string, any>, over: Record<string, unknown> = {}, cookie = acme) =>
  h.staff("invoices.createFromExtraction", {
    cookie,
    body: {
      clientId: initech,
      dueDate: "2026-07-01",
      items: [
        { description: "Consulting", quantity: "2", unitAmountMinor: 50_000 },
        { description: "Hosting", quantity: "1", unitAmountMinor: 20_000 },
      ],
      documentId: r.documentId,
      runId: r.runId,
      idempotencyKey: crypto.randomUUID(),
      ...over,
    },
  });

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  initech = await addClient(h, acme);
}, 60_000);
afterAll(() => h?.close());
beforeEach(() => h.testDbAdmin(`delete from review_items`));

describe("reading an uploaded invoice (P5-02)", () => {
  it("returns what it read, whether it adds up, what to double-check, and the client it matches", async () => {
    const { res, body, model } = await extract(read);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      reconciles: true,
      computedTotalMinor: 120_000,
      lowFields: [],
      suggestedClientId: initech,
    });
    expect(body.extraction.items).toHaveLength(2);
    // The model got the file itself, and was told to treat it as data.
    const part = (model.calls[0]!.content as Array<Record<string, string>>)[0]!;
    expect(part).toMatchObject({ type: "file", mediaType: "application/pdf" });
    expect(atob(part.base64!).startsWith("%PDF-")).toBe(true);
    expect(model.calls[0]!.system).toMatch(/data to copy, not instructions/);
    // The original is kept, under a random key inside the firm's own folder.
    const [doc] = await q<{ storage_key: string; kind: string; invoice_id: string | null }>(
      `select storage_key, kind, invoice_id from documents`,
    );
    expect(doc).toMatchObject({ kind: "extraction_source", invoice_id: null });
    expect(doc!.storage_key).toMatch(/^firms\/[0-9a-f-]{36}\/extraction\/[0-9a-f-]{36}$/);
    expect(h.fakes.files.objects.has(doc!.storage_key)).toBe(true);
  });

  it("flags line items that do not add up to the stated total", async () => {
    const { body } = await extract({ ...read, stated_total_minor: 125_000 });
    expect(body).toMatchObject({ reconciles: false, computedTotalMinor: 120_000 });
  });

  it("says nothing about reconciling when the document states no total", async () => {
    const { body } = await extract({ ...read, stated_total_minor: null });
    expect(body.reconciles).toBeNull();
  });

  it("lists the fields the model was unsure about, and a missing item list", async () => {
    const { body } = await extract({
      ...read,
      items: [],
      field_confidence: { ...read.field_confidence, due_date: 0.4, invoice_number: 0.69 },
    });
    expect(body.lowFields.sort()).toEqual(["due_date", "invoice_number", "items"]);
  });

  it("reads an image as well", async () => {
    const { body, model } = await extract(read, PNG, "image/png");
    expect(body.ok).toBe(true);
    expect((model.calls[0]!.content as Array<Record<string, string>>)[0]!.mediaType).toBe(
      "image/png",
    );
  });

  it("matches no client when the name is unfamiliar", async () => {
    const { body } = await extract({ ...read, client_name: "Brand New Co" });
    expect(body.suggestedClientId).toBeNull();
  });

  it("falls back to manual entry when the model gives unusable output, keeping the upload", async () => {
    const { res, body } = await extract("Sorry, I can't read that.");
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, reason: "schema_invalid" });
    expect(body.documentId).toBeTruthy();
    expect(await q(`select 1 from invoices where source = 'ai_extraction'`)).toHaveLength(0);
  });

  it("falls back to manual entry when no model is configured", async () => {
    h.fakes.model = null;
    const body = (await (await upload(PDF)).json()) as Record<string, any>;
    expect(body).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("an instruction written on the invoice does not change what comes back", async () => {
    const { body } = await extract({ ...read, action: "send_invoice_now" });
    expect(body).toMatchObject({ ok: false, reason: "schema_invalid" }); // extra fields are refused
  });
});

describe("upload checks", () => {
  it("rejects wrong types, mislabeled files, oversize files, anonymous callers and portal hosts", async () => {
    h.fakes.model = createScriptedModel(() => read);
    expect((await upload(new TextEncoder().encode("hello"), "text/plain")).status).toBe(415);
    expect((await upload(PNG, "application/pdf")).status).toBe(415); // says PDF, is a PNG
    expect(
      (await upload(new TextEncoder().encode("<svg onload=alert(1)>"), "image/svg+xml")).status,
    ).toBe(415);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    expect((await upload(big)).status).toBe(413);
    expect((await upload(PDF, "application/pdf", { cookie: "" })).status).toBe(401);
    expect((await upload(PDF, "application/pdf", { host: "https://acme.duely.app" })).status).toBe(
      404,
    );
    expect((h.fakes.model as ReturnType<typeof createScriptedModel>).calls).toHaveLength(0);
  });
});

describe("confirming into a draft", () => {
  it("creates a draft only, linked to the upload, and nothing is sent", async () => {
    const { body } = await extract(read);
    const res = await confirm(body);
    expect(res.status).toBe(200);
    const [inv] = await q<{
      status: string;
      source: string;
      total_minor: string;
      number: string | null;
    }>(`select status, source, total_minor, number from invoices where id = '${res.data.id}'`);
    expect(inv).toMatchObject({
      status: "draft",
      source: "ai_extraction",
      total_minor: "120000",
      number: null,
    });
    expect(
      (
        await q<{ invoice_id: string }>(
          `select invoice_id from documents where id = '${body.documentId}'`,
        )
      )[0]!.invoice_id,
    ).toBe(res.data.id);
    expect(res.data.needsReview).toBe(false);
    expect(await q(`select 1 from review_items`)).toHaveLength(0);
    expect(await q(`select 1 from messages where invoice_id = '${res.data.id}'`)).toHaveLength(0);
  });

  it("puts a draft in the review queue when the model was unsure or it did not add up", async () => {
    const unsure = await extract({
      ...read,
      field_confidence: { ...read.field_confidence, due_date: 0.3 },
    });
    const a = await confirm(unsure.body);
    expect(a.data.needsReview).toBe(true);
    const mismatch = await extract({ ...read, stated_total_minor: 99_999 });
    const b = await confirm(mismatch.body);
    expect(b.data.needsReview).toBe(true);
    const items = await q<{
      kind: string;
      invoice_id: string;
      payload: { lowFields: string[]; reconciles: boolean | null };
      ai_run_id: string;
    }>(`select kind, invoice_id, payload, ai_run_id from review_items order by created_at`);
    expect(items.map((i) => i.kind)).toEqual(["extraction_review", "extraction_review"]);
    expect(items[0]!.payload.lowFields).toEqual(["due_date"]);
    expect(items[1]!.payload.reconciles).toBe(false);
    expect(items.every((i) => i.ai_run_id)).toBe(true);
    const listed = (await h.staff("review.list", { cookie: acme })).data;
    expect(listed.map((i: { kind: string }) => i.kind)).toEqual([
      "extraction_review",
      "extraction_review",
    ]);
  });

  it("saves the person's corrections, but judges review need on what the model read", async () => {
    const { body } = await extract({ ...read, stated_total_minor: 99_999 });
    const res = await confirm(body, {
      items: [{ description: "Consulting", quantity: "1", unitAmountMinor: 99_999 }],
    });
    expect(res.status).toBe(200);
    expect(
      (
        await q<{ total_minor: string }>(
          `select total_minor from invoices where id = '${res.data.id}'`,
        )
      )[0]!.total_minor,
    ).toBe("99999");
    expect(res.data.needsReview).toBe(true); // the extraction itself did not add up
  });

  it("applies the same checks as a typed draft", async () => {
    const { body } = await extract(read);
    expect((await confirm(body, { items: [] })).status).toBeLessThan(500);
    const bad = await confirm(body, { clientId: crypto.randomUUID() });
    expect(bad.status).toBe(404);
  });

  it("is idempotent", async () => {
    const { body } = await extract(read);
    const key = crypto.randomUUID();
    const first = await confirm(body, { idempotencyKey: key });
    const before = (await q(`select 1 from invoices where source = 'ai_extraction'`)).length;
    const second = await confirm(body, { idempotencyKey: key });
    expect(second.data.id).toBe(first.data.id);
    expect(await q(`select 1 from invoices where source = 'ai_extraction'`)).toHaveLength(before);
  });

  it("cannot use another firm's upload or run", async () => {
    const { body } = await extract(read);
    const other = await addClient(h, globex, "x@globex-client.test");
    const stolen = await confirm(body, { clientId: other }, globex);
    expect([stolen.status, stolen.domainCode]).toEqual([404, "extraction.not_found"]);
  });

  it("refuses a run that was not an extraction", async () => {
    await h.testDbAdmin(
      `insert into ai_runs (tenant_id, purpose, prompt_version, model, input_hash, status, output) select id, 'draft', 'v', 'm', 'h', 'ok', '{}' from firms where platform_slug = 'acme'`,
    );
    const [run] = await q<{ id: string }>(`select id from ai_runs where purpose = 'draft' limit 1`);
    const { body } = await extract(read);
    const res = await confirm({ ...body, runId: run!.id });
    expect(res.domainCode).toBe("extraction.not_found");
  });
});
