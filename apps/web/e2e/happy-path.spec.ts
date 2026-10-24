import { expect, test, type Page } from "@playwright/test";

// e2e-happy-path (SPEC 8): sign-up -> connect -> invoice -> pay -> paid.
// Runs against the built Worker with fake services: no real email or payments, and the outbox is
// delivered inline. Staff work happens on app.localhost, the client's on acme.localhost.

const PORT = 3100;
const APP = `http://app.localhost:${PORT}`;
const PORTAL = `http://e2e-acme.localhost:${PORT}`;
const PASSWORD = "correct horse battery staple";

async function outbox(page: Page) {
  const res = await page.request.get(`${APP}/api/dev/outbox`);
  return (await res.json()) as Array<{ to: string; subject: string; text: string }>;
}

async function waitForEmail(page: Page, match: (m: { to: string; subject: string }) => boolean) {
  let found: { to: string; subject: string; text: string } | undefined;
  await expect
    .poll(async () => (found = (await outbox(page)).filter(match).at(-1)), {
      timeout: 15_000,
      message: "email not delivered",
    })
    .toBeTruthy();
  return found!;
}

test("a firm signs up, connects payments, sends an invoice, and the client pays it", async ({
  page,
  browser,
}) => {
  // 1. Sign up and create the firm.
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ada Owner");
  await page.getByLabel("Email").fill("ada@e2e.test");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();

  await page.waitForURL("**/onboarding");
  await page.getByLabel("Legal name").fill("E2E Acme LLC");
  await page.getByLabel("Display name").fill("E2E Acme");
  await page.getByLabel("Client portal address").fill("e2e-acme");
  await page.getByRole("button", { name: "Create firm" }).click();
  await page.waitForURL("**/app");
  await expect(page.getByRole("heading", { name: "Welcome to E2E Acme" })).toBeVisible();

  // 2. Connect payments. Stripe's hosted form is replaced by the fake; finish onboarding as it would.
  await page.goto("/app/settings");
  let accountId = "";
  await page.route("https://connect.stripe.test/**", async (route) => {
    accountId = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<p>Stripe onboarding</p>",
    });
  });
  await page.getByRole("button", { name: "Connect payments" }).click();
  await expect.poll(() => accountId).toMatch(/^acct_fake_/);
  expect(
    (await page.request.post(`${APP}/api/dev/complete-onboarding`, { data: { accountId } })).ok(),
  ).toBe(true);
  await page.goto("/app/settings");
  await expect(page.getByText("Payments are connected")).toBeVisible();

  // 3. Add a client and draft an invoice.
  await page.goto("/app/clients");
  await page.getByLabel("Client name").fill("Initech");
  await page.getByLabel("Contact name").fill("Bill Lumbergh");
  await page.getByLabel("Contact email").fill("bill@initech.test");
  await page.getByRole("button", { name: "Add client" }).click();
  await page.waitForURL(/\/app\/clients\/[0-9a-f-]{36}$/);

  await page.getByRole("button", { name: "New invoice" }).click();
  await page.getByLabel("Description 1").fill("Consulting");
  await page.getByLabel("Quantity 1").fill("2");
  await page.getByLabel("Price 1").fill("150.00");
  await expect(page.getByText("Total $300.00")).toBeVisible(); // live total, same rounding as the server
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/app\/invoices\/[0-9a-f-]{36}$/);
  const invoiceUrl = page.url();

  // 4. Send it. The client's invoice email carries the magic link.
  await page.getByRole("button", { name: "Send invoice" }).click();
  await expect(page.getByRole("heading", { name: /Invoice E2E-|Invoice INV-/ })).toBeVisible();
  await expect(page.getByText("sent", { exact: true }).first()).toBeVisible();

  const invoiceEmail = await waitForEmail(
    page,
    (m) => m.to === "bill@initech.test" && m.subject.startsWith("Invoice "),
  );
  const link = /http:\/\/[\w.:-]+\/api\/portal\/auth\/[\w-]{43}/.exec(invoiceEmail.text)?.[0];
  expect(link, "invoice email contains the portal link").toBeTruthy();
  expect(link!.startsWith(PORTAL)).toBe(true);

  // 5. The client opens the link in their own browser context (separate cookies) and pays.
  const clientContext = await browser.newContext();
  const client = await clientContext.newPage();
  await client.goto(link!);
  await client.waitForURL(/\/portal\/invoices\/[0-9a-f-]{36}$/);
  await expect(client.getByTestId("amount-due")).toHaveText("$300.00");
  await client.getByRole("button", { name: "Pay now" }).click();
  await client.getByRole("button", { name: "Pay (test mode)" }).click();
  await expect(client.getByText("this invoice is paid")).toBeVisible();

  // The staff cookie was never sent to the portal host, and vice versa.
  expect(await clientContext.cookies(APP)).toEqual([]);
  expect((await page.context().cookies(PORTAL)).length).toBe(0);

  // 6. The firm sees it paid, and the client gets a receipt.
  await page.goto(invoiceUrl);
  await expect(page.getByText("paid", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Card · succeeded")).toBeVisible();
  const receipt = await waitForEmail(
    page,
    (m) => m.to === "bill@initech.test" && m.subject.startsWith("Receipt for invoice"),
  );
  expect(receipt.text).toContain("$300.00");

  await client.goto(`${PORTAL}/portal/receipts`);
  await expect(client.getByText("$300.00")).toBeVisible();
  await clientContext.close();
});

test("the staff app is a 404 on a portal host and the portal is a 404 on the app host", async ({
  page,
}) => {
  expect((await page.goto(`${PORTAL}/app`))!.status()).toBe(404);
  expect((await page.goto(`${PORTAL}/login`))!.status()).toBe(404);
  expect((await page.goto(`${APP}/portal`))!.status()).toBe(404);
  expect((await page.goto(`http://nope.localhost:${PORT}/`))!.status()).toBe(404);
});
