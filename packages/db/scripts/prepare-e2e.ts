import { createTestDatabase } from "../src/testing.ts";

// Creates (or recreates) the `duely_e2e` database with the real roles and migrations, then exits.
// Run by the Playwright web server command before the build, so every E2E run starts clean.
await createTestDatabase("duely_e2e");
