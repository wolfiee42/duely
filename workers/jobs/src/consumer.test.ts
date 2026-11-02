import { describe, expect, it } from "vite-plus/test";

import { handleBatch, type Delivery } from "./consumer";

const delivery = (body: Delivery["body"]) => {
  const state = { acked: 0, retried: 0 };
  return {
    state,
    d: { body, ack: () => state.acked++, retry: () => state.retried++ } satisfies Delivery,
  };
};

describe("queue consumer", () => {
  it("acks what the runner handled and retries what it threw on, without blocking the batch", async () => {
    const handled: string[] = [];
    const runner = {
      handle: async (m: Delivery["body"]) => {
        if (m.type === "send_message" && m.messageId === "bad") throw new Error("provider down");
        handled.push(m.type === "process_job" ? m.jobId : m.messageId);
      },
    };
    const a = delivery({ type: "send_message", messageId: "bad" });
    const b = delivery({ type: "process_job", jobId: "j-1" });
    await handleBatch([a.d, b.d], runner);
    expect(a.state).toEqual({ acked: 0, retried: 1 });
    expect(b.state).toEqual({ acked: 1, retried: 0 });
    expect(handled).toEqual(["j-1"]);
  });
});
