import type { JobRunner, QueueMessage } from "@repo/api";

export interface Delivery {
  body: QueueMessage;
  ack(): void;
  retry(): void;
}

/** Cloudflare Queues glue: the runner decides what a message means; a throw becomes a queue retry. */
export async function handleBatch(batch: readonly Delivery[], runner: Pick<JobRunner, "handle">) {
  for (const delivery of batch) {
    try {
      await runner.handle(delivery.body);
      delivery.ack();
    } catch {
      delivery.retry();
    }
  }
}
