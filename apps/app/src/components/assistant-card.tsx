import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { field } from "#/lib/form.ts";

const settings = getRouteApi("/_staff/_app/settings");

const PURPOSES: Record<string, string> = {
  extraction: "Reading invoices",
  draft: "Writing reminders",
  classify: "Reading replies",
  risk_explain: "Payment outlook",
};

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** What the assistant has cost this month, the monthly limit, and whether it may act on clear replies. */
export function AssistantCard({ isOwner }: { isOwner: boolean }) {
  const { trpc } = settings.useRouteContext();
  const queryClient = useQueryClient();
  const { data: usage } = useSuspenseQuery(trpc.ai.usage.queryOptions());
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.ai.usage.queryKey() });
  const save = useMutation(
    trpc.ai.updateSettings.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.add({ type: "success", description: "Saved." });
      },
      onError: () =>
        toast.add({ type: "error", description: "Enter a limit between $0 and $1,000." }),
    }),
  );
  const off = usage.capCents === 0 || !usage.available;
  const used = Math.min(
    100,
    Math.round((usage.spentMicros / Math.max(1, usage.capCents * 10_000)) * 100),
  );

  return (
    <div className="grid gap-4 text-sm">
      <p className="text-muted-foreground">
        The assistant reads uploaded invoices, writes reminder drafts, reads replies and explains
        payment outlook. You approve what it drafts unless you choose otherwise.
      </p>
      {!usage.available ? (
        <p data-testid="assistant-status">
          The assistant isn't available right now. Everything still works by hand.
        </p>
      ) : off ? (
        <p data-testid="assistant-status">
          The assistant is switched off. Set a monthly limit to turn it on.
        </p>
      ) : usage.spentMicros >= usage.capCents * 10_000 ? (
        <p data-testid="assistant-status">
          You've reached this month's limit, so the assistant is paused until next month.
        </p>
      ) : (
        <p data-testid="assistant-status">The assistant is on.</p>
      )}

      <div>
        <div className="flex justify-between">
          <span>This month</span>
          <span className="tabular-nums" data-testid="assistant-spend">
            {dollars(usage.spentMicros)} of ${(usage.capCents / 100).toFixed(2)}
          </span>
        </div>
        <div className="mt-1 h-2 rounded-full bg-muted" role="presentation">
          <div className="h-2 rounded-full bg-primary" style={{ width: `${used}%` }} />
        </div>
      </div>

      {Object.keys(usage.byPurpose).length > 0 && (
        <ul className="divide-y">
          {Object.entries(usage.byPurpose).map(([purpose, v]) => (
            <li key={purpose} className="flex justify-between py-1.5">
              <span>{PURPOSES[purpose] ?? purpose}</span>
              <span className="text-muted-foreground tabular-nums">
                {v.calls} {v.calls === 1 ? "use" : "uses"} · {dollars(v.costMicros)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const value = Number(field(new FormData(e.currentTarget), "limit"));
              save.mutate({ capCents: Math.round(value * 100) });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="ai-limit">Monthly limit ($)</Label>
              <Input
                id="ai-limit"
                name="limit"
                type="number"
                min={0}
                max={1000}
                step="0.01"
                defaultValue={(usage.capCents / 100).toFixed(2)}
                required
              />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={save.isPending}>
              Save limit
            </Button>
          </form>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={usage.autoActions}
              onChange={(e) => save.mutate({ autoActions: e.target.checked })}
            />
            <span>
              Act on clear replies without asking me
              <span className="block text-xs text-muted-foreground">
                When a client clearly promises a date or disputes an invoice, record it and pause
                reminders. Anything unclear still comes to you. A reply that says they've paid never
                marks the invoice paid.
              </span>
            </span>
          </label>
        </>
      )}
    </div>
  );
}
