import { resolveTenantByHost } from "@repo/db";

import type { WithDb } from "../db";

export type HostKind = "marketing" | "app" | "portal";

/** Platform slugs that can never belong to a firm (SPEC 1.4). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "app",
  "www",
  "api",
  "inbound",
  "mail",
  "admin",
  "status",
  "docs",
  "assets",
]);

// 3 to 30 characters, lowercase letters, digits and inner hyphens.
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;

export function isValidPlatformSlug(slug: string): boolean {
  return SLUG.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** What the host looks like, before any database lookup. */
export type HostClass =
  | { kind: "marketing" }
  | { kind: "app" }
  /** A valid slug under the platform domain. The firm still has to exist. */
  | { kind: "portal"; via: "platform" }
  /** Not under the platform domain, so it can only be an `active` custom domain. */
  | { kind: "portal"; via: "custom" };

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

// Letters, digits, dots and hyphens only. Rejects anything odd before it reaches a query.
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Pure, table-tested (SPEC 1.4). Unknown or malformed hosts return `null` and get a generic 404.
 * `platformDomain` is `duely.app` in production and `localhost` locally, so `acme.localhost`
 * takes the same path as `acme.duely.app`.
 */
export function resolveHostKind(host: string | null, platformDomain: string): HostClass | null {
  if (!host) return null;
  const h = normalizeHost(host);
  if (!HOSTNAME.test(h)) return null;
  if (h === platformDomain || h === `www.${platformDomain}`) return { kind: "marketing" };
  if (h === `app.${platformDomain}`) return { kind: "app" };
  const suffix = `.${platformDomain}`;
  if (!h.endsWith(suffix)) return { kind: "portal", via: "custom" };
  return isValidPlatformSlug(h.slice(0, -suffix.length))
    ? { kind: "portal", via: "platform" }
    : null;
}

export interface HostContext {
  hostKind: HostKind;
  /** Set for portal hosts only. Staff tenant comes from the members row, not the host (D20). */
  tenantId: string | null;
}

/** Classifies the host and, for portal hosts, resolves the tenant. `null` means a generic 404. */
export async function resolveHostContext(
  host: string | null,
  platformDomain: string,
  withDb: WithDb,
): Promise<HostContext | null> {
  const cls = resolveHostKind(host, platformDomain);
  if (!cls) return null;
  if (cls.kind !== "portal") return { hostKind: cls.kind, tenantId: null };
  const resolved = await withDb((db) =>
    resolveTenantByHost(db, normalizeHost(host!), platformDomain),
  );
  return resolved ? { hostKind: "portal", tenantId: resolved.tenantId } : null;
}
