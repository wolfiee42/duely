import { TRIGGER_TASK_IDS, type QueueMessage } from "@repo/api";
import { schedules, task } from "@trigger.dev/sdk";

import { createRunner } from "./runner";

// Mirrors the Cloudflare queue settings: 5 retries with backoff. A message that exhausts them shows as a
// failed run in the dashboard, which is the dead-letter queue's equivalent.
const retry = { maxAttempts: 6, factor: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 300_000 };
const queue = { concurrencyLimit: 10 };

// The runner throws on a transient failure; Trigger.dev retries the run. Handlers are idempotent (D13).
const messageTask = <T extends QueueMessage["type"]>(type: T) =>
  task({
    id: TRIGGER_TASK_IDS[type],
    retry,
    queue,
    run: (payload: Extract<QueueMessage, { type: T }>) => createRunner().handle(payload),
  });

export const sendMessage = messageTask("send_message");
export const processJob = messageTask("process_job");
export const classifyReply = messageTask("classify_reply");

/** Every minute (SPEC 4.2). */
export const tick = schedules.task({
  id: "tick",
  cron: "* * * * *",
  // A slow tick must not pile up behind itself; the next one picks up what is still due.
  queue: { concurrencyLimit: 1 },
  run: () => createRunner().tick(),
});
