import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createDb, withTenant, type Db, type Tx } from "./index";
import { clients, firms, invoiceItems, invoices, payments, refunds, stripeEvents } from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let testDb: TestDatabase;
let app: Db;
let system: Db;
const closers: Array<() => Promise<unknown>> = [];

async function pgError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { message: string; cause?: { message: string } };
    return e.cause?.message ?? e.message;
  }
  return null;
}

async function newInvoice(tx: Tx, tenantId: string, status: "draft" | "sent" = "draft") {
  const [client] = await tx
    .insert(clients)
    .values({ tenantId, name: "Initech" })
    .returning({ id: clients.id });
  const [invoice] = await tx
    .insert(invoices)
    .values({ tenantId, clientId: client!.id, status: "draft", totalMinor: 5000 })
    .returning({ id: invoices.id });
  await tx.insert(invoiceItems).values({
    tenantId,
    invoiceId: invoice!.id,
    position: 1,
    description: "Consulting",
    quantity: "1.000",
    unitAmountMinor: 5000,
    amountMinor: 5000,
  });
  if (status === "sent")
    await tx
      .update(invoices)
      .set({ status: "sent" })
      .where(sql`id = ${invoice!.id}`);
  return invoice!.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const a = createDb(testDb.appUrl, { max: 4 });
  const s = createDb(testDb.systemUrl);
  app = a.db;
  system = s.db;
  closers.push(a.close, s.close);
  for (const [id, slug] of [
    [A, "acme"],
    [B, "globex"],
  ] as const) {
    await withTenant(app, id, (tx) =>
      tx.insert(firms).values({ id, platformSlug: slug, legalName: slug, displayName: slug }),
    );
  }
}, 60_000);

afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
  await testDb?.drop();
});

describe("invoices across tenants", () => {
  it("a tenant cannot see, update or attach to another tenant's invoices", async () => {
    const invoiceA = await withTenant(app, A, (tx) => newInvoice(tx, A));
    const seenByB = await withTenant(app, B, async (tx) => ({
      invoices: await tx.select().from(invoices),
      items: await tx.select().from(invoiceItems),
      updated: await tx.execute(
        sql`update invoices set notes = 'x' where id = ${invoiceA} returning id`,
      ),
    }));
    expect(seenByB.invoices).toEqual([]);
    expect(seenByB.items).toEqual([]);
    expect(seenByB.updated.length).toBe(0);

    const message = await pgError(
      withTenant(app, B, (tx) =>
        tx.insert(invoiceItems).values({
          tenantId: B,
          invoiceId: invoiceA,
          position: 2,
          description: "sneaky",
          quantity: "1",
          unitAmountMinor: 1,
          amountMinor: 1,
        }),
      ),
    );
    // FK checks bypass RLS, so only the composite (tenant_id, invoice_id) key stops this.
    expect(message).toMatch(/invoice_items_tenant_id_invoice_id_invoices_tenant_id_id_fkey/);
  });
});

describe("invoice items lock (SPEC 2.3)", () => {
  it("items are editable on a draft and frozen after send", async () => {
    const id = await withTenant(app, A, (tx) => newInvoice(tx, A));
    await withTenant(app, A, (tx) =>
      tx.execute(sql`update invoice_items set description = 'edited' where invoice_id = ${id}`),
    );
    await withTenant(app, A, (tx) =>
      tx
        .update(invoices)
        .set({ status: "sent" })
        .where(sql`id = ${id}`),
    );

    for (const statement of [
      sql`update invoice_items set description = 'x' where invoice_id = ${id}`,
      sql`delete from invoice_items where invoice_id = ${id}`,
      sql`insert into invoice_items (tenant_id, invoice_id, position, description, quantity, unit_amount_minor, amount_minor)
          values (${A}, ${id}, 9, 'late', 1, 1, 1)`,
    ]) {
      expect(await pgError(withTenant(app, A, (tx) => tx.execute(statement)))).toMatch(/frozen/);
    }
  });

  it("deleting a draft removes its items; a sent invoice cannot be deleted", async () => {
    const draft = await withTenant(app, A, (tx) => newInvoice(tx, A));
    await withTenant(app, A, (tx) => tx.execute(sql`delete from invoices where id = ${draft}`));
    const left = await withTenant(app, A, (tx) =>
      tx.execute(sql`select 1 from invoice_items where invoice_id = ${draft}`),
    );
    expect(left.length).toBe(0);

    const sent = await withTenant(app, A, (tx) => newInvoice(tx, A, "sent"));
    expect(
      await pgError(
        withTenant(app, A, (tx) => tx.execute(sql`delete from invoices where id = ${sent}`)),
      ),
    ).toMatch(/only draft invoices/);
  });
});

describe("invoice status graph (SPEC 3.1 backstop)", () => {
  const move = (id: string, status: string) =>
    pgError(
      withTenant(app, A, (tx) =>
        tx.execute(sql`update invoices set status = ${status} where id = ${id}`),
      ),
    );

  it("allows the legal path and rejects illegal jumps", async () => {
    const id = await withTenant(app, A, (tx) => newInvoice(tx, A));
    expect(await move(id, "paid")).toMatch(/invalid invoice transition draft -> paid/);
    expect(await move(id, "sent")).toBeNull();
    expect(await move(id, "draft")).toMatch(/invalid invoice transition/);
    expect(await move(id, "viewed")).toBeNull();
    expect(await move(id, "disputed")).toBeNull();
    expect(await move(id, "promised")).toMatch(/invalid invoice transition disputed -> promised/);
    expect(await move(id, "paid")).toBeNull();
  });

  it("paid and void are terminal", async () => {
    for (const end of ["paid", "void"]) {
      const id = await withTenant(app, A, (tx) => newInvoice(tx, A, "sent"));
      expect(await move(id, end)).toBeNull();
      for (const next of ["sent", "viewed", "overdue", "void", "paid"]) {
        if (next === end) continue;
        expect(await move(id, next)).toMatch(/invalid invoice transition/);
      }
    }
  });

  it("rejects values outside the status set and non-USD currency", async () => {
    const id = await withTenant(app, A, (tx) => newInvoice(tx, A));
    expect(await move(id, "bogus")).toMatch(/invalid invoice transition/); // the graph guard fires first
    expect(
      await pgError(
        withTenant(app, A, (tx) =>
          tx.execute(sql`update invoices set currency = 'EUR' where id = ${id}`),
        ),
      ),
    ).toMatch(/invoices_currency_check/);
  });
});

describe("ledger immutability (SPEC 2.3)", () => {
  async function newPayment(status: "processing" | "succeeded", intent: string) {
    return withTenant(app, A, async (tx) => {
      const invoiceId = await newInvoice(tx, A, "sent");
      const [p] = await tx
        .insert(payments)
        .values({
          tenantId: A,
          invoiceId,
          stripePaymentIntentId: intent,
          method: "card",
          status,
          amountMinor: 5000,
        })
        .returning({ id: payments.id, invoiceId: payments.invoiceId });
      return p!;
    });
  }
  const update = (id: string, set: string) =>
    pgError(
      withTenant(app, A, (tx) =>
        tx.execute(sql.raw(`update payments set ${set} where id = '${id}'`)),
      ),
    );

  it("a processing payment can settle once; then it is final", async () => {
    const p = await newPayment("processing", "pi_1");
    expect(
      await update(p.id, "status = 'succeeded', succeeded_at = now(), stripe_charge_id = 'ch_1'"),
    ).toBeNull();
    expect(await update(p.id, "status = 'failed'")).toMatch(/immutable/);
  });

  it("cannot change the amount, invoice or intent, even while processing", async () => {
    const p = await newPayment("processing", "pi_2");
    expect(await update(p.id, "amount_minor = 1")).toMatch(/permission denied/);
    expect(await update(p.id, "invoice_id = invoice_id")).toMatch(/permission denied/);
    expect(await update(p.id, "stripe_payment_intent_id = 'pi_x'")).toMatch(/permission denied/);
  });

  it("payments and refunds cannot be deleted; duplicate intents and refunds are rejected", async () => {
    const p = await newPayment("succeeded", "pi_3");
    expect(
      await pgError(
        withTenant(app, A, (tx) => tx.execute(sql`delete from payments where id = ${p.id}`)),
      ),
    ).toMatch(/permission denied/);
    const refund = (stripeId: string) =>
      withTenant(app, A, (tx) =>
        tx.insert(refunds).values({
          tenantId: A,
          paymentId: p.id,
          invoiceId: p.invoiceId,
          stripeRefundId: stripeId,
          amountMinor: 100,
        }),
      );
    await refund("re_1");
    expect(await pgError(refund("re_1"))).toMatch(/duplicate key/);
    expect(await pgError(withTenant(app, A, (tx) => tx.execute(sql`delete from refunds`)))).toMatch(
      /permission denied/,
    );
    expect(
      await pgError(
        withTenant(app, A, (tx) => tx.execute(sql`update refunds set amount_minor = 1`)),
      ),
    ).toMatch(/permission denied/);
  });

  it("rejects non-positive amounts and a repeated payment intent", async () => {
    const p = await newPayment("processing", "pi_dup");
    expect(
      await pgError(
        withTenant(app, A, (tx) =>
          tx.insert(payments).values({
            tenantId: A,
            invoiceId: p.invoiceId,
            stripePaymentIntentId: "pi_dup",
            method: "card",
            status: "processing",
            amountMinor: 5000,
          }),
        ),
      ),
    ).toMatch(/duplicate key/);
    expect(
      await pgError(
        withTenant(app, A, (tx) =>
          tx.insert(payments).values({
            tenantId: A,
            invoiceId: p.invoiceId,
            stripePaymentIntentId: "pi_zero",
            method: "card",
            status: "processing",
            amountMinor: 0,
          }),
        ),
      ),
    ).toMatch(/payments_amount_check/);
  });
});

describe("stripe_events", () => {
  it("is invisible and unwritable to the app role, usable by the system role", async () => {
    expect(await pgError(app.select().from(stripeEvents))).toMatch(/permission denied/);
    expect(
      await pgError(app.insert(stripeEvents).values({ id: "evt_app", type: "x", payload: {} })),
    ).toMatch(/permission denied/);

    await system.insert(stripeEvents).values({
      id: "evt_1",
      type: "payment_intent.succeeded",
      stripeAccountId: "acct_1",
      payload: { a: 1 },
    });
    expect(
      await pgError(system.insert(stripeEvents).values({ id: "evt_1", type: "x", payload: {} })),
    ).toMatch(/duplicate key/);
    expect((await system.select().from(stripeEvents)).map((e) => e.id)).toEqual(["evt_1"]);
  });
});

describe("per-client rules", () => {
  it("allows one primary contact per client, and one row per address (case-insensitive)", async () => {
    const clientId = await withTenant(app, A, async (tx) => {
      const [c] = await tx
        .insert(clients)
        .values({ tenantId: A, name: "Hooli" })
        .returning({ id: clients.id });
      return c!.id;
    });
    const contact = (email: string, isPrimary: boolean) =>
      withTenant(app, A, (tx) =>
        tx.execute(
          sql`insert into contacts (tenant_id, client_id, name, email, is_primary) values (${A}, ${clientId}, 'n', ${email}, ${isPrimary})`,
        ),
      );
    expect(await pgError(contact("a@hooli.test", true))).toBeNull();
    expect(await pgError(contact("b@hooli.test", false))).toBeNull();
    expect(await pgError(contact("c@hooli.test", true))).toMatch(/one_primary_contact/);
    expect(await pgError(contact("A@Hooli.test", false))).toMatch(/duplicate key/);
  });

  it("a contact cannot be attached to another tenant's client", async () => {
    const clientA = await withTenant(app, A, async (tx) => {
      const [c] = await tx
        .insert(clients)
        .values({ tenantId: A, name: "Pied Piper" })
        .returning({ id: clients.id });
      return c!.id;
    });
    const message = await pgError(
      withTenant(app, B, (tx) =>
        tx.execute(
          sql`insert into contacts (tenant_id, client_id, name, email) values (${B}, ${clientA}, 'n', 'x@y.test')`,
        ),
      ),
    );
    expect(message).toMatch(/contacts_tenant_id_client_id_clients_tenant_id_id_fkey/);
  });
});
