import { formatUsd } from "@repo/api/money";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Card, fieldClass, Page } from "#/components/ui-bits.tsx";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/_app/invoices/import")({
  component: ImportInvoice,
});

// What the upload route returns. Typed here because the browser never imports server code.
interface Extracted {
  ok: true;
  documentId: string;
  runId: string;
  extraction: {
    client_name: string | null;
    invoice_number: string | null;
    due_date: string | null;
    items: Array<{ description: string; quantity: number; unit_amount_minor: number }>;
    stated_total_minor: number | null;
  };
  lowFields: string[];
  reconciles: boolean | null;
  computedTotalMinor: number;
  suggestedClientId: string | null;
}
type Upload = Extracted | { ok: false; reason: string };

interface Row {
  description: string;
  quantity: string;
  price: string;
}

const FIELD_NOTE = "ring-2 ring-amber-400";

function ImportInvoice() {
  const { trpc } = Route.useRouteContext();
  const navigate = useNavigate();
  const { data: clients } = useSuspenseQuery(trpc.clients.list.queryOptions());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Extracted | null>(null);
  const [failed, setFailed] = useState(false);
  const [clientId, setClientId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [rows, setRows] = useState<Row[]>([]);

  async function upload(file: File) {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/files/extract", {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as Upload;
      if (!data.ok) {
        setFailed(true);
        return;
      }
      setResult(data);
      setClientId(data.suggestedClientId ?? "");
      setDueDate(data.extraction.due_date ?? "");
      setRows(
        data.extraction.items.map((i) => ({
          description: i.description,
          quantity: String(i.quantity),
          price: (i.unit_amount_minor / 100).toFixed(2),
        })),
      );
    } catch {
      toast.add({ type: "error", description: "Use a PDF, PNG, JPEG or WebP file under 10 MB." });
    } finally {
      setBusy(false);
    }
  }

  const create = useMutation(
    trpc.invoices.createFromExtraction.mutationOptions({
      onSuccess: async (created) => {
        toast.add({
          type: "success",
          description: created.needsReview
            ? "Draft created. A few things are worth a second look."
            : "Draft created.",
        });
        await navigate({ to: "/invoices/$invoiceId", params: { invoiceId: created.id } });
      },
      onError: (error) =>
        toast.add({
          type: "error",
          description:
            trpcErrorInfo(error).domainCode === "extraction.not_found"
              ? "That upload is no longer available. Upload it again."
              : "Check the details and try again.",
        }),
    }),
  );

  const low = (name: string) => (result?.lowFields.includes(name) ? FIELD_NOTE : "");
  const total = rows.reduce(
    (t, r) => t + Math.round(Number(r.quantity || 0) * Math.round(Number(r.price || 0) * 100)),
    0,
  );

  return (
    <Page
      title="Import an invoice"
      actions={
        <Button render={<Link to="/invoices" />} nativeButton={false} variant="ghost" size="sm">
          Back
        </Button>
      }
    >
      {!result && (
        <Card>
          <Label htmlFor="file">Upload a PDF or a photo of an invoice</Label>
          <input
            id="file"
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            className={`${fieldClass} mt-1.5`}
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            We read it into a draft for you to check. Nothing is sent until you send it.
          </p>
          {busy && (
            <p className="mt-2 text-sm" role="status">
              Reading your invoice…
            </p>
          )}
          {failed && (
            <p className="mt-2 text-sm" role="alert" data-testid="import-failed">
              We couldn't read that file.{" "}
              <Link to="/invoices/new" className="underline underline-offset-4">
                Enter the invoice by hand
              </Link>
              .
            </p>
          )}
        </Card>
      )}

      {result && (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              clientId,
              dueDate: dueDate || null,
              documentId: result.documentId,
              runId: result.runId,
              idempotencyKey: crypto.randomUUID(),
              items: rows.map((r) => ({
                description: r.description,
                quantity: r.quantity,
                unitAmountMinor: Math.round(Number(r.price) * 100),
              })),
            });
          }}
        >
          {(result.lowFields.length > 0 || result.reconciles === false) && (
            <div
              className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950"
              role="alert"
              data-testid="import-warning"
            >
              {result.reconciles === false && (
                <p>
                  The lines add up to {formatUsd(result.computedTotalMinor)}, but the document says{" "}
                  {formatUsd(result.extraction.stated_total_minor ?? 0)}.
                </p>
              )}
              {result.lowFields.length > 0 && (
                <p>We weren't sure about the highlighted details. Please check them.</p>
              )}
            </div>
          )}
          <Card title="Details">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="client">Client</Label>
                <select
                  id="client"
                  className={`${fieldClass} ${low("client_name")}`}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  required
                >
                  <option value="">Choose a client</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {result.extraction.client_name && (
                  <p className="text-xs text-muted-foreground">
                    The document says: {result.extraction.client_name}
                  </p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="due">Due date</Label>
                <Input
                  id="due"
                  type="date"
                  value={dueDate}
                  className={low("due_date")}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>
          </Card>
          <Card title="Items">
            <div className="grid gap-2">
              {rows.map((r, i) => (
                <div key={i} className={`grid grid-cols-6 gap-2 rounded-md ${low("items")}`}>
                  <Input
                    className="col-span-3"
                    aria-label={`Description ${i + 1}`}
                    value={r.description}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                      )
                    }
                    required
                  />
                  <Input
                    aria-label={`Quantity ${i + 1}`}
                    value={r.quantity}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)),
                      )
                    }
                    required
                  />
                  <Input
                    className="col-span-2"
                    aria-label={`Price ${i + 1}`}
                    value={r.price}
                    onChange={(e) =>
                      setRows(rows.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))
                    }
                    required
                  />
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() =>
                  setRows([...rows, { description: "", quantity: "1", price: "0.00" }])
                }
              >
                Add item
              </Button>
            </div>
            <p className="mt-3 text-sm font-medium">Total {formatUsd(total)}</p>
          </Card>
          <div className="flex gap-2">
            <Button type="submit" disabled={create.isPending || rows.length === 0}>
              Create draft
            </Button>
            <Button type="button" variant="ghost" onClick={() => setResult(null)}>
              Start over
            </Button>
          </div>
        </form>
      )}
    </Page>
  );
}
