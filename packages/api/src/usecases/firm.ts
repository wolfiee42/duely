import { firmSlugExists, resolveMembership, uniqueViolation, withTenant, type Db } from "@repo/db";
import { firms, members } from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import { eq } from "drizzle-orm";

import { isValidPlatformSlug } from "../host/host";
import { audit } from "./audit";

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
