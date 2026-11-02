import type { QueueMessage, QueuePort } from "./services";

// Producer adapters for `QueuePort`. Each one only knows how to hand a message to a provider; running
// the message is `createJobRunner`'s job, wired up by that provider's consumer (workers/jobs,
// workers/trigger). To add a provider, add a producer here and a consumer next to the others.

export type QueueProvider = "cloudflare" | "trigger";

/** Cloudflare Queues: the Worker binding already has the right shape. */
export function createCloudflareQueue(binding: { send(message: QueueMessage): Promise<unknown> }) {
  return { send: async (message) => void (await binding.send(message)) } satisfies QueuePort;
}

/** Trigger.dev task ids, one per message type. The Trigger.dev project registers a task under each. */
export const TRIGGER_TASK_IDS = {
  send_message: "send-message",
  process_job: "process-job",
  classify_reply: "classify-reply",
} as const satisfies Record<QueueMessage["type"], string>;

export interface TriggerQueueOptions {
  /** Environment secret key (`tr_dev_…` or `tr_prod_…`). */
  secretKey: string;
  /** Defaults to Trigger.dev cloud; set it for a self-hosted instance. */
  apiUrl?: string;
}

/**
 * Trigger.dev over its REST API, so it works inside a Cloudflare Worker without the Node SDK. No
 * idempotency key: handlers are idempotent (D13), and a key would block the scheduler's legitimate
 * re-send of the same job or message.
 */
export function createTriggerQueue({
  secretKey,
  apiUrl = "https://api.trigger.dev",
}: TriggerQueueOptions): QueuePort {
  return {
    async send(message) {
      const response = await fetch(
        `${apiUrl.replace(/\/$/, "")}/api/v1/tasks/${TRIGGER_TASK_IDS[message.type]}/trigger`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
          body: JSON.stringify({ payload: message }),
        },
      );
      if (!response.ok) throw new Error(`Trigger.dev rejected ${message.type}: ${response.status}`);
    },
  };
}

/** Picks the producer for the configured provider. The Cloudflare binding is only needed for `cloudflare`. */
export function createQueue(
  provider: QueueProvider,
  deps: {
    cloudflareBinding?: { send(message: QueueMessage): Promise<unknown> };
    trigger?: TriggerQueueOptions;
  },
): QueuePort {
  if (provider === "trigger") {
    if (!deps.trigger?.secretKey)
      throw new Error("QUEUE_PROVIDER=trigger needs TRIGGER_SECRET_KEY");
    return createTriggerQueue(deps.trigger);
  }
  if (!deps.cloudflareBinding)
    throw new Error("QUEUE_PROVIDER=cloudflare needs the QUEUE_MAIN binding");
  return createCloudflareQueue(deps.cloudflareBinding);
}
