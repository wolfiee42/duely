import { toast } from "@repo/ui/components/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { blankItem, InvoiceEditor } from "#/components/invoice-editor.tsx";
import { Page } from "#/components/ui-bits.tsx";

export const Route = createFileRoute("/_staff/app/invoices/new")({
  validateSearch: z.object({ clientId: z.uuid().optional() }),
  component: NewInvoice,
});

function NewInvoice() {
  const { trpc } = Route.useRouteContext();
  const { clientId } = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: clients } = useSuspenseQuery(trpc.clients.list.queryOptions());

  const create = useMutation(
    trpc.invoices.createDraft.mutationOptions({
      onSuccess: async ({ id }) => {
        await queryClient.invalidateQueries({ queryKey: trpc.invoices.list.queryKey() });
        await navigate({ to: "/app/invoices/$invoiceId", params: { invoiceId: id } });
      },
      onError: () =>
        toast.add({
          type: "error",
          description: "We couldn't save the invoice. Check the details and try again.",
        }),
    }),
  );

  return (
    <Page title="New invoice">
      {clients.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add a client first, then create an invoice for them.
        </p>
      ) : (
        <InvoiceEditor
          clients={clients}
          initial={{ clientId: clientId ?? "", dueDate: "", notes: "", items: [blankItem()] }}
          submitLabel="Save draft"
          pending={create.isPending}
          onSubmit={(value) => create.mutate(value)}
        />
      )}
    </Page>
  );
}
