import { createAnthropicModel } from "@repo/ai";
import { createHeuristicModel } from "@repo/ai/fake";
import { createCloudflareClient } from "@repo/cloudflare";
import { createFakeCloudflare } from "@repo/cloudflare/fake";
import { createDb } from "@repo/db";
import { createResendClient } from "@repo/email";
import { createFakeEmail, type FakeEmail } from "@repo/email/fake";
import { createStripeClient } from "@repo/stripe";
import { createFakeStripe } from "@repo/stripe/fake";

import {
  createMemoryFiles,
  createMemoryQueue,
  type AppConfig,
  type FilesPort,
  type QueuePort,
  type Services,
} from "./services";
import { classifyReply } from "./usecases/classify";
import { deliverMessage } from "./usecases/outbox";

export interface BuildServicesOptions {
  /** `fake` keeps everything in memory and delivers the outbox inline. For local dev and E2E only. */
  mode: "live" | "fake";
  stripeSecretKey: string;
  /** Empty disables AI features in live mode. */
  anthropicApiKey: string;
  aiModel?: string;
  cloudflareApiToken: string;
  cloudflareZoneId: string;
  resendApiKey: string;
  /** Real bindings, used in `live` mode. */
  files: FilesPort;
  queue: QueuePort;
  /** Connection string for `duely_system`, used to deliver the outbox inline in `fake` mode. */
  systemConnectionString: () => string;
  config: AppConfig;
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface FakeControls {
  outbox(): FakeEmail["sent"];
  /** Stands in for the hosted Stripe onboarding form. */
  completeOnboarding(accountId: string): void;
  /** Stands in for DNS and certificate issuance finishing. */
  activateDomain(hostname: string): void;
}

/** Wires the ports to real providers, or to in-memory fakes. */
export function buildServices(opts: BuildServicesOptions): {
  services: Services;
  fake: FakeControls | null;
} {
  if (opts.mode === "live") {
    return {
      services: {
        model: opts.anthropicApiKey
          ? createAnthropicModel(opts.anthropicApiKey, opts.aiModel || undefined)
          : null,
        cloudflare: createCloudflareClient(opts.cloudflareApiToken, opts.cloudflareZoneId),
        stripe: createStripeClient(opts.stripeSecretKey),
        email: createResendClient(opts.resendApiKey),
        files: opts.files,
        queue: opts.queue,
      },
      fake: null,
    };
  }

  if (opts.config.platformDomain !== "localhost") {
    throw new Error("SERVICES_MODE=fake is only allowed when PLATFORM_DOMAIN is localhost");
  }
  const email = createFakeEmail();
  const model = createHeuristicModel();
  const stripe = createFakeStripe();
  const cloudflare = createFakeCloudflare();
  const memory = createMemoryQueue();
  const queue: QueuePort = {
    async send(message) {
      await memory.send(message);
      if (message.type !== "send_message" && message.type !== "classify_reply") return;
      // No jobs worker in fake mode: do the work right after the response.
      opts.waitUntil(
        (async () => {
          const { db, close } = createDb(opts.systemConnectionString());
          try {
            if (message.type === "send_message") {
              await deliverMessage(db, { email, config: opts.config }, message.messageId);
            } else {
              await classifyReply(db, { model }, message.messageId);
            }
          } finally {
            await close();
          }
        })(),
      );
    },
  };
  return {
    services: {
      model,
      cloudflare,
      stripe,
      email,
      files: createMemoryFiles(),
      queue,
    },
    fake: {
      outbox: () => email.sent,
      completeOnboarding: (id) => stripe.completeOnboarding(id),
      activateDomain: (hostname) =>
        cloudflare.set(hostname, { status: "active", sslStatus: "active", errors: [] }),
    },
  };
}
