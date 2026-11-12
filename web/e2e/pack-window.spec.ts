import { test, expect, type Page } from "@playwright/test";
import { standIn } from "./accounts";

// The window a pack opens in (v0.9.9, the owner: "when you're opening a pack and scroll up and
// down to see the new cards (more relevant with larger packs) it doesn't also scroll the Leng's
// shop area underneath, too. That layer should lock while the new card view window is up.").
// A Tournament Pack's 75 cards, in a shop that page.route answers for a stand-in account: the
// journey is the page's own, with no SysOp, catalog or tokens. At a desktop's size, a phone's and
// a phone turned on its side, the cards scroll inside the window while the page under it, Leng's
// backdrop, the pack's title and its buttons all hold still; and the shop is where it was when
// the window closes.
const sizes = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
];

const PRODUCT = {
  id: "00000000-0000-4000-8000-00000000a101",
  set_code: "USG",
  set_name: "Urza's Saga",
  name: "Urza's Saga Tournament Pack",
  kind: "tournament",
  released: "1998-10-12",
  booster: "tournament",
  era: "oldborder",
  art: null,
  symbol: null,
};
const OPENING = "00000000-0000-4000-8000-00000000b101";
const PACK = "00000000-0000-4000-8000-00000000f101";
const COUNT = 75;

function card(position: number) {
  const land = position < 30;
  const rarity = land
    ? "common"
    : position < 60
      ? "common"
      : position < 72
        ? "uncommon"
        : "rare";
  return {
    position,
    card_id: `00000000-0000-4000-8000-0000001d${String(position).padStart(4, "0")}`,
    printing_id: `00000000-0000-4000-8000-0000001e${String(position).padStart(4, "0")}`,
    name: land ? "Island" : `Tolarian Scholar ${position}`,
    mana_cost: land ? null : "{1}{U}",
    type_line: land ? "Basic Land — Island" : "Creature — Human Wizard",
    rarity,
    set_code: "USG",
    set_name: "Urza's Saga",
    released_at: "1998-10-12",
    collector_number: String(position + 1),
    finish: "nonfoil",
    sheet: rarity,
    new: position % 4 === 0,
    faces: 0,
    stand_in: false,
    extra: false,
  };
}

/** A shop with one Tournament Pack to open and enough on its page to scroll. */
async function shop(page: Page) {
  let opened = false;
  const product = (index: number) => ({
    ...PRODUCT,
    id: `00000000-0000-4000-8000-0000000a2${String(index).padStart(3, "0")}`,
    name: `Urza's Saga Booster ${index}`,
    kind: "draft",
    booster: "draft",
    price: 400 + index,
    price_basis: "market",
    pack_size: 15,
    sale_price: null,
    sold_out: false,
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (pathname === "/api/v1/me") return route.fallback();
    if (pathname.startsWith("/api/v1/card-images/"))
      return route.fulfill({ status: 404, body: "" });
    if (pathname === "/api/v1/shop" && method === "GET")
      return json({
        balance: 1_000,
        // Enough on the shelves for the page to scroll well past a window's height.
        products: Array.from({ length: 24 }, (_, index) => product(index)),
        eras: [
          { id: "oldborder", name: "The old border", since: "1997-01-01" },
        ],
        inventory: opened
          ? []
          : [{ product: PRODUCT, count: 1, next_pack: PACK, openable: true }],
        data: {
          mtgjson_version: "5.3.0",
          prices_as_of: "2026-10-21",
          checked_at: "2026-10-21T11:00:00Z",
        },
        decks: [],
        free_decks: false,
        sale: null,
      });
    if (pathname === "/api/v1/shop/openings" && method === "GET")
      return json([]);
    if (pathname === `/api/v1/shop/packs/${PACK}/open`) {
      opened = true;
      return json({
        id: OPENING,
        pack: PACK,
        product: PRODUCT,
        collation_revision: 1,
        mtgjson_version: "5.3.0",
        opened_at: "2026-11-11T19:00:00Z",
        cards: Array.from({ length: COUNT }, (_, index) => card(index)),
        deck: { format: "legacy", deck: null, deck_title: null },
      });
    }
    return route.fallback();
  });
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where things are while the window is up: the page, the body's scroll and what must not move. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const window_ = document.querySelector("dialog[data-opening-window]")!;
    const box = (element: Element | null): Box | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    interface Box {
      x: number;
      y: number;
      width: number;
      height: number;
    }
    const body = window_.querySelector("[data-opening-scroll]")!;
    return {
      page: Math.round(window.scrollY),
      body: Math.round(body.scrollTop),
      bodyRoom: Math.round(body.scrollHeight - body.clientHeight),
      window: box(window_),
      title: box(window_.querySelector("h2")),
      backdrop: box(window_.querySelector('[data-backdrop="leng"]')),
      foot: box(
        window_.querySelector<HTMLElement>("[data-opening-foot] button"),
      ),
      close: box(window_.querySelector('button[aria-label="Close"]')),
      locked: document.documentElement.hasAttribute("data-modal"),
      overflow: getComputedStyle(document.documentElement).overflowY,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
}

/** What holds still while the cards scroll. */
function fixed(found: Awaited<ReturnType<typeof measure>>) {
  const { page, window: window_, title, backdrop, foot, close } = found;
  return { page, window: window_, title, backdrop, foot, close };
}

for (const size of sizes) {
  test(`a large pack's cards scroll in its window and nothing under it at ${size.width}×${size.height}`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(size);
    await standIn(page, {
      permissions: ["profile.edit", "decks.edit"],
      preferences: { large_text: false, reduced_motion: true },
    });
    await shop(page);
    await page.goto("/#shop");
    const open = page.getByRole("button", {
      name: `Open a pack of ${PRODUCT.name}`,
    });
    await expect(open).toBeVisible();

    // The shop itself scrolls, and is left part of the way down its page: where the page is
    // at the press that opens the pack is where it must be again when the window closes.
    await open.evaluate((button) => button.scrollIntoView({ block: "center" }));
    await page.evaluate(() =>
      addEventListener(
        "click",
        () =>
          document.documentElement.setAttribute(
            "data-pressed-at",
            String(Math.round(scrollY)),
          ),
        { capture: true, once: true },
      ),
    );
    await open.click();
    const before = await page.evaluate(() => ({
      page: Number(document.documentElement.getAttribute("data-pressed-at")),
      room: document.documentElement.scrollHeight - innerHeight,
    }));
    expect(before.room).toBeGreaterThan(400);
    expect(before.page).toBeGreaterThan(0);
    const window_ = page.getByRole("dialog", {
      name: `${PRODUCT.name}: your pack`,
    });
    await expect(window_).toBeVisible();
    // The pack has the keyboard as the window opens, not the way out.
    const sealed = window_.getByRole("button", {
      name: `Tear open the ${PRODUCT.name}`,
    });
    await expect(sealed).toBeFocused();
    const sealedAt = await measure(page);
    // The window is the whole screen, the page under it is locked and has not moved.
    expect(sealedAt.window).toEqual({
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
    });
    expect(sealedAt.locked).toBe(true);
    expect(sealedAt.overflow).toBe("hidden");
    expect(sealedAt.page).toBe(before.page);
    await page.screenshot({
      path: testInfo.outputPath(`pack-window-sealed-${size.width}.png`),
    });

    // Torn open (reduced motion: at once): 75 cards, more than the window shows.
    await sealed.click();
    const board = window_.getByRole("group", { name: "The pack's cards" });
    await expect(board.getByRole("button", { name: /face down/ })).toHaveCount(
      COUNT,
    );
    // The cards have the keyboard, and taking it scrolled nothing.
    await expect(board).toBeFocused();
    const start = await measure(page);
    expect(start.bodyRoom).toBeGreaterThan(size.height);
    expect(start.body).toBe(0);
    // The title, the close button and Reveal all are all inside the screen.
    for (const part of [start.title!, start.close!, start.foot!]) {
      expect(part.y).toBeGreaterThanOrEqual(0);
      expect(part.y + part.height).toBeLessThanOrEqual(size.height);
    }
    // Leng's counter is the window's size behind the cards (drawn a little larger than it, so
    // that its blurred edges lie outside), not the cards' length.
    expect(start.backdrop!.height).toBeLessThanOrEqual(size.height * 1.1);
    expect(start.backdrop!.height).toBeGreaterThanOrEqual(size.height);

    // The wheel over the cards scrolls them, and only them.
    await page.mouse.move(size.width / 2, size.height / 2);
    await page.mouse.wheel(0, 700);
    await expect
      .poll(async () => (await measure(page)).body)
      .toBeGreaterThan(300);
    const scrolled = await measure(page);
    expect(fixed(scrolled)).toEqual(fixed(start));
    await page.screenshot({
      path: testInfo.outputPath(`pack-window-scrolled-${size.width}.png`),
    });

    // To the cards' end and on: the wheel has nowhere else to go.
    for (let turn = 0; turn < 12; turn += 1) await page.mouse.wheel(0, 2_000);
    await expect
      .poll(async () => {
        const now = await measure(page);
        return now.bodyRoom - now.body;
      })
      .toBeLessThanOrEqual(1);
    await page.mouse.wheel(0, 2_000);
    await page.mouse.wheel(0, 2_000);
    await page.waitForTimeout(200);
    expect(fixed(await measure(page))).toEqual(fixed(start));

    // The wheel over the head, which does not scroll, moves nothing under it either.
    await page.mouse.move(
      start.title!.x + 10,
      start.title!.y + start.title!.height / 2,
    );
    await page.mouse.wheel(0, 1_500);
    await page.mouse.wheel(0, -1_500);
    await page.waitForTimeout(200);
    expect(fixed(await measure(page))).toEqual(fixed(start));

    // Back to the top; Space turns the cards in order and the window follows the card turned.
    await page.mouse.move(size.width / 2, size.height / 2);
    for (let turn = 0; turn < 12; turn += 1) await page.mouse.wheel(0, -2_000);
    await expect.poll(async () => (await measure(page)).body).toBe(0);
    await board.focus();
    const turns = 40;
    for (let turn = 0; turn < turns; turn += 1)
      await page.keyboard.press("Space");
    await expect(board.getByRole("button", { name: /face down/ })).toHaveCount(
      COUNT - turns,
    );
    const turned = await page.evaluate((position) => {
      const window_ = document.querySelector("dialog[data-opening-window]")!;
      const body = window_
        .querySelector("[data-opening-scroll]")!
        .getBoundingClientRect();
      const slot = window_
        .querySelector(`[data-position="${position}"]`)!
        .getBoundingClientRect();
      return {
        above: Math.round(body.top - slot.top),
        below: Math.round(slot.bottom - body.bottom),
      };
    }, turns - 1);
    // The fortieth card lies wholly inside the body's view (a pixel's rounding aside).
    expect(turned.above).toBeLessThanOrEqual(1);
    expect(turned.below).toBeLessThanOrEqual(1);
    expect(fixed(await measure(page))).toEqual(fixed(start));

    // The summary starts at its top, in the same window, and scrolls the same way.
    await window_.getByRole("button", { name: "Reveal all" }).click();
    const summary = window_.getByRole("list", { name: "Cards in the pack" });
    await expect(summary.getByRole("listitem")).toHaveCount(COUNT);
    const summed = await measure(page);
    expect(summed.body).toBe(0);
    expect(summed.bodyRoom).toBeGreaterThan(size.height);
    expect(summed.page).toBe(before.page);
    expect(summed.window).toEqual(start.window);
    const back = window_.getByRole("button", { name: "Back to the shop" });
    await expect(back).toBeInViewport({ ratio: 1 });
    // The pointer is still where Reveal all was, on the foot: the wheel there scrolls the
    // cards too, as it did when the pack was part of the page.
    await page.mouse.wheel(0, 900);
    await expect
      .poll(async () => (await measure(page)).body)
      .toBeGreaterThan(300);
    const summaryScrolled = await measure(page);
    expect(fixed(summaryScrolled)).toEqual(fixed(summed));
    await expect(back).toBeInViewport({ ratio: 1 });
    // So do the scrolling keys from the summary's title, which has the keyboard.
    await expect(
      window_.getByRole("heading", { name: PRODUCT.name }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect
      .poll(async () => {
        const now = await measure(page);
        return now.bodyRoom - now.body;
      })
      .toBeLessThanOrEqual(1);
    await page.keyboard.press("Home");
    await expect.poll(async () => (await measure(page)).body).toBe(0);
    await page.keyboard.press("PageDown");
    await expect
      .poll(async () => (await measure(page)).body)
      .toBeGreaterThan(100);
    expect(fixed(await measure(page))).toEqual(fixed(summed));
    // Nothing in the window scrolls sideways.
    expect(
      await page.evaluate(() => {
        const body = document.querySelector(
          "dialog[data-opening-window] [data-opening-scroll]",
        )!;
        return body.scrollWidth <= body.clientWidth;
      }),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`pack-window-summary-${size.width}.png`),
    });

    // A card's details open over the window and close back to it.
    await page.mouse.wheel(0, -5_000);
    await summary
      .getByRole("button", { name: "Details of Island" })
      .first()
      .click();
    const details = page.getByRole("dialog", { name: "Island, card details" });
    await expect(details).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await expect(window_).toBeVisible();

    // Closed, the shop is where it was left, and scrolls again.
    await page.keyboard.press("Escape");
    await expect(window_).toBeHidden();
    const after = await page.evaluate(() => ({
      page: Math.round(window.scrollY),
      locked: document.documentElement.hasAttribute("data-modal"),
      overflow: getComputedStyle(document.documentElement).overflowY,
    }));
    expect(after.locked).toBe(false);
    expect(after.overflow).not.toBe("hidden");
    expect(after.page).toBe(before.page);
    await page.mouse.move(size.width / 2, size.height / 2);
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => page.evaluate(() => Math.round(window.scrollY)))
      .toBeGreaterThan(before.page);
    expect(errors).toEqual([]);
  });
}

// The tutorial's tour inside the window: its coach is drawn into the pop-up (a modal dialog hides
// everything outside it), wholly on screen, and never over what it points at: the pack to tear,
// then Reveal all.
for (const size of [sizes[0], sizes[1]]) {
  test(`the tour's bubbles are in the pack's window at ${size.width}×${size.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    const account = {
      permissions: ["profile.edit", "decks.edit"],
      preferences: { large_text: false, reduced_motion: true },
      tutorial: { path: "beginner", stage: "tour_shop", skipped: false },
    } as const;
    const change = await standIn(page, {
      ...account,
      permissions: [...account.permissions],
    });
    await shop(page);
    // The tour moves on once the pack is opened; the stand-in's account follows it.
    let moved = "";
    await page.route("**/api/v1/me/tutorial", async (route) => {
      const body = route.request().postDataJSON() as { stage: string };
      moved = body.stage;
      const tutorial = {
        path: "beginner" as const,
        stage: body.stage,
        skipped: false,
      };
      change({ tutorial } as never);
      // The stand-in's account as the page itself is given it (page.route answers /me).
      const me = (await page.evaluate(async () =>
        (await fetch("/api/v1/me")).json(),
      )) as object;
      await route.fulfill({ json: { ...me, tutorial } });
    });
    await page.goto("/#shop");
    await page
      .getByRole("button", { name: `Open a pack of ${PRODUCT.name}` })
      .click();
    const window_ = page.getByRole("dialog", {
      name: `${PRODUCT.name}: your pack`,
    });
    await expect(window_).toBeVisible();
    const coach = window_.locator('[data-tutorial="coach"]');

    /** The bubble and what it points at, once the bubble has settled. */
    const placed = async (target: string) => {
      await expect(coach).toHaveAttribute("data-target", target);
      let last = "";
      await expect
        .poll(
          async () => {
            const now = JSON.stringify(await coach.boundingBox());
            const still = now === last;
            last = now;
            return still;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      const bubble = (await coach.boundingBox())!;
      const pointed = (await window_
        .locator(`[data-tour="${target}"]`)
        .boundingBox())!;
      // Wholly on screen.
      expect(bubble.x).toBeGreaterThanOrEqual(0);
      expect(bubble.y).toBeGreaterThanOrEqual(0);
      expect(bubble.x + bubble.width).toBeLessThanOrEqual(size.width);
      expect(bubble.y + bubble.height).toBeLessThanOrEqual(size.height);
      const overlap =
        Math.max(
          0,
          Math.min(bubble.x + bubble.width, pointed.x + pointed.width) -
            Math.max(bubble.x, pointed.x),
        ) *
        Math.max(
          0,
          Math.min(bubble.y + bubble.height, pointed.y + pointed.height) -
            Math.max(bubble.y, pointed.y),
        );
      return { bubble, pointed, overlap };
    };

    // Sealed: "Tear it open" points at the pack, which can still be pressed.
    const tear = await placed("pack-tear");
    await expect(coach).toContainText("Tear it open");
    await page.screenshot({
      path: testInfo.outputPath(`pack-window-tour-tear-${size.width}.png`),
    });
    // The pack's top, where it tears, is clear of the bubble.
    expect(tear.bubble.y).toBeGreaterThanOrEqual(tear.pointed.y + 56);
    await window_
      .getByRole("button", { name: `Tear open the ${PRODUCT.name}` })
      .click({ position: { x: 20, y: 20 } });

    // Turning the cards over: "Turn them over" points at Reveal all and leaves it free.
    const reveal = await placed("pack-reveal");
    await expect(coach).toContainText("Turn them over");
    expect(reveal.overlap).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(`pack-window-tour-reveal-${size.width}.png`),
    });
    await window_.getByRole("button", { name: "Reveal all" }).click();

    // The summary: the tour has moved on to the auction house and waits under the window.
    await expect(
      window_.getByRole("list", { name: "Cards in the pack" }),
    ).toBeVisible();
    await expect.poll(() => moved).toBe("tour_auctions");
    await expect(coach).toHaveCount(0);
    await window_.getByRole("button", { name: "Back to the shop" }).click();
    await expect(window_).toBeHidden();
  });
}
