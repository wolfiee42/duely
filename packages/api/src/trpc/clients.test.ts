import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createHarness, type Harness } from "../testing";

let h: Harness;
let acme: string;
let globex: string;

beforeAll(async () => {
  h = await createHarness();
  acme = await h.ownerOf("acme");
  globex = await h.ownerOf("globex");
}, 60_000);
afterAll(() => h?.close());

const newClient = (cookie: string, name = "Initech", email = "bill@initech.test") =>
  h.staff("clients.create", {
    cookie,
    body: { client: { name }, contact: { name: "Bill", email } },
  });

describe("clients and contacts", () => {
  it("creates a client with a primary contact and lists it", async () => {
    const created = await newClient(acme);
    expect(created.status).toBe(200);
    const got = await h.staff("clients.get", {
      cookie: acme,
      input: { clientId: created.data.id },
    });
    expect(got.data).toMatchObject({
      name: "Initech",
      contacts: [{ email: "bill@initech.test", isPrimary: true }],
    });
    const list = await h.staff("clients.list", { cookie: acme });
    expect(list.data.map((c: { name: string }) => c.name)).toEqual(["Initech"]);
  });

  it("requires a session and a firm, and validates input", async () => {
    expect((await h.staff("clients.list")).status).toBe(401);
    expect(
      (
        await h.staff("clients.create", {
          cookie: acme,
          body: { client: { name: "" }, contact: { name: "x", email: "nope" } },
        })
      ).status,
    ).toBe(400);
  });

  it("another firm cannot see, change or archive the client (404, not 403)", async () => {
    const id = (await newClient(acme, "Hooli", "gavin@hooli.test")).data.id;
    expect((await h.staff("clients.list", { cookie: globex })).data).toEqual([]);
    expect((await h.staff("clients.get", { cookie: globex, input: { clientId: id } })).status).toBe(
      404,
    );
    expect(
      (await h.staff("clients.update", { cookie: globex, body: { clientId: id, name: "Pwned" } }))
        .status,
    ).toBe(404);
    expect(
      (await h.staff("clients.archive", { cookie: globex, body: { clientId: id } })).status,
    ).toBe(404);
    expect(
      (
        await h.staff("contacts.add", {
          cookie: globex,
          body: { clientId: id, name: "x", email: "x@y.test" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await h.staff("clients.get", { cookie: acme, input: { clientId: id } })).data.name,
    ).toBe("Hooli");
  });

  it("manages contacts: add, primary handoff, duplicate email, last contact", async () => {
    const id = (await newClient(acme, "Umbrella", "a@umbrella.test")).data.id;
    const added = await h.staff("contacts.add", {
      cookie: acme,
      body: { clientId: id, name: "Ann", email: "Ann@Umbrella.test" },
    });
    expect(added.status).toBe(200);
    const dup = await h.staff("contacts.add", {
      cookie: acme,
      body: { clientId: id, name: "Ann 2", email: "ann@umbrella.test" },
    });
    expect([dup.status, dup.domainCode]).toEqual([409, "contact.duplicate_email"]);

    await h.staff("contacts.setPrimary", { cookie: acme, body: { contactId: added.data.id } });
    let contacts = (await h.staff("clients.get", { cookie: acme, input: { clientId: id } })).data
      .contacts;
    expect(
      contacts
        .filter((c: { isPrimary: boolean }) => c.isPrimary)
        .map((c: { email: string }) => c.email),
    ).toEqual(["ann@umbrella.test"]);

    await h.staff("contacts.remove", { cookie: acme, body: { contactId: added.data.id } });
    contacts = (await h.staff("clients.get", { cookie: acme, input: { clientId: id } })).data
      .contacts;
    expect(contacts).toMatchObject([{ email: "a@umbrella.test", isPrimary: true }]); // primary handed on

    const last = await h.staff("contacts.remove", {
      cookie: acme,
      body: { contactId: contacts[0].id },
    });
    expect([last.status, last.domainCode]).toEqual([422, "contact.last_contact"]);
  });

  it("archives and restores (soft delete) and hides archived clients by default", async () => {
    const id = (await newClient(acme, "Soylent", "s@soylent.test")).data.id;
    await h.staff("clients.archive", { cookie: acme, body: { clientId: id } });
    const names = async (archived?: boolean) =>
      (await h.staff("clients.list", { cookie: acme, input: { archived } })).data.map(
        (c: { name: string }) => c.name,
      );
    expect(await names()).not.toContain("Soylent");
    expect(await names(true)).toContain("Soylent");
    await h.staff("clients.archive", { cookie: acme, body: { clientId: id, archived: false } });
    expect(await names()).toContain("Soylent");
  });

  it("search treats % and _ literally", async () => {
    await newClient(acme, "100% Organic", "o@organic.test");
    const hit = await h.staff("clients.list", { cookie: acme, input: { search: "100%" } });
    expect(hit.data.map((c: { name: string }) => c.name)).toEqual(["100% Organic"]);
    expect(
      (await h.staff("clients.list", { cookie: acme, input: { search: "%" } })).data,
    ).toHaveLength(1);
  });
});
