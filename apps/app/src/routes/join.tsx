import { Button } from "@repo/ui/components/button";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { authQueryOptions } from "#/lib/auth/queries.ts";
import { requireHostKind } from "#/lib/host.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

// Invite landing page: shows the firm, asks the invitee to sign in (or sign up), then joins.
export const Route = createFileRoute("/join")({
  validateSearch: z.object({ token: z.string().min(20).max(100) }),
  beforeLoad: ({ context }) => requireHostKind(context.host, "app"),
  component: Join,
});

function Join() {
  const { trpc } = Route.useRouteContext();
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const { data: user } = useQuery(authQueryOptions());
  const { data: preview, error } = useQuery(trpc.members.previewInvite.queryOptions({ token }));

  const accept = useMutation(
    trpc.members.acceptInvite.mutationOptions({
      onSuccess: () => navigate({ to: "/", reloadDocument: true }),
      onError: (e) =>
        toast.add({
          type: "error",
          description:
            trpcErrorInfo(e).domainCode === "invite.wrong_account"
              ? "Sign in with the email address this invite was sent to."
              : "This invite can't be accepted.",
        }),
    }),
  );

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      {error ? (
        <p>This invite is no longer valid.</p>
      ) : preview ? (
        <>
          <h1 className="text-2xl font-bold tracking-tight">Join {preview.firmName}</h1>
          <p className="text-sm text-muted-foreground">Invited as {preview.email}</p>
          {user ? (
            <Button onClick={() => accept.mutate({ token })} disabled={accept.isPending}>
              Accept invite
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button render={<Link to="/signup" />} nativeButton={false}>
                Create account
              </Button>
              <Button render={<Link to="/login" />} nativeButton={false} variant="outline">
                Sign in
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
