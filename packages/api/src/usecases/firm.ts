import { realNow } from "@repo/clock";
import { firmSlugExists, resolveMembership, uniqueViolation, withTenant, type Db } from "@repo/db";
import { firms, members } from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import { eq, sql } from "drizzle-orm";

import { isValidPlatformSlug } from "../host/host";
import { audit, type Actor } from "./audit";

export interface NewFirmUser {
  id: string;
  email: string;
  name: string;
}

export interface CreateFirmInput {
  legalName: string;
  displayName: string;
  platformSlug: string;
}

/** Signup step 2: the new user's firm and its owner member, in one short transaction. */
export async function createFirm(
  db: Db,
  user: NewFirmUser,
  input: CreateFirmInput,
  requestId?: string,
) {
  if (!isValidPlatformSlug(input.platformSlug)) {
    throw new DomainError("firm.invalid_slug", "validation", "That address is not available.");
  }
  if (await resolveMembership(db, user.id)) {
    throw new DomainError("firm.already_member", "conflict", "You already belong to a firm.");
  }

  // The tenant id is chosen here so the firm's own RLS check passes on insert.
  const tenantId = crypto.randomUUID();
  try {
    await withTenant(db, tenantId, async (tx) => {
      await tx.insert(firms).values({ id: tenantId, ...input });
      const [member] = await tx
        .insert(members)
        .values({ tenantId, userId: user.id, email: user.email, name: user.name, role: "owner" })
        .returning({ id: members.id });
      await audit(
        tx,
        { tenantId, type: "member", id: member!.id, requestId },
        "firm.created",
        { type: "firm", id: tenantId },
        { after: { platformSlug: input.platformSlug, displayName: input.displayName } },
      );
    });
  } catch (error) {
    // Lost a race with the pre-checks.
    const constraint = uniqueViolation(error);
    if (constraint === "firms_platform_slug_key") {
      throw new DomainError("firm.slug_taken", "conflict", "That address is already taken.");
    }
    if (constraint === "members_user_id_key") {
      throw new DomainError("firm.already_member", "conflict", "You already belong to a firm.");
    }
    throw error;
  }
  return { tenantId };
}

export async function getFirm(db: Db, tenantId: string) {
  const [firm] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: firms.id,
        platformSlug: firms.platformSlug,
        legalName: firms.legalName,
        displayName: firms.displayName,
        timezone: firms.timezone,
        brandPrimary: firms.brandPrimary,
        brandAccent: firms.brandAccent,
        replyToEmail: firms.replyToEmail,
        defaultTermsDays: firms.defaultTermsDays,
        invoicePrefix: firms.invoicePrefix,
        hasLogo: sql<boolean>`${firms.logoUrl} is not null`,
        stripeAccountId: firms.stripeAccountId,
        stripeChargesEnabled: firms.stripeChargesEnabled,
        stripePayoutsEnabled: firms.stripePayoutsEnabled,
        stripeDetailsSubmitted: firms.stripeDetailsSubmitted,
        isDemo: firms.isDemo,
      })
      .from(firms)
      .where(eq(firms.id, tenantId)),
  );
  if (!firm) throw new DomainError("firm.not_found", "not_found");
  return firm;
}

export async function slugAvailable(db: Db, slug: string) {
  return isValidPlatformSlug(slug) && !(await firmSlugExists(db, slug));
}

export interface FirmSettingsPatch {
  legalName?: string;
  displayName?: string;
  timezone?: string;
  replyToEmail?: string | null;
  brandPrimary?: string;
  brandAccent?: string | null;
  defaultTermsDays?: number;
  invoicePrefix?: string;
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Owner-only (FR-1.5). The platform slug is deliberately not editable here. */
export async function updateFirmSettings(db: Db, actor: Actor, patch: FirmSettingsPatch) {
  if (patch.timezone !== undefined && !validTimezone(patch.timezone)) {
    throw new DomainError("firm.invalid_timezone", "validation", "Choose a valid timezone.");
  }
  await withTenant(db, actor.tenantId, async (tx) => {
    const [before] = await tx.select().from(firms).where(eq(firms.id, actor.tenantId));
    if (!before) throw new DomainError("firm.not_found", "not_found");
    await tx
      .update(firms)
      .set({ ...patch, updatedAt: realNow() })
      .where(eq(firms.id, actor.tenantId));
    await audit(
      tx,
      actor,
      "firm.updated",
      { type: "firm", id: actor.tenantId },
      {
        before: Object.fromEntries(
          Object.keys(patch).map((k) => [k, (before as Record<string, unknown>)[k]]),
        ),
        after: patch,
      },
    );
  });
}

export async function setFirmLogo(db: Db, actor: Actor, key: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    await tx
      .update(firms)
      .set({ logoUrl: key, updatedAt: realNow() })
      .where(eq(firms.id, actor.tenantId));
    await audit(tx, actor, "firm.logo_changed", { type: "firm", id: actor.tenantId });
  });
}

export async function getFirmLogoKey(db: Db, tenantId: string) {
  const [row] = await withTenant(db, tenantId, (tx) =>
    tx.select({ key: firms.logoUrl }).from(firms).where(eq(firms.id, tenantId)),
  );
  return row?.key ?? null;
}
