import { createDb, withTenant, type Db } from "@repo/db";
import { auditLog, members, user } from "@repo/db/schema";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { testDeps } from "../testing";
import { audit } from "../usecases/audit";
import { createFirm } from "../usecases/firm";
import type { SessionUser, StaffContext } from "./context";
import { createCallerFactory, ownerProcedure, router, staffProcedure } from "./init";

// trpc-authz (SPEC 8): each procedure builder, without HTTP, so roles can be set up directly.

let testDb: TestDatabase;
let db: Db;
let close: () => Promise<unknown>;

const probe = createCallerFactory(
  router({
    staff: staffProcedure.query(({ ctx }) => ({ tenantId: ctx.tenantId, role: ctx.member.role })),
    owner: ownerProcedure.query(() => "ok"),
  }),
);

const ctxFor = (u: SessionUser | null, hostKind: "app" | "portal" = "app"): StaffContext => ({
  requestId: "req-1",
  host: { hostKind, tenantId: null },
  withDb: (fn) => fn(db),
  withSystemDb: (fn) => fn(db),
  services: testDeps().services,
  config: testDeps().config,
  getSession: async () => u,
});

const owner: SessionUser = { id: "u-owner", email: "owner@example.com", name: "Owner" };
const staff: SessionUser = { id: "u-staff", email: "staff@example.com", name: "Staff" };
const loner: SessionUser = { id: "u-loner", email: "loner@example.com", name: "Loner" };
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  ({ db, close } = createDb(testDb.appUrl, { max: 4 }));
  for (const u of [owner, staff, loner]) {
    await db.insert(user).values({ id: u.id, name: u.name, email: u.email });
  }
  ({ tenantId } = await createFirm(db, owner, {
    legalName: "Acme LLC",
    displayName: "Acme",
    platformSlug: "acme",
  }));
  await withTenant(db, tenantId, (tx) =>
    tx.insert(members).values({ tenantId, userId: staff.id, email: staff.email, role: "member" }),
  );
}, 60_000);

afterAll(async () => {
  await close?.();
  await testDb?.drop();
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code: string }).code;
  }
};

describe("procedure builders", () => {
  it("staffProcedure: needs a session (UNAUTHORIZED) and a firm (FORBIDDEN)", async () => {
    expect(await code(probe(ctxFor(null)).staff())).toBe("UNAUTHORIZED");
    expect(await code(probe(ctxFor(loner)).staff())).toBe("FORBIDDEN");
    expect(await probe(ctxFor(staff)).staff()).toEqual({ tenantId, role: "member" });
  });

  it("takes the tenant from the members row, never from the host or input", async () => {
    const ctx = ctxFor(owner);
    ctx.host = { hostKind: "app", tenantId: "00000000-0000-4000-8000-000000000000" };
    expect(await probe(ctx).staff()).toEqual({ tenantId, role: "owner" });
  });

  it("rejects a portal host even with a valid session (FORBIDDEN)", async () => {
    expect(await code(probe(ctxFor(owner, "portal")).staff())).toBe("FORBIDDEN");
  });

  it("ownerProcedure: a member gets FORBIDDEN, an owner passes", async () => {
    expect(await code(probe(ctxFor(staff)).owner())).toBe("FORBIDDEN");
    expect(await probe(ctxFor(owner)).owner()).toBe("ok");
  });
});

describe("audit", () => {
  const actor = () => ({ tenantId, type: "member" as const, id: "m-1", requestId: "req-9" });

  it("records actor, entity, summary and request id", async () => {
    const entityId = crypto.randomUUID();
    await withTenant(db, tenantId, (tx) =>
      audit(
        tx,
        actor(),
        "client.created",
        { type: "client", id: entityId },
        { after: { name: "Initech" } },
      ),
    );
    const [row] = await withTenant(db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, entityId)),
    );
    expect(row).toMatchObject({
      tenantId,
      actorType: "member",
      actorId: "m-1",
      action: "client.created",
      entityType: "client",
      requestId: "req-9",
      summary: { after: { name: "Initech" } },
    });
  });

  it("commits or rolls back together with the change it describes", async () => {
    const entityId = crypto.randomUUID();
    await withTenant(db, tenantId, async (tx) => {
      await audit(tx, actor(), "client.created", { type: "client", id: entityId });
      throw new Error("mutation failed after audit");
    }).catch(() => undefined);
    const rows = await withTenant(db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, entityId)),
    );
    expect(rows).toEqual([]);
  });

  it("firm.create leaves exactly one firm.created entry", async () => {
    const rows = await withTenant(db, tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, "firm.created")),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "firm", entityId: tenantId, actorType: "member" });
  });
});
