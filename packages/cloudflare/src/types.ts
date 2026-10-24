/** Mirrors `firm_domains.status` (SPEC 2.2). */
export type CustomHostnameStatus = "pending" | "verifying" | "active" | "failed";

export interface CustomHostname {
  id: string;
  hostname: string;
  status: CustomHostnameStatus;
  /** Cloudflare's certificate state, kept for display and troubleshooting. */
  sslStatus: string | null;
  /** Plain messages from Cloudflare about why verification is stuck. Empty when nothing is wrong. */
  errors: string[];
}

/** The slice of Cloudflare for SaaS (custom hostnames) that Duely uses. */
export interface CloudflareClient {
  createCustomHostname(hostname: string): Promise<CustomHostname>;
  /** `null` when Cloudflare no longer knows the hostname (it expires unverified ones). */
  getCustomHostname(id: string): Promise<CustomHostname | null>;
  /** Idempotent: deleting something already gone succeeds. */
  deleteCustomHostname(id: string): Promise<void>;
}
