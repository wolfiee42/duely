import type { QueueMessage } from "@repo/api";

export interface Delivery {
  body: QueueMessage;
  ack(): void;
  retry(): void;
}

export interface ConsumerDeps {
  /** Runs one `send_message`. Throws on a transient failure; returns on success, duplicate or permanent failure. */
  deliver(messageId: string): Promise<unknown>;
  log(event: string, data: Record<string, unknown>): void;
}

/**
 * D13: payloads are ids only. A duplicate or already-handled message is a no-op inside `deliver`, so the only
 * decision here is ack versus retry. A transient failure is retried by the queue; after `max_retries` the
 * message lands in the dead-letter queue.
 */
export async function handleBatch(batch: readonly Delivery[], deps: ConsumerDeps) {
  for (const delivery of batch) {
    const message = delivery.body;
    if (message.type !== "send_message") {
      // Other job types arrive with the collections engine; acknowledging avoids a poison loop meanwhile.
      deps.log("jobs.unhandled_type", { type: message.type });
      delivery.ack();
      continue;
    }
    try {
      await deps.deliver(message.messageId);
      delivery.ack();
    } catch (error) {
      deps.log("jobs.send_message_failed", {
        messageId: message.messageId,
        error: error instanceof Error ? error.message : "error",
      });
      delivery.retry();
    }
  }
}
