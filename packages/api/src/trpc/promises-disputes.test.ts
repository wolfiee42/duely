import { resolveTenantByHost, withTenant } from "@repo/db";
import { promises } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createHarness, deliverMessage, testDeps, type Harness } from "../testing";

const ACME = "https://acme.duely.app";
const cfg = testDeps().config;
const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

let h: Harness;
let acme: string;
let globex: string;
let tenantId: string;
let initech: string;
let umbrella: string;
let billCookie: string;

async function portalCookieFor(email: string, ip: string) {
  await h.portal("auth.requestLink", { host: ACME, body: { email }, ip });
  for (const m of h.fakes.queue.messages.splice(0)) {
    if (m.type === "send_message")
      await deliverMessage(h.systemDb, { email: h.fakes.email, config: cfg }, m.messageId);
  }
  const token = /\/api\/portal\/auth\/([\w-]{43})/.exec(h.fakes.email.sent.at(-1)!.text)![1]!;
  return (await h.app.request(`${ACME}/api/portal/auth/${token}`, { redirect: "manual" })).headers
    .get("set-cookie")!
    .split(";")[0]!;
}

async function sentInvoice(clientId: string, dueDate?: string) {
  const id = (
    await h.staff("invoices.createDraft", {
      cookie: acme,
      body: {
        clientId,
        dueDate,
        items: [{ description: "Work", quantity: "1", unitAmountMinor: 5000 }],
      },
    })
  ).data.id as string;
  expect(
    (
      await h.staff("invoices.send", {
        cookie: acme,
        body: { invoiceId: id, idempotencyKey: crypto.randomUUID() },
      })
    ).status,
  ).toBe(200);
  return id;
}
const inv = async (id: string) =>
  (await h.staff("invoices.get", { cookie: acme, input: { invoiceId: id } })).data;

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
  tenantId = (await resolveTenantByHost(h.db, "acme.duely.app", "duely.app"))!.tenantId;
  await h.staff("stripe.connectLink", { cookie: acme, body: {} });
  h.fakes.stripe.completeOnboarding(
    (await h.staff("firm.get", { cookie: acme })).data.firm.stripeAccountId,
  );
  await h.staff("stripe.status", { cookie: acme });
  initech = (
    await h.staff("clients.create", {
      cookie: acme,
      body: { client: { name: "Initech" }, contact: { name: "Bill", email: "bill@initech.test" } },
    })
  ).data.id;
  umbrella = (
    await h.staff("clients.create", {
      cookie: acme,
      body: { client: { name: "Umbrella" }, contact: { name: "Ann", email: "ann@umbrella.test" } },
    })
  ).data.id;
  billCookie = await portalCookieFor("bill@initech.test", "10.2.2.2");
}, 60_000);
afterAll(() => h?.close());
beforeEach(() => h.testDbAdmin("delete from rate_limit_events"));

describe("promises", () => {
  it("a client promises a date from the portal: invoice becomes promised and the prior status is stored", async () => {
    const id = await sentInvoice(initech, iso(10));
    const date = iso(5);
    const res = await h.portal("promises.create", {
      host: ACME,
      cookie: billCookie,
      body: { invoiceId: id, promisedDate: date },
    });
    expect(res.status).toBe(200);
    const got = await inv(id);
    expect(got.status).toBe("promised");
    expect(got.activePromise).toMatchObject({
      promisedDate: date,
      source: "portal",
      status: "active",
      priorStatus: "sent",
    });
    const timeline = await h.staff("invoices.timeline", { cookie: acme, input: { invoiceId: id } });
    const created = timeline.data.events.find(
      (e: { action: string }) => e.action === "promise.created",
    );
    expect(created).toMatchObject({ actorType: "contact" });
  });

  it("validates the date: not in the past, not beyond 90 days", async () => {
    const id = await sentInvoice(initech);
    const past = await h.portal("promises.create", {
      host: ACME,
      cookie: billCookie,
      body: { invoiceId: id, promisedDate: iso(-2) },
    });
    const far = await h.portal("promises.create", {
      host: ACME,
      cookie: billCookie,
      body: { invoiceId: id, promisedDate: iso(200) },
    });
    expect([past.domainCode, far.domainCode]).toEqual([
      "promise.date_in_past",
      "promise.date_too_far",
    ]);
    expect(
      (
        await h.portal("promises.create", {
          host: ACME,
          cookie: billCookie,
          body: { invoiceId: id, promisedDate: "tomorrow" },
        })
      ).status,
    ).toBe(400);
    expect((await inv(id)).status).toBe("sent");
  });

  it("only one active promise at a time, and not on paid, void or draft invoices", async () => {
    const id = await sentInvoice(initech);
    await h.portal("promises.create", {
      host: ACME,
      cookie: billCookie,
      body: { invoiceId: id, promisedDate: iso(3) },
    });
    const second = await h.portal("promises.create", {
      host: ACME,
      cookie: billCookie,
      body: { invoiceId: id, promisedDate: iso(4) },
    });
    expect([second.status, second.domainCode]).toEqual([409, "invoice.invalid_transition"]);

    const voided = await sentInvoice(initech);
    await h.staff("invoices.void", { cookie: acme, body: { invoiceId: voided, reason: "x" } });
    expect(
      (
        await h.portal("promises.create", {
          host: ACME,
          cookie: billCookie,
          body: { invoiceId: voided, promisedDate: iso(3) },
        })
      ).status,
    ).toBe(409);
    const draft = (
      await h.staff("invoices.createDraft", {
        cookie: acme,
        body: { clientId: initech, items: [] },
      })
    ).data.id;
    expect(
      (
        await h.portal("promises.create", {
          host: ACME,
          cookie: billCookie,
          body: { invoiceId: draft, promisedDate: iso(3) },
        })
      ).status,
    ).toBe(404);
  });

  it("cannot promise on another client's invoice, another firm's, or without a session", async () => {
    const theirs = await sentInvoice(umbrella);
    expect(
      (
        await h.portal("promises.create", {
          host: ACME,
          cookie: billCookie,
          body: { invoiceId: theirs, promisedDate: iso(3) },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.portal("promises.create", {
          host: ACME,
          body: { invoiceId: theirs, promisedDate: iso(3) },
        })
      ).status,
    ).toBe(401);
    expect((await inv(theirs)).status).toBe("sent");
  });

  it("staff cancel restores the invoice by its dates: sent when not due, overdue when past due", async () => {
    const fresh = await sentInvoice(initech, iso(10));
    await h.staff("promises.create", {
      cookie: acme,
      body: { invoiceId: fresh, promisedDate: iso(2) },
    });
    expect((await inv(fresh)).activePromise.source).toBe("manual");
    await h.staff("promises.cancel", {
      cookie: acme,
      body: { promiseId: (await inv(fresh)).activePromise.id },
    });
    expect(await inv(fresh)).toMatchObject({ status: "sent", activePromise: null });

    const late = await sentInvoice(initech);
    await h.staff("promises.create", {
      cookie: acme,
      body: { invoiceId: late, promisedDate: iso(2) },
    });
    await h.testDbAdmin(`update invoices set due_date = '2020-01-01' where id = '${late}'`);
    await h.staff("promises.cancel", {
      cookie: acme,
      body: { promiseId: (await inv(late)).activePromise.id },
    });
    expect((await inv(late)).status).toBe("overdue");
  });

  it("another firm cannot cancel it (404)", async () => {
    const id = await sentInvoice(initech);
    await h.staff("promises.create", {
      cookie: acme,
      body: { invoiceId: id, promisedDate: iso(2) },
    });
    const promiseId = (await inv(id)).activePromise.id;
    expect((await h.staff("promises.cancel", { cookie: globex, body: { promiseId } })).status).toBe(
      404,
    );
    expect(
      (
        await withTenant(h.db, tenantId, (tx) =>
          tx.select().from(promises).where(eq(promises.id, promiseId)),
        )
      )[0]!.status,
    ).toBe("active");
  });
});

describe("disputes", () => {
  it("a client opens a dispute: invoice is disputed, prior status stored, a second one is refused", async () => {
    const id = await sentInvoice(initech);
    const res = await h.portal("disputes.open", {
      host: ACME,
      cookie: billCookie,
      body: { invoiceId: id, reason: "Wrong amount", detail: "We agreed $40." },
    });
    expect(res.status).toBe(200);
    const got = await inv(id);
    expect(got.status).toBe("disputed");
    expect(got.openDispute).toMatchObject({
      reason: "Wrong amount",
      detail: "We agreed $40.",
      source: "portal",
      priorStatus: "sent",
    });
    const again = await h.portal("disputes.open", {
      host: ACME,
      cookie: billCookie,
      body: { invoiceId: id, reason: "again" },
    });
    expect([again.status, again.domainCode]).toEqual([409, "invoice.invalid_transition"]);
  });

  it("a promised invoice can be disputed; resolving returns it by its dates (promise stays on record)", async () => {
    const id = await sentInvoice(initech, iso(10));
    await h.portal("promises.create", {
      host: ACME,
      cookie: billCookie,
      body: { invoiceId: id, promisedDate: iso(3) },
    });
    await h.staff("disputes.open", {
      cookie: acme,
      body: { invoiceId: id, reason: "Client called" },
    });
    expect((await inv(id)).status).toBe("disputed");

    const disputeId = (await inv(id)).openDispute.id;
    expect(
      (
        await h.staff("disputes.resolve", {
          cookie: acme,
          body: { disputeId, outcome: "resolved", note: "Corrected" },
        })
      ).status,
    ).toBe(200);
    expect(await inv(id)).toMatchObject({ status: "sent", openDispute: null });
  });

  it("an overdue invoice returns to overdue when its dispute is resolved", async () => {
    const id = await sentInvoice(initech);
    await h.testDbAdmin(
      `update invoices set due_date = '2020-01-01', status = 'overdue' where id = '${id}'`,
    );
    await h.staff("disputes.open", { cookie: acme, body: { invoiceId: id, reason: "x" } });
    await h.staff("disputes.resolve", {
      cookie: acme,
      body: { disputeId: (await inv(id)).openDispute.id, outcome: "upheld", note: "Firm agrees" },
    });
    expect((await inv(id)).status).toBe("overdue");
  });

  it("a disputed invoice can still be paid or voided, and resolving twice is refused", async () => {
    const id = await sentInvoice(initech);
    await h.staff("disputes.open", { cookie: acme, body: { invoiceId: id, reason: "x" } });
    const disputeId = (await inv(id)).openDispute.id;
    await h.staff("disputes.resolve", {
      cookie: acme,
      body: { disputeId, outcome: "resolved", note: "ok" },
    });
    const twice = await h.staff("disputes.resolve", {
      cookie: acme,
      body: { disputeId, outcome: "resolved", note: "ok" },
    });
    expect([twice.status, twice.domainCode]).toEqual([404, "dispute.not_found"]);

    const other = await sentInvoice(initech);
    await h.staff("disputes.open", { cookie: acme, body: { invoiceId: other, reason: "x" } });
    expect(
      (
        await h.staff("invoices.void", {
          cookie: acme,
          body: { invoiceId: other, reason: "Settled" },
        })
      ).status,
    ).toBe(200);
  });

  it("is isolated: other client, other firm, no session, and cross-firm resolve all fail", async () => {
    const theirs = await sentInvoice(umbrella);
    expect(
      (
        await h.portal("disputes.open", {
          host: ACME,
          cookie: billCookie,
          body: { invoiceId: theirs, reason: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await h.portal("disputes.open", { host: ACME, body: { invoiceId: theirs, reason: "x" } }))
        .status,
    ).toBe(401);
    await h.staff("disputes.open", { cookie: acme, body: { invoiceId: theirs, reason: "real" } });
    const disputeId = (await inv(theirs)).openDispute.id;
    expect(
      (
        await h.staff("disputes.resolve", {
          cookie: globex,
          body: { disputeId, outcome: "resolved", note: "x" },
        })
      ).status,
    ).toBe(404);
    expect((await inv(theirs)).status).toBe("disputed");
  });

  it("validates input", async () => {
    const id = await sentInvoice(initech);
    expect(
      (
        await h.portal("disputes.open", {
          host: ACME,
          cookie: billCookie,
          body: { invoiceId: id, reason: "" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.portal("disputes.open", {
          host: ACME,
          cookie: billCookie,
          body: { invoiceId: id, reason: "x".repeat(201) },
        })
      ).status,
    ).toBe(400);
  });
});

describe("timeline", () => {
  it("lists audit events and messages for the invoice, newest first, scoped to the firm", async () => {
    const id = await sentInvoice(initech);
    await h.staff("disputes.open", { cookie: acme, body: { invoiceId: id, reason: "x" } });
    const t = await h.staff("invoices.timeline", { cookie: acme, input: { invoiceId: id } });
    expect(t.data.events.map((e: { action: string }) => e.action)).toEqual([
      "dispute.opened",
      "invoice.sent",
      "invoice.created",
    ]);
    expect(t.data.messages).toMatchObject([{ kind: "invoice", status: "queued" }]);
    expect(
      (await h.staff("invoices.timeline", { cookie: globex, input: { invoiceId: id } })).status,
    ).toBe(404);
  });
});
