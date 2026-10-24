import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

// Superuser connection used to create the `duely_e2e` database (see packages/db/scripts/prepare-e2e.ts).
const admin = new URL(
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://postgres:password@localhost:5432/postgres",
);
const as = (role: string) =>
  `postgresql://${role}:${role}@${admin.hostname}:${admin.port || 5432}/duely_e2e`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../.cache/playwright/web",
  fullyParallel: false,
  workers: 1,
  use: {
    // `*.localhost` resolves to this machine, so the staff app (app.localhost) and a client portal
    // (acme.localhost) are separate origins with separate cookies, as in production.
    baseURL: `http://app.localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `vp run --filter=@repo/db e2e:prepare && vp build && vp preview --port ${PORT} --strictPort`,
    env: {
      TEST_ADMIN_DATABASE_URL: admin.toString(),
      SERVICES_MODE: "fake",
      PLATFORM_DOMAIN: "localhost",
      VITE_BASE_URL: `http://app.localhost:${PORT}`,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? randomBytes(32).toString("base64url"),
      DATABASE_URL: as("duely_owner"),
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP: as("duely_app"),
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_SYSTEM: as("duely_system"),
    },
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 500 },
    timeout: 180_000,
  },
});
