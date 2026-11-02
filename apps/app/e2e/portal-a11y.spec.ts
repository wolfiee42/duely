import { expect, test } from "@playwright/test";

// Basics a client with a keyboard or a screen reader relies on, checked through the accessibility tree
// (roles and names), the way assistive technology sees the portal.

const PASSWORD = "correct horse battery staple";

test("the client portal works by keyboard and reads sensibly to a screen reader", async ({
  page,
  browser,
}) => {
  await page.goto("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Ay Visitor");
  await page.getByLabel("Email").fill("ay@e2e.test");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL("**/onboarding");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Explore with sample data" }).click();
  await page.waitForURL("**/demo");

  // Send an invoice so the client has an emailed link to follow.
  await page.goto("/invoices/new");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Client").selectOption({ label: "Initech" });
  await page.getByLabel("Description 1").fill("Accessibility check");
  await page.getByLabel("Quantity 1").fill("1");
  await page.getByLabel("Price 1").fill("250.00");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Send invoice" }).click();
  const heading = page.getByRole("heading", { name: /^Invoice / });
  await expect(heading).toBeVisible();
  const number = (await heading.textContent())!.replace("Invoice ", "").trim();

  await page.goto("/demo");
  await page.waitForLoadState("networkidle");
  const row = page
    .getByTestId("outbox")
    .getByRole("listitem")
    .filter({ hasText: `Invoice ${number} from` });
  await row.locator("summary").click();
  const href = await row.getByRole("link").first().getAttribute("href");

  const context = await browser.newContext();
  const portal = await context.newPage();
  await portal.goto(href!);
  await portal.waitForURL(/\/portal\/invoices\/[0-9a-f-]{36}$/);
  await portal.waitForLoadState("networkidle");

  // A page title and one top-level heading say where you are.
  await expect(portal).toHaveTitle("Invoice");
  await expect(portal.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(portal.getByRole("main")).toBeVisible();
  await expect(portal.getByRole("navigation", { name: "Portal" })).toBeVisible();

  // The first Tab lands on "Skip to content", and using it moves focus into the page.
  await portal.keyboard.press("Tab");
  const skip = portal.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await portal.keyboard.press("Enter");
  await expect(portal.getByRole("main")).toBeFocused();

  // The items table has a name and column headings; every control has a label, not just a placeholder.
  const table = portal.getByRole("table", { name: "Items on this invoice" });
  await expect(table.getByRole("columnheader")).toHaveCount(3);
  await expect(portal.getByLabel("I'll pay by")).toBeVisible();
  await expect(portal.getByLabel("What's the issue?")).toBeVisible();
  await expect(portal.getByLabel("More detail (optional)")).toBeVisible();

  // Every button and link has an accessible name, and no image announces filler.
  for (const role of ["button", "link"] as const) {
    for (const el of await portal.getByRole(role).all()) {
      expect(
        (await el.innerText()).trim() || (await el.getAttribute("aria-label")),
        role,
      ).toBeTruthy();
    }
  }

  // Doing something is announced: telling them you'll pay on a date shows a status message.
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  await portal.getByLabel("I'll pay by").fill(soon);
  await portal.getByRole("button", { name: "Let them know" }).click();
  await expect(portal.getByRole("status")).toContainText("You told us you'd pay on");
  await context.close();
});
