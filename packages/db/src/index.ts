import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { authRelations } from "./schema/auth.schema";
import { relations } from "./schema/relations";

export * from "./errors";
export * from "./resolvers";

export interface CreateDbOptions {
  /** Request paths use 1: Hyperdrive holds the connection for a whole transaction (D22). */
  max?: number;
}

/** Build one per request from the Hyperdrive binding, never at module scope (SPEC 9.1). */
export function createDb(connectionString: string, { max = 1 }: CreateDbOptions = {}) {
  const client = postgres(connectionString, { max, fetch_types: false });
  const db = drizzle({
    client,
    // authRelations uses defineRelationsPart,
    // so it must come after the main relations.
    // https://orm.drizzle.team/docs/relations-v2#relations-parts
    relations: { ...relations, ...authRelations },
  });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only DB entry point in request paths (D5). Opens a transaction and sets the tenant for it
 * (`set_config(..., true)` is the parameterized form of `SET LOCAL`), so nothing leaks to the next
 * request on a pooled connection. Keep `fn` to DB work only: no network calls (D22).
 */
export function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("withTenant: tenantId must be a uuid");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * For the jobs worker and webhook ingress (D4). The connection is `duely_system` (BYPASSRLS); this drops to
 * `duely_app` for the transaction so one unit of work is confined to one tenant like any request.
 */
export function withSystemTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("withSystemTenant: tenantId must be a uuid");
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role duely_app`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
