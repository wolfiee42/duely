import { expect, test, type Page } from "@playwright/test";

// A reminder end to end: invoice sent -> the scheduler drafts a reminder -> the firm edits and approves it
// in the review queue -> the client gets exactly that text -> the client stops reminders from the email.
// No jobs worker locally, so `/api/dev/tick` runs one scheduler cycle and `makeDue` stands in for time passing.

const PORT = 3100;
const APP = `http://app.localhost:${PORT}`;
const PASSWORD = "correct horse battery staple";

async function outbox(page: Page) {
  const res = await page.request.get(`${APP}/api/dev/outbox`);
  return (await res.json()) as Array<{ to: string; subject: string; text: string }>;
}

test("a drafted reminder is edited, approved, sent once, and can be stopped by the client", async ({
  page,
  browser,
}) => {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Rem Owner");
  await page.getByLabel("Email").fill("rem@e2e.test");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL("**/onboarding");
  await page.getByLabel("Legal name").fill("E2E Reminders LLC");
  await page.getByLabel("Display name").fill("E2E Reminders");
  await page.getByLabel("Client portal address").fill("e2e-reminders");
  await page.getByRole("button", { name: "Create firm" }).click();
  await page.waitForURL("**/");

  // Connect payments (fake) so invoices can be sent.
  await page.goto("/settings");
  let accountId = "";
  await page.route("https://connect.stripe.test/**", async (route) => {
    accountId = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({ status: 200, contentType: "text/html", body: "<p>Stripe</p>" });
  });
  await page.getByRole("button", { name: "Connect payments" }).click();
  await expect.poll(() => accountId).toMatch(/^acct_fake_/);
  await page.request.post(`${APP}/api/dev/complete-onboarding`, { data: { accountId } });
  await page.goto("/settings"); // loading the page syncs the account's status
  await expect(page.getByText("Payments are connected")).toBeVisible();

  // The default plan is there, and the preview shows what would happen.
  await page.goto("/policies");
  await expect(page.getByRole("tab", { name: /Standard follow-up/ })).toBeVisible();
  await expect(page.getByTestId("preview").getByRole("listitem")).toHaveCount(5);
  // Weekends and all-day windows: make the sending window cover any time of day, so the test is not clock-dependent.
  await page.getByLabel("Earliest send time").fill("00:00");
  await page.getByLabel("Latest send time").fill("23:59");
  await page.getByLabel("Send on weekends").check();
  await page.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByText("Plan saved.")).toBeVisible();

  // A client and an invoice, sent.
  await page.goto("/clients");
  await page.getByLabel("Client name").fill("Initech");
  await page.getByLabel("Contact name").fill("Bill Lumbergh");
  await page.getByLabel("Contact email").fill("bill@initech.test");
  await page.getByRole("button", { name: "Add client" }).click();
  await page.waitForURL(/\/clients\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "New invoice" }).click();
  await page.getByLabel("Description 1").fill("Consulting");
  await page.getByLabel("Quantity 1").fill("1");
  await page.getByLabel("Price 1").fill("500.00");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Send invoice" }).click();
  await expect(page.getByText("sent", { exact: true }).first()).toBeVisible();

  // Time passes: the scheduler drafts the reminders that fell due. Nothing is emailed without approval.
  const before = (await outbox(page)).length;
  const tick = await page.request.post(`${APP}/api/dev/tick`, { data: { makeDue: true } });
  expect(tick.ok()).toBe(true);
  expect((await tick.json()).drafted).toBeGreaterThan(0);
  expect((await outbox(page)).length).toBe(before);

  await page.goto("/review");
  await expect(page.getByTestId("review-count")).toBeVisible();
  const card = page.getByRole("listitem").first();
  await expect(card.getByText("Reminder to approve")).toBeVisible();
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Subject").fill("A quick note about your invoice");
  await card
    .getByLabel("Message")
    .fill("Hi Bill, just checking in.\n\nView and pay: {{portal_url}}");
  await card.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByText("Approved. It will be sent shortly.")).toBeVisible();

  // Exactly the edited text is sent, once, with a stop link.
  await expect
    .poll(
      async () =>
        (await outbox(page)).filter((m) => m.subject === "A quick note about your invoice").length,
    )
    .toBe(1);
  const reminder = (await outbox(page)).find(
    (m) => m.subject === "A quick note about your invoice",
  )!;
  expect(reminder.to).toBe("bill@initech.test");
  expect(reminder.text).toContain("Hi Bill, just checking in.");
  expect(reminder.text).toMatch(/\/api\/portal\/auth\/[\w-]{43}/);
  const stop = /http:\/\/[\w.:-]+\/api\/unsubscribe\/[\w-]+/.exec(reminder.text)?.[0];
  expect(stop).toBeTruthy();

  // The client stops reminders: opening the link alone changes nothing; confirming does.
  const client = await (await browser.newContext()).newPage();
  await client.goto(stop!);
  await expect(client.getByRole("heading", { name: "Stop reminders?" })).toBeVisible();
  await client.getByRole("button", { name: "Stop reminders" }).click();
  await expect(client.getByRole("heading", { name: "Reminders stopped" })).toBeVisible();

  // The firm sees it on the client, and no more reminders are drafted.
  await page.goto("/clients");
  await page.getByRole("link", { name: "Initech" }).click();
  await expect(page.getByText("stopped reminders")).toBeVisible();
  await page.request.post(`${APP}/api/dev/tick`, { data: { makeDue: true } });
  await page.goto("/review");
  await expect(page.getByText("Reminder to approve")).toHaveCount(0);
});
