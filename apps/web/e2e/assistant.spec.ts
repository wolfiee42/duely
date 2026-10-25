import { expect, test } from "@playwright/test";

// The assistant end to end, on the offline stand-in model: an uploaded invoice becomes a draft to check, the
// invoice is sent, a client's reply is read, and the firm records the promise it found.

const APP = "http://app.localhost:3100";
const PASSWORD = "correct horse battery staple";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

test("an uploaded invoice becomes a draft, and a reply is read into a promise", async ({
  page,
}) => {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ana Owner");
  await page.getByLabel("Email").fill("ana@e2e.test");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL("**/onboarding");
  await page.getByLabel("Legal name").fill("E2E Assistant LLC");
  await page.getByLabel("Display name").fill("E2E Assistant");
  await page.getByLabel("Client portal address").fill("e2e-assistant");
  await page.getByRole("button", { name: "Create firm" }).click();
  await page.waitForURL("**/app");

  // Payments (fake), so the invoice can be sent later.
  await page.goto("/app/settings");
  let accountId = "";
  await page.route("https://connect.stripe.test/**", async (route) => {
    accountId = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({ status: 200, contentType: "text/html", body: "<p>Stripe</p>" });
  });
  await page.getByRole("button", { name: "Connect payments" }).click();
  await expect.poll(() => accountId).toMatch(/^acct_fake_/);
  await page.request.post(`${APP}/api/dev/complete-onboarding`, { data: { accountId } });
  await page.goto("/app/settings");
  await expect(page.getByText("Payments are connected")).toBeVisible();

  // The assistant card: on, with a monthly limit.
  await expect(page.getByTestId("assistant-status")).toHaveText("The assistant is on.");
  await expect(page.getByLabel("Monthly limit ($)")).toHaveValue("5.00");

  // A client whose name the invoice mentions.
  await page.goto("/app/clients");
  await page.getByLabel("Client name").fill("Initech");
  await page.getByLabel("Contact name").fill("Bill Lumbergh");
  await page.getByLabel("Contact email").fill("bill@initech.test");
  await page.getByRole("button", { name: "Add client" }).click();
  await page.waitForURL(/\/app\/clients\/[0-9a-f-]{36}$/);

  // Upload: the file is read, the client is picked, and shaky details are highlighted.
  await page.goto("/app/invoices/import");
  await page.waitForLoadState("networkidle"); // the file input must be hydrated before a file is chosen
  await page.getByLabel("Upload a PDF or a photo of an invoice").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: PDF,
  });
  await expect(page.getByLabel("Description 1")).toHaveValue("Consulting");
  await expect(page.getByLabel("Client")).toHaveValue(/[0-9a-f-]{36}/);
  await expect(page.getByTestId("import-warning")).toContainText("highlighted");
  await expect(page.getByText("Total $1,200.00")).toBeVisible();
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/\/app\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Draft invoice" })).toBeVisible();

  // It is a draft until the firm sends it; the uncertain read is also waiting in the review queue.
  await page.goto("/app/review");
  await expect(page.getByText("Invoice to check")).toBeVisible();
  await page.goBack();
  await page.getByRole("button", { name: "Send invoice" }).click();
  await expect(page.getByText("sent", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("risk-badge").first()).toBeVisible();
  await expect(page.getByTestId("risk-explanation")).not.toBeEmpty();
  const invoiceNumber = (await page.getByRole("heading", { name: /^Invoice / }).textContent())!
    .replace("Invoice ", "")
    .trim();

  // The client replies; the assistant reads it as a promise and the firm confirms.
  const reply = await page.request.post(`${APP}/api/dev/inbound`, {
    data: {
      from: "Bill Lumbergh <bill@initech.test>",
      subject: `Re: Invoice ${invoiceNumber}`,
      text: "Hi, I will pay this on Friday.\n\nOn Mon, Acme wrote:\n> Invoice is due",
    },
  });
  expect((await reply.json()).outcome).toBe("matched");

  await page.goto("/app/review");
  await expect
    .poll(async () => page.getByTestId("suggestion").count(), { message: "reply classified" })
    .toBeGreaterThan(0);
  const suggestion = page.getByTestId("suggestion").first();
  await expect(suggestion).toContainText("Looks like a promise to pay");
  await expect(suggestion).toContainText("I will pay this on Friday");
  await expect(page.getByLabel("Promised date")).not.toHaveValue("");
  await page.getByRole("button", { name: "Record the promise" }).click();
  await expect(page.getByText("Done.")).toBeVisible();

  await page.goto("/app/invoices");
  await page.getByRole("link", { name: invoiceNumber }).click();
  await expect(page.getByText("Promise to pay", { exact: true })).toBeVisible();
  await expect(page.getByText("ai_reply")).toBeVisible();
});
