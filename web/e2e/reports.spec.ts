import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

// "Report a problem" (v0.4.1) as SysOp: a report with a screenshot sent from the top bar, then
// read in Administration's Reports tab, where its screenshot shows and its status is set, in a
// computer's window and on a phone's. The screenshot is the table journeys' card image, a JPEG.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const CARD = fileURLToPath(new URL("./helpers/card.jpg", import.meta.url));

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

/** Nothing wider than the window, as on every page; then back to the computer's window. */
async function onPhone(page: Page, path: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path, fullPage: true });
  await page.setViewportSize({ width: 1366, height: 900 });
}

test.describe("Report a problem", () => {
  test.skip(!sysopPassword, "Needs SysOp: set CD_E2E_SYSOP_PASSWORD.");

  test("a report with a screenshot, read and handled in Administration", async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signInSysop(page);
    await page.goto("/#settings");
    const summary = `The journey's report ${Date.now()}`;

    await page.getByRole("button", { name: "Report a problem" }).click();
    // Named by its heading, which becomes the thanks once the report is sent.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Report a problem");
    await expect(dialog).toContainText(
      "We'll also send: this page, the version, your browser and screen size, and the IDs of your last requests",
    );
    await dialog.getByLabel("Summary").fill(summary);
    await dialog
      .getByLabel("What happened? What did you expect?")
      .fill("Sent by the browser journey.\nNothing is wrong.");
    await dialog.getByLabel("Choose an image…").setInputFiles(CARD);
    const preview = dialog.getByRole("img", { name: "The screenshot to send" });
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        preview.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(dialog.getByRole("status")).toContainText(
      "Screenshot attached",
    );
    await page.screenshot({ path: testInfo.outputPath("report-dialog.png") });
    await onPhone(page, testInfo.outputPath("report-dialog-390.png"));
    await dialog.getByRole("button", { name: "Send report" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Thank you. Your report was sent." }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    // Counted on Admin and in the tab's title once the page asks again.
    await page.goto("/#admin");
    await page.reload();
    await expect(
      page
        .getByRole("navigation")
        .getByRole("link", { name: /^Admin, .*unread reports?$/ }),
    ).toBeVisible();
    await expect(page).toHaveTitle(/^\(\d+\) Commander Duels$/);
    await page.getByRole("tab", { name: /^Reports/ }).click();
    const item = page.getByRole("listitem", { name: summary });
    await expect(item).toContainText("NEW");
    await item.getByRole("button", { name: `Open “${summary}”` }).click();
    // Opened, it is seen.
    await expect(item).toContainText("SEEN");
    await expect(item).toContainText("Sent by the browser journey.");
    await expect(item).toContainText("GET /api/v1/me");
    const shot = item.getByRole("img", {
      name: `Screenshot sent with “${summary}”`,
    });
    await expect(shot).toBeVisible();
    await expect
      .poll(() =>
        shot.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.screenshot({
      path: testInfo.outputPath("admin-reports.png"),
      fullPage: true,
    });
    await onPhone(page, testInfo.outputPath("admin-reports-390.png"));
    await item.getByRole("combobox", { name: "Status" }).selectOption("fixed");
    await expect(item).toContainText("FIXED");
    expect(errors).toEqual([]);
  });
});
