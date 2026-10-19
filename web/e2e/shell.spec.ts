import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const version = readFileSync(
  new URL("../../VERSION", import.meta.url),
  "utf8",
).trim();

test("connected shell, all navigation, format dialog and saved preferences", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("status", { name: "Connection status" }),
  ).toHaveText("Service connected");
  await expect(
    page.getByRole("heading", { name: "Commander", exact: true }),
  ).toBeVisible();
  // The owner's art: the monogram in the sidebar, the banner on Play, and the favicon.
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
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  for (const name of ["Campaign", "Learn", "Decks", "Cards", "Collection"]) {
    await page
      .getByRole("navigation")
      .getByRole("link", { name, exact: true })
      .click();
    await expect(page.getByText(`NOT AVAILABLE IN v${version}`)).toBeVisible();
  }
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

test("service outage is visible and retry recovers", async ({ page }) => {
  await page.route("**/api/v1/bootstrap", (route) => route.abort());
  await page.goto("/");
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
    await page.screenshot({
      path: testInfo.outputPath(`play-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Decks", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Larger text" }).check();
  await page.getByRole("checkbox", { name: "Reduce motion" }).check();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Play", exact: true })
    .click();
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
