import type { EmailClient } from "@repo/email";
import type { StripeClient } from "@repo/stripe";

// Ports for everything outside Postgres. Runtime wires real adapters (apps/web, workers/jobs);
// tests wire in-memory fakes, so default runs never touch a remote service.

export interface FilesPort {
  put(
    key: string,
    body: ReadableStream | ArrayBuffer | Uint8Array,
    contentType: string,
  ): Promise<void>;
  get(
    key: string,
  ): Promise<{ body: ReadableStream | Uint8Array; contentType: string; size: number } | null>;
}

/** D13: queue payloads are ids only; consumers re-read everything from the database. */
export type QueueMessage =
  | { type: "send_message"; messageId: string }
  | { type: "process_job"; jobId: string }
  | { type: "classify_reply"; messageId: string };

export interface QueuePort {
  send(message: QueueMessage): Promise<void>;
}

export interface Services {
  stripe: StripeClient;
  email: EmailClient;
  files: FilesPort;
  queue: QueuePort;
}

export interface AppConfig {
  /** `duely.app` in production, `localhost` locally. */
  platformDomain: string;
  /** Public origin of the app host, e.g. `https://app.duely.app`. */
  appOrigin: string;
  stripeWebhookSecret: string;
  /** Public key the payer's browser uses with Stripe Elements. */
  stripePublishableKey: string;
  /** Sender for every outbound email, e.g. `billing@duely.app`. */
  emailFromAddress: string;
  /** Signs portal session cookies. */
  portalSessionSecret: string;
}

/** `https://acme.duely.app` from the app origin `https://app.duely.app`. Works for `*.localhost:3000` too. */
export function portalOrigin(appOrigin: string, slug: string): string {
  const url = new URL(appOrigin);
  return `${url.protocol}//${slug}.${url.host.replace(/^app\./, "")}`;
}

export function createMemoryFiles(): FilesPort & {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
} {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    async put(key, body, contentType) {
      const bytes =
        body instanceof ReadableStream
          ? new Uint8Array(await new Response(body).arrayBuffer())
          : new Uint8Array(body as ArrayBuffer);
      objects.set(key, { bytes, contentType });
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { body: o.bytes, contentType: o.contentType, size: o.bytes.byteLength } : null;
    },
  };
}

export function createMemoryQueue(): QueuePort & { messages: QueueMessage[] } {
  const messages: QueueMessage[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
    },
  };
}
