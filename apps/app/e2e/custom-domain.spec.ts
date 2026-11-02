import { expect, test } from "@playwright/test";

// A firm points its own domain at the portal: add, see the DNS record, go live, remove.
// Cloudflare is replaced by the in-memory fake; `/api/dev/activate-domain` stands in for DNS and the certificate.

const APP = "http://app.localhost:3100";

test("an owner adds a custom domain, waits for it to go live, and removes it", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Dom Owner");
  await page.getByLabel("Email").fill("dom@e2e.test");
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
  await page.getByLabel("Confirm Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL("**/onboarding");
  await page.getByLabel("Legal name").fill("E2E Domains LLC");
  await page.getByLabel("Display name").fill("E2E Domains");
  await page.getByLabel("Client portal address").fill("e2e-domains");
  await page.getByRole("button", { name: "Create firm" }).click();
  await page.waitForURL("**/app");

  await page.goto("/app/settings");
  await page.getByLabel("Show invoices on your own address").fill("not a domain");
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page.getByText("Enter a domain like billing.yourfirm.com.")).toBeVisible();

  await page.getByLabel("Show invoices on your own address").fill("Billing.E2EFirm.com");
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page.getByTestId("domain-hostname")).toHaveText("billing.e2efirm.com");
  await expect(page.getByText("Waiting for DNS")).toBeVisible();
  await expect(page.getByText("customers.localhost")).toBeVisible();
  await expect(page.getByTestId("domain-hint")).toBeVisible();

  expect(
    (
      await page.request.post(`${APP}/api/dev/activate-domain`, {
        data: { hostname: "billing.e2efirm.com" },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByText("Your Duely address keeps working too.")).toBeVisible();

  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Remove" }).click(); // confirm
  await expect(page.getByLabel("Show invoices on your own address")).toBeVisible();
});
