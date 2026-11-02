import { Button } from "@repo/ui/components/button";
import { Label } from "@repo/ui/components/label";
import { toast } from "@repo/ui/components/toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { Card, fieldClass, Page } from "#/components/ui-bits.tsx";
import { trpcErrorInfo } from "#/lib/trpc/errors.ts";

export const Route = createFileRoute("/_staff/_app/imports")({
  component: Imports,
});

type Kind = "clients" | "invoices";
interface Issue {
  row: number;
  reason: string;
}
interface Report {
  dryRun: boolean;
  total: number;
  created: number;
  duplicates: Issue[];
  invalid: Issue[];
}

const MESSAGES: Record<string, string> = {
  "import.bad_csv":
    "We couldn't read that file. Export it as CSV from your spreadsheet and try again.",
  "import.empty": "The file has no rows below the headings.",
  "import.unmapped": "Choose a column for every required field.",
};

function Imports() {
  const { trpc } = Route.useRouteContext();
  const [kind, setKind] = useState<Kind>("clients");
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);

  const spec = useQuery(trpc.imports.fields.queryOptions({ kind }));
  const onError = (error: unknown) =>
    toast.add({
      type: "error",
      description:
        MESSAGES[trpcErrorInfo(error).domainCode ?? ""] ??
        "Something went wrong. Please try again.",
    });

  const inspect = useMutation(
    trpc.imports.inspect.mutationOptions({
      onSuccess: (r) => {
        setHeaders(r.headers);
        setMapping(r.suggested);
      },
      onError,
    }),
  );
  const run = useMutation(
    trpc.imports.run.mutationOptions({
      onSuccess: (r, vars) => {
        setReport(r);
        if (!vars.dryRun) {
          toast.add({
            type: "success",
            description: `Imported ${r.created} ${kind === "clients" ? "clients" : "invoices"}.`,
          });
        }
      },
      onError,
    }),
  );

  function reset(next: Kind) {
    setKind(next);
    setCsv(null);
    setFileName("");
    setHeaders([]);
    setMapping({});
    setReport(null);
  }

  async function pick(file: File) {
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setReport(null);
    inspect.mutate({ kind, csv: text });
  }

  function downloadTemplate() {
    if (!spec.data) return;
    const url = URL.createObjectURL(new Blob([spec.data.template], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind}-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const missing = (spec.data?.fields ?? []).filter((f) => f.required && !mapping[f.key]);

  return (
    <Page title="Import">
      <div className="flex gap-2" role="tablist" aria-label="What to import">
        {(["clients", "invoices"] as const).map((k) => (
          <Button
            key={k}
            role="tab"
            aria-selected={kind === k}
            size="sm"
            variant={kind === k ? "default" : "outline"}
            onClick={() => reset(k)}
          >
            {k === "clients" ? "Clients" : "Open invoices"}
          </Button>
        ))}
      </div>

      <Card title="1. Choose your file">
        <Label htmlFor="csv">A CSV exported from your spreadsheet</Label>
        <input
          id="csv"
          type="file"
          accept=".csv,text/csv"
          className={`${fieldClass} mt-1.5`}
          onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {kind === "invoices"
            ? "Each row is a line; rows with the same invoice reference become one draft. Clients must already exist."
            : "One row per client with a contact email."}{" "}
          <button type="button" className="underline underline-offset-4" onClick={downloadTemplate}>
            Download a template
          </button>
        </p>
      </Card>

      {csv && headers.length > 0 && (
        <Card title="2. Match your columns">
          <p className="mb-3 text-xs text-muted-foreground">{fileName}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {spec.data?.fields.map((f) => (
              <div key={f.key} className="grid gap-1.5">
                <Label htmlFor={`map-${f.key}`}>
                  {f.label}
                  {f.required ? " *" : ""}
                </Label>
                <select
                  id={`map-${f.key}`}
                  className={fieldClass}
                  value={mapping[f.key] ?? ""}
                  onChange={(e) => {
                    setMapping({ ...mapping, [f.key]: e.target.value });
                    setReport(null);
                  }}
                >
                  <option value="">{f.required ? "Choose a column" : "Not in my file"}</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={missing.length > 0 || run.isPending}
              onClick={() => run.mutate({ kind, csv, mapping, dryRun: true })}
            >
              Check the file
            </Button>
            {missing.length > 0 && (
              <span className="self-center text-xs text-muted-foreground">
                Still needed: {missing.map((m) => m.label).join(", ")}
              </span>
            )}
          </div>
        </Card>
      )}

      {report && (
        <Card title={report.dryRun ? "3. Here's what would happen" : "Done"}>
          <p className="text-sm" data-testid="import-summary">
            {report.dryRun ? "Would create" : "Created"} <strong>{report.created}</strong> of{" "}
            {report.total} rows
            {report.duplicates.length > 0 && `, ${report.duplicates.length} already imported`}
            {report.invalid.length > 0 && `, ${report.invalid.length} with problems`}.
          </p>
          {report.invalid.length > 0 && (
            <ul className="mt-3 divide-y rounded-md border text-sm" data-testid="import-problems">
              {report.invalid.map((i, n) => (
                <li key={n} className="flex gap-3 px-3 py-1.5">
                  <span className="w-16 shrink-0 text-muted-foreground">Row {i.row}</span>
                  <span>{i.reason}</span>
                </li>
              ))}
            </ul>
          )}
          {report.dryRun && csv && (
            <div className="mt-4 flex items-center gap-3">
              <Button
                size="sm"
                disabled={report.created === 0 || run.isPending}
                onClick={() => run.mutate({ kind, csv, mapping, dryRun: false })}
              >
                Import {report.created} {kind === "clients" ? "clients" : "invoices"}
              </Button>
              {report.invalid.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  Rows with problems are skipped. Fix them and import again; rows already imported
                  are left alone.
                </span>
              )}
            </div>
          )}
          {!report.dryRun && (
            <p className="mt-3 text-sm">
              <Link
                to={kind === "clients" ? "/clients" : "/invoices"}
                className="underline underline-offset-4"
              >
                See your {kind === "clients" ? "clients" : "invoices"}
              </Link>
            </p>
          )}
        </Card>
      )}
    </Page>
  );
}
