import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createQueue, createTriggerQueue, TRIGGER_TASK_IDS } from "./queue";
import { createMemoryQueue } from "./services";

afterEach(() => vi.unstubAllGlobals());

describe("trigger queue producer", () => {
  it("posts the message as the payload of the task for its type", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await createTriggerQueue({ secretKey: "tr_dev_1" }).send({ type: "process_job", jobId: "j-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://api.trigger.dev/api/v1/tasks/${TRIGGER_TASK_IDS.process_job}/trigger`,
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tr_dev_1");
    expect(JSON.parse(init.body as string)).toEqual({
      payload: { type: "process_job", jobId: "j-1" },
    });
  });

  it("throws when Trigger.dev refuses, so the caller can retry or requeue later", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    await expect(
      createTriggerQueue({ secretKey: "bad" }).send({ type: "send_message", messageId: "m-1" }),
    ).rejects.toThrow("401");
  });
});

describe("createQueue", () => {
  it("routes to the Cloudflare binding by default and refuses a half-configured provider", async () => {
    const memory = createMemoryQueue();
    await createQueue("cloudflare", { cloudflareBinding: memory }).send({
      type: "classify_reply",
      messageId: "m-1",
    });
    expect(memory.messages).toHaveLength(1);
    expect(() => createQueue("trigger", {})).toThrow("TRIGGER_SECRET_KEY");
    expect(() => createQueue("cloudflare", {})).toThrow("QUEUE_MAIN");
  });
});
