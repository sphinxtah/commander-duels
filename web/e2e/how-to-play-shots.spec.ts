import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// How to play's screenshots of the table (v0.8.6), taken from the game as it is: the tutorial's
// guided game, on the real table, at the lessons the guide needs, and a practice game's mulligan
// for the prompt (when the engine is running). Each is saved at 1280 x 800 under
// test-results/how-to-play with marks.json, where each place the guide points at lies (the centre
// of its elements, in percent); scripts/how_to_play_shots.py makes web/public/how-to-play's
// pictures and web/src/howToPlay/shots.json from them. Only on demand (CD_E2E_HOW_TO_PLAY_SHOTS=1,
// with SysOp's password).
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const wanted = process.env.CD_E2E_HOW_TO_PLAY_SHOTS === "1";
const OUT = "test-results/how-to-play";
const marks: Record<string, Record<string, { x: number; y: number }>> = {};

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

/** The chat bar and the guided game's narration stay out of the pictures. */
async function clearView(page: Page) {
  await page.addStyleTag({
    content:
      '[data-chat-bar], [data-tutorial="narration"] { visibility: hidden !important; }',
  });
}

/** The guided game, at the lesson with this title. */
async function lesson(page: Page, title: string, settle = 9_000) {
  await page.goto("/#tutorial/demo");
  const narration = page.locator('[data-tutorial="narration"]');
  await expect(narration).toBeVisible();
  for (let n = 0; n < 40; n += 1) {
    if ((await narration.getByRole("heading").textContent()) === title) break;
    await narration.getByRole("button", { name: /Next/ }).click();
    await page.waitForTimeout(150);
  }
  await expect(narration.getByRole("heading")).toHaveText(title);
  // Its frames play through, and the cards' pictures arrive from the API.
  await page.waitForTimeout(settle);
}

/** The centre of everything a locator finds, in percent of the window. */
async function centre(page: Page, locator: Locator) {
  const viewport = page.viewportSize()!;
  const boxes = (
    await Promise.all((await locator.all()).map((item) => item.boundingBox()))
  ).filter((box): box is NonNullable<typeof box> => !!box && box.width > 0);
  expect(boxes.length, String(locator)).toBeGreaterThan(0);
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return {
    x: Math.round((((left + right) / 2) * 1000) / viewport.width) / 10,
    y: Math.round((((top + bottom) / 2) * 1000) / viewport.height) / 10,
  };
}

async function shoot(
  page: Page,
  name: string,
  places: Record<string, Locator>,
  settle = 800,
) {
  await clearView(page);
  await page.waitForTimeout(settle);
  marks[name] = {};
  for (const [mark, locator] of Object.entries(places))
    marks[name][mark] = await centre(page, locator);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

function places(page: Page) {
  const mine = page.locator('section[aria-label$="side of the table"]');
  const theirs = page
    .locator('section[aria-label="Opponents"] article')
    .first();
  return {
    hand: page.locator('[aria-label$="hand"] [data-node^="hand:"]'),
    battlefield: page.locator(
      '[aria-label^="Mira\'s battlefield: creatures"] [data-node]',
    ),
    life: mine.locator('span[aria-label$=" life"]'),
    opponent: theirs.locator('span[aria-label$=" life"]'),
    library: mine.locator('span[aria-label$="cards in library"]'),
    graveyard: mine.locator('[data-zone="graveyard"]'),
    command: mine.locator('[data-zone="command"]'),
    theirCommand: theirs.locator('[data-zone="command"]'),
    band: page.getByText(/^Turn \d+ · /i).first(),
  };
}

test.describe("How to play's screenshots", () => {
  test.skip(
    !wanted || !sysopPassword,
    "On demand: CD_E2E_HOW_TO_PLAY_SHOTS=1 and CD_E2E_SYSOP_PASSWORD.",
  );
  test.use({ viewport: { width: 1280, height: 800 } });
  test.setTimeout(240_000);
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
  });
  test.afterAll(() => {
    // A run of some of the shots keeps the others' marks.
    const file = `${OUT}/marks.json`;
    const kept = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...kept, ...marks }, null, 2));
  });
  test.beforeEach(async ({ page }) => {
    await signInSysop(page);
  });

  test("the table", async ({ page }) => {
    await lesson(page, "Commander damage");
    const at = places(page);
    await shoot(page, "table", {
      hand: at.hand,
      battlefield: at.battlefield,
      opponent: at.opponent,
      life: at.life,
      library: at.library,
      graveyard: at.graveyard,
      command: at.command,
      band: at.band,
    });
  });

  test("the commanders", async ({ page }) => {
    await lesson(page, "The commander");
    const at = places(page);
    await shoot(page, "commander", {
      command: at.command,
      opponent: at.theirCommand,
    });
  });

  test("attacking", async ({ page }) => {
    await lesson(page, "Attacking");
    await shoot(page, "attacking", {
      attackers: page.locator(
        '[data-node^="battlefield:"][aria-label*="Attacking"]',
      ),
      defender: places(page).life,
    });
  });

  test("blocking", async ({ page }) => {
    // The attack first, so every picture is loaded; then the blocker, caught as it steps in,
    // before the lesson's frames go on to the damage.
    await lesson(page, "Attacking");
    const narration = page.locator('[data-tutorial="narration"]');
    await narration.getByRole("button", { name: /Next/ }).click();
    const blockers = page.locator(
      '[data-node^="battlefield:"][aria-label*="Blocking"]',
    );
    const attackers = page.locator(
      '[data-node^="battlefield:"][aria-label*="Attacking"]',
    );
    await expect(blockers.first()).toBeVisible();
    await expect(attackers.first()).toBeVisible();
    await page.waitForTimeout(250);
    await shoot(page, "blocking", { blockers, attackers }, 0);
  });

  test("the stack", async ({ page }) => {
    await lesson(page, "Responding");
    await shoot(page, "stack", {
      stack: page.locator('[data-node^="stack:"]'),
      prompt: page
        .locator('aside[aria-label="Prompt and game log"] > *')
        .first(),
    });
  });

  test("a prompt", async ({ page }) => {
    // A practice game's opening hand: the choice of keeping it, as the prompt column asks it.
    const engine = await page.evaluate(async () => {
      const response = await fetch("/api/v1/engine/status");
      return response.ok
        ? ((await response.json()) as { gameplay_available?: boolean })
        : null;
    });
    test.skip(!engine?.gameplay_available, "Needs the engine's games.");
    await page.goto("/#practice");
    await page
      .getByRole("button", { name: /Start (the )?game/i })
      .first()
      .click();
    await expect(page).toHaveURL(/#game\//, { timeout: 60_000 });
    const keep = page.getByRole("button", { name: /Keep Hand/i }).first();
    await expect(keep).toBeVisible({ timeout: 120_000 });
    await page.waitForTimeout(6_000);
    await shoot(page, "prompt", {
      prompt: keep,
      hand: places(page).hand,
    });
    // The practice game ends here: closed through the API, as its owner may.
    const id = /#game\/([0-9a-f-]{36})/.exec(page.url())![1];
    await page.evaluate(async (gameId) => {
      const me = (await (await fetch("/api/v1/me")).json()) as { csrf_token: string };
      await fetch(`/api/v1/games/${gameId}/close`, {
        method: "POST",
        headers: { "X-CSRF-Token": me.csrf_token },
      });
    }, id);
  });
});
