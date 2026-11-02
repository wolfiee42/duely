import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/portal/login")({
  validateSearch: z.object({ link: z.literal("invalid").optional() }),
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.query(context.portalTrpc.auth.me.queryOptions());
    if (me.contact) throw redirect({ to: "/portal" });
  },
  head: () => ({ meta: [{ title: "Sign in" }] }),
  component: PortalLogin,
});

function PortalLogin() {
  const { portalTrpc } = Route.useRouteContext();
  const { link } = Route.useSearch();
  const [sent, setSent] = useState(false);

  const request = useMutation(
    portalTrpc.auth.requestLink.mutationOptions({
      onSuccess: () => setSent(true),
      onError: (error) =>
        toast.add({
          type: "error",
          description:
            trpcErrorInfo(error).code === "TOO_MANY_REQUESTS"
              ? "Too many requests. Try again in a few minutes."
              : "Something went wrong. Please try again.",
        }),
    }),
  );

  if (sent) {
    return (
      <div className="flex flex-col gap-2 text-center" role="status">
        <h1 className="text-2xl font-bold tracking-tight">Check your email</h1>
        <p className="text-sm text-muted-foreground">
          If that address has invoices with us, a sign-in link is on its way. It works once and
          expires in 15 minutes.
        </p>
      </div>
    );
  }

  return (
    <form
      className="mx-auto flex w-full max-w-sm flex-col gap-4"
      aria-busy={request.isPending}
      onSubmit={(e) => {
        e.preventDefault();
        request.mutate({ email: field(new FormData(e.currentTarget), "email") });
      }}
    >
      <h1 className="text-center text-2xl font-bold tracking-tight">View your invoices</h1>
      <p className="text-center text-sm text-muted-foreground">
        Enter the email address your invoices were sent to.
      </p>
      {link === "invalid" && (
        <p role="alert" className="rounded-md border border-destructive/40 p-2 text-sm">
          That link has expired or was already used. Request a new one below.
        </p>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <Button type="submit" disabled={request.isPending}>
        {request.isPending ? "Sending..." : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
