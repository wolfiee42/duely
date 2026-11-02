import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Card, fieldClass, Page, StatusBadge } from "#/components/ui-bits.tsx";
import { field } from "#/lib/form.ts";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/_app/clients/$clientId")({
  component: ClientPage,
});

const MESSAGES: Record<string, string> = {
  "contact.duplicate_email": "This client already has a contact with that email.",
  "contact.last_contact": "A client needs at least one contact.",
};

function ClientPage() {
  const { clientId } = Route.useParams();
  const { trpc } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const { data: client } = useSuspenseQuery(trpc.clients.get.queryOptions({ clientId }));
  const { data: invoices } = useSuspenseQuery(trpc.invoices.list.queryOptions({ clientId }));

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.clients.get.queryKey({ clientId }) });
  const onError = (error: unknown) =>
    toast.add({
      type: "error",
      description:
        MESSAGES[trpcErrorInfo(error).domainCode ?? ""] ??
        "Something went wrong. Please try again.",
    });

  const rename = useMutation(trpc.clients.update.mutationOptions({ onSuccess: refresh, onError }));
  const archive = useMutation(
    trpc.clients.archive.mutationOptions({ onSuccess: refresh, onError }),
  );
  const { data: policies } = useSuspenseQuery(trpc.policies.list.queryOptions());
  const addContact = useMutation(
    trpc.contacts.add.mutationOptions({ onSuccess: refresh, onError }),
  );
  const setPrimary = useMutation(
    trpc.contacts.setPrimary.mutationOptions({ onSuccess: refresh, onError }),
  );
  const removeContact = useMutation(
    trpc.contacts.remove.mutationOptions({ onSuccess: refresh, onError }),
  );

  return (
    <Page
      title={client.name}
      actions={
        <>
          {!client.archivedAt && (
            <Button
              render={<Link to="/invoices/new" search={{ clientId }} />}
              nativeButton={false}
              size="sm"
            >
              New invoice
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => archive.mutate({ clientId, archived: !client.archivedAt })}
          >
            {client.archivedAt ? "Restore" : "Archive"}
          </Button>
        </>
      }
    >
      {client.archivedAt && (
        <p className="text-sm text-muted-foreground">This client is archived.</p>
      )}

      <Card title="Details">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate({
              clientId,
              name: field(new FormData(e.currentTarget), "name"),
            });
          }}
        >
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" defaultValue={client.name} required />
          </div>
          <Button type="submit" size="sm" disabled={rename.isPending}>
            Save
          </Button>
        </form>
      </Card>

      <Card title="Reminders">
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor="policy">Follow-up plan</Label>
          <select
            id="policy"
            className={fieldClass}
            value={client.policyId ?? ""}
            onChange={(e) => rename.mutate({ clientId, policyId: e.target.value || null })}
          >
            <option value="">Firm default</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">Applies to invoices sent from now on.</p>
        </div>
      </Card>

      <Card title="Contacts">
        <ul className="mb-4 divide-y">
          {client.contacts.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span>
                {c.name} <span className="text-muted-foreground">&lt;{c.email}&gt;</span>
                {c.isPrimary && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">primary</span>
                )}
                {c.emailStatus !== "ok" && (
                  <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-900 dark:bg-red-950 dark:text-red-200">
                    can't receive email
                  </span>
                )}
                {c.emailStatus === "ok" && !c.receivesReminders && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                    stopped reminders
                  </span>
                )}
              </span>
              <span className="flex gap-1">
                {!c.isPrimary && (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setPrimary.mutate({ contactId: c.id })}
                  >
                    Make primary
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => removeContact.mutate({ contactId: c.id })}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
        <form
          className="grid gap-2 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            addContact.mutate(
              {
                clientId,
                name: field(f, "c_name"),
                email: field(f, "c_email"),
              },
              { onSuccess: () => form.reset() },
            );
          }}
        >
          <Input name="c_name" placeholder="Name" aria-label="Contact name" required />
          <Input
            name="c_email"
            type="email"
            placeholder="Email"
            aria-label="Contact email"
            required
          />
          <Button type="submit" size="sm" disabled={addContact.isPending}>
            Add contact
          </Button>
        </form>
      </Card>

      <Card title="Invoices">
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {invoices.map((i) => (
              <li key={i.id} className="flex items-center justify-between py-2">
                <Link
                  to="/invoices/$invoiceId"
                  params={{ invoiceId: i.id }}
                  className="underline underline-offset-4"
                >
                  {i.number ?? "Draft"}
                </Link>
                <StatusBadge status={i.effectiveStatus} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
