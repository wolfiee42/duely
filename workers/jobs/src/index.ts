import { createAnthropicModel } from "@repo/ai";
import {
  createCloudflareQueue,
  createJobRunner,
  type AppConfig,
  type QueueMessage,
} from "@repo/api";
import { createCloudflareClient } from "@repo/cloudflare";
import { createDb } from "@repo/db";
import { createResendClient } from "@repo/email";

import { handleBatch } from "./consumer";

// Cloudflare adapter for background work (D24): queue() consumes messages and scheduled() ticks, both
// through the provider-agnostic job runner. workers/trigger is the Trigger.dev equivalent; run only one.

interface Env {
  HYPERDRIVE_SYSTEM: Hyperdrive;
  QUEUE_MAIN: Queue<QueueMessage>;
  RESEND_API_KEY: string;
  PLATFORM_DOMAIN: string;
  APP_ORIGIN: string;
  EMAIL_FROM_ADDRESS: string;
  ANTHROPIC_API_KEY?: string;
  AI_MODEL?: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;
}

// Only what delivering email needs; the rest of the app config belongs to the web Worker.
const configOf = (env: Env): AppConfig => ({
  platformDomain: env.PLATFORM_DOMAIN,
  appOrigin: env.APP_ORIGIN,
  emailFromAddress: env.EMAIL_FROM_ADDRESS,
  cnameTarget: "",
  demoEnabled: false,
  resendWebhookSecret: "",
  stripeWebhookSecret: "",
  stripePublishableKey: "",
  portalSessionSecret: "",
});

/** A fresh database client per unit of work, closed afterwards (SPEC 9.1). */
const runnerOf = (env: Env) =>
  createJobRunner({
    withSystemDb: async (fn) => {
      const { db, close } = createDb(env.HYPERDRIVE_SYSTEM.connectionString);
      try {
        return await fn(db);
      } finally {
        await close();
      }
    },
    email: createResendClient(env.RESEND_API_KEY),
    cloudflare: createCloudflareClient(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ZONE_ID),
    // AI is optional: without a key every reminder uses the plain template.
    model: env.ANTHROPIC_API_KEY
      ? createAnthropicModel(env.ANTHROPIC_API_KEY, env.AI_MODEL || undefined)
      : null,
    config: configOf(env),
    queue: createCloudflareQueue(env.QUEUE_MAIN),
    log: (event, data) => console.warn(event, data),
  });

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    await handleBatch(batch.messages, runnerOf(env));
  },

  async scheduled(_controller: ScheduledController, env: Env) {
    await runnerOf(env).tick();
  },
};
