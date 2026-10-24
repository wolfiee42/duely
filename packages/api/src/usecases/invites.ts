import { realNow } from "@repo/clock";
import { resolveInvite, uniqueViolation, withTenant, type Db } from "@repo/db";
import { memberInvites, members } from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import { and, eq, isNull } from "drizzle-orm";

import { audit, type Actor } from "./audit";

const INVITE_DAYS = 7;

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url. Only the hash is stored (SPEC 7). */
function newToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Re-inviting an address replaces its open invite. Returns the token once; email delivery comes with the outbox. */
export async function inviteMember(
  db: Db,
  actor: Actor,
  email: string,
  role: "owner" | "member" = "member",
) {
  const address = email.trim().toLowerCase();
  const token = newToken();
  const expiresAt = new Date(realNow().getTime() + INVITE_DAYS * 86_400_000);
  await withTenant(db, actor.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: members.id })
      .from(members)
      .where(eq(members.email, address));
    if (existing)
      throw new DomainError(
        "member.already_member",
        "conflict",
        "That person is already a member.",
      );
    await tx
      .delete(memberInvites)
      .where(and(eq(memberInvites.email, address), isNull(memberInvites.acceptedAt)));
    const [invite] = await tx
      .insert(memberInvites)
      .values({
        tenantId: actor.tenantId,
        email: address,
        role,
        tokenHash: await sha256Hex(token),
        invitedBy: actor.id!,
        expiresAt,
      })
      .returning({ id: memberInvites.id });
    await audit(
      tx,
      actor,
      "member.invited",
      { type: "member_invite", id: invite!.id },
      { after: { email: address, role } },
    );
  });
  return { token, expiresAt };
}

export async function listInvites(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: memberInvites.id,
        email: memberInvites.email,
        role: memberInvites.role,
        expiresAt: memberInvites.expiresAt,
      })
      .from(memberInvites)
      .where(isNull(memberInvites.acceptedAt)),
  );
}

export async function revokeInvite(db: Db, actor: Actor, inviteId: string) {
  await withTenant(db, actor.tenantId, async (tx) => {
    const gone = await tx
      .delete(memberInvites)
      .where(and(eq(memberInvites.id, inviteId), isNull(memberInvites.acceptedAt)))
      .returning({ id: memberInvites.id });
    if (!gone.length) throw new DomainError("invite.not_found", "not_found");
    await audit(tx, actor, "member.invite_revoked", { type: "member_invite", id: inviteId });
  });
}

/** What the join page shows before sign-in. Unknown, used and expired tokens look the same. */
export async function previewInvite(db: Db, token: string) {
  const invite = await resolveInvite(db, await sha256Hex(token));
  if (!invite || invite.acceptedAt || invite.expiresAt <= realNow()) {
    throw new DomainError("invite.invalid", "not_found", "This invite is no longer valid.");
  }
  return { firmName: invite.firmName, email: invite.email };
}

export async function acceptInvite(
  db: Db,
  user: { id: string; email: string; name: string },
  token: string,
  requestId?: string,
) {
  const invite = await resolveInvite(db, await sha256Hex(token));
  if (!invite || invite.acceptedAt || invite.expiresAt <= realNow()) {
    throw new DomainError("invite.invalid", "not_found", "This invite is no longer valid.");
  }
  // The link alone is not enough: it must be used by the invited address.
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new DomainError(
      "invite.wrong_account",
      "forbidden",
      "Sign in with the invited email address.",
    );
  }
  try {
    await withTenant(db, invite.tenantId, async (tx) => {
      // Single use: only one concurrent accept can flip accepted_at.
      const claimed = await tx
        .update(memberInvites)
        .set({ acceptedAt: realNow(), acceptedByUserId: user.id })
        .where(and(eq(memberInvites.id, invite.inviteId), isNull(memberInvites.acceptedAt)))
        .returning({ id: memberInvites.id });
      if (!claimed.length)
        throw new DomainError("invite.invalid", "not_found", "This invite is no longer valid.");
      const [member] = await tx
        .insert(members)
        .values({
          tenantId: invite.tenantId,
          userId: user.id,
          email: user.email,
          name: user.name,
          role: invite.role,
        })
        .returning({ id: members.id });
      await audit(
        tx,
        { tenantId: invite.tenantId, type: "member", id: member!.id, requestId },
        "member.joined",
        { type: "member", id: member!.id },
        { after: { role: invite.role } },
      );
    });
  } catch (error) {
    if (uniqueViolation(error) === "members_user_id_key") {
      throw new DomainError("firm.already_member", "conflict", "You already belong to a firm.");
    }
    throw error;
  }
  return { tenantId: invite.tenantId };
}
