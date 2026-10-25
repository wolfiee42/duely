const DOT: Record<string, string> = {
  invoice: "bg-blue-500",
  email: "bg-slate-400",
  reply: "bg-indigo-500",
  promise: "bg-amber-500",
  dispute: "bg-orange-500",
  payment: "bg-green-500",
};
const KIND: Record<string, string> = {
  invoice: "Invoice",
  email: "Email",
  reply: "Reply",
  promise: "Promise",
  dispute: "Dispute",
  payment: "Payment",
};

interface Entry {
  at: Date | string;
  kind: string;
  title: string;
  detail: string | null;
}

/** An invoice's story, oldest first: what happened, what we sent, what the client said (FR-12.4). */
export function Timeline({ entries }: { entries: readonly Entry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>;
  }
  return (
    <ol className="relative ml-2 border-l pl-5" data-testid="timeline">
      {entries.map((e, i) => (
        <li key={i} className="relative pb-4 last:pb-0">
          <span
            className={`absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full ${DOT[e.kind] ?? "bg-slate-400"}`}
            aria-hidden="true"
          />
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <p className="text-sm font-medium">
              <span className="sr-only">{KIND[e.kind] ?? "Event"}: </span>
              {e.title}
            </p>
            <time className="text-xs text-muted-foreground" dateTime={new Date(e.at).toISOString()}>
              {new Date(e.at).toLocaleString()}
            </time>
          </div>
          {e.detail && (
            <p className="mt-0.5 text-sm whitespace-pre-line text-muted-foreground">{e.detail}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
