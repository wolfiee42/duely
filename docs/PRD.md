# PRD: Branded Billing Portals with Adaptive Collections

> **Product name:** Duely
> **Status:** Draft v1 · **Owner:** Saif · **Last updated:** 2026-10-24
> **Companion doc:** `FEATURE_REQUIREMENTS.md` (stories, requirements, acceptance criteria)

---

## 1. Summary

A multi-tenant SaaS that gives small service firms a **branded client billing portal** on their own domain (`billing.theirfirm.com`) and a **collections engine that adapts to what clients actually say**.

Most invoicing tools send reminders on a fixed schedule and keep sending them even after the client replies "I'll pay Friday." This product reads the reply, records a **promise to pay**, and reshapes the reminder schedule around it. Firms get paid faster with less awkward chasing, and clients get a clean, professional place to view and pay what they owe.

**One-line pitch:** _Branded client billing portals for small firms, with a collections engine that adapts to what clients actually say._

---

## 2. Problem

Small service firms (consultancies, boutique law, design and dev studios, architects) invoice by hand or through generic tools and then chase payment manually.

| Pain                                                                                                             | Who feels it | Today's workaround                     |
| ---------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------- |
| Invoices arrive as email attachments with no branded, trustworthy place to pay                                   | Client       | Bank transfer, back-and-forth emails   |
| Reminders are either forgotten or sent on a rigid schedule that ignores context                                  | Firm         | Calendar nudges, awkward manual emails |
| Client replies ("paying Friday", "we dispute line 3", "already paid") sit in an inbox and never update the books | Firm         | Mental tracking, spreadsheets          |
| Tone is hard: too soft is ignored, too hard damages the relationship                                             | Firm owner   | Procrastination                        |
| Cash-flow visibility is poor: who is late, who is likely to be late                                              | Firm owner   | Gut feel                               |

**Core insight:** the valuable signal in collections is the client's _reply_, and nobody is using it.

---

## 3. Target users

### 3.1 Personas

**Firm Owner / Admin ("Maya", 6-person design studio)**
Runs the business, signs up, connects Stripe, sets brand and collections policy. Cares about cash flow and about not souring client relationships. Low tolerance for setup friction.

**Firm Staff / Biller ("Dan", office manager)**
Creates invoices, reviews AI-drafted follow-ups, handles replies flagged "needs human." Wants a short daily queue, not a dashboard to study.

**Client Payer ("Priya", finance contact at a client company)**
Receives an email, wants to see what she owes, pay by card or ACH in under a minute, get a receipt, and say "paying Friday" or "this line is wrong" without a phone call. Will never create a password.

### 3.2 Out-of-scope customers (v1)

Accounting and tax practices, enterprises, firms billing in multiple currencies, subscription businesses with recurring billing.

---

## 4. Goals and non-goals

### 4.1 Product goals

1. A firm can go from sign-up to **first payable invoice** in under 15 minutes.
2. A client can pay an invoice from email link to receipt in **under 60 seconds** with no account creation.
3. Collections run **automatically, safely, and idempotently**: no duplicate sends, no reminders after payment, no reminders during a promise or dispute.
4. Client replies are **classified and acted on** (promise, dispute, already-paid, needs-human) with a human in the loop by default.
5. Every AI action is **auditable** (input hash, model, cost, validated output).

### 4.2 Portfolio goals (secondary, shape priorities)

1. A live, seeded demo that shows the full loop in under 90 seconds using the "simulate time" button.
2. A README that exposes architecture and trade-offs clearly.
3. Concrete evidence for interview topics: idempotency, RLS, custom-domain lifecycle, Stripe Connect charge models, ledger design, auditable AI.

### 4.3 Non-goals (v1)

- Accounting-system sync (QuickBooks, Xero). CSV import instead.
- SMS or any non-email reminder channel.
- Recurring or subscription invoices.
- Tax calculation.
- Multi-currency (USD only).
- A trained ML risk model (rules plus LLM explanation only).
- Full accounting, payroll, expense tracking, or a general CRM.
- Native mobile apps (responsive web only).

---

## 5. Product principles

1. **The ledger is the truth.** UI reads the internal payments ledger, never live Stripe state.
2. **Humans approve by default.** AI drafts; auto-send is an explicit, per-firm opt-in.
3. **Stop is sacred.** A payment, promise, or dispute must stop or pause reminders immediately and provably.
4. **Idempotent everywhere.** Webhooks, reminder jobs, and sends can all be retried safely.
5. **Isolation in depth.** `tenant_id` on every table plus row-level security; never rely on application code alone.
6. **Clients never see the machinery.** The portal looks like the firm, not like the platform.

---

## 6. Scope and phasing

Full planned scope is kept, delivered in vertical slices. Priorities: **P0** = demo cannot work without it, **P1** = expected in a polished v1, **P2** = nice to have, first to cut under time pressure.

| Phase | Theme              | Outcome                                                                         |
| ----- | ------------------ | ------------------------------------------------------------------------------- |
| 1     | Foundation         | Auth, firms, members, tenant resolution by host, RLS                            |
| 2     | Money path         | Connect onboarding, invoice CRUD, portal payment, webhooks, ledger              |
| 3     | Custom domains     | Cloudflare custom hostnames, verification and SSL status UI                     |
| 4     | Collections engine | Policies, scheduler, idempotent sends, pause and stop rules                     |
| 5     | AI layer           | PDF extraction, follow-up drafts, reply classification and promises, risk score |
| 6     | Demo polish        | Seed data, simulate-time, README and diagram, GIF, Loom                         |

**Additions beyond the original plan** (flagged so you can veto): a minimal firm dashboard with AR aging (P1), CSV import for clients and invoices (P1, replaces accounting sync), ACH async-state handling (P0, required for correctness), and a "needs human" review queue (P0, required by the AI-approval principle).

---

## 7. Key user journeys

### J1. Firm onboarding

Sign up → create firm → upload logo and pick colors → Stripe Connect Express onboarding → add custom domain (optional, CNAME instructions) → create first client and invoice → send.
_Success:_ invoice link received by a test client within 15 minutes of sign-up.

### J2. Client pays

Email with invoice link → magic-link sign-in (no password) → invoice detail → pay by card or ACH → receipt by email and in portal.
_Success:_ invoice moves to `paid`, ledger entry written, reminders cancelled.

### J3. Adaptive collection (the signature flow)

Invoice goes overdue → policy step sends reminder → client replies "I'll pay Friday" → inbound parser feeds classifier → promise recorded with date → reminders pause until the promise date → on a missed promise, schedule resumes at the next escalation step → on payment, everything stops.
_Success:_ promise created with correct date, no reminder sent during promise window, firm sees the full timeline.

### J4. Dispute

Client clicks "dispute" (or the classifier detects one) → invoice moves to `disputed` → reminders pause → firm is notified → firm resolves (edit, void, or re-open) → schedule resumes or stops.

### J5. PDF to invoice

Firm uploads a PDF or photo → structured extraction → draft invoice with line items → firm reviews, edits, sends.

### J6. Firm reviews AI work

Daily queue shows drafted follow-ups awaiting approval, replies classified as "needs human," and low-confidence promises. Firm approves, edits, or rejects. Every decision is logged.

---

## 8. Success metrics

### 8.1 Product metrics (what a real launch would track)

| Metric                                           | Target (illustrative) |
| ------------------------------------------------ | --------------------- |
| Time from sign-up to first sent invoice          | < 15 min median       |
| Client time from link click to receipt           | < 60 sec median       |
| Days sales outstanding vs. firm's prior baseline | Improved by 15%+      |
| Share of inbound replies correctly classified    | ≥ 90% on the eval set |
| Draft approval rate without edits                | ≥ 60%                 |
| Duplicate sends or reminders-after-payment       | 0                     |

### 8.2 Build-quality metrics (what the portfolio proves)

| Metric                                                    | Target                                           |
| --------------------------------------------------------- | ------------------------------------------------ |
| Tenant-isolation tests (cross-tenant read/write attempts) | 100% blocked, automated                          |
| Webhook replay test (same event delivered 3x)             | Exactly one ledger effect                        |
| Scheduler concurrency test (2 workers, same due rows)     | Exactly one send per job                         |
| Classifier eval set                                       | 40+ labeled replies, accuracy reported in README |
| Demo run time                                             | Full loop in < 90 sec                            |

---

## 9. Technical overview

Details are in the project plan; this section records the decisions requirements depend on.

| Area           | Decision                                                                                                                | Rationale                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| App            | TanStack Start (React 19, Router, Query) on Cloudflare Workers, in a pnpm monorepo created from `mugnavo/cove-monorepo` | One deployment serves all tenants; Cove supplies auth, UI kit, and layouts |
| API            | Hono for HTTP edge routes (auth, webhooks, inbound email, uploads); tRPC for typed app calls; Zod shared everywhere     | End-to-end types without a second RPC style                                |
| Tenancy        | Host kinds: marketing, app (staff), portal (clients). Portal tenant resolved from `Host`; staff tenant from membership  | Custom domains expose only the client portal; no per-tenant deploys        |
| Database       | Postgres via Hyperdrive, shared schema, `tenant_id` + RLS                                                               | Defense in depth; RLS needs the tenant set per transaction (see risks)     |
| Custom domains | Cloudflare for SaaS custom hostnames, fallback origin                                                                   | Managed SSL and verification lifecycle                                     |
| Scheduler      | `reminder_jobs` with `next_run_at`; cron every minute; claim with `FOR UPDATE SKIP LOCKED`; push to Cloudflare Queues   | Durable, concurrent-safe, testable                                         |
| Email          | Resend outbound; inbound parsing for replies                                                                            | Replies feed the classifier                                                |
| AI             | Claude API, structured output, schema validation, `ai_runs` log                                                         | Auditable, bounded, cost-visible                                           |
| Payments       | Stripe Connect Express, direct charges, `application_fee_amount`, firm is merchant of record                            | Matches target customer; firm owns the relationship                        |
| Money          | Integer minor units plus currency code; USD only                                                                        | No float errors                                                            |
| Client auth    | Magic links, no passwords                                                                                               | Lowest friction for payers                                                 |
| AI autonomy    | Draft-and-approve default; optional per-firm auto-send                                                                  | Safety and trust                                                           |
| Risk scoring   | Rules plus LLM explanation                                                                                              | No training data needed                                                    |

### Core entities

`firms`, `firm_domains`, `members`, `clients`, `contacts`, `invoices`, `invoice_items`, `payments`, `refunds`, `collection_policies`, `policy_steps`, `reminder_jobs`, `messages`, `promises`, `stripe_events`, `ai_runs`, `audit_log`.

---

## 10. Non-functional requirements

| Category           | Requirement                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security           | RLS on every tenant table; magic links are single-use, short-lived, and bound to a contact; secrets never in client bundles; inbound email content treated as untrusted input                 |
| Privacy            | Send the minimum necessary data to the LLM; no card or bank data ever touches our servers (Stripe-hosted elements only)                                                                       |
| Reliability        | All external callbacks and sends are idempotent; retries are safe; failures are visible in the dashboard                                                                                      |
| Performance        | Portal pages < 1.5s p95 on a warm Worker; scheduler claims and enqueues due jobs within 60s of `next_run_at`                                                                                  |
| Auditability       | `audit_log` for state changes and approvals; `ai_runs` for every model call                                                                                                                   |
| Observability      | Structured logs with tenant and request IDs; error tracking on Workers; a basic "system health" view for the demo                                                                             |
| Accessibility      | Portal meets WCAG 2.1 AA basics (contrast, keyboard, labels)                                                                                                                                  |
| Compliance posture | Not a regulated debt collector: copy and defaults avoid threatening language; add a note in the README on FDCPA-style considerations for third-party collectors (this product is first-party) |

---

## 11. Risks and mitigations

| Risk                                                      | Impact                      | Mitigation                                                                                                                                                               |
| --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RLS with pooled connections leaks or loses tenant context | Cross-tenant data exposure  | Set tenant via `SET LOCAL` inside each transaction; automated cross-tenant tests; fail closed when unset                                                                 |
| Prompt injection via inbound client emails                | AI takes unintended action  | Classifier output is schema-validated and can only propose; state changes from low-confidence results go to human queue; never execute instructions from message content |
| Misclassified reply stops collections wrongly             | Lost revenue                | Confidence thresholds; promises always show source quote; missed-promise fallback resumes schedule                                                                       |
| ACH is asynchronous and can fail days later               | Invoice wrongly marked paid | Model `processing` and `failed` states; only mark paid on success event                                                                                                  |
| Custom-domain verification stalls or SSL fails            | Broken portal for a firm    | Visible status states, retry guidance, platform-domain fallback always works                                                                                             |
| Scope too large for 3 to 4 weeks part-time                | Unfinished project hurts CV | Priorities (P0/P1/P2); phase 6 demo polish is protected; cut P2 first                                                                                                    |
| IP conflict with employer                                 | Legal and reputational risk | Ground rules in section 13                                                                                                                                               |
| Duplicate or out-of-order webhooks                        | Wrong balances              | `stripe_events` dedupe table; handlers derive state from the event plus ledger, not from arrival order                                                                   |

---

## 12. Open questions

| #   | Question                                                 | Default if undecided                                                             |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Partial payments in v1?                                  | No: full payment only; ledger schema supports partials for v1.1                  |
| 2   | Late fees or interest?                                   | Out of v1                                                                        |
| 3   | Who can approve AI drafts (any member vs. admin only)?   | Any member; role gating in v1.1                                                  |
| 4   | Data retention and deletion policy for messages?         | Retain until firm deletes; document in README                                    |
| 5   | Platform fee percentage for the demo?                    | Configurable constant, shown transparently in UI                                 |
| 6   | Hosted demo with real Stripe test mode, or fully mocked? | Stripe test mode with seeded data                                                |
| 7   | Final product name and domain                            | Name decided: **Duely**. Domain still to choose before README and Loom           |
| 8   | Reply-matching method for inbound email                  | Tokenized Reply-To address per message, falling back to sender and subject match |

---

## 13. Ground rules (IP and independence)

- Built in a blank repo with original naming (firms, clients, promises, policies).
- No code, schema, workflows, copy, or customer data from any employer product.
- The README describes this as an independent project built from general experience and does not reference an employer's product.
- Before starting, skim the employment contract for IP-assignment and non-compete language. If unclear, get advice from a lawyer rather than guessing.

---

## 14. Definition of done (v1)

- All P0 requirements pass their acceptance criteria.
- Cross-tenant, webhook-replay, and scheduler-concurrency tests pass in CI.
- Seeded demo runs the full loop (send, overdue, reply, promise, pay) with simulate-time in under 90 seconds.
- README includes architecture diagram, decision table, trade-offs, classifier eval results, and a GIF.
- A Loom under 90 seconds is linked at the top of the README.
