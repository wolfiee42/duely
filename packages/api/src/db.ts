import { createDb, type Db } from "@repo/db";

/** Runs `fn` with a database client that lives for one unit of work. */
export type WithDb = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

/**
 * One client per call, built from the Hyperdrive binding and never kept at module scope (SPEC 9.1).
 * The connection is closed after the response is on its way, via the Worker's `waitUntil`.
 */
export function createWithDb(
  connectionString: () => string,
  waitUntil: (promise: Promise<unknown>) => void,
): WithDb {
  return async (fn) => {
    const { db, close } = createDb(connectionString());
    try {
      return await fn(db);
    } finally {
      waitUntil(close().catch(() => undefined));
    }
  };
}
