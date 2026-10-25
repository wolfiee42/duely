import { describe, expect, it } from "vite-plus/test";

import { handleBatch, type ConsumerDeps, type Delivery } from "./consumer";

const delivery = (body: Delivery["body"]) => {
  const state = { acked: 0, retried: 0 };
  return {
    state,
    d: { body, ack: () => state.acked++, retry: () => state.retried++ } satisfies Delivery,
  };
};

function deps(over: Partial<ConsumerDeps> = {}) {
  const calls = {
    classified: [] as string[],
    delivered: [] as string[],
    processed: [] as string[],
    failed: [] as string[],
    queued: [] as unknown[],
  };
  const base: ConsumerDeps = {
    deliver: async (id) => void calls.delivered.push(id),
    processJob: async (id) => {
      calls.processed.push(id);
      return {};
    },
    classifyReply: async (id) => void calls.classified.push(id),
    recordJobFailure: async (id) => void calls.failed.push(id),
    enqueue: async (m) => void calls.queued.push(m),
    log: () => {},
  };
  return { calls, deps: { ...base, ...over } };
}

describe("queue consumer", () => {
  it("acks a delivered message and passes only its id", async () => {
    const { calls, deps: d } = deps();
    const a = delivery({ type: "send_message", messageId: "m-1" });
    await handleBatch([a.d], d);
    expect(calls.delivered).toEqual(["m-1"]);
    expect(a.state).toEqual({ acked: 1, retried: 0 });
  });

  it("retries a transient send failure without blocking the rest of the batch", async () => {
    const { calls, deps: d } = deps({
      deliver: async (id) => {
        if (id === "bad") throw new Error("provider down");
        calls.delivered.push(id);
      },
    });
    const a = delivery({ type: "send_message", messageId: "bad" });
    const b = delivery({ type: "send_message", messageId: "good" });
    await handleBatch([a.d, b.d], d);
    expect(a.state).toEqual({ acked: 0, retried: 1 });
    expect(b.state).toEqual({ acked: 1, retried: 0 });
    expect(calls.delivered).toEqual(["good"]);
  });

  it("queues the message a processed job produced, after processing", async () => {
    const { calls, deps: d } = deps({ processJob: async () => ({ messageId: "m-9" }) });
    const a = delivery({ type: "process_job", jobId: "j-1" });
    await handleBatch([a.d], d);
    expect(calls.queued).toEqual([{ type: "send_message", messageId: "m-9" }]);
    expect(a.state).toEqual({ acked: 1, retried: 0 });
  });

  it("does not queue anything for a job that needs approval or was a duplicate", async () => {
    const { calls, deps: d } = deps();
    const a = delivery({ type: "process_job", jobId: "j-1" });
    await handleBatch([a.d], d);
    expect(calls.queued).toEqual([]);
    expect(a.state.acked).toBe(1);
  });

  it("records a failing job for backoff instead of retrying it through the queue", async () => {
    const { calls, deps: d } = deps({
      processJob: async () => {
        throw new Error("db down");
      },
    });
    const a = delivery({ type: "process_job", jobId: "j-2" });
    await handleBatch([a.d], d);
    expect(calls.failed).toEqual(["j-2"]);
    expect(a.state).toEqual({ acked: 1, retried: 0 });
  });

  it("retries when even the failure cannot be recorded", async () => {
    const { deps: d } = deps({
      processJob: async () => {
        throw new Error("db down");
      },
      recordJobFailure: async () => {
        throw new Error("still down");
      },
    });
    const a = delivery({ type: "process_job", jobId: "j-3" });
    await handleBatch([a.d], d);
    expect(a.state).toEqual({ acked: 0, retried: 1 });
  });

  it("retries a process_job whose follow-up could not be queued; the repeat is a no-op", async () => {
    const { deps: d } = deps({
      processJob: async () => ({ messageId: "m-1" }),
      enqueue: async () => {
        throw new Error("queue down");
      },
    });
    const a = delivery({ type: "process_job", jobId: "j-4" });
    await handleBatch([a.d], d);
    // Recording it as a job failure would double-count the attempt, so the queue retries instead.
    expect(a.state).toEqual({ acked: 0, retried: 1 });
  });

  it("classifies a reply by its id", async () => {
    const { calls, deps: d } = deps();
    const a = delivery({ type: "classify_reply", messageId: "m-1" });
    await handleBatch([a.d], d);
    expect(calls.classified).toEqual(["m-1"]);
    expect(a.state).toEqual({ acked: 1, retried: 0 });
  });

  it("retries a classification that failed for infrastructure reasons", async () => {
    const { deps: d } = deps({
      classifyReply: async () => {
        throw new Error("db down");
      },
    });
    const a = delivery({ type: "classify_reply", messageId: "m-2" });
    await handleBatch([a.d], d);
    expect(a.state).toEqual({ acked: 0, retried: 1 });
  });
});
