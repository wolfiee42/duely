import {
  deliverMessage,
  pollDomains,
  requeueStaleMessages,
  type AppConfig,
  type QueueMessage,
} from "@repo/api";
import { createCloudflareClient } from "@repo/cloudflare";
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
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;
}

// Only what delivering email needs; the rest of the app config belongs to the web Worker.
const configOf = (env: Env): AppConfig => ({
  platformDomain: env.PLATFORM_DOMAIN,
  appOrigin: env.APP_ORIGIN,
  emailFromAddress: env.EMAIL_FROM_ADDRESS,
  cnameTarget: "",
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

  // Every minute (SPEC 4.2). Each step is independent: one failing must not starve the next.
  async scheduled(_controller: ScheduledController, env: Env) {
    // Re-enqueue anything that committed but never reached the queue (crash between commit and enqueue).
    const requeue = withSystemDb(env, (db) =>
      requeueStaleMessages(db, {
        send: async (message) => {
          await env.QUEUE_MAIN.send(message);
        },
      }),
    ).then((count) => {
      if (count) console.warn("jobs.requeued_stale_messages", { count });
    });

    // Custom domains still waiting on DNS or a certificate.
    const cloudflare = createCloudflareClient(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ZONE_ID);
    const domains = withSystemDb(env, (db) => pollDomains(db, cloudflare)).then((result) => {
      if (result.failures) console.warn("jobs.domain_poll_failures", result);
    });

    const results = await Promise.allSettled([requeue, domains]);
    for (const r of results) {
      if (r.status === "rejected")
        console.warn("jobs.tick_step_failed", { error: String(r.reason) });
    }
  },
};
