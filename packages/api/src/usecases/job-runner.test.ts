import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createHarness, testDeps, type Harness } from "../testing";
import { createJobRunner } from "./job-runner";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(() => h?.close());

function runner(
  over: { withSystemDb?: Parameters<typeof createJobRunner>[0]["withSystemDb"] } = {},
) {
  const logged: string[] = [];
  const { config } = testDeps();
  return {
    logged,
    runner: createJobRunner({
      withSystemDb: over.withSystemDb ?? ((fn) => fn(h.systemDb)),
      email: h.fakes.email,
      cloudflare: h.fakes.cloudflare,
      model: null,
      config,
      queue: h.fakes.queue,
      log: (event) => void logged.push(event),
    }),
  };
}

const unknownId = () => crypto.randomUUID();

describe("job runner", () => {
  it("treats a message for something that no longer exists as handled", async () => {
    const { runner: r } = runner();
    await expect(
      r.handle({ type: "send_message", messageId: unknownId() }),
    ).resolves.toBeUndefined();
    await expect(
      r.handle({ type: "classify_reply", messageId: unknownId() }),
    ).resolves.toBeUndefined();
    await expect(r.handle({ type: "process_job", jobId: unknownId() })).resolves.toBeUndefined();
  });

  it("throws on an infrastructure failure so the provider retries", async () => {
    const down = () => Promise.reject(new Error("db down"));
    const { runner: r, logged } = runner({ withSystemDb: down });
    await expect(r.handle({ type: "send_message", messageId: unknownId() })).rejects.toThrow(
      "db down",
    );
    expect(logged).toEqual(["jobs.message_failed"]);
  });

  it("records a failing process_job for backoff instead of throwing", async () => {
    let calls = 0;
    const { runner: r, logged } = runner({
      // Processing fails, then the failure can still be recorded.
      withSystemDb: (fn) => (calls++ === 0 ? Promise.reject(new Error("boom")) : fn(h.systemDb)),
    });
    await expect(r.handle({ type: "process_job", jobId: unknownId() })).resolves.toBeUndefined();
    expect(logged).toEqual(["jobs.process_job_failed"]);
  });

  it("throws when even the failure cannot be recorded", async () => {
    const down = () => Promise.reject(new Error("still down"));
    const { runner: r } = runner({ withSystemDb: down });
    await expect(r.handle({ type: "process_job", jobId: unknownId() })).rejects.toThrow(
      "still down",
    );
  });

  it("keeps ticking when one step fails", async () => {
    const down = () => Promise.reject(new Error("db down"));
    const { runner: r, logged } = runner({ withSystemDb: down });
    await expect(r.tick()).resolves.toBeUndefined();
    expect(logged).toEqual([
      "jobs.tick_step_failed",
      "jobs.tick_step_failed",
      "jobs.tick_step_failed",
    ]);
  });
});
