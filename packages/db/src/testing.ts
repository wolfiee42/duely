import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const sqlDir = new URL("../sql/", import.meta.url);
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

// A superuser connection, used only to create roles and a throwaway database per test file.
const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/postgres";

function urlAs(base: string, user: string, database: string) {
  const url = new URL(base);
  url.username = user;
  url.password = user;
  url.pathname = `/${database}`;
  return url.toString();
}

export interface TestDatabase {
  ownerUrl: string;
  appUrl: string;
  systemUrl: string;
  /** Superuser connection to this database, for setup that must bypass everything. */
  adminUrl: string;
  drop(): Promise<void>;
}

/** Creates a fresh, fully migrated database with the real roles. Integration tests only. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `duely_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    // Roles are cluster-wide and test files run in parallel, so serialize their creation.
    await admin`select pg_advisory_lock(7000001)`;
    await admin.unsafe(readFileSync(new URL("roles.sql", sqlDir), "utf8"));
    await admin.unsafe(readFileSync(new URL("dev-passwords.sql", sqlDir), "utf8"));
    await admin`select pg_advisory_unlock(7000001)`;
    await admin.unsafe(`create database ${name} owner duely_owner`);
  } finally {
    await admin.end();
  }

  const ownerUrl = urlAs(ADMIN_URL, "duely_owner", name);
  const migrator = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle({ client: migrator }), { migrationsFolder });
  } finally {
    await migrator.end();
  }

  const adminDbUrl = new URL(ADMIN_URL);
  adminDbUrl.pathname = `/${name}`;

  return {
    ownerUrl,
    appUrl: urlAs(ADMIN_URL, "duely_app", name),
    systemUrl: urlAs(ADMIN_URL, "duely_system", name),
    adminUrl: adminDbUrl.toString(),
    async drop() {
      const conn = postgres(ADMIN_URL, { max: 1 });
      try {
        await conn.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await conn.end();
      }
    },
  };
}
