import { test, expect, type Browser, type Page } from "@playwright/test";
import type { FixtureName } from "../src/game/table/fixtures";
import { occluded, sizeChecks } from "./helpers/checks";
import { openTable, respondingFixture } from "./helpers/fakeTable";

// The game screen on the fake table (design §24.2): Vite's dev server with no engine and no API.
// Each table is a fixture sent over a fake game socket. The sizes are the scope's: 1280 × 720 to
// 4K, at the display scales Windows uses, with the PixiJS scene (WebGL2 on SwiftShader in CI)
// and with the plain DOM table.

const SIZES = [
  { width: 1280, height: 720, dpr: 1 },
  { width: 1280, height: 720, dpr: 1.5 },
  { width: 1366, height: 768, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1 },
  { width: 1920, height: 1080, dpr: 2 },
  { width: 2560, height: 1440, dpr: 1 },
  { width: 3840, height: 2160, dpr: 1 },
] as const;

async function tablePage(
  browser: Browser,
  size: { width: number; height: number; dpr: number },
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dpr,
  });
  return context.newPage();
}

test.describe("the table at every size", () => {
  test.setTimeout(120_000);

  for (const size of SIZES)
    test(`fits ${size.width} × ${size.height} at ${size.dpr}×, every control in reach`, async ({
      browser,
    }, testInfo) => {
      const page = await tablePage(browser, size);
      const table = await openTable(page, { fixture: "duel" });
      await sizeChecks(page, size);
      await page.screenshot({
        path: testInfo.outputPath(
          `table-${size.width}x${size.height}@${size.dpr}.jpg`,
        ),
        quality: 80,
      });
      expect(await occluded(page)).toEqual([]);
      expect(await table.problems()).toEqual([]);
      await page.context().close();
    });

  for (const fixture of [
    "three",
    "four",
    "stress",
    "stack",
    "hand25",
  ] as FixtureName[])
    test(`draws the ${fixture} table at 1920 × 1080 with every control in reach`, async ({
      browser,
    }, testInfo) => {
      const size = { width: 1920, height: 1080, dpr: 1 };
      const page = await tablePage(browser, size);
      const table = await openTable(page, { fixture });
      await sizeChecks(page, size);
      if (fixture === "four") {
        await expect(page.getByRole("article")).toHaveCount(3);
        // The manifest's install screenshot (scripts/brand_assets.py screenshots table.png).
        await page.screenshot({ path: testInfo.outputPath("table.png") });
      }
      await page.screenshot({
        path: testInfo.outputPath(`table-${fixture}.jpg`),
        quality: 80,
      });
      expect(await occluded(page)).toEqual([]);
      expect(await table.problems()).toEqual([]);
      await page.context().close();
    });

  for (const size of [SIZES[0], SIZES[3]])
    test(`draws the plain table without WebGL at ${size.width} × ${size.height}`, async ({
      browser,
    }, testInfo) => {
      const page = await tablePage(browser, size);
      const table = await openTable(page, {
        fixture: "duel",
        settings: { painter: "dom" },
      });
      await sizeChecks(page, size, "dom");
      await expect(page.locator("canvas[data-table-canvas]")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`table-dom-${size.width}.jpg`),
        quality: 80,
      });
      expect(await occluded(page)).toEqual([]);
      expect(await table.problems()).toEqual([]);
      await page.context().close();
    });
});

test.describe("playing on the table", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("P and a card's own option answer the prompt and revision on screen", async ({
    page,
  }, testInfo) => {
    const table = await openTable(page, { fixture: "duel" });
    await sizeChecks(page, { width: 1920, height: 1080, dpr: 1 });
    await page.screenshot({
      path: testInfo.outputPath("table-prompt.jpg"),
      quality: 80,
    });
    const revision = table.fixture.snapshot.revision;
    const prompt = table.fixture.snapshot.prompt!;
    await page.keyboard.press("p");
    await expect.poll(() => table.commands.length).toBe(1);
    expect(table.commands[0]).toMatchObject({
      type: "submit_choice",
      prompt_id: prompt.id,
      expected_revision: revision,
      payload: {
        option_id: prompt.options.find((o) => o.action === "pass")!.id,
      },
    });
    // The same prompt again, at a new revision: a land in hand plays from the table.
    const land = prompt.options.find((o) => o.action === "play_land")!;
    table.send({ ...table.fixture.snapshot, revision: revision + 1 });
    await expect(
      page.locator(`section[data-revision="${revision + 1}"]`),
    ).toHaveCount(1);
    await page.locator(`[data-card="${land.object_id}"]`).first().click();
    await expect.poll(() => table.commands.length).toBe(2);
    expect(table.commands[1]).toMatchObject({
      prompt_id: prompt.id,
      expected_revision: revision + 1,
      payload: { option_id: land.id },
    });
    expect(await table.problems()).toEqual([]);
  });

  test("the response timer passes once at the end, and Space stops it for good", async ({
    page,
  }, testInfo) => {
    const fixture = respondingFixture();
    const table = await openTable(page, {
      fixture,
      settings: { responseTimerSeconds: 5 },
    });
    const timer = page.locator("[data-timer]");
    await expect(timer).toHaveAttribute("data-timer", "running", {
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: "Stop Timer" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("table-timer.jpg"),
      quality: 80,
    });
    await expect.poll(() => table.commands.length, { timeout: 9_000 }).toBe(1);
    expect(table.commands[0]).toMatchObject({
      prompt_id: "p-respond",
      expected_revision: fixture.snapshot.revision,
      payload: { option_id: "1" },
    });

    // A new spell on top is a new moment: the timer starts again, and Space stops it.
    const next = structuredClone(fixture.snapshot);
    next.revision += 1;
    next.prompt!.id = "p-respond-2";
    next.view!.stack[0].id = "fake-bolt-2";
    table.send(next);
    await expect(timer).toHaveAttribute("data-timer", "running", {
      timeout: 10_000,
    });
    await page.locator("[data-first]").focus();
    await page.keyboard.press("Space");
    await expect(timer).toHaveAttribute("data-timer", "stopped");
    await page.waitForTimeout(6_000);
    expect(table.commands).toHaveLength(1);
    expect(await table.problems()).toEqual([]);
  });

  test("drawers and the Game menu close with Escape, one per press", async ({
    page,
  }) => {
    const table = await openTable(page, { fixture: "duel" });
    await sizeChecks(page, { width: 1920, height: 1080, dpr: 1 });
    const log = page.getByRole("button", { name: "Game log" });
    await log.click();
    await expect(page.locator('[data-drawer="log"]')).toHaveAttribute(
      "data-open",
      "true",
    );
    await page.getByRole("button", { name: "Game menu" }).click();
    await expect(page.getByRole("group", { name: "Game menu" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("group", { name: "Game menu" })).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-drawer="log"]')).not.toHaveAttribute(
      "data-open",
    );
    await expect(log).toBeFocused();
    expect(table.commands).toEqual([]);
    expect(await table.problems()).toEqual([]);
  });

  test("the magnifier shows a hovered card and never takes a click", async ({
    page,
  }) => {
    const table = await openTable(page, { fixture: "duel" });
    await sizeChecks(page, { width: 1920, height: 1080, dpr: 1 });
    const prompt = table.fixture.snapshot.prompt!;
    const mana = prompt.options.find((o) => o.action === "activate_mana")!;
    const permanent = page.locator(`[data-card="${mana.object_id}"]`).first();
    await permanent.hover();
    await expect(page.locator("[data-magnifier]").first()).toBeVisible();
    expect(await occluded(page)).toEqual([]);
    await permanent.click();
    await expect.poll(() => table.commands.length).toBe(1);
    expect(table.commands[0]).toMatchObject({
      payload: { option_id: mana.id },
    });
  });

  test("a lost WebGL context draws the plain table until it comes back", async ({
    page,
  }) => {
    const table = await openTable(page, { fixture: "duel" });
    await sizeChecks(page, { width: 1920, height: 1080, dpr: 1 });
    const lost = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        "canvas[data-table-canvas]",
      );
      const gl = (canvas?.getContext("webgl2") ??
        canvas?.getContext("webgl")) as WebGLRenderingContext | null;
      const extension = gl?.getExtension("WEBGL_lose_context");
      if (!extension) return false;
      (window as unknown as { __lose: WEBGL_lose_context }).__lose = extension;
      extension.loseContext();
      return true;
    });
    test.skip(!lost, "This browser cannot lose a WebGL context on purpose.");
    const root = page.locator("[data-screen]");
    await expect(root).toHaveAttribute("data-renderer", "dom");
    await page.keyboard.press("p");
    await expect.poll(() => table.commands.length).toBe(1);
    await page.evaluate(() =>
      (
        window as unknown as { __lose: WEBGL_lose_context }
      ).__lose.restoreContext(),
    );
    await expect(root).toHaveAttribute("data-renderer", "webgl", {
      timeout: 15_000,
    });
  });
});
