import { Button } from "@repo/ui/components/button";
import {
  ArrowRightIcon,
  BellRingIcon,
  CheckCircle2Icon,
  FileTextIcon,
  MessageSquareTextIcon,
  PaletteIcon,
  SendIcon,
  SparklesIcon,
  WalletIcon,
} from "lucide-react";

// Sign-in and sign-up live in the product app, which runs on its own host.
const APP_URL = import.meta.env.VITE_APP_URL ?? "http://app.localhost:3000";

const STEPS = [
  {
    icon: SendIcon,
    title: "Send",
    text: "Create an invoice and send a branded link your client can open and pay.",
  },
  {
    icon: BellRingIcon,
    title: "Chase",
    text: "Polite reminders go out on a schedule, and stop the moment they pay.",
  },
  {
    icon: MessageSquareTextIcon,
    title: "Understand",
    text: "Replies like “I'll pay Friday” are read and turned into a promise for you to confirm.",
  },
  {
    icon: WalletIcon,
    title: "Get paid",
    text: "Clients pay by card or bank transfer. You see it land, with a receipt.",
  },
] as const;

const FEATURES = [
  {
    icon: PaletteIcon,
    title: "Your name on everything",
    text: "Clients see your logo and colours on your own address, not ours.",
  },
  {
    icon: BellRingIcon,
    title: "Reminders that adapt",
    text: "Promises and disputes pause the chasing. Quiet hours and time zones are respected.",
  },
  {
    icon: SparklesIcon,
    title: "An assistant you approve",
    text: "It drafts follow-ups and reads replies. Nothing is sent until you say so.",
  },
] as const;

export function App() {
  return (
    <div className="min-h-svh bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <span className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            D
          </span>
          Duely
        </span>
        <Button
          render={<a href={APP_URL} aria-label="Sign in" />}
          nativeButton={false}
          variant="outline"
        >
          Sign in
        </Button>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pt-10 pb-20 lg:grid-cols-[1.1fr_1fr] lg:pt-20">
          <div>
            <p className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
              <SparklesIcon className="size-3.5" /> Collections that read the room
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Send invoices, get paid, and stop chasing clients.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
              Duely gives your firm a branded billing portal and a collections assistant that
              follows up, understands replies, and keeps you in control.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button
                render={<a href={`${APP_URL}/signup`} aria-label="Try the demo" />}
                nativeButton={false}
                size="lg"
              >
                Try the demo <ArrowRightIcon />
              </Button>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Explore a sample firm in under two minutes. No payment details needed.
            </p>
          </div>

          {/* A small picture of the product, drawn in markup so it always matches the real colours. */}
          <div aria-hidden className="relative">
            <div className="rounded-2xl border bg-card p-5 shadow-xl">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border p-4">
                  <p className="text-xs text-muted-foreground">Outstanding</p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums">$45,430</p>
                </div>
                <div className="rounded-xl border p-4">
                  <p className="text-xs text-muted-foreground">Overdue</p>
                  <p className="mt-2 text-2xl font-semibold text-danger tabular-nums">$34,080</p>
                </div>
              </div>
              <div className="mt-4 flex h-2.5 overflow-hidden rounded-full">
                <span className="w-[25%] bg-chart-3" />
                <span className="w-[33%] bg-amber-500" />
                <span className="w-[15%] bg-orange-500" />
                <span className="w-[27%] bg-red-500" />
              </div>
              <div className="mt-4 rounded-xl border border-violet/20 bg-violet-soft/50 p-4">
                <p className="mb-1.5 inline-flex items-center gap-1 text-xs font-medium text-violet">
                  <SparklesIcon className="size-3" /> Assistant's reading
                </p>
                <p className="text-sm">“Sorry for the delay, I'll pay this on Friday.”</p>
                <p className="mt-1 text-sm font-medium">Looks like a promise to pay</p>
              </div>
            </div>
            <div className="absolute -bottom-5 -left-4 flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm shadow-lg">
              <CheckCircle2Icon className="size-4 text-success" />
              <span className="font-medium">INV-0007 paid</span>
              <span className="text-muted-foreground tabular-nums">$1,250.00</span>
            </div>
          </div>
        </section>

        <section className="border-y bg-card">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-center text-2xl font-semibold tracking-tight">
              From invoice to paid, in four steps
            </h2>
            <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map(({ icon: Icon, title, text }, n) => (
                <li key={title} className="relative">
                  <span className="mb-3 grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
                    <Icon className="size-5" />
                  </span>
                  <p className="text-xs font-medium text-muted-foreground">Step {n + 1}</p>
                  <h3 className="font-semibold">{title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16">
          <div className="grid gap-6 md:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-xl border bg-card p-6 shadow-card">
                <Icon className="mb-3 size-5 text-primary" />
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t">
        <p className="mx-auto flex max-w-6xl items-center gap-2 px-6 py-6 text-sm text-muted-foreground">
          <FileTextIcon className="size-4" /> Duely · Billing portals with adaptive collections
        </p>
      </footer>
    </div>
  );
}
