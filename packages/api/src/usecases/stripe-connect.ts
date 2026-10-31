import { realNow } from "@repo/clock";
import { withTenant, type Db } from "@repo/db";
import { firms, members } from "@repo/db/schema";
import { DomainError } from "@repo/domain";
import type { ConnectedAccountStatus, StripeClient } from "@repo/stripe";
import { and, eq, isNull } from "drizzle-orm";

import type { WithDb } from "../db";
import { audit, type Actor } from "./audit";

/** Writes Stripe's capability flags onto the firm. Used by the status refresh and by `account.updated`. */
export async function applyAccountStatus(
  db: Db,
  tenantId: string,
  status: ConnectedAccountStatus,
  actor?: Actor,
) {
  await withTenant(db, tenantId, async (tx) => {
    const [before] = await tx.select().from(firms).where(eq(firms.id, tenantId));
    if (!before) return;
    const changed =
      before.stripeChargesEnabled !== status.chargesEnabled ||
      before.stripePayoutsEnabled !== status.payoutsEnabled ||
      before.stripeDetailsSubmitted !== status.detailsSubmitted;
    if (!changed) return;
    await tx
      .update(firms)
      .set({
        stripeChargesEnabled: status.chargesEnabled,
        stripePayoutsEnabled: status.payoutsEnabled,
        stripeDetailsSubmitted: status.detailsSubmitted,
        updatedAt: realNow(),
      })
      .where(eq(firms.id, tenantId));
    await audit(
      tx,
      actor ?? { tenantId, type: "stripe", id: status.id },
      "stripe.account_updated",
      { type: "firm", id: tenantId },
      {
        before: {
          chargesEnabled: before.stripeChargesEnabled,
          payoutsEnabled: before.stripePayoutsEnabled,
        },
        after: { chargesEnabled: status.chargesEnabled, payoutsEnabled: status.payoutsEnabled },
      },
    );
  });
}

/** Owner-only. Creates the connected account on first use, then returns a fresh onboarding link. */
export async function startConnectOnboarding(
  withDb: WithDb,
  stripe: StripeClient,
  actor: Actor,
  ownerEmail: string,
  appOrigin: string,
) {
  const existing = await withDb((db) =>
    withTenant(db, actor.tenantId, async (tx) => {
      const [firm] = await tx
        .select({ id: firms.stripeAccountId })
        .from(firms)
        .where(eq(firms.id, actor.tenantId));
      return firm?.id ?? null;
    }),
  );

  let accountId = existing;
  if (!accountId) {
    // Network call: outside any transaction (D22).
    const created = await stripe.createExpressAccount({
      email: ownerEmail,
      firmId: actor.tenantId,
    });
    accountId = await withDb((db) =>
      withTenant(db, actor.tenantId, async (tx) => {
        // Guarded so two simultaneous clicks cannot overwrite each other; the loser adopts the winner's account.
        const claimed = await tx
          .update(firms)
          .set({ stripeAccountId: created.id })
          .where(and(eq(firms.id, actor.tenantId), isNull(firms.stripeAccountId)))
          .returning({ id: firms.stripeAccountId });
        if (claimed.length) {
          await audit(
            tx,
            actor,
            "stripe.account_created",
            { type: "firm", id: actor.tenantId },
            { after: { accountId: created.id } },
          );
          return created.id;
        }
        const [firm] = await tx
          .select({ id: firms.stripeAccountId })
          .from(firms)
          .where(eq(firms.id, actor.tenantId));
        return firm!.id!;
      }),
    );
  }

  const link = await stripe.createAccountLink({
    accountId,
    returnUrl: `${appOrigin}/app/settings?stripe=return`,
    refreshUrl: `${appOrigin}/app/settings?stripe=refresh`,
  });
  return { url: link.url };
}

/** Pulls the live flags from Stripe, stores them, and returns them. */
export async function refreshConnectStatus(withDb: WithDb, stripe: StripeClient, actor: Actor) {
  const firm = await withDb((db) =>
    withTenant(db, actor.tenantId, async (tx) => {
      const [row] = await tx
        .select({
          id: firms.stripeAccountId,
          chargesEnabled: firms.stripeChargesEnabled,
          payoutsEnabled: firms.stripePayoutsEnabled,
          detailsSubmitted: firms.stripeDetailsSubmitted,
        })
        .from(firms)
        .where(eq(firms.id, actor.tenantId));
      return row;
    }),
  );
  const accountId = firm?.id;
  if (!accountId) return { connected: false as const };
  // The demo seed stamps a made-up account id that Stripe has never heard of; its flags are already final.
  if (accountId.startsWith("acct_demo_")) {
    return {
      connected: true as const,
      id: accountId,
      chargesEnabled: firm.chargesEnabled,
      payoutsEnabled: firm.payoutsEnabled,
      detailsSubmitted: firm.detailsSubmitted,
    };
  }
  const status = await stripe.retrieveAccount(accountId);
  await withDb((db) => applyAccountStatus(db, actor.tenantId, status, actor));
  return { connected: true as const, ...status };
}

export async function ownerEmail(db: Db, tenantId: string, memberId: string) {
  const [m] = await withTenant(db, tenantId, (tx) =>
    tx.select({ email: members.email }).from(members).where(eq(members.id, memberId)),
  );
  if (!m) throw new DomainError("member.not_found", "not_found");
  return m.email;
}
