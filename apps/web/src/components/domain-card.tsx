import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";

import { StatusBadge } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

const settings = getRouteApi("/_staff/app/settings");

const MESSAGES: Record<string, string> = {
  "domain.invalid_hostname": "Enter a domain like billing.yourfirm.com.",
  "domain.needs_subdomain": "Use a subdomain such as billing.yourfirm.com.",
  "domain.reserved": "That address belongs to us. Use a domain you own.",
  "domain.taken": "That domain is already in use. Use a different one.",
  "domain.already_set": "Remove your current domain before adding another.",
  "domain.provider_unavailable": "We couldn't do that just now. Please try again in a moment.",
};

const LABELS = {
  pending: "Waiting for DNS",
  verifying: "Securing",
  active: "Live",
  failed: "Needs attention",
} as const;

/** Owners only. One custom domain per firm; the Duely address keeps working throughout. */
export function DomainCard() {
  const { trpc } = settings.useRouteContext();
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const query = useQuery({
    ...trpc.domains.list.queryOptions(),
    // The poller updates the row every minute; keep the screen current while the firm waits on DNS.
    refetchInterval: (q) =>
      q.state.data?.some((d) => d.status === "pending" || d.status === "verifying")
        ? 15_000
        : false,
  });
  const domain = query.data?.[0];
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.domains.list.queryKey() });
  const onError = (error: unknown) =>
    toast.add({
      type: "error",
      description:
        MESSAGES[trpcErrorInfo(error).domainCode ?? ""] ??
        "Something went wrong. Please try again.",
    });

  const add = useMutation(trpc.domains.add.mutationOptions({ onSuccess: refresh, onError }));
  const check = useMutation(
    trpc.domains.check.mutationOptions({
      onSuccess: async (result) => {
        await refresh();
        if (result.status === "active")
          toast.add({ type: "success", description: "Domain is live." });
      },
      onError,
    }),
  );
  const remove = useMutation(
    trpc.domains.remove.mutationOptions({
      onSuccess: async () => {
        setConfirmRemove(false);
        await refresh();
      },
      onError,
    }),
  );

  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;

  if (!domain) {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({
            hostname: field(new FormData(e.currentTarget), "hostname"),
            idempotencyKey: crypto.randomUUID(),
          });
        }}
      >
        <Label htmlFor="hostname">Show invoices on your own address</Label>
        <div className="flex gap-2">
          <Input
            id="hostname"
            name="hostname"
            placeholder="billing.yourfirm.com"
            autoComplete="off"
            required
          />
          <Button type="submit" size="sm" disabled={add.isPending}>
            Add domain
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Your Duely address keeps working. You'll add one DNS record at your domain provider.
        </p>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium break-all" data-testid="domain-hostname">
          {domain.hostname}
        </span>
        <StatusBadge status={domain.status} label={LABELS[domain.status]} />
      </div>

      {domain.status === "active" ? (
        <p>Clients now get links on this address. Your Duely address keeps working too.</p>
      ) : (
        <>
          <p>Add this record where you manage DNS for your domain:</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border bg-muted p-3 font-mono text-xs">
            <dt className="text-muted-foreground">Type</dt>
            <dd>CNAME</dd>
            <dt className="text-muted-foreground">Name</dt>
            <dd className="break-all">{domain.cname.name}</dd>
            <dt className="text-muted-foreground">Target</dt>
            <dd className="break-all">{domain.cname.target}</dd>
          </dl>
          {domain.hint && (
            <p className="text-muted-foreground" data-testid="domain-hint">
              {domain.hint}
            </p>
          )}
        </>
      )}

      <div className="flex items-center gap-2">
        {domain.status !== "active" && (
          <Button
            size="sm"
            variant="outline"
            disabled={check.isPending}
            onClick={() => check.mutate({ domainId: domain.id })}
          >
            {check.isPending ? "Checking…" : "Check now"}
          </Button>
        )}
        {confirmRemove ? (
          <>
            <span className="text-xs text-muted-foreground">
              Links already sent on this address will stop working.
            </span>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ domainId: domain.id })}
            >
              Remove
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
