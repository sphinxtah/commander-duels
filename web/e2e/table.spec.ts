import {
  test,
  expect,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "../src/game/table/fixtures";
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
    "giant",
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

// The Planeswalker portraits (v0.3.1), the real files from web/public/portraits. The three-player
// table with both opponents human: Alice allied with Rowan (in colour, hers), Bob with Ugin
// (grey, an opponent's) and Carol with "ezra", an ID shaped like the roster's with no picture, who
// keeps the sigil.
test.describe("Planeswalker portraits", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  const PORTRAITS = { 0: "rowan", 1: "ugin", 2: "ezra" };

  function allied(): TableFixture {
    const f = tableFixture("three");
    f.summarySeats[1] = { seat: 1, player: "human", handle: "bob", deck: null };
    f.summarySeats[2] = {
      seat: 2,
      player: "human",
      handle: "carol",
      deck: null,
    };
    return f;
  }

  /** The mean colour of the screen's (2r+1)-pixel square around (x, y), and its luminance and
   * chroma: read from a screenshot, so it is what the canvas showed. */
  async function colourAt(page: Page, x: number, y: number, r = 1) {
    const png = await page.screenshot({
      clip: { x: x - r, y: y - r, width: 2 * r + 1, height: 2 * r + 1 },
    });
    const [red, green, blue] = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4)
        for (let c = 0; c < 3; c++) sum[c] += data[i + c];
      const n = data.length / 4;
      return sum.map((s) => s / n);
    }, png.toString("base64"));
    return {
      red,
      green,
      blue,
      luminance: 0.2126 * red + 0.7152 * green + 0.0722 * blue,
      chroma: Math.max(red, green, blue) - Math.min(red, green, blue),
    };
  }

  test("stand in the players' diamonds on the canvas: yours in colour, an opponent's grey, a missing one the sigil", async ({
    page,
  }, testInfo) => {
    const rowan = page.waitForResponse("**/portraits/rowan-256.webp");
    const ugin = page.waitForResponse("**/portraits/ugin-256.webp");
    const table = await openTable(page, {
      fixture: allied(),
      portraits: PORTRAITS,
    });
    await sizeChecks(page, { width: 1920, height: 1080, dpr: 1 });
    for (const response of [await rowan, await ugin]) {
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toBe("image/webp");
    }
    // Each is named for screen readers apart from the player and their life.
    for (const name of ["Rowan", "Ugin", "Ezra"])
      await expect(
        page.getByRole("img", { name: `${name} portrait` }),
      ).toHaveCount(1);
    await expect(page.getByRole("img", { name: /portrait/ })).toHaveCount(3);

    // Points where a portrait rises past its frame, which a sigil never does: Rowan's red cloak
    // at your right shoulder (your diamond ◇(118,912) 124), Ugin's glowing horn above Bob's
    // (◇(880,86) 100), and the same place above Carol's (◇(1840,86) 100), which shows the stone.
    await expect
      .poll(async () => {
        const cloak = await colourAt(page, 189, 946);
        return cloak.red > 120 && cloak.red > 2.5 * cloak.green;
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const horn = await colourAt(page, 917, 34);
        return horn.luminance > 120 && horn.chroma < 16;
      })
      .toBe(true);
    const stone = await colourAt(page, 1877, 34);
    expect(stone.luminance).toBeLessThan(115);
    // Ezra has no picture: Carol's diamond shows her sigil, bright at its core.
    await expect
      .poll(async () => (await colourAt(page, 1840, 86)).luminance)
      .toBeGreaterThan(100);
    await page.screenshot({
      path: testInfo.outputPath("table-portraits.jpg"),
      quality: 80,
    });
    expect(await occluded(page)).toEqual([]);
    expect(await table.problems()).toEqual([]);
  });

  test("stand in the plain table too, grey for an opponent, and a missing one keeps the sigil", async ({
    page,
  }, testInfo) => {
    const table = await openTable(page, {
      fixture: allied(),
      portraits: PORTRAITS,
      settings: { painter: "dom" },
    });
    await sizeChecks(page, { width: 1920, height: 1080, dpr: 1 }, "dom");
    const loaded = (name: string) =>
      page
        .getByRole("img", { name: `${name} portrait` })
        .locator("img")
        .evaluate((image: HTMLImageElement) =>
          image.complete ? image.naturalWidth : 0,
        );
    await expect.poll(() => loaded("Rowan")).toBe(256);
    await expect.poll(() => loaded("Ugin")).toBe(256);
    const rowan = page
      .getByRole("img", { name: "Rowan portrait" })
      .locator("img");
    await expect(rowan).toHaveAttribute("src", "/portraits/rowan-256.webp");
    await expect(rowan).not.toHaveAttribute("data-grey");
    const ugin = page
      .getByRole("img", { name: "Ugin portrait" })
      .locator("img");
    await expect(ugin).toHaveAttribute("data-grey", "true");
    expect(await ugin.evaluate((image) => getComputedStyle(image).filter)).toBe(
      "grayscale(1)",
    );
    // Upright in front of the frame and fitted whole: nothing clips it to the diamond.
    expect(
      await rowan.evaluate((image) => [
        getComputedStyle(image).objectFit,
        getComputedStyle(image.parentElement!).clipPath,
      ]),
    ).toEqual(["contain", "none"]);
    const ezra = page.getByRole("img", { name: "Ezra portrait" });
    await expect(ezra.locator("img")).toHaveCount(0);
    await expect(ezra.locator('svg[data-sigil="grey"]')).toHaveCount(1);
    await page.screenshot({
      path: testInfo.outputPath("table-portraits-dom.jpg"),
      quality: 80,
    });
    expect(await occluded(page)).toEqual([]);
    expect(await table.problems()).toEqual([]);
  });
});

test.describe("a human table's chat (v0.4.4)", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  /** Whether the element at a control's centre is that control. */
  const reachable = (control: Locator) =>
    control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return hit === element || element.contains(hit);
    });

  test("folds behind the band's diamond, counts what arrives, sends, and offers alliances on the plates", async ({
    page,
  }, testInfo) => {
    const table = await openTable(page, {
      fixture: "three",
      humans: { 1: "bob", 2: "cara" },
    });
    await sizeChecks(page, { width: 1920, height: 1080, dpr: 1 });
    const toggle = page.getByRole("button", { name: /^Table chat/ });
    await expect(toggle).toHaveAccessibleName("Table chat");
    expect(await reachable(toggle)).toBe(true);

    // Each other player's Alliance button sits on their plate, clear of everything drawn there.
    for (const name of ["bob", "cara"]) {
      const button = page.getByRole("button", {
        name: `Alliance with ${name}`,
      });
      await expect(button).toBeVisible();
      expect(await reachable(button)).toBe(true);
    }
    await page.getByRole("button", { name: "Alliance with bob" }).click();
    await page.getByRole("menuitem", { name: "Offer an alliance" }).click();
    await expect.poll(() => table.chat.length).toBe(1);
    expect(table.chat[0]).toEqual({
      type: "alliance",
      action: "offer",
      seat: 1,
    });
    await expect(page.getByText("Offer sent")).toBeVisible();

    table.say(2, "Good luck, both of you");
    await expect(toggle).toHaveAccessibleName("Table chat, 1 unread");
    await expect(page.locator("[data-announcer]")).toHaveText(
      "cara: Good luck, both of you",
    );
    await page.screenshot({
      path: testInfo.outputPath("table-chat-folded.jpg"),
      quality: 80,
    });

    await toggle.click();
    await expect(page.locator('[data-drawer="chat"]')).toHaveAttribute(
      "data-open",
      "true",
    );
    await expect(toggle).toHaveAccessibleName("Table chat");
    const box = page.getByRole("textbox", { name: "Message to the table" });
    await expect(box).toBeFocused();
    // P and F typed in the box are letters, not a pass or full screen.
    await box.pressSequentially("Pass the salt, Frank");
    await box.press("Enter");
    await expect.poll(() => table.chat.length).toBe(2);
    expect(table.chat[1]).toMatchObject({
      type: "chat",
      channel: "table",
      text: "Pass the salt, Frank",
    });
    const list = page.getByRole("list", { name: "Messages to the table" });
    await expect(list).toContainText("You: Pass the salt, Frank");
    await expect(list.locator('[data-status="pending"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Good game!" }).click();
    await expect(list).toContainText("You: Good game!");
    await expect(page.getByRole("region", { name: "Alliances" })).toContainText(
      "You offered bob an alliance.",
    );
    await page.screenshot({
      path: testInfo.outputPath("table-chat-open.jpg"),
      quality: 80,
    });

    // Escape folds it again, back to its diamond.
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-drawer="chat"]')).not.toHaveAttribute(
      "data-open",
    );
    await expect(toggle).toBeFocused();
    expect(table.commands).toEqual([]);
    expect(await occluded(page)).toEqual([]);
    expect(await table.problems()).toEqual([]);
  });
});

// Two-Headed Giant at the table (v0.5.1): four humans in two teams, Alice's view. Her teammate
// bram's hand lies face up under his board (810.5); cara's and dave's are counts only.
test.describe("Two-Headed Giant at the table (v0.5.1)", () => {
  const HUMANS = { 1: "bram", 2: "cara", 3: "dave" };

  /** A copy of a snapshot one revision on, changed by `change`. */
  function after(
    snapshot: TableFixture["snapshot"],
    change: (view: NonNullable<TableFixture["snapshot"]["view"]>) => void,
  ): TableFixture["snapshot"] {
    const next = structuredClone(snapshot);
    next.revision += 1;
    change(next.view!);
    return next;
  }

  for (const [painter, size] of [
    ["webgl", { width: 1280, height: 720, dpr: 1 }],
    ["dom", { width: 1920, height: 1080, dpr: 1 }],
  ] as const)
    test(`shows the teammate's hand face up by their board, never to be played (${painter}, ${size.width} × ${size.height})`, async ({
      browser,
    }, testInfo) => {
      const page = await tablePage(browser, size);
      const table = await openTable(page, {
        fixture: "giant",
        humans: HUMANS,
        settings: { painter: painter === "dom" ? "dom" : "auto" },
      });
      await sizeChecks(page, size, painter);

      // The teams: bram is Alice's teammate, at the left; cara and dave the other team.
      const mate = page.getByRole("article", {
        name: "bram, seat 2, your teammate",
      });
      await expect(mate.getByText("Teammate", { exact: true })).toBeVisible();
      for (const name of ["cara, seat 3", "dave, seat 4"]) {
        const other = page.getByRole("article", {
          name: `${name}, the other team`,
        });
        await expect(other.getByText("Other team")).toBeVisible();
        await expect(other.getByText("7 team poison")).toBeVisible();
        await expect(other.getByRole("group", { name: /hand/ })).toHaveCount(0);
      }
      await expect(
        page.getByRole("img", { name: "24 team life" }).first(),
      ).toBeAttached();

      // bram's six cards, each a named button, painted face up, none offered.
      const hand = mate.getByRole("group", { name: "bram's hand" });
      const cards = hand.getByRole("button");
      await expect(cards).toHaveCount(6);
      await expect(cards.first()).toHaveAccessibleName(
        "Lightning Bolt, Instant",
      );
      await expect(page.locator('[data-role="teammate-hand"]')).toHaveCount(6);
      await expect(
        page.locator('[data-role="teammate-hand"][data-actionable]'),
      ).toHaveCount(0);
      if (painter === "dom")
        for (const card of await cards.all())
          await expect(card.locator("img")).toHaveCount(1);
      expect(await occluded(page)).toEqual([]);

      // Hovering one magnifies it, saying whose hand it is in.
      const guide = cards.nth(2);
      await expect(guide).toHaveAccessibleName(/^Goblin Guide/);
      await guide.hover();
      const magnifier = page.locator("[data-magnifier]").first();
      await expect(magnifier).toBeVisible();
      await expect(magnifier).toContainText("Goblin Guide");
      await expect(magnifier).toContainText("In bram’s hand");
      await page.screenshot({
        path: testInfo.outputPath(`table-giant-${painter}-${size.width}.jpg`),
        quality: 80,
      });

      // The keyboard reaches them as one zone: the arrow keys move along it.
      await page.keyboard.press("Shift");
      await cards.first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(cards.nth(1)).toBeFocused();
      await expect(magnifier).toContainText("Mountain");

      // Pressing one shows its details and plays nothing.
      await cards.first().click();
      const zoom = page.getByRole("dialog", { name: /Lightning Bolt/ });
      await expect(zoom).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(zoom).toBeHidden();

      // bram draws a Swamp and plays his Mountain: the fan follows.
      const swamp = {
        id: "g-swamp",
        hidden: false,
        name: "Swamp",
        mana_cost: null,
        type_line: "Basic Land — Swamp",
        power: null,
        toughness: null,
        rules: ["({T}: Add {B}.)"],
      };
      const mountain = table.fixture.snapshot.view!.opponents[0].hand![1];
      table.send(
        after(table.fixture.snapshot, (view) => {
          const bram = view.opponents[0];
          bram.hand = [
            ...bram.hand!.filter((card) => card.id !== mountain.id),
            swamp,
          ];
          bram.library_count -= 1;
          view.battlefield.push({
            id: mountain.id,
            controller_seat: 1,
            owner_seat: 1,
            card: mountain,
            tapped: false,
            summoning_sick: false,
            damage: 0,
            counters: {},
            attacking: false,
            blocking: false,
            attached_to: null,
          });
        }),
      );
      await expect(hand.getByRole("button", { name: /^Swamp/ })).toHaveCount(1);
      await expect(hand.getByRole("button", { name: /^Mountain/ })).toHaveCount(
        0,
      );
      await expect(cards).toHaveCount(6);
      await expect(
        mate
          .getByRole("group", { name: "bram's battlefield: lands" })
          .getByRole("button", { name: /^Mountain/ }),
      ).toHaveCount(4);
      expect(await occluded(page)).toEqual([]);
      expect(table.commands).toEqual([]);
      expect(await table.problems()).toEqual([]);
      await page.context().close();
    });

  test("says whose turn it is by team, and names the winning team", async ({
    browser,
  }) => {
    const size = { width: 1920, height: 1080, dpr: 1 };
    const page = await tablePage(browser, size);
    const table = await openTable(page, { fixture: "giant", humans: HUMANS });
    await sizeChecks(page, size);
    const turn = page.locator("p[aria-live]").first();
    await expect(turn).toContainText("Turn 7 · Your turn");
    // bram holds the team's turn: it is Alice's too.
    let snapshot = after(table.fixture.snapshot, (view) => {
      view.turn = 8;
      view.active_seat = 1;
    });
    table.send(snapshot);
    await expect(turn).toContainText("Turn 8 · Your team’s turn");
    snapshot = after(snapshot, (view) => {
      view.turn = 9;
      view.active_seat = 2;
    });
    table.send(snapshot);
    await expect(turn).toContainText("Turn 9 · Other team’s turn");
    // The whole line shows: while connected the status chip's place is the line's too.
    expect(
      await turn
        .locator("span")
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    table.send({
      ...after(snapshot, () => undefined),
      status: "finished",
      prompt: null,
      result: {
        kind: "completed",
        winner_seat: 0,
        winner_seats: [0, 1],
        draw: false,
        conceded_seats: [],
        turns: 9,
        error: null,
      },
    });
    await expect(
      page
        .getByRole("dialog", { name: "Victory" })
        .getByText("You and bram won in 9 turns."),
    ).toBeVisible();
    expect(await table.problems()).toEqual([]);
    await page.context().close();
  });

  test("numbers each team for SysOp observing, who sees the watched seat's teammate's hand", async ({
    browser,
  }, testInfo) => {
    const size = { width: 1920, height: 1080, dpr: 1 };
    const page = await tablePage(browser, size);
    const table = await openTable(page, { fixture: "giantSysop" });
    await sizeChecks(page, size);
    await expect(page.locator("p[aria-live]").first()).toContainText(
      "Turn 7 · Team 1’s turn",
    );
    for (const [name, team] of [
      ["Bot 2, seat 2, team 1", "Team 1"],
      ["Bot 3, seat 3, team 2", "Team 2"],
      ["Bot 4, seat 4, team 2", "Team 2"],
    ])
      await expect(
        page.getByRole("article", { name }).getByText(team, { exact: true }),
      ).toBeVisible();
    await expect(
      page
        .getByRole("article", { name: "Bot 2, seat 2, team 1" })
        .getByRole("group", { name: "Bot 2's hand" })
        .getByRole("button"),
    ).toHaveCount(6);
    await page.screenshot({
      path: testInfo.outputPath("table-giant-sysop.jpg"),
      quality: 80,
    });
    table.send({
      ...after(table.fixture.snapshot, () => undefined),
      status: "finished",
      prompt: null,
      result: {
        kind: "completed",
        winner_seat: 2,
        winner_seats: [2, 3],
        draw: false,
        conceded_seats: [],
        turns: 9,
        error: null,
      },
    });
    await expect(
      page
        .getByRole("dialog", { name: "Game over" })
        .getByText("Team 2 won in 9 turns: Bot 3 and Bot 4."),
    ).toBeVisible();
    expect(table.commands).toEqual([]);
    expect(await table.problems()).toEqual([]);
    await page.context().close();
  });
});
