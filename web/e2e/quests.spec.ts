import { test, expect, type Page } from "@playwright/test";

// Daily quests, achievements and the record (v0.5.0) as SysOp, which has quests as every account
// does: the main menu's three quests and the day's swap, then Profile's record, achievements and
// games, and SysOp's own player page with its badges, record and games. No game is played, so
// the journey needs no engine; quests.md describes what a game's end adds. The day's swap is used
// once a day, so a second run the same day finds it used.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

test.describe("quests, achievements and the record", () => {
  test.skip(!sysopPassword, "Needs SysOp: set CD_E2E_SYSOP_PASSWORD.");

  test("the day's quests, a swap, and the record on Profile", async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signInSysop(page);
    await page.goto("/#home");
    const quests = page.getByRole("region", { name: "Today's quests" });
    await expect(quests.getByRole("listitem")).toHaveCount(3);
    await expect(quests).toContainText(/New quests in \d+ (h|min)|in a minute/);
    for (const item of await quests.getByRole("listitem").all())
      await expect(item).toContainText(/\d+ tokens/);
    const swaps = quests.getByRole("button", { name: /^Swap “/ });
    if ((await swaps.count()) > 0) {
      await swaps.first().click();
      await expect(quests.getByRole("status")).toContainText(
        "Swapped: your new quest is",
      );
      await expect(swaps).toHaveCount(0);
      await expect(quests).toContainText("swapped in today");
    }
    await expect(quests).toContainText("Today's swap is used.");
    // The same three, whatever the page asks again.
    const names = await quests.getByRole("listitem").allTextContents();
    await page.reload();
    await expect(quests.getByRole("listitem")).toHaveCount(3);
    expect(await quests.getByRole("listitem").allTextContents()).toEqual(names);
    await page.screenshot({ path: testInfo.outputPath("quests.png") });

    await page.goto("/#profile");
    await expect(
      page.getByRole("region", { name: "Your record" }),
    ).toBeVisible();
    const achievements = page.getByRole("region", { name: "Achievements" });
    await expect(achievements).toContainText(/\d+ of 29 earned\./);
    await expect(
      achievements.getByRole("list", { name: "Commander" }),
    ).toContainText("Commander and Legacy addition");
    await expect(page.getByRole("region", { name: "Your games" })).toBeVisible();

    // SysOp's own page shows its badges, its record and, to its own player, its games.
    const me = await page.evaluate(async () => {
      const response = await fetch("/api/v1/me");
      return ((await response.json()) as { id: string }).id;
    });
    await page.goto(`/#player/${me}`);
    await expect(page.getByRole("region", { name: "Badges" })).toContainText(
      /of 29 achievements earned/,
    );
    await expect(page.getByRole("region", { name: "Record" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Games" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
});
