import { deliverMessage, requeueStaleMessages, type AppConfig, type QueueMessage } from "@repo/api";
import { createDb } from "@repo/db";
import { createResendClient } from "@repo/email";

import { handleBatch } from "./consumer";

// D24: scheduled() runs the tick, queue() consumes jobs. The web Worker only produces to the queue.

interface Env {
  HYPERDRIVE_SYSTEM: Hyperdrive;
  QUEUE_MAIN: Queue<QueueMessage>;
  RESEND_API_KEY: string;
  PLATFORM_DOMAIN: string;
  APP_ORIGIN: string;
  EMAIL_FROM_ADDRESS: string;
}

// Only what delivering email needs; the rest of the app config belongs to the web Worker.
const configOf = (env: Env): AppConfig => ({
  platformDomain: env.PLATFORM_DOMAIN,
  appOrigin: env.APP_ORIGIN,
  emailFromAddress: env.EMAIL_FROM_ADDRESS,
  stripeWebhookSecret: "",
  stripePublishableKey: "",
  portalSessionSecret: "",
});

/** A fresh client per invocation, closed afterwards (SPEC 9.1). */
async function withSystemDb<T>(
  env: Env,
  fn: (db: ReturnType<typeof createDb>["db"]) => Promise<T>,
) {
  const { db, close } = createDb(env.HYPERDRIVE_SYSTEM.connectionString);
  try {
    return await fn(db);
  } finally {
    await close();
  }
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    const email = createResendClient(env.RESEND_API_KEY);
    await handleBatch(batch.messages, {
      deliver: (messageId) =>
        withSystemDb(env, (db) => deliverMessage(db, { email, config: configOf(env) }, messageId)),
      log: (event, data) => console.warn(event, data),
    });
  },

  // Every minute: re-enqueue anything that committed but never reached the queue (crash between commit and enqueue).
  async scheduled(_controller: ScheduledController, env: Env) {
    const requeued = await withSystemDb(env, (db) =>
      requeueStaleMessages(db, {
        send: async (message) => {
          await env.QUEUE_MAIN.send(message);
        },
      }),
    );
    if (requeued) console.warn("jobs.requeued_stale_messages", { count: requeued });
  },
};
