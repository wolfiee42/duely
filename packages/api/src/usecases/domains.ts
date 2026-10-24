import { realNow } from "@repo/clock";
import { CloudflareApiError, type CloudflareClient, type CustomHostname } from "@repo/cloudflare";
import { withSystemTenant, withTenant, type Db, type Tx } from "@repo/db";
import { firmDomains } from "@repo/db/schema";
import { DomainError, domainHint, parseCustomHostname } from "@repo/domain";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { WithDb } from "../db";
import { portalOrigin } from "../services";
import { audit, type Actor } from "./audit";

/** Runs a unit of work inside one tenant: via the request's `duely_app` connection or the worker's system one. */
export type TenantScope = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;

export const requestScope =
  (withDb: WithDb): TenantScope =>
  (tenantId, fn) =>
    withDb((db) => withTenant(db, tenantId, fn));

export const systemScope =
  (systemDb: Db): TenantScope =>
  (tenantId, fn) =>
    withSystemTenant(systemDb, tenantId, fn);

/** A row created but never given a Cloudflare id means the add was interrupted; give up after this long. */
const INTERRUPTED_AFTER_MS = 5 * 60_000;

type DomainRow = typeof firmDomains.$inferSelect;

export function domainView(row: DomainRow, cnameTarget: string) {
  const errors = Array.isArray(row.verificationErrors) ? (row.verificationErrors as string[]) : [];
  return {
    id: row.id,
    hostname: row.hostname,
    status: row.status,
    sslStatus: row.sslStatus,
    errors,
    lastCheckedAt: row.lastCheckedAt,
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
    /** The one DNS record the firm must create (FR-7.2). */
    cname: { name: row.hostname, target: cnameTarget },
    hint: domainHint({
      status: row.status,
      errors,
      ageMinutes: Math.max(0, Math.floor((realNow().getTime() - row.createdAt.getTime()) / 60_000)),
    }),
  };
}

export async function listDomains(scope: TenantScope, tenantId: string, cnameTarget: string) {
  const rows = await scope(tenantId, (tx) => tx.select().from(firmDomains));
  return rows.map((row) => domainView(row, cnameTarget));
}

// The driver error may arrive wrapped, with the Postgres error as `cause`.
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("code" in error && error.code === "23505") ||
    ("cause" in error && isUniqueViolation(error.cause)));

/**
 * FR-7.1/7.2. The row is written first, which is what enforces uniqueness across firms; Cloudflare is called
 * after commit (no network in a transaction, D22), and its id is attached afterwards. If Cloudflare refuses,
 * the row is removed so the firm can try again.
 */
export async function addDomain(
  scope: TenantScope,
  cloudflare: CloudflareClient,
  actor: Actor,
  input: string,
  config: { platformDomain: string; cnameTarget: string },
) {
  const hostname = parseCustomHostname(input, config.platformDomain);

  const row = await scope(actor.tenantId, async (tx) => {
    try {
      // A savepoint keeps a duplicate from aborting the whole transaction before we can explain it.
      return await tx.transaction(async (inner) => {
        const [created] = await inner
          .insert(firmDomains)
          .values({ tenantId: actor.tenantId, hostname, status: "pending" })
          .returning();
        await audit(
          inner,
          actor,
          "domain.added",
          { type: "domain", id: created!.id },
          { after: { hostname } },
        );
        return created!;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either this firm already has a domain, or another firm owns the hostname. RLS hides which, by design.
      const own = await tx.select({ id: firmDomains.id }).from(firmDomains);
      throw own.length
        ? new DomainError(
            "domain.already_set",
            "conflict",
            "Remove your current domain before adding another.",
          )
        : new DomainError(
            "domain.taken",
            "conflict",
            "That domain is already in use. Use a different one.",
          );
    }
  });

  let created: CustomHostname;
  try {
    created = await cloudflare.createCustomHostname(hostname);
  } catch (error) {
    await scope(actor.tenantId, async (tx) => {
      await tx.delete(firmDomains).where(eq(firmDomains.id, row.id));
      await audit(
        tx,
        actor,
        "domain.add_failed",
        { type: "domain", id: row.id },
        { hostname, reason: error instanceof Error ? error.message : "error" },
      );
    });
    if (error instanceof CloudflareApiError && error.isDuplicate) {
      throw new DomainError(
        "domain.taken",
        "conflict",
        "That domain is already in use. Use a different one.",
      );
    }
    throw new DomainError(
      "domain.provider_unavailable",
      "unprocessable",
      "We couldn't set that up just now. Please try again in a moment.",
    );
  }

  const [saved] = await scope(actor.tenantId, (tx) =>
    tx
      .update(firmDomains)
      .set({
        cfCustomHostnameId: created.id,
        status: created.status,
        sslStatus: created.sslStatus,
        verificationErrors: created.errors,
        lastCheckedAt: realNow(),
      })
      .where(eq(firmDomains.id, row.id))
      .returning(),
  );
  return domainView(saved!, config.cnameTarget);
}

/**
 * Asks Cloudflare where one domain stands and records it (FR-7.3, 7.4). Used by the manual "check now" button
 * and by the poller. Returns the stored row, or `null` if it disappeared meanwhile.
 */
export async function refreshDomain(
  scope: TenantScope,
  cloudflare: CloudflareClient,
  actor: Actor,
  domainId: string,
): Promise<DomainRow | null> {
  const row = await scope(actor.tenantId, async (tx) => {
    const [r] = await tx.select().from(firmDomains).where(eq(firmDomains.id, domainId));
    return r;
  });
  if (!row) return null;

  let remote: CustomHostname | null;
  if (!row.cfCustomHostnameId) {
    if (realNow().getTime() - row.createdAt.getTime() < INTERRUPTED_AFTER_MS) return row;
    remote = null; // Cloudflare never heard of it: the add was interrupted.
  } else {
    remote = await cloudflare.getCustomHostname(row.cfCustomHostnameId); // network: outside the transaction
  }

  const next = remote
    ? {
        status: remote.status,
        sslStatus: remote.sslStatus,
        errors: remote.errors,
      }
    : {
        status: "failed" as const,
        sslStatus: row.sslStatus,
        errors: ["This domain wasn't verified in time."],
      };

  return scope(actor.tenantId, async (tx) => {
    const now = realNow();
    const [updated] = await tx
      .update(firmDomains)
      .set({
        status: next.status,
        sslStatus: next.sslStatus,
        verificationErrors: next.errors,
        lastCheckedAt: now,
        activatedAt: next.status === "active" ? (row.activatedAt ?? now) : row.activatedAt,
      })
      .where(eq(firmDomains.id, domainId))
      .returning();
    if (updated && row.status !== next.status) {
      await audit(
        tx,
        actor,
        "domain.status_changed",
        { type: "domain", id: domainId },
        { before: { status: row.status }, after: { status: next.status } },
      );
    }
    return updated ?? null;
  });
}

export async function checkDomain(
  scope: TenantScope,
  cloudflare: CloudflareClient,
  actor: Actor,
  domainId: string,
  cnameTarget: string,
) {
  const row = await refreshDomain(scope, cloudflare, actor, domainId);
  if (!row) throw new DomainError("domain.not_found", "not_found");
  return domainView(row, cnameTarget);
}

/**
 * FR-7.7. Cloudflare is asked to release the hostname first; if that fails the row stays so the firm can retry.
 * Once the row is gone the host stops resolving at once and the platform subdomain carries on.
 */
export async function removeDomain(
  scope: TenantScope,
  cloudflare: CloudflareClient,
  actor: Actor,
  domainId: string,
) {
  const row = await scope(actor.tenantId, async (tx) => {
    const [r] = await tx.select().from(firmDomains).where(eq(firmDomains.id, domainId));
    return r;
  });
  if (!row) throw new DomainError("domain.not_found", "not_found");

  if (row.cfCustomHostnameId) {
    try {
      await cloudflare.deleteCustomHostname(row.cfCustomHostnameId);
    } catch {
      throw new DomainError(
        "domain.provider_unavailable",
        "unprocessable",
        "We couldn't remove that just now. Please try again in a moment.",
      );
    }
  }
  await scope(actor.tenantId, async (tx) => {
    const removed = await tx.delete(firmDomains).where(eq(firmDomains.id, domainId)).returning();
    if (removed.length) {
      await audit(
        tx,
        actor,
        "domain.removed",
        { type: "domain", id: domainId },
        { before: { hostname: row.hostname, status: row.status } },
      );
    }
  });
}

/**
 * The tick's domain poll (SPEC 4.2): `pending|verifying` domains last checked over a minute ago. A failure for
 * one domain never stops the others.
 */
export async function pollDomains(
  systemDb: Db,
  cloudflare: CloudflareClient,
  { olderThanSeconds = 60, limit = 50 } = {},
) {
  const due = await systemDb
    .select({ id: firmDomains.id, tenantId: firmDomains.tenantId })
    .from(firmDomains)
    .where(
      and(
        inArray(firmDomains.status, ["pending", "verifying"]),
        or(
          isNull(firmDomains.lastCheckedAt),
          lt(firmDomains.lastCheckedAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
        ),
      ),
    )
    .orderBy(sql`${firmDomains.lastCheckedAt} asc nulls first`)
    .limit(limit);

  const scope = systemScope(systemDb);
  let failures = 0;
  for (const { id, tenantId } of due) {
    try {
      await refreshDomain(scope, cloudflare, { tenantId, type: "system", id: null }, id);
    } catch {
      failures++;
    }
  }
  return { checked: due.length, failures };
}

/** The origin clients should be sent to: the firm's `active` custom domain, else its platform subdomain (FR-7.5, 7.6). */
export async function firmPortalOrigin(
  tx: Tx,
  appOrigin: string,
  firm: { id: string; platformSlug: string },
): Promise<string> {
  const [active] = await tx
    .select({ hostname: firmDomains.hostname })
    .from(firmDomains)
    .where(and(eq(firmDomains.tenantId, firm.id), eq(firmDomains.status, "active")));
  return active
    ? `${new URL(appOrigin).protocol}//${active.hostname}`
    : portalOrigin(appOrigin, firm.platformSlug);
}
