import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { DomainCard } from "#/components/domain-card.tsx";
import { Card, fieldClass, Page } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/app/settings")({
  component: Settings,
});

const MESSAGES: Record<string, string> = {
  "member.owner_required": "Only an owner can change this.",
  "member.already_member": "That person is already on your team.",
  "firm.invalid_timezone": "Choose a valid timezone.",
};

function Settings() {
  const { trpc, host } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(trpc.firm.get.queryOptions());
  const { data: team } = useSuspenseQuery(trpc.members.list.queryOptions());
  const { data: stripe } = useSuspenseQuery(trpc.stripe.status.queryOptions());
  const isOwner = data.role === "owner";
  const firm = data.firm;
  // `stripe.status` syncs the flags from Stripe, so it is fresher than the firm row loaded alongside it.
  const paymentsReady = stripe.connected ? stripe.chargesEnabled : firm.stripeChargesEnabled;
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (stripe.connected && stripe.chargesEnabled !== firm.stripeChargesEnabled) {
      void queryClient.invalidateQueries({ queryKey: trpc.firm.get.queryKey() });
    }
  }, [stripe, firm.stripeChargesEnabled, queryClient, trpc]);

  const onError = (error: unknown) =>
    toast.add({
      type: "error",
      description:
        MESSAGES[trpcErrorInfo(error).domainCode ?? ""] ??
        "Something went wrong. Please try again.",
    });
  const refreshFirm = () => queryClient.invalidateQueries({ queryKey: trpc.firm.get.queryKey() });

  const update = useMutation(
    trpc.firm.update.mutationOptions({
      onSuccess: async () => {
        await refreshFirm();
        toast.add({ type: "success", description: "Settings saved." });
      },
      onError,
    }),
  );
  const connect = useMutation(
    trpc.stripe.connectLink.mutationOptions({
      onSuccess: ({ url }) => window.location.assign(url),
      onError,
    }),
  );
  const invite = useMutation(
    trpc.members.invite.mutationOptions({
      onSuccess: async ({ token }) => {
        await queryClient.invalidateQueries({ queryKey: trpc.members.list.queryKey() });
        // Email delivery for invites is not wired yet, so the owner shares the link themselves.
        setInviteLink(`${host.appOrigin}/join?token=${token}`);
      },
      onError,
    }),
  );
  const revoke = useMutation(
    trpc.members.revokeInvite.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.members.list.queryKey() }),
      onError,
    }),
  );

  async function uploadLogo(file: File) {
    setUploading(true);
    try {
      const res = await fetch("/api/files/logo", {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(String(res.status));
      await refreshFirm();
      toast.add({ type: "success", description: "Logo updated." });
    } catch {
      toast.add({ type: "error", description: "Use a PNG, JPEG or WebP image under 2 MB." });
    } finally {
      setUploading(false);
    }
  }

  return (
    <Page title="Settings">
      <Card title="Payments">
        {paymentsReady ? (
          <p className="text-sm">
            Payments are connected. Clients can pay by card or bank transfer.
          </p>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">
              {firm.stripeAccountId
                ? "Finish setting up your payout account to start sending invoices."
                : "Connect a payout account so clients can pay you online."}
            </p>
            {isOwner ? (
              <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                {firm.stripeAccountId ? "Continue setup" : "Connect payments"}
              </Button>
            ) : (
              <p className="text-sm">Ask an owner to connect payments.</p>
            )}
          </div>
        )}
        <p className="sr-only" data-testid="stripe-status">
          {stripe.connected ? "connected" : "not connected"}
        </p>
      </Card>

      <Card title="Branding">
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            update.mutate({
              displayName: field(f, "displayName"),
              legalName: field(f, "legalName"),
              brandPrimary: field(f, "brandPrimary"),
              invoicePrefix: field(f, "invoicePrefix"),
              defaultTermsDays: Number(f.get("defaultTermsDays")),
              timezone: field(f, "timezone"),
              replyToEmail: field(f, "replyToEmail") || null,
            });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="displayName">Display name</Label>
            <Input
              id="displayName"
              name="displayName"
              defaultValue={firm.displayName}
              disabled={!isOwner}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="legalName">Legal name</Label>
            <Input
              id="legalName"
              name="legalName"
              defaultValue={firm.legalName}
              disabled={!isOwner}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brandPrimary">Brand color</Label>
            <Input
              id="brandPrimary"
              name="brandPrimary"
              type="color"
              defaultValue={firm.brandPrimary}
              disabled={!isOwner}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invoicePrefix">Invoice prefix</Label>
            <Input
              id="invoicePrefix"
              name="invoicePrefix"
              defaultValue={firm.invoicePrefix}
              disabled={!isOwner}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="defaultTermsDays">Payment terms (days)</Label>
            <Input
              id="defaultTermsDays"
              name="defaultTermsDays"
              type="number"
              min={0}
              max={365}
              defaultValue={firm.defaultTermsDays}
              disabled={!isOwner}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="timezone">Timezone</Label>
            <Input
              id="timezone"
              name="timezone"
              defaultValue={firm.timezone}
              disabled={!isOwner}
              required
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="replyToEmail">Reply-to email</Label>
            <Input
              id="replyToEmail"
              name="replyToEmail"
              type="email"
              defaultValue={firm.replyToEmail ?? ""}
              disabled={!isOwner}
            />
          </div>
          {isOwner && (
            <Button type="submit" className="sm:w-fit" disabled={update.isPending}>
              Save
            </Button>
          )}
        </form>
        {isOwner && (
          <div className="mt-4 border-t pt-4">
            <Label htmlFor="logo">Logo {firm.hasLogo ? "(uploaded)" : ""}</Label>
            <input
              id="logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className={`${fieldClass} mt-1.5`}
              disabled={uploading}
              onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])}
            />
          </div>
        )}
      </Card>

      {isOwner && (
        <Card title="Custom domain">
          <DomainCard />
        </Card>
      )}

      <Card title="Team">
        <ul className="mb-3 divide-y text-sm">
          {team.members.map((m) => (
            <li key={m.id} className="flex justify-between py-2">
              <span>
                {m.name ?? m.email} <span className="text-muted-foreground">{m.email}</span>
              </span>
              <span className="text-muted-foreground">{m.role}</span>
            </li>
          ))}
          {team.invites.map((i) => (
            <li key={i.id} className="flex items-center justify-between py-2">
              <span>
                {i.email} <span className="text-muted-foreground">invited</span>
              </span>
              <Button variant="outline" size="xs" onClick={() => revoke.mutate({ inviteId: i.id })}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
        {isOwner && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              invite.mutate(
                { email: field(new FormData(form), "email"), role: "member" },
                { onSuccess: () => form.reset() },
              );
            }}
          >
            <Input
              name="email"
              type="email"
              placeholder="teammate@example.com"
              aria-label="Teammate email"
              required
            />
            <Button type="submit" size="sm" disabled={invite.isPending}>
              Invite
            </Button>
          </form>
        )}
        {inviteLink && (
          <p
            className="mt-2 rounded-md border bg-muted p-2 font-mono text-xs break-all"
            data-testid="invite-link"
          >
            {inviteLink}
          </p>
        )}
      </Card>
    </Page>
  );
}
