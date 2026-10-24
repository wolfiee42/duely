import { describe, expect, it } from "vite-plus/test";

import { handleBatch, type Delivery } from "./consumer";

const delivery = (body: Delivery["body"]) => {
  const state = { acked: 0, retried: 0 };
  return {
    state,
    d: { body, ack: () => state.acked++, retry: () => state.retried++ } satisfies Delivery,
  };
};
const noLog = { log: () => {} };

describe("queue consumer", () => {
  it("acks a delivered message and passes only its id", async () => {
    const seen: string[] = [];
    const a = delivery({ type: "send_message", messageId: "m-1" });
    await handleBatch([a.d], { ...noLog, deliver: async (id) => void seen.push(id) });
    expect(seen).toEqual(["m-1"]);
    expect(a.state).toEqual({ acked: 1, retried: 0 });
  });

  it("retries a transient failure without blocking the rest of the batch", async () => {
    const a = delivery({ type: "send_message", messageId: "bad" });
    const b = delivery({ type: "send_message", messageId: "good" });
    const done: string[] = [];
    await handleBatch([a.d, b.d], {
      ...noLog,
      deliver: async (id) => {
        if (id === "bad") throw new Error("provider down");
        done.push(id);
      },
    });
    expect(a.state).toEqual({ acked: 0, retried: 1 });
    expect(b.state).toEqual({ acked: 1, retried: 0 });
    expect(done).toEqual(["good"]);
  });

  it("acknowledges job types it does not handle yet instead of looping on them", async () => {
    const a = delivery({ type: "process_job", jobId: "j-1" });
    let delivered = 0;
    await handleBatch([a.d], { ...noLog, deliver: async () => void delivered++ });
    expect(delivered).toBe(0);
    expect(a.state).toEqual({ acked: 1, retried: 0 });
  });
});
