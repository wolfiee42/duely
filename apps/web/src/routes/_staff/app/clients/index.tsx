import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { Card, Page } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/app/clients/")({
  component: Clients,
});

function Clients() {
  const { trpc } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: clients } = useSuspenseQuery(trpc.clients.list.queryOptions());

  const create = useMutation(
    trpc.clients.create.mutationOptions({
      onSuccess: async ({ id }) => {
        await queryClient.invalidateQueries({ queryKey: trpc.clients.list.queryKey() });
        await navigate({ to: "/app/clients/$clientId", params: { clientId: id } });
      },
      onError: (error) =>
        toast.add({
          type: "error",
          description:
            trpcErrorInfo(error).code === "BAD_REQUEST"
              ? "Check the details and try again."
              : "We couldn't add the client.",
        }),
    }),
  );

  const submit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    create.mutate({
      client: { name: field(f, "name") },
      contact: { name: field(f, "contact_name"), email: field(f, "email") },
    });
  };

  return (
    <Page title="Clients">
      <Card title="Add a client">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3" aria-busy={create.isPending}>
          <div className="grid gap-1.5">
            <Label htmlFor="name">Client name</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="contact_name">Contact name</Label>
            <Input id="contact_name" name="contact_name" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="email">Contact email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <Button type="submit" disabled={create.isPending} className="sm:col-span-3 sm:w-fit">
            {create.isPending ? "Adding..." : "Add client"}
          </Button>
        </form>
      </Card>
      {clients.length === 0 ? (
        <p className="text-sm text-muted-foreground">No clients yet. Add your first one above.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {clients.map((c) => (
            <li key={c.id}>
              <Link
                to="/app/clients/$clientId"
                params={{ clientId: c.id }}
                className="block px-4 py-3 hover:bg-muted"
              >
                {c.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
