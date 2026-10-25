import { expect, test } from "@playwright/test";

// The demo loop a visitor follows (SPEC P6-08): start the demo, send an invoice, fast-forward, reply as the
// client, record the promise, pay as the client. It has to take under 90 seconds end to end.

const PASSWORD = "correct horse battery staple";
const BUDGET_MS = 90_000;

test("the demo loop: send, fast-forward, reply, promise, pay, in under 90 seconds", async ({
  page,
  browser,
}) => {
  const started = performance.now();

  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Dee Visitor");
  await page.getByLabel("Email").fill("dee@e2e.test");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL("**/onboarding");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Explore with sample data" }).click();
  await page.waitForURL("**/app/demo");
  await expect(page.getByText("Quick tour · 0 of 5")).toBeVisible();

  // The sample firm has history: aging buckets, a promise this week, payments.
  await page.goto("/app");
  await expect(page.getByTestId("aging-61+")).toContainText("(1)");
  await expect(page.getByTestId("promises-due").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("recent-payments").getByRole("listitem")).toHaveCount(5);

  // 1. Send an invoice.
  await page.goto("/app/invoices/new");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Client").selectOption({ label: "Initech" });
  await page.getByLabel("Description 1").fill("Demo consulting");
  await page.getByLabel("Quantity 1").fill("1");
  await page.getByLabel("Price 1").fill("500.00");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/app\/invoices\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Send invoice" }).click();
  const heading = page.getByRole("heading", { name: /^Invoice / });
  await expect(heading).toBeVisible();
  const number = (await heading.textContent())!.replace("Invoice ", "").trim();
  // The invoice now has a story.
  await expect(page.getByTestId("timeline")).toContainText("Invoice sent");

  // 2. Fast-forward a week.
  await page.goto("/app/demo");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "+7 days" }).click();
  await expect(page.getByTestId("demo-note")).toContainText("It's now");

  // 3. Reply as the client.
  await page.getByLabel("Reply to invoice").selectOption({ label: `${number} · Initech` });
  await page.getByLabel("Their message").fill("Hi, sorry for the wait. I will pay this on Friday.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByTestId("demo-note")).toContainText("reply arrived");

  // 4. The assistant read it as a promise; record it.
  await page.goto("/app/review");
  const card = page.getByRole("listitem").filter({ hasText: number });
  await expect(card.getByTestId("suggestion")).toContainText("Looks like a promise to pay");
  await card.getByRole("button", { name: "Record the promise" }).click();
  await expect(page.getByText("Done.")).toBeVisible();

  // 5. Pay as the client, from the link in the outbox.
  await page.goto("/app/demo");
  await page.waitForLoadState("networkidle");
  const row = page
    .getByTestId("outbox")
    .getByRole("listitem")
    .filter({ hasText: `Invoice ${number} from` });
  await row.locator("summary").click();
  const href = await row.getByRole("link").first().getAttribute("href");
  expect(href).toMatch(/\/api\/portal\/auth\/[\w-]{43}$/);

  const clientContext = await browser.newContext();
  const client = await clientContext.newPage();
  await client.goto(href!);
  await client.waitForURL(/\/portal\/invoices\/[0-9a-f-]{36}$/);
  await client.waitForLoadState("networkidle");
  await client.getByRole("button", { name: "Pay now" }).click();
  await client.getByRole("button", { name: "Pay (test mode)" }).click();
  await expect(client.getByText("this invoice is paid")).toBeVisible();
  await clientContext.close();

  // The tour ticks off all five, and the whole story is on the invoice.
  await page.goto("/app/demo");
  await expect(page.getByText("Quick tour · 5 of 5")).toBeVisible();
  await page.getByRole("link", { name: "Open review" }).waitFor();
  await page.goto("/app/invoices");
  await page.getByRole("link", { name: number }).click();
  const story = page.getByTestId("timeline");
  for (const step of ["Invoice sent", "Client replied", "Promise to pay by", "Payment received"]) {
    await expect(story).toContainText(step);
  }

  expect(performance.now() - started, "demo loop duration").toBeLessThan(BUDGET_MS);
});
