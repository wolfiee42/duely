import type { ReactNode } from "react";

// Small shared pieces for the staff and portal pages. Plain Tailwind on top of @repo/ui primitives.

export function Page({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded-md border bg-card p-4 text-card-foreground">
      {title && <h2 className="mb-3 text-sm font-semibold">{title}</h2>}
      {children}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  viewed: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200",
  overdue: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  promised: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  disputed: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  paid: "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200",
  void: "bg-muted text-muted-foreground line-through",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? ""}`}>
      {status}
    </span>
  );
}

export const fieldClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
