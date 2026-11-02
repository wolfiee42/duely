import { defineConfig } from "@trigger.dev/sdk";

// Trigger.dev adapter for background work (D24). workers/jobs is the Cloudflare equivalent; run only one.
export default defineConfig({
  // `proj_…` from the Trigger.dev dashboard.
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./src"],
  runtime: "node",
  maxDuration: 300,
});
