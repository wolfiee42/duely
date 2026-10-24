import type { CloudflareClient, CustomHostname, CustomHostnameStatus } from "./types";

const API = "https://api.cloudflare.com/client/v4";

type Fetch = typeof fetch;

export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
  /** Cloudflare rejects a hostname that another account or zone already uses (error 1406/1407). */
  get isDuplicate() {
    return this.code === 1406 || this.code === 1407;
  }
}

interface RawCustomHostname {
  id: string;
  hostname: string;
  status: string;
  verification_errors?: string[];
  ssl?: { status?: string; validation_errors?: Array<{ message?: string }> };
}

const SSL_IN_PROGRESS = new Set([
  "initializing",
  "pending_validation",
  "pending_issuance",
  "pending_deployment",
  "pending_cleanup",
]);

/** Folds Cloudflare's two state machines (hostname ownership, certificate) into the one we show. */
export function toCustomHostname(raw: RawCustomHostname): CustomHostname {
  const sslStatus = raw.ssl?.status ?? null;
  const errors = [
    ...(raw.verification_errors ?? []),
    ...(raw.ssl?.validation_errors ?? []).map((e) => e.message ?? ""),
  ].filter(Boolean);

  let status: CustomHostnameStatus;
  if (raw.status === "active" && sslStatus === "active") status = "active";
  else if (["blocked", "moved", "deleted", "pending_deletion"].includes(raw.status))
    status = "failed";
  else if (sslStatus && !SSL_IN_PROGRESS.has(sslStatus) && sslStatus !== "active")
    status = "failed";
  // The CNAME is seen but the certificate is still being issued.
  else if (raw.status === "active") status = "verifying";
  else status = "pending";

  return { id: raw.id, hostname: raw.hostname, status, sslStatus, errors };
}

export function createCloudflareClient(
  apiToken: string,
  zoneId: string,
  fetchImpl: Fetch = fetch,
): CloudflareClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await fetchImpl(`${API}/zones/${zoneId}/custom_hostnames${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    const json = (await res.json().catch(() => ({}))) as {
      result?: T;
      errors?: Array<{ code?: number; message?: string }>;
    };
    if (!res.ok) {
      const first = json.errors?.[0];
      throw new CloudflareApiError(res.status, first?.code, first?.message ?? "Cloudflare error");
    }
    return json.result ?? null;
  }

  return {
    async createCustomHostname(hostname) {
      const raw = await call<RawCustomHostname>("POST", "", {
        hostname,
        // HTTP validation works once the CNAME points at us, so the firm only adds one DNS record.
        ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
      });
      if (!raw) throw new CloudflareApiError(502, undefined, "Cloudflare returned no hostname");
      return toCustomHostname(raw);
    },
    async getCustomHostname(id) {
      const raw = await call<RawCustomHostname>("GET", `/${encodeURIComponent(id)}`);
      return raw ? toCustomHostname(raw) : null;
    },
    async deleteCustomHostname(id) {
      await call("DELETE", `/${encodeURIComponent(id)}`);
    },
  };
}
