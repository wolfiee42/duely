import { describe, expect, it } from "vite-plus/test";

import { createResendClient, EmailSendError } from "./client";
import { createFakeEmail } from "./fake";
import { escapeHtml, invoiceEmail, magicLinkEmail, receiptEmail } from "./templates";
import { EmailWebhookError, signSvix, verifyResendWebhook } from "./webhook";

const brand = { firmName: "Acme <b>&</b> Co", brandColor: "#112233" };

describe("templates", () => {
  it("escapes firm and client supplied text but not the amount", () => {
    const mail = invoiceEmail({
      ...brand,
      clientName: '<script>alert("x")</script>',
      number: "INV-0001",
      totalMinor: 123_456,
      dueDate: "2026-04-01",
      portalUrl: "https://acme.duely.app/portal/invoices/1",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("Acme &lt;b&gt;&amp;&lt;/b&gt; Co");
    expect(mail.html).toContain("$1,234.56");
    expect(mail.subject).toBe("Invoice INV-0001 from Acme <b>&</b> Co"); // subjects are plain text
    expect(mail.text).toContain("https://acme.duely.app/portal/invoices/1");
  });

  it("refuses non-http links and ignores a brand color that is not #RRGGBB", () => {
    expect(() => magicLinkEmail({ ...brand, url: "javascript:alert(1)", minutes: 15 })).toThrow(
      /unsafe/,
    );
    const mail = receiptEmail({
      firmName: "A",
      brandColor: "red;background:url(x)",
      clientName: "C",
      number: "1",
      amountMinor: 100,
      portalUrl: "https://a.test/r",
    });
    expect(mail.html).not.toContain("url(x)");
    expect(mail.html).toContain("#1F4FD8");
  });

  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("resend client", () => {
  const email = {
    to: "a@b.test",
    from: "Acme <x@duely.app>",
    subject: "s",
    html: "<p>h</p>",
    text: "t",
    idempotencyKey: "k-1",
  };
  const fetchReturning = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("sends with the idempotency key and returns the provider id", async () => {
    let seen: RequestInit | undefined;
    const f = (async (_u: string, init: RequestInit) => (
      (seen = init),
      new Response(JSON.stringify({ id: "re_1" }))
    )) as unknown as typeof fetch;
    expect(await createResendClient("key", f).send(email)).toEqual({ providerMessageId: "re_1" });
    expect((seen!.headers as Record<string, string>)["idempotency-key"]).toBe("k-1");
  });

  it("marks 5xx and 429 retryable, other 4xx permanent", async () => {
    for (const [status, retryable] of [
      [503, true],
      [429, true],
      [422, false],
      [403, false],
    ] as const) {
      const err = await createResendClient("k", fetchReturning({ message: "no" }, status))
        .send(email)
        .catch((e) => e);
      expect(err).toBeInstanceOf(EmailSendError);
      expect(err.retryable).toBe(retryable);
    }
  });
});

describe("fake email", () => {
  it("delivers a repeated idempotency key once", async () => {
    const f = createFakeEmail();
    const m = {
      to: "a@b.test",
      from: "x",
      subject: "s",
      html: "h",
      text: "t",
      idempotencyKey: "same",
    };
    const a = await f.send(m);
    const b = await f.send(m);
    expect(b).toEqual(a);
    expect(f.sent).toHaveLength(1);
  });
});

describe("Resend webhook verification", () => {
  const secret = `whsec_${btoa("super-secret-key-bytes")}`;
  const body = JSON.stringify({ type: "email.bounced", data: { email_id: "re_1" } });
  const now = 1_800_000_000;
  const headers = async (
    over: Partial<Record<"id" | "timestamp" | "signature", string | null>> = {},
  ) => ({
    id: "msg_1",
    timestamp: String(now),
    signature: await signSvix("msg_1", now, body, secret),
    ...over,
  });

  it("accepts a correctly signed event", async () => {
    const event = await verifyResendWebhook(body, await headers(), secret, { nowSeconds: now });
    expect(event.type).toBe("email.bounced");
  });

  it("accepts any of several signatures during secret rotation", async () => {
    const h = await headers();
    const rotated = { ...h, signature: `v1,AAAA ${h.signature}` };
    await expect(
      verifyResendWebhook(body, rotated, secret, { nowSeconds: now }),
    ).resolves.toBeTruthy();
  });

  it.each([
    ["no signature", { signature: null }],
    ["no id", { id: null }],
    ["a wrong signature", { signature: "v1,AAAAAAAA" }],
    ["a replayed old timestamp", { timestamp: String(now - 3600) }],
  ])("rejects %s", async (_label, over) => {
    await expect(
      verifyResendWebhook(body, await headers(over), secret, { nowSeconds: now }),
    ).rejects.toBeInstanceOf(EmailWebhookError);
  });

  it("rejects a tampered body", async () => {
    await expect(
      verifyResendWebhook(`${body} `, await headers(), secret, { nowSeconds: now }),
    ).rejects.toThrow(/mismatch/);
  });

  it("refuses everything when no secret is configured", async () => {
    await expect(
      verifyResendWebhook(body, await headers(), "", { nowSeconds: now }),
    ).rejects.toThrow(/not configured/);
  });
});
