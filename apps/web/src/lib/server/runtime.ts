import {
  buildServices,
  createWithDb,
  type AppConfig,
  type FilesPort,
  type QueuePort,
  type Services,
} from "@repo/api";
import { createApp } from "@repo/api/hono";
import { env, waitUntil } from "cloudflare:workers";
import { ENV } from "varlock/env";

// The only module that touches Worker bindings. Import it from server code only.

/** A fresh database client per call, from the Hyperdrive binding (SPEC 9.1). */
export const withDb = createWithDb(() => env.HYPERDRIVE_APP.connectionString, waitUntil);
/** `duely_system`: webhook ingress only (D4). */
export const withSystemDb = createWithDb(() => env.HYPERDRIVE_SYSTEM.connectionString, waitUntil);

export const platformDomain = ENV.PLATFORM_DOMAIN;

/** Cookies are host-only on the app host (D20). */
export const authConfig = { baseURL: ENV.VITE_BASE_URL, secret: ENV.BETTER_AUTH_SECRET };

export const config: AppConfig = {
  platformDomain,
  appOrigin: ENV.VITE_BASE_URL,
  cnameTarget: ENV.CLOUDFLARE_CNAME_TARGET ?? `customers.${platformDomain}`,
  resendWebhookSecret: ENV.RESEND_WEBHOOK_SECRET ?? "",
  stripeWebhookSecret: ENV.STRIPE_CONNECT_WEBHOOK_SECRET ?? "",
  stripePublishableKey: ENV.STRIPE_PUBLISHABLE_KEY ?? "",
  emailFromAddress: ENV.EMAIL_FROM_ADDRESS ?? "billing@duely.app",
  portalSessionSecret: ENV.PORTAL_SESSION_SECRET ?? "",
};

function r2Files(): FilesPort {
  return {
    async put(key, body, contentType) {
      await env.FILES.put(key, body as ArrayBuffer, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await env.FILES.get(key);
      return object
        ? {
            body: object.body,
            contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
            size: object.size,
          }
        : null;
    },
  };
}

const queueProducer: QueuePort = {
  async send(message) {
    await env.QUEUE_MAIN.send(message);
  },
};

const built = buildServices({
  mode: ENV.SERVICES_MODE === "fake" ? "fake" : "live",
  stripeSecretKey: ENV.STRIPE_SECRET_KEY ?? "",
  anthropicApiKey: ENV.ANTHROPIC_API_KEY ?? "",
  aiModel: ENV.AI_MODEL,
  cloudflareApiToken: ENV.CLOUDFLARE_API_TOKEN ?? "",
  cloudflareZoneId: ENV.CLOUDFLARE_ZONE_ID ?? "",
  resendApiKey: ENV.RESEND_API_KEY ?? "",
  files: r2Files(),
  queue: queueProducer,
  systemConnectionString: () => env.HYPERDRIVE_SYSTEM.connectionString,
  config,
  waitUntil,
});

export const services: Services = built.services;
/** Fake mode only; `null` in live mode, which is what keeps the dev routes inert in production. */
export const fake = built.fake;

export const app = createApp({ withDb, withSystemDb, auth: authConfig, services, config });

// Start handlers only receive `{ request }`, so build the ExecutionContext Hono needs (ADR P0-04).
export const executionContext = {
  waitUntil,
  passThroughOnException() {},
} as unknown as ExecutionContext;
export { env };
