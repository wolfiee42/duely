import { resolveTenantByHost, withTenant } from "@repo/db";
import { invoices } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createHarness, type Harness } from "../testing";

let h: Harness;
let acme: string;
let globex: string;
let clientId: string;

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  clientId = (
    await h.staff("clients.create", {
      cookie: acme,
      body: { client: { name: "Initech" }, contact: { name: "Bill", email: "bill@initech.test" } },
    })
  ).data.id;
}, 60_000);
afterAll(() => h?.close());

const draft = (
  items: Array<{ description: string; quantity: string; unitAmountMinor: number }>,
  extra = {},
) => h.staff("invoices.createDraft", { cookie: acme, body: { clientId, items, ...extra } });

describe("invoice drafts", () => {
  it("prices lines server-side, rounding each half-up, and stores the totals", async () => {
    const created = await draft([
      { description: "Design", quantity: "1.5", unitAmountMinor: 1001 }, // 1501.5 -> 1502
      { description: "Hosting", quantity: "3", unitAmountMinor: 2500 }, // 7500
      { description: "Half cent", quantity: "0.5", unitAmountMinor: 1 }, // 0.5 -> 1
    ]);
    expect(created.status).toBe(200);
    expect(created.data.totalMinor).toBe(1502 + 7500 + 1);
    const got = await h.staff("invoices.get", {
      cookie: acme,
      input: { invoiceId: created.data.id },
    });
    expect(got.data).toMatchObject({
      status: "draft",
      number: null,
      subtotalMinor: 9003,
      totalMinor: 9003,
      client: { name: "Initech" },
    });
    expect(got.data.items.map((i: { amountMinor: number }) => i.amountMinor)).toEqual([
      1502, 7500, 1,
    ]);
    expect(got.data.items.map((i: { position: number }) => i.position)).toEqual([1, 2, 3]);
  });

  it("rejects bad quantities and prices with namespaced codes", async () => {
    for (const [quantity, unitAmountMinor, code] of [
      ["0", 100, "invoice.invalid_quantity"],
      ["1.0001", 100, "invoice.invalid_quantity"],
      ["abc", 100, "invoice.invalid_quantity"],
      ["1", 100_000_000_000_000, "invoice.invalid_amount"],
    ] as const) {
      const res = await draft([{ description: "x", quantity, unitAmountMinor }]);
      expect([res.status, res.domainCode]).toEqual([400, code]);
    }
    expect((await draft([{ description: "x", quantity: "1", unitAmountMinor: -5 }])).status).toBe(
      400,
    );
    expect((await draft([{ description: "", quantity: "1", unitAmountMinor: 5 }])).status).toBe(
      400,
    );
  });

  it("ignores amounts a client tries to supply (totals are never trusted)", async () => {
    const res = await h.staff("invoices.createDraft", {
      cookie: acme,
      body: {
        clientId,
        totalMinor: 1,
        items: [{ description: "x", quantity: "2", unitAmountMinor: 500, amountMinor: 1 }],
      },
    });
    expect(res.data.totalMinor).toBe(1000);
  });

  it("edits a draft by replacing its lines and recomputing", async () => {
    const { data } = await draft([{ description: "A", quantity: "1", unitAmountMinor: 1000 }]);
    const updated = await h.staff("invoices.updateDraft", {
      cookie: acme,
      body: {
        invoiceId: data.id,
        clientId,
        dueDate: "2026-12-01",
        items: [{ description: "B", quantity: "2", unitAmountMinor: 750 }],
      },
    });
    expect(updated.data.totalMinor).toBe(1500);
    const got = await h.staff("invoices.get", { cookie: acme, input: { invoiceId: data.id } });
    expect(got.data.items).toHaveLength(1);
    expect(got.data).toMatchObject({ dueDate: "2026-12-01", totalMinor: 1500 });
  });

  it("is isolated per firm: others get 404, and cannot use another firm's client", async () => {
    const { data } = await draft([{ description: "A", quantity: "1", unitAmountMinor: 1000 }]);
    expect(
      (await h.staff("invoices.get", { cookie: globex, input: { invoiceId: data.id } })).status,
    ).toBe(404);
    expect(
      (await h.staff("invoices.deleteDraft", { cookie: globex, body: { invoiceId: data.id } }))
        .status,
    ).toBe(404);
    expect(
      (
        await h.staff("invoices.void", {
          cookie: globex,
          body: { invoiceId: data.id, reason: "x" },
        })
      ).status,
    ).toBe(404);
    const stolen = await h.staff("invoices.createDraft", {
      cookie: globex,
      body: { clientId, items: [] },
    });
    expect([stolen.status, stolen.domainCode]).toEqual([404, "client.not_found"]);
    expect((await h.staff("invoices.list", { cookie: globex })).data).toEqual([]);
  });

  it("refuses archived clients", async () => {
    const other = (
      await h.staff("clients.create", {
        cookie: acme,
        body: { client: { name: "Gone" }, contact: { name: "g", email: "g@gone.test" } },
      })
    ).data.id;
    await h.staff("clients.archive", { cookie: acme, body: { clientId: other } });
    const res = await h.staff("invoices.createDraft", {
      cookie: acme,
      body: { clientId: other, items: [] },
    });
    expect([res.status, res.domainCode]).toEqual([422, "client.archived"]);
  });

  it("deletes a draft, and voids with a reason (terminal)", async () => {
    const a = (await draft([{ description: "A", quantity: "1", unitAmountMinor: 100 }])).data.id;
    expect(
      (await h.staff("invoices.deleteDraft", { cookie: acme, body: { invoiceId: a } })).status,
    ).toBe(200);
    expect((await h.staff("invoices.get", { cookie: acme, input: { invoiceId: a } })).status).toBe(
      404,
    );

    const b = (await draft([{ description: "B", quantity: "1", unitAmountMinor: 100 }])).data.id;
    expect(
      (
        await h.staff("invoices.void", {
          cookie: acme,
          body: { invoiceId: b, reason: "Duplicate" },
        })
      ).status,
    ).toBe(200);
    const got = await h.staff("invoices.get", { cookie: acme, input: { invoiceId: b } });
    expect(got.data).toMatchObject({ status: "void", voidReason: "Duplicate" });
    const again = await h.staff("invoices.void", {
      cookie: acme,
      body: { invoiceId: b, reason: "again" },
    });
    expect([again.status, again.domainCode]).toEqual([409, "invoice.invalid_transition"]);
    const edit = await h.staff("invoices.updateDraft", {
      cookie: acme,
      body: { invoiceId: b, clientId, items: [] },
    });
    expect([edit.status, edit.domainCode]).toEqual([409, "invoice.not_draft"]);
  });

  it("lists with the effective status for past-due invoices the sweep has not reached", async () => {
    const id = (
      await draft([{ description: "A", quantity: "1", unitAmountMinor: 100 }], {
        dueDate: "2020-01-01",
      })
    ).data.id;
    const tenantId = (await resolveTenantByHost(h.db, "acme.duely.app", "duely.app"))!.tenantId;
    await withTenant(h.db, tenantId, (tx) =>
      tx.update(invoices).set({ status: "sent" }).where(eq(invoices.id, id)),
    );

    const overdue = await h.staff("invoices.list", { cookie: acme, input: { status: "overdue" } });
    expect(overdue.data.map((r: { id: string }) => r.id)).toContain(id);
    expect(overdue.data.find((r: { id: string }) => r.id === id)).toMatchObject({
      status: "sent",
      effectiveStatus: "overdue",
    });
    expect(
      (await h.staff("invoices.get", { cookie: acme, input: { invoiceId: id } })).data
        .effectiveStatus,
    ).toBe("overdue");
    const edit = await h.staff("invoices.updateDraft", {
      cookie: acme,
      body: { invoiceId: id, clientId, items: [] },
    });
    expect(edit.domainCode).toBe("invoice.not_draft");
  });
});
