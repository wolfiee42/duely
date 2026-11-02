import { createAnthropicModel } from "@repo/ai";
import { createJobRunner, createTriggerQueue, type AppConfig } from "@repo/api";
import { createCloudflareClient } from "@repo/cloudflare";
import { createDb } from "@repo/db";
import { createResendClient } from "@repo/email";

// Trigger.dev run environment: set these in the dashboard (Environment variables). TRIGGER_SECRET_KEY and
// TRIGGER_API_URL are provided to every run automatically.
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in the Trigger.dev environment`);
  return value;
};

/** Built per run, so a task never keeps a database client or provider handle between runs (SPEC 9.1). */
export function createRunner() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const config: AppConfig = {
    platformDomain: required("PLATFORM_DOMAIN"),
    appOrigin: required("APP_ORIGIN"),
    emailFromAddress: required("EMAIL_FROM_ADDRESS"),
    // Only what delivering email needs; the rest of the app config belongs to the web Worker.
    cnameTarget: "",
    demoEnabled: false,
    resendWebhookSecret: "",
    stripeWebhookSecret: "",
    stripePublishableKey: "",
    portalSessionSecret: "",
  };

  return createJobRunner({
    withSystemDb: async (fn) => {
      const { db, close } = createDb(required("SYSTEM_DATABASE_URL"));
      try {
        return await fn(db);
      } finally {
        await close();
      }
    },
    email: createResendClient(required("RESEND_API_KEY")),
    cloudflare: createCloudflareClient(
      required("CLOUDFLARE_API_TOKEN"),
      required("CLOUDFLARE_ZONE_ID"),
    ),
    model: anthropicKey
      ? createAnthropicModel(anthropicKey, process.env.AI_MODEL || undefined)
      : null,
    config,
    queue: createTriggerQueue({
      secretKey: required("TRIGGER_SECRET_KEY"),
      apiUrl: process.env.TRIGGER_API_URL,
    }),
    log: (event, data) => console.warn(event, data),
  });
}
