import { test, expect, type Page } from "@playwright/test";

// The quest boards (v0.9.5), achievements and the record (v0.5.0) as SysOp, which has quests as
// every account does: the main menu's five daily quests and the week's line, the Quests page with
// both boards, then Profile's record, achievements and games, and SysOp's own player page with its
// badges, record and games. No game is played, so the journey needs no engine; quests.md
// describes what a game's end adds.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

test.describe("quests, achievements and the record", () => {
  test.skip(!sysopPassword, "Needs SysOp: set CD_E2E_SYSOP_PASSWORD.");

  test("the quest boards, and the record on Profile", async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signInSysop(page);
    await page.goto("/#home");
    const quests = page.getByRole("region", { name: "Today's quests" });
    await expect(quests.getByRole("listitem")).toHaveCount(5);
    await expect(quests).toContainText(/New quests in \d+ (h|min)|in a minute/);
    await expect(quests).toContainText(/of 5 done/);
    for (const item of await quests.getByRole("listitem").all())
      await expect(item).toContainText(/\d+ tokens/);
    // The same five, whatever the page asks again; no swap.
    const names = await quests.getByRole("listitem").allTextContents();
    await expect(quests.getByRole("button")).toHaveCount(0);
    await page.reload();
    await expect(quests.getByRole("listitem")).toHaveCount(5);
    expect(await quests.getByRole("listitem").allTextContents()).toEqual(names);
    await page.screenshot({ path: testInfo.outputPath("quests.png") });
    await page.getByRole("link", { name: /This week's goals/ }).click();
    await expect(page).toHaveURL(/#quests$/);
    const week = page.getByRole("region", { name: "This week's goals" });
    await expect(week.getByRole("listitem")).toHaveCount(20);
    await expect(week).toContainText(/Finish all 20 for|Board complete/);
    await page.screenshot({
      path: testInfo.outputPath("quests-page.png"),
      fullPage: true,
    });

    // Profile opens on its Achievements tab (v0.6.1); the record and the games are on Record.
    await page.goto("/#profile");
    const achievements = page.getByRole("region", { name: "Achievements" });
    await expect(achievements).toContainText(/\d+ of 35 earned\./);
    await expect(
      achievements.getByRole("list", { name: "Commander" }),
    ).toContainText("Commander and Legacy addition");
    await page.getByRole("tab", { name: "Record" }).click();
    await expect(
      page.getByRole("region", { name: "Your record" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Your games" }),
    ).toBeVisible();

    // SysOp's own page shows its badges, its record and, to its own player, its games.
    const me = await page.evaluate(async () => {
      const response = await fetch("/api/v1/me");
      return ((await response.json()) as { id: string }).id;
    });
    await page.goto(`/#player/${me}`);
    await expect(page.getByRole("region", { name: "Badges" })).toContainText(
      /of 35 achievements earned/,
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
