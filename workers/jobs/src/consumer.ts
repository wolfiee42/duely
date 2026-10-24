import type { QueueMessage } from "@repo/api";

export interface Delivery {
  body: QueueMessage;
  ack(): void;
  retry(): void;
}

export interface ConsumerDeps {
  /** Runs one `send_message`. Throws on a transient failure; returns on success, duplicate or permanent failure. */
  deliver(messageId: string): Promise<unknown>;
  /** Runs one `process_job`. Returns the id of a message to send, if the job produced one that needs no approval. */
  processJob(jobId: string): Promise<{ messageId?: string }>;
  /** Records a failed job so the scheduler retries it with backoff, or buries it after too many attempts. */
  recordJobFailure(jobId: string, error: string): Promise<unknown>;
  /** Puts a follow-up message on the queue. Called only after the producing transaction has committed. */
  enqueue(message: QueueMessage): Promise<void>;
  log(event: string, data: Record<string, unknown>): void;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : "error");

/**
 * D13: payloads are ids only. A duplicate or already-handled message is a no-op inside `deliver` and
 * `processJob`, so the only decision here is ack versus retry. A transient `send_message` failure is retried
 * by the queue and, after `max_retries`, lands in the dead-letter queue. A failing `process_job` is not
 * retried by the queue: the job records the failure and the scheduler picks it up again with backoff.
 */
export async function handleBatch(batch: readonly Delivery[], deps: ConsumerDeps) {
  for (const delivery of batch) {
    const message = delivery.body;
    try {
      if (message.type === "send_message") {
        await deps.deliver(message.messageId);
      } else if (message.type === "process_job") {
        let produced: { messageId?: string };
        try {
          produced = await deps.processJob(message.jobId);
        } catch (error) {
          deps.log("jobs.process_job_failed", { jobId: message.jobId, error: errorText(error) });
          await deps.recordJobFailure(message.jobId, errorText(error));
          delivery.ack();
          continue;
        }
        // If this throws, the queue retries; processing the job again finds its message and returns it.
        if (produced.messageId) {
          await deps.enqueue({ type: "send_message", messageId: produced.messageId });
        }
      } else {
        // Other job types arrive with the inbound pipeline; acknowledging avoids a poison loop meanwhile.
        deps.log("jobs.unhandled_type", { type: message.type });
      }
      delivery.ack();
    } catch (error) {
      deps.log("jobs.message_failed", { type: message.type, error: errorText(error) });
      delivery.retry();
    }
  }
}
