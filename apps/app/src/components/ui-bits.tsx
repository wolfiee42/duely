import { SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";

// Small shared pieces for the staff and portal pages. Plain Tailwind on top of @repo/ui primitives.

export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-5 text-card-foreground shadow-card">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "violet" | "orange";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  violet: "bg-violet-soft text-violet",
  orange: "bg-orange-soft text-orange",
};

const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  sent: "info",
  viewed: "violet",
  overdue: "danger",
  promised: "warning",
  disputed: "orange",
  paid: "success",
  void: "neutral",
  pending: "neutral",
  verifying: "info",
  active: "success",
  failed: "danger",
};

function Pill({ tone, label, testId }: { tone: Tone; label: string; testId?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}
      data-testid={testId}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
      {label}
    </span>
  );
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Pill tone={STATUS_TONE[status] ?? "neutral"} label={label ?? status} />;
}

const RISK_TONE: Record<string, Tone> = { low: "success", medium: "warning", high: "danger" };
const RISK_LABELS: Record<string, string> = {
  low: "Likely on time",
  medium: "May run late",
  high: "Likely late",
};

/** How likely a client is to pay late, from their history. Informational: it never blocks sending. */
export function RiskBadge({ level }: { level: string | null | undefined }) {
  if (!level) return null;
  return (
    <Pill
      tone={RISK_TONE[level] ?? "neutral"}
      label={RISK_LABELS[level] ?? level}
      testId="risk-badge"
    />
  );
}

/** A headline number: the label stays quiet so the figure carries the card. */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
  testId,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {icon && (
          <span
            className={`grid size-8 place-items-center rounded-lg [&_svg]:size-4 ${TONES[tone]}`}
          >
            {icon}
          </span>
        )}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums" data-testid={testId}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function EmptyState({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground [&_svg]:size-5">
      {icon}
      <p>{children}</p>
    </div>
  );
}

/** Marks anything the assistant wrote or read, so people can tell machine output from their own data. */
export function AiMark({ label = "Assistant" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-soft px-2 py-0.5 text-xs font-medium text-violet">
      <SparklesIcon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

/** Initials in a tinted circle, for clients and contacts in lists. */
export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
    >
      {initials}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-muted ${className}`} />;
}

/** Shown while a page's queries load: the same rhythm as a real page, so nothing jumps. */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((n) => (
          <Skeleton key={n} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-56" />
    </div>
  );
}

export const fieldClass =
  "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30";
