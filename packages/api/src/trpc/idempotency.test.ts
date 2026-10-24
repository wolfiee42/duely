import { createDb, type Db } from "@repo/db";
import { user } from "@repo/db/schema";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createFirm } from "../usecases/firm";
import { runIdempotent } from "./idempotency";

let testDb: TestDatabase;
let db: Db;
let close: () => Promise<unknown>;
let tenantA: string;
let tenantB: string;
const withDb = <T>(fn: (db: Db) => Promise<T>) => fn(db);

beforeAll(async () => {
  testDb = await createTestDatabase();
  ({ db, close } = createDb(testDb.appUrl, { max: 6 }));
  for (const n of ["a", "b"]) {
    await db.insert(user).values({ id: `u-${n}`, name: n, email: `${n}@example.com` });
  }
  tenantA = (
    await createFirm(
      db,
      { id: "u-a", email: "a@example.com", name: "a" },
      { legalName: "A LLC", displayName: "A", platformSlug: "firm-a" },
    )
  ).tenantId;
  tenantB = (
    await createFirm(
      db,
      { id: "u-b", email: "b@example.com", name: "b" },
      { legalName: "B LLC", displayName: "B", platformSlug: "firm-b" },
    )
  ).tenantId;
}, 60_000);

afterAll(async () => {
  await close?.();
  await testDb?.drop();
});

const key = () => crypto.randomUUID();

describe("runIdempotent", () => {
  it("runs once and replays the stored result on a repeat", async () => {
    const k = key();
    let runs = 0;
    const act = () =>
      runIdempotent(withDb, tenantA, "invoices.send", k, async () => ({ n: ++runs }));
    expect(await act()).toEqual({ n: 1 });
    expect(await act()).toEqual({ n: 1 });
    expect(runs).toBe(1);
  });

  it("replays a null or undefined result without re-running", async () => {
    const k = key();
    let runs = 0;
    const act = () => runIdempotent(withDb, tenantA, "x.noop", k, async () => (++runs, null));
    await act();
    await act();
    expect(runs).toBe(1);
  });

  it("treats a different procedure or tenant as a different key", async () => {
    const k = key();
    const results = await Promise.all([
      runIdempotent(withDb, tenantA, "p.one", k, async () => "a-one"),
      runIdempotent(withDb, tenantA, "p.two", k, async () => "a-two"),
      runIdempotent(withDb, tenantB, "p.one", k, async () => "b-one"),
    ]);
    expect(results).toEqual(["a-one", "a-two", "b-one"]);
  });

  it("gives a concurrent duplicate a conflict instead of running twice", async () => {
    const k = key();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runIdempotent(withDb, tenantA, "slow", k, async () => {
      runs++;
      await gate;
      return "done";
    });
    // Let the first call claim the key before the duplicate arrives.
    await new Promise((r) => setTimeout(r, 100));
    const second = runIdempotent(withDb, tenantA, "slow", k, async () => (runs++, "again"));
    await expect(second).rejects.toMatchObject({
      code: "idempotency.in_progress",
      kind: "conflict",
    });
    release();
    expect(await first).toBe("done");
    expect(runs).toBe(1);
    expect(await runIdempotent(withDb, tenantA, "slow", k, async () => (runs++, "again"))).toBe(
      "done",
    );
  });

  it("releases the key when the work fails, so the client can retry", async () => {
    const k = key();
    await expect(
      runIdempotent(withDb, tenantA, "flaky", k, async () => {
        throw new Error("provider down");
      }),
    ).rejects.toThrow("provider down");
    expect(await runIdempotent(withDb, tenantA, "flaky", k, async () => "recovered")).toBe(
      "recovered",
    );
  });
});
