import type { ModelClient } from "@repo/ai";
import { addDays } from "@repo/clock";
import { withTenant, type Db } from "@repo/db";
import {
  auditLog,
  clients,
  contacts,
  disputes,
  firms,
  invoiceItems,
  invoiceSequences,
  invoices,
  messages,
  payments,
  promises,
  reminderJobs,
  reviewItems,
  policySteps,
} from "@repo/db/schema";
import { DomainError, invoiceTotals, parseQuantity } from "@repo/domain";
import { reminderDraft } from "@repo/email";
import { and, eq, sql } from "drizzle-orm";

import type { QueuePort } from "../services";
import { type Actor } from "./audit";
import { classifyReply } from "./classify";
import { runDevTick } from "./dev-tick";
import { createFirm, type NewFirmUser } from "./firm";
import { firmClock } from "./firm-clock";
import { receiveInboundEmail } from "./inbound";
import { ensureDefaultPolicy } from "./policies";
import { pauseInvoiceJobs, planInvoiceJobs } from "./reminders";
import { refreshRisk } from "./risk";
import { newToken } from "./tokens";

// FR-14: a believable firm to click around in, a clock the viewer controls, and a way to start over.
// Everything here is refused for a firm that is not a demo (FR-14.7); the database also refuses a clock
// offset on a non-demo firm.

export function assertDemo(isDemo: boolean) {
  if (!isDemo) {
    throw new DomainError("demo.not_demo", "forbidden", "This is only available in the demo.");
  }
}

async function isDemoFirm(db: Db, tenantId: string) {
  const [f] = await withTenant(db, tenantId, (tx) =>
    tx.select({ demo: firms.isDemo }).from(firms).where(eq(firms.id, tenantId)),
  );
  return Boolean(f?.demo);
}

const DAY = 86_400_000;

interface ClientSpec {
  key: string;
  name: string;
  timezone: string;
  contact: string;
  email: string;
}
const CLIENTS: ClientSpec[] = [
  {
    key: "initech",
    name: "Initech",
    timezone: "America/New_York",
    contact: "Bill Lumbergh",
    email: "bill@initech.example",
  },
  {
    key: "globex",
    name: "Globex Corporation",
    timezone: "Europe/London",
    contact: "Hank Scorpio",
    email: "hank@globex.example",
  },
  {
    key: "umbrella",
    name: "Umbrella Health",
    timezone: "America/Chicago",
    contact: "Alice Abernathy",
    email: "alice@umbrella.example",
  },
  {
    key: "hooli",
    name: "Hooli",
    timezone: "America/Los_Angeles",
    contact: "Gavin Belson",
    email: "gavin@hooli.example",
  },
  {
    key: "stark",
    name: "Stark Industries",
    timezone: "America/New_York",
    contact: "Pepper Potts",
    email: "pepper@stark.example",
  },
  {
    key: "wayne",
    name: "Wayne Enterprises",
    timezone: "America/New_York",
    contact: "Lucius Fox",
    email: "lucius@wayne.example",
  },
];

type Final = "paid" | "sent" | "viewed" | "overdue" | "promised" | "disputed" | "void" | "draft";
interface InvoiceSpec {
  key: string;
  client: string;
  /** Days from today; negative is past due. */
  due: number;
  lines: Array<[description: string, quantity: string, unitDollars: number]>;
  status: Final;
  /** Days ago it was paid (paid only). */
  paidAgo?: number;
  viewedAgo?: number;
  /** Reminder steps (days from due) that already went out. */
  remindersSent?: number[];
  note?: string;
}

const INVOICES: InvoiceSpec[] = [
  // History: how each client has paid before. It is what the payment outlook is built from.
  {
    key: "h1",
    client: "hooli",
    due: -150,
    lines: [["Platform retainer", "1", 4500]],
    status: "paid",
    paidAgo: 120,
  },
  {
    key: "h2",
    client: "hooli",
    due: -100,
    lines: [["Platform retainer", "1", 3200]],
    status: "paid",
    paidAgo: 78,
  },
  {
    key: "h3",
    client: "hooli",
    due: -60,
    lines: [["Integration work", "11", 250]],
    status: "paid",
    paidAgo: 41,
  },
  {
    key: "i1",
    client: "initech",
    due: -90,
    lines: [["TPS report automation", "12", 150]],
    status: "paid",
    paidAgo: 92,
  },
  {
    key: "i2",
    client: "initech",
    due: -45,
    lines: [["Support block", "8", 300]],
    status: "paid",
    paidAgo: 47,
  },
  {
    key: "g1",
    client: "globex",
    due: -30,
    lines: [["Quarterly advisory", "1", 5000]],
    status: "paid",
    paidAgo: 28,
  },
  {
    key: "u1",
    client: "umbrella",
    due: -20,
    lines: [["Compliance review", "5", 250]],
    status: "paid",
    paidAgo: 20,
  },
  // Open work, one of each kind of trouble.
  {
    key: "o1",
    client: "initech",
    due: 12,
    lines: [["Website refresh", "1", 2950]],
    status: "sent",
  },
  {
    key: "o2",
    client: "globex",
    due: 5,
    lines: [
      ["Strategy workshop", "2", 3200],
      ["Travel", "1", 2000],
    ],
    status: "viewed",
    viewedAgo: 1,
  },
  {
    key: "o3",
    client: "umbrella",
    due: -8,
    lines: [["Audit support", "12", 300]],
    status: "overdue",
    remindersSent: [-3, 0],
  },
  {
    key: "o4",
    client: "initech",
    due: -25,
    lines: [["Data migration", "1", 1980]],
    status: "overdue",
    remindersSent: [-3, 0, 3, 7],
  },
  {
    key: "o5",
    client: "hooli",
    due: -47,
    lines: [
      ["Platform retainer", "1", 4500],
      ["Overage", "1", 2300],
    ],
    status: "overdue",
    remindersSent: [-3, 0, 3, 7],
  },
  {
    key: "o6",
    client: "wayne",
    due: -75,
    lines: [["Security assessment", "1", 12400]],
    status: "overdue",
    remindersSent: [-3, 0, 3, 7, 14],
  },
  {
    key: "o7",
    client: "stark",
    due: -10,
    lines: [["Prototype review", "6", 1200]],
    status: "promised",
    remindersSent: [-3, 0],
  },
  {
    key: "o8",
    client: "globex",
    due: -6,
    lines: [["Training sessions", "3", 700]],
    status: "disputed",
    remindersSent: [-3, 0],
  },
  { key: "d1", client: "hooli", due: 20, lines: [["Design sprint", "1", 1500]], status: "draft" },
  {
    key: "v1",
    client: "wayne",
    due: -2,
    lines: [["Duplicate of earlier invoice", "1", 900]],
    status: "void",
  },
];

const dollars = (n: number) => Math.round(n * 100);

/**
 * Fills a demo firm with clients, invoices in every status, a payment history for the outlook to learn from,
 * reminders already sent, drafts and replies waiting, a promise, a dispute and a ledger. Dates are relative to
 * the firm's clock, so a reset always looks fresh. Returns the replies to classify once the transaction is done.
 */
export async function seedDemoData(db: Db, actor: Actor, opts: { connectPayments: boolean }) {
  const tenantId = actor.tenantId;
  return withTenant(db, tenantId, async (tx) => {
    const { firm, now, today } = await firmClock(tx, tenantId);
    const ago = (days: number) => new Date(now.getTime() - days * DAY);

    await tx
      .update(firms)
      .set({
        brandPrimary: "#0F766E",
        replyToEmail: "billing@northwind.example",
        ...(opts.connectPayments
          ? {
              stripeAccountId: firm.stripeAccountId ?? `acct_demo_${tenantId.slice(0, 8)}`,
              stripeChargesEnabled: true,
              stripePayoutsEnabled: true,
              stripeDetailsSubmitted: true,
            }
          : {}),
      })
      .where(eq(firms.id, tenantId));
    await ensureDefaultPolicy(tx, tenantId);

    const log = (
      at: Date,
      action: string,
      invoiceId: string,
      summary: Record<string, unknown> = {},
    ) =>
      tx.insert(auditLog).values({
        tenantId,
        actorType: "member",
        actorId: actor.id,
        action,
        entityType: "invoice",
        entityId: invoiceId,
        // Marks sample history, so the guided tour only counts what the viewer does.
        summary: { ...summary, demo: true },
        createdAt: at,
      });

    // Clients and their contacts.
    const clientId: Record<string, string> = {};
    const contactId: Record<string, string> = {};
    for (const c of CLIENTS) {
      const [row] = await tx
        .insert(clients)
        .values({ tenantId, name: c.name, timezone: c.timezone, externalRef: `demo:${c.key}` })
        .returning({ id: clients.id });
      clientId[c.key] = row!.id;
      const [contact] = await tx
        .insert(contacts)
        .values({ tenantId, clientId: row!.id, name: c.contact, email: c.email, isPrimary: true })
        .returning({ id: contacts.id });
      contactId[c.key] = contact!.id;
    }

    await tx.insert(invoiceSequences).values({ tenantId }).onConflictDoNothing();
    const stepIds = new Map<number, string>();
    const steps = await tx.select().from(policySteps);
    for (const s of steps.filter((s) => !s.archivedAt)) stepIds.set(s.offsetDays, s.id);

    const invoiceId: Record<string, string> = {};
    const replyMessageIds: string[] = [];
    let intent = 0;

    for (const spec of INVOICES) {
      const priced = spec.lines.map(([description, quantity, price]) => ({
        description,
        quantity,
        unitAmountMinor: dollars(price),
      }));
      const totals = invoiceTotals(
        priced.map((p) => ({
          quantityMilli: parseQuantity(p.quantity)!,
          unitAmountMinor: p.unitAmountMinor,
        })),
      );
      const dueDate = addDays(today, spec.due);
      const issueDate = addDays(dueDate, -30);
      const sentAt = new Date(now.getTime() + (spec.due - 30) * DAY);

      const [inv] = await tx
        .insert(invoices)
        .values({
          tenantId,
          clientId: clientId[spec.client]!,
          dueDate,
          subtotalMinor: totals.subtotalMinor,
          totalMinor: totals.totalMinor,
          notes: null,
        })
        .returning({ id: invoices.id });
      const id = inv!.id;
      invoiceId[spec.key] = id;
      await tx.insert(invoiceItems).values(
        priced.map((p, i) => ({
          tenantId,
          invoiceId: id,
          position: i + 1,
          description: p.description,
          quantity: (parseQuantity(p.quantity)! / 1000).toFixed(3),
          unitAmountMinor: p.unitAmountMinor,
          amountMinor: totals.lineAmounts[i]!,
        })),
      );
      await log(new Date(sentAt.getTime() - DAY), "invoice.created", id, {
        after: { totalMinor: totals.totalMinor },
      });
      if (spec.status === "draft") continue;

      const [seq] = await tx
        .update(invoiceSequences)
        .set({ nextNumber: sql`${invoiceSequences.nextNumber} + 1` })
        .where(eq(invoiceSequences.tenantId, tenantId))
        .returning({ issued: sql<number>`${invoiceSequences.nextNumber} - 1` });
      const number = `${firm.invoicePrefix}${String(seq!.issued).padStart(4, "0")}`;
      await tx
        .update(invoices)
        .set({ status: "sent", number, issueDate, sentAt })
        .where(eq(invoices.id, id));
      await log(sentAt, "invoice.sent", id, {
        after: { number, dueDate, totalMinor: totals.totalMinor },
      });
      const [email] = await tx
        .insert(messages)
        .values({
          tenantId,
          clientId: clientId[spec.client]!,
          invoiceId: id,
          contactId: contactId[spec.client]!,
          direction: "out",
          kind: "invoice",
          status: "delivered",
          subject: `Invoice ${number} from ${firm.displayName}`,
          bodyText: `Hello, ${firm.displayName} sent you invoice ${number}. View and pay: [portal link]`,
          dedupeKey: `invoice:${id}:${contactId[spec.client]}`,
          providerMessageId: `demo:${id}`,
          createdAt: sentAt,
          sentAt,
        })
        .returning({ id: messages.id });
      void email;

      if (spec.status === "paid") {
        const paidAt = ago(spec.paidAgo!);
        await tx.insert(payments).values({
          tenantId,
          invoiceId: id,
          stripePaymentIntentId: `pi_demo_${tenantId.slice(0, 6)}_${++intent}`,
          method: intent % 3 === 0 ? "ach" : "card",
          status: "succeeded",
          amountMinor: totals.totalMinor,
          applicationFeeMinor: Math.floor(totals.totalMinor / 100),
          succeededAt: paidAt,
        });
        await tx
          .update(invoices)
          .set({ status: "paid", paidMinor: totals.totalMinor, paidAt })
          .where(eq(invoices.id, id));
        await log(paidAt, "payment.succeeded", id, { after: { amountMinor: totals.totalMinor } });
        continue;
      }
      if (spec.status === "void") {
        await tx
          .update(invoices)
          .set({ status: "void", voidedAt: ago(1), voidReason: "Duplicate" })
          .where(eq(invoices.id, id));
        await log(ago(1), "invoice.voided", id, { after: { reason: "Duplicate" } });
        continue;
      }

      if (spec.viewedAgo !== undefined) {
        await tx
          .update(invoices)
          .set({ firstViewedAt: ago(spec.viewedAgo) })
          .where(eq(invoices.id, id));
        await log(ago(spec.viewedAgo), "invoice.viewed", id);
      }
      if (spec.status !== "sent") {
        await tx.update(invoices).set({ status: spec.status }).where(eq(invoices.id, id));
      }

      // Reminders: plan, then mark the ones that already went out as sent, with their emails.
      await planInvoiceJobs(tx, tenantId, id);
      for (const offset of spec.remindersSent ?? []) {
        const stepId = stepIds.get(offset);
        if (!stepId) continue;
        const [job] = await tx
          .select()
          .from(reminderJobs)
          .where(and(eq(reminderJobs.invoiceId, id), eq(reminderJobs.stepId, stepId)));
        if (!job) continue;
        const at = new Date(now.getTime() + (spec.due + offset) * DAY);
        const step = steps.find((s) => s.id === stepId)!;
        const wording = reminderDraft({
          clientName: CLIENTS.find((c) => c.key === spec.client)!.name,
          number,
          amountDueMinor: totals.totalMinor,
          dueDate,
          daysFromDue: offset,
          templateKey: step.templateKey,
          tone: step.tone,
        });
        const [m] = await tx
          .insert(messages)
          .values({
            tenantId,
            clientId: clientId[spec.client]!,
            invoiceId: id,
            contactId: contactId[spec.client]!,
            direction: "out",
            kind: "reminder",
            status: "delivered",
            subject: wording.subject,
            bodyText: wording.body,
            replyToken: newToken().slice(0, 24),
            jobId: job.id,
            dedupeKey: `job:${job.id}`,
            providerMessageId: `demo:${job.id}`,
            generatedBy: "template",
            createdAt: at,
            sentAt: at,
          })
          .returning({ id: messages.id });
        await tx
          .update(reminderJobs)
          .set({ status: "sent", messageId: m!.id })
          .where(eq(reminderJobs.id, job.id));
      }

      if (spec.key === "o4") {
        await tx.insert(promises).values({
          tenantId,
          invoiceId: id,
          promisedDate: addDays(today, -15),
          source: "portal",
          status: "broken",
          priorStatus: "overdue",
          resolvedAt: ago(13),
        });
        await log(ago(18), "promise.created", id, {
          after: { promisedDate: addDays(today, -15), source: "portal" },
        });
        await log(ago(13), "promise.broken", id, { after: { promisedDate: addDays(today, -15) } });
      }
      if (spec.status === "promised") {
        const promisedDate = addDays(today, 3);
        await tx.insert(promises).values({
          tenantId,
          invoiceId: id,
          promisedDate,
          source: "portal",
          priorStatus: "overdue",
        });
        await log(ago(2), "promise.created", id, { after: { promisedDate, source: "portal" } });
        await pauseInvoiceJobs(tx, id, "promise");
      }
      if (spec.status === "disputed") {
        await tx.insert(disputes).values({
          tenantId,
          invoiceId: id,
          reason: "The number of sessions doesn't match our purchase order",
          source: "portal",
          priorStatus: "overdue",
        });
        await log(ago(3), "dispute.opened", id, {
          after: { reason: "The number of sessions doesn't match our purchase order" },
        });
        await pauseInvoiceJobs(tx, id, "dispute");
      }

      // A reminder the firm still has to approve, and replies still to read.
      if (spec.key === "o5") {
        const [job] = await tx
          .select()
          .from(reminderJobs)
          .where(and(eq(reminderJobs.invoiceId, id), eq(reminderJobs.status, "scheduled")));
        if (job) {
          const step = steps.find((s) => s.id === job.stepId)!;
          const wording = reminderDraft({
            clientName: "Hooli",
            number,
            amountDueMinor: totals.totalMinor,
            dueDate,
            daysFromDue: -spec.due,
            templateKey: step.templateKey,
            tone: step.tone,
          });
          const [draft] = await tx
            .insert(messages)
            .values({
              tenantId,
              clientId: clientId.hooli!,
              invoiceId: id,
              contactId: contactId.hooli!,
              direction: "out",
              kind: "reminder",
              status: "draft",
              subject: wording.subject,
              bodyText: wording.body,
              replyToken: newToken().slice(0, 24),
              jobId: job.id,
              dedupeKey: `job:${job.id}`,
            })
            .returning({ id: messages.id });
          await tx
            .update(reminderJobs)
            .set({ status: "awaiting_approval", messageId: draft!.id })
            .where(eq(reminderJobs.id, job.id));
          await tx.insert(reviewItems).values({
            tenantId,
            kind: "draft_approval",
            invoiceId: id,
            messageId: draft!.id,
            jobId: job.id,
            payload: {
              stepOffsetDays: step.offsetDays,
              tone: step.tone,
              to: CLIENTS[3]!.email,
              by: "template",
            },
          });
        }
      }
      const reply =
        spec.key === "o5"
          ? "Hi, sorry for the delay on this one. We'll get the payment out on Friday."
          : spec.key === "o3"
            ? "Hello, we already paid this invoice by bank transfer last week. Can you check?"
            : null;
      if (reply) {
        const c = CLIENTS.find((x) => x.key === spec.client)!;
        const [m] = await tx
          .insert(messages)
          .values({
            tenantId,
            clientId: clientId[spec.client]!,
            invoiceId: id,
            contactId: contactId[spec.client]!,
            direction: "in",
            kind: "reply",
            status: "received",
            subject: `Re: Invoice ${number}`,
            bodyText: reply,
            bodyStripped: reply,
            providerMessageId: `demo_in_${id}`,
            createdAt: ago(0.1),
          })
          .returning({ id: messages.id });
        await tx.insert(reviewItems).values({
          tenantId,
          kind: "low_confidence_reply",
          invoiceId: id,
          messageId: m!.id,
          payload: { from: c.email, reason: "awaiting_review" },
        });
        replyMessageIds.push(m!.id);
      }
    }

    // The payment outlook for everything still open.
    const open = await tx.select({ id: invoices.id, status: invoices.status }).from(invoices);
    for (const o of open) {
      if (["sent", "viewed", "overdue", "promised", "disputed"].includes(o.status))
        await refreshRisk(tx, tenantId, o.id);
    }
    return { replyMessageIds, invoiceIds: invoiceId };
  });
}

/** A new firm, flagged as a demo and filled with data, for someone who just wants to look around. */
export async function createDemoFirm(
  db: Db,
  user: NewFirmUser,
  opts: { connectPayments: boolean; model: ModelClient | null },
  requestId?: string,
) {
  const slug = `demo-${crypto.randomUUID().slice(0, 6)}`;
  const { tenantId } = await createFirm(
    db,
    user,
    { legalName: "Northwind Advisory LLC", displayName: "Northwind Advisory", platformSlug: slug },
    requestId,
  );
  await withTenant(db, tenantId, (tx) =>
    tx.update(firms).set({ isDemo: true }).where(eq(firms.id, tenantId)),
  );
  const seeded = await seedDemoData(db, { tenantId, type: "system", id: null, requestId }, opts);
  return { tenantId, slug, replyMessageIds: seeded.replyMessageIds };
}

/** Reads the seeded replies the way the jobs worker would, so the review queue opens with suggestions ready. */
export async function classifySeededReplies(
  systemDb: Db,
  model: ModelClient | null,
  ids: string[],
) {
  for (const id of ids) await classifyReply(systemDb, { model }, id);
}

export async function demoStatus(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const { firm, today } = await firmClock(tx, tenantId);
    const did = async (action: string) =>
      (
        await tx
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(and(eq(auditLog.action, action), sql`${auditLog.summary}->>'demo' is null`))
          .limit(1)
      ).length > 0;
    return {
      isDemo: firm.isDemo,
      today,
      offsetDays: Math.round(firm.clockOffsetSeconds / 86_400),
      // The guided tour (FR-14.6): send, fast-forward, reply, promise, pay. Sample history is not counted.
      tour: {
        sent: await did("invoice.sent"),
        advanced: await did("demo.clock_advanced"),
        replied: await did("message.received"),
        promised: await did("promise.created"),
        paid: await did("payment.succeeded"),
      },
    };
  });
}

/**
 * FR-14.2. Moves the firm's clock forward and runs one scheduler cycle straight away, so the reminders that
 * fell due are drafted or sent now instead of at the next minute. Only the firm's own clock moves.
 */
export async function advanceClock(
  db: Db,
  systemDb: Db,
  deps: { queue: QueuePort; model: ModelClient | null },
  actor: Actor,
  days: number,
) {
  if (!(await isDemoFirm(db, actor.tenantId))) assertDemo(false);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new DomainError("demo.invalid_days", "validation", "Choose between 1 and 90 days.");
  }
  await withTenant(db, actor.tenantId, async (tx) => {
    await tx
      .update(firms)
      .set({ clockOffsetSeconds: sql`${firms.clockOffsetSeconds} + ${days * 86_400}` })
      .where(and(eq(firms.id, actor.tenantId), eq(firms.isDemo, true)));
    await tx.insert(auditLog).values({
      tenantId: actor.tenantId,
      actorType: actor.type,
      actorId: actor.id,
      action: "demo.clock_advanced",
      entityType: "firm",
      entityId: actor.tenantId,
      summary: { after: { days } },
    });
  });
  const cycle = await runDevTick(systemDb, deps.queue, { model: deps.model });
  return { ...(await demoStatus(db, actor.tenantId)), cycle };
}

/** FR-14.4. The viewer types a client's reply; it goes through the real inbound and classification path. */
export async function simulateReply(
  db: Db,
  systemDb: Db,
  deps: { model: ModelClient | null },
  actor: Actor,
  input: { invoiceId: string; text: string },
) {
  if (!(await isDemoFirm(db, actor.tenantId))) assertDemo(false);
  const target = await withTenant(db, actor.tenantId, async (tx) => {
    const { now } = await firmClock(tx, actor.tenantId);
    const [row] = await tx
      .select({ number: invoices.number, email: contacts.email })
      .from(invoices)
      .innerJoin(
        contacts,
        and(eq(contacts.clientId, invoices.clientId), eq(contacts.isPrimary, true)),
      )
      .where(eq(invoices.id, input.invoiceId));
    return row && { ...row, now };
  });
  if (!target?.number)
    throw new DomainError("invoice.not_found", "not_found", "Invoice not found.");

  const received = await receiveInboundEmail(systemDb, {
    providerId: `demo_reply_${crypto.randomUUID()}`,
    from: target.email,
    to: ["billing@duely.app"],
    subject: `Re: Invoice ${target.number}`,
    text: input.text,
    // Written on the firm's clock, so "Friday" means the Friday after the date the viewer fast-forwarded to.
    receivedAt: target.now,
  });
  if (!("messageId" in received)) {
    throw new DomainError(
      "demo.not_matched",
      "unprocessable",
      "That reply couldn't be matched to the invoice.",
    );
  }
  const decision = await classifyReply(systemDb, deps, received.messageId);
  return { decision };
}

/** FR-14.5. Wipes the demo firm's data (the database refuses any other firm) and seeds it again. */
export async function resetDemo(
  db: Db,
  systemDb: Db,
  deps: { model: ModelClient | null },
  actor: Actor,
  opts: { connectPayments: boolean },
) {
  if (!(await isDemoFirm(db, actor.tenantId))) assertDemo(false);
  await withTenant(db, actor.tenantId, (tx) =>
    tx.execute(sql`select reset_demo_firm(${actor.tenantId}::uuid)`),
  );
  const seeded = await seedDemoData(db, actor, opts);
  await classifySeededReplies(systemDb, deps.model, seeded.replyMessageIds);
  return demoStatus(db, actor.tenantId);
}
