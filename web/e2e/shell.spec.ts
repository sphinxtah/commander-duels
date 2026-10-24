import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { standIn } from "./accounts";

const version = readFileSync(
  new URL("../../VERSION", import.meta.url),
  "utf8",
).trim();

// The shell opens only for an active account (v0.3.0; identity.spec.ts covers the landing page
// before it). These journeys need no data of their own, so they sign in as a stand-in account
// rather than as SysOp: they run without SysOp's password, and the Larger text and Reduce motion
// they switch on stay off SysOp's real account, which the deck journeys use meanwhile.
test.beforeEach(async ({ page }) => {
  await standIn(page);
});

test("connected shell, the main menu, all navigation, format dialog and saved preferences", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("status", { name: "Connection status" }),
  ).toHaveText("Service connected");
  // The main menu first (v0.4.5): the greeting and its tiles.
  await expect(
    page.getByRole("heading", { name: "Welcome back, stand-in" }),
  ).toBeVisible();
  const menu = page.getByRole("region", { name: "Main menu" });
  for (const name of ["Play", "Tables", "Leng's Card Shop", "Decks", "Cards"])
    await expect(
      menu.getByRole("link", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  await menu.getByRole("link", { name: /^Play/ }).click();
  await expect(page).toHaveURL(/#play$/);
  await expect(
    page.getByRole("heading", { name: "Commander", exact: true }),
  ).toBeVisible();
  // The owner's art: the mark in the top bar, the banner on Play, and the favicon.
  const brand = page.locator('img[src^="/brand/"]');
  await expect(brand).toHaveCount(2);
  await expect
    .poll(() =>
      brand.evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);
  expect((await page.request.get("/brand/favicon-32.png")).ok()).toBe(true);
  await page.getByRole("button", { name: "About this format" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Commander is open to play; Two-Headed Giant is early (v0.5.0), and nothing is coming soon.
  await expect(page.getByRole("dialog")).toContainText("OPEN TO PLAY");
  await expect(page.getByRole("dialog")).not.toContainText("planned");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const giant = page.locator('[data-format="two_headed_giant"]');
  await expect(giant).toContainText("Early");
  await expect(page.getByText("Coming soon")).toHaveCount(0);
  await giant.getByRole("button", { name: "About this format" }).click();
  await expect(page.getByRole("dialog")).toContainText("EARLY");
  await expect(page.getByRole("dialog")).toContainText("a bot teammate");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  // The title band's way back to the main menu.
  await page.getByRole("link", { name: "Main menu" }).click();
  await expect(page).toHaveURL(/#home$/);
  // Decks and Cards have their own journeys, as SysOp, in decks.spec.ts. Campaign, Learn and
  // Collection are gone; their old addresses open the main menu.
  for (const name of ["Campaign", "Learn", "Collection"])
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
  await page.goto("/#campaign");
  await expect(
    page.getByRole("heading", { name: "Welcome back, stand-in" }),
  ).toBeVisible();
  await expect(page.getByText(`v${version}`).first()).toBeAttached();
  await page.getByRole("button", { name: /^Your account/ }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Larger text" }).check();
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Larger text" }),
  ).toBeChecked();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("the skip link moves to the content and stays on the page", async ({
  page,
}) => {
  await page.goto("/#settings");
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expect(page).toHaveURL(/#settings$/);
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
});

test("service outage is visible and retry recovers", async ({ page }) => {
  await page.route("**/api/v1/bootstrap", (route) => route.abort());
  await page.goto("/#play");
  await expect(
    page.getByText("The application service is unavailable."),
  ).toBeVisible();
  await page.unroute("**/api/v1/bootstrap");
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(
    page.getByRole("heading", { name: "Commander", exact: true }),
  ).toBeVisible();
});

test("layouts remain usable and keyboard navigation works", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("status", { name: "Connection status" }),
  ).toHaveText("Service connected");
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [683, 384],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // The player search at every width (v0.6.1: the top bar holds no pages, on a phone or not).
    await expect(
      page.getByRole("search", { name: "Find players" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`menu-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  const tiles = page.getByRole("region", { name: "Main menu" });
  await tiles.getByRole("link", { name: /^Decks/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await page.getByRole("button", { name: /^Your account/ }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Larger text" }).check();
  await page.getByRole("checkbox", { name: "Reduce motion" }).check();
  await page.getByRole("link", { name: "Commander Duels home" }).click();
  await tiles.getByRole("link", { name: /^Play/ }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("play-large-text.png"),
    fullPage: true,
  });
});
