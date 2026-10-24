import { customType } from "drizzle-orm/pg-core";

// Needs `create extension citext` (migration 0000).
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});
