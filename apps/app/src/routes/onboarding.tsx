import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon } from "lucide-react";

import { authQueryOptions } from "#/lib/auth/queries.ts";
import { requireHostKind } from "#/lib/host.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

// Signup step 2: a signed-in user without a firm creates it. Finished users go to the dashboard.
export const Route = createFileRoute("/onboarding")({
  beforeLoad: async ({ context }) => {
    requireHostKind(context.host, "app");
    const user = await context.queryClient.query({ ...authQueryOptions(), staleTime: "static" });
    if (!user) throw redirect({ to: "/login" });
    try {
      await context.queryClient.query(context.trpc.firm.get.queryOptions());
    } catch (error) {
      if (trpcErrorInfo(error).domainCode === "member.no_firm") return;
      throw error;
    }
    throw redirect({ to: "/" });
  },
  component: OnboardingForm,
});

const MESSAGES: Record<string, string> = {
  "firm.slug_taken": "That address is already taken. Try another.",
  "firm.invalid_slug": "Use 3 to 30 lowercase letters, numbers or hyphens.",
};

function OnboardingForm() {
  const { trpc, host } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { mutate, isPending } = useMutation(
    trpc.firm.create.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.firm.get.queryKey() });
        await navigate({ to: "/" });
      },
      onError: (error) => {
        const { domainCode } = trpcErrorInfo(error);
        toast.add({
          type: "error",
          description:
            (domainCode && MESSAGES[domainCode]) ||
            "We couldn't create your firm. Please try again.",
        });
      },
    }),
  );

  const demoAvailable = useQuery(trpc.firm.demoAvailable.queryOptions());
  const demo = useMutation(
    trpc.firm.createDemo.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.firm.get.queryKey() });
        await navigate({ to: "/demo" });
      },
      onError: () =>
        toast.add({ type: "error", description: "We couldn't start the demo. Please try again." }),
    }),
  );

  const handleSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isPending) return;
    const form = new FormData(e.currentTarget);
    const legalName = form.get("legal_name");
    const displayName = form.get("display_name");
    const platformSlug = form.get("slug");
    if (
      typeof legalName !== "string" ||
      typeof displayName !== "string" ||
      typeof platformSlug !== "string"
    )
      return;
    mutate({ legalName, displayName, platformSlug });
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">Set up your firm</h1>
          <p className="text-sm text-muted-foreground">This is what your clients will see.</p>
        </div>
        <form onSubmit={handleSubmit} aria-busy={isPending} className="flex flex-col gap-5">
          <div className="grid gap-2">
            <Label htmlFor="legal_name">Legal name</Label>
            <Input
              id="legal_name"
              name="legal_name"
              placeholder="Acme Consulting LLC"
              readOnly={isPending}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="display_name">Display name</Label>
            <Input
              id="display_name"
              name="display_name"
              placeholder="Acme"
              readOnly={isPending}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="slug">Client portal address</Label>
            <div className="flex items-center gap-2">
              <Input
                id="slug"
                name="slug"
                placeholder="acme"
                autoComplete="off"
                readOnly={isPending}
                required
              />
              <span className="font-mono text-sm text-muted-foreground">.{host.rootHost}</span>
            </div>
          </div>
          <Button type="submit" className="mt-2 w-full" size="lg" disabled={isPending}>
            {isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            {isPending ? "Creating..." : "Create firm"}
          </Button>
        </form>
        {demoAvailable.data?.available && (
          <div className="border-t pt-5 text-center">
            <p className="mb-3 text-sm text-muted-foreground">Just want a look around?</p>
            <Button
              variant="outline"
              className="w-full"
              disabled={demo.isPending || isPending}
              onClick={() => demo.mutate()}
            >
              {demo.isPending ? "Setting up the demo…" : "Explore with sample data"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
