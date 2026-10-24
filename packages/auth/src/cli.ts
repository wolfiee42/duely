import type { Db } from "@repo/db";

import { createAuth } from "./auth";

// Only for `vpr auth:generate`: the CLI reads the options and plugins from an exported `auth`.
// It never opens a connection, so the placeholder db is not used.
export const auth = createAuth({
  db: undefined as unknown as Db,
  baseURL: "http://app.localhost:3000",
  secret: "schema-generation-only",
});
