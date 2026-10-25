import { Button } from "@repo/ui/components/button";
import { toast } from "@repo/ui/components/toast";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { PortalTrpc } from "#/lib/trpc/portal.ts";

interface Props {
  invoiceId: string;
  trpc: PortalTrpc;
  /** Called after a payment is confirmed so the page can refetch. */
  onPaid: () => void;
}

/**
 * Live mode: Stripe's Payment Element on the firm's connected account. No card or bank data ever touches
 * our servers (SPEC 7). Test mode (no publishable key): a labelled button that stands in for Stripe.
 */
export function PayPanel({ invoiceId, trpc, onPaid }: Props) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<{
    clientSecret: string;
    stripeAccountId: string;
    publishableKey: string;
    amountMinor: number;
    tenantId: string;
  } | null>(null);

  const start = useMutation(
    trpc.invoices.createPayment.mutationOptions({
      onSuccess: setSession,
      onError: () =>
        toast.add({
          type: "error",
          description: "Payment isn't available right now. Please try again shortly.",
        }),
    }),
  );

  const simulate = useMutation({
    mutationFn: async (s: NonNullable<typeof session>) => {
      const res = await fetch("/api/dev/simulate-payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intentId: s.clientSecret.replace(/_secret$/, ""),
          accountId: s.stripeAccountId,
          invoiceId,
          tenantId: s.tenantId,
          amountMinor: s.amountMinor,
        }),
      });
      if (!res.ok) throw new Error("simulate failed");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onPaid();
    },
  });

  const stripePromise = useMemo(
    () =>
      session?.publishableKey
        ? loadStripe(session.publishableKey, { stripeAccount: session.stripeAccountId })
        : null,
    [session],
  );

  if (!session) {
    return (
      <Button
        size="lg"
        disabled={start.isPending}
        onClick={() => start.mutate({ invoiceId, idempotencyKey: crypto.randomUUID() })}
      >
        {start.isPending ? "Preparing..." : "Pay now"}
      </Button>
    );
  }

  if (!stripePromise) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-dashed p-4">
        <p className="text-sm text-muted-foreground" role="note">
          Test mode: no real payment is taken.
        </p>
        <Button size="lg" disabled={simulate.isPending} onClick={() => simulate.mutate(session)}>
          {simulate.isPending ? "Paying..." : "Pay (test mode)"}
        </Button>
      </div>
    );
  }

  return (
    <Elements stripe={stripePromise} options={{ clientSecret: session.clientSecret }}>
      <CheckoutForm onPaid={onPaid} />
    </Elements>
  );
}

function CheckoutForm({ onPaid }: { onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!stripe || !elements) return;
        setBusy(true);
        const { error } = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        setBusy(false);
        if (error)
          toast.add({
            type: "error",
            description: error.message ?? "The payment didn't go through.",
          });
        else onPaid();
      }}
    >
      <PaymentElement />
      <Button type="submit" size="lg" disabled={!stripe || busy}>
        {busy ? "Processing..." : "Pay"}
      </Button>
    </form>
  );
}
