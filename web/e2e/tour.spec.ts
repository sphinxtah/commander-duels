import { test, expect, type Page } from "@playwright/test";
import { standIn } from "./accounts";

// The main menu's tour on a phone and a desktop (v0.8.5): each of its main menu bubbles (Leng's
// Card Shop, Tivit's Auction House, Decks, Play) with its arrow and its ring stays wholly in the
// window, below the sticky top bar, and never covers the tile it points at; turned sideways and
// back, and scrolled, it follows. A stand-in account at each stage, so no SysOp and no catalog.
const sizes = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];
const stops = [
  { stage: "tour_shop", target: "shop" },
  { stage: "tour_auctions", target: "auctions" },
  { stage: "tour_decks", target: "decks" },
  { stage: "tour_play", target: "play" },
] as const;

type Box = { left: number; top: number; right: number; bottom: number };

/** The bubble, its arrow and ring, and the tile, as the window shows them. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element | null | undefined): Box | null => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const coach = document.querySelector('[data-tutorial="coach"]');
    const target = coach?.getAttribute("data-target");
    return {
      coach: box(coach),
      arrow: box(coach?.querySelector("[data-side]")),
      ring: box(coach?.previousElementSibling),
      tile: box(
        target ? document.querySelector(`[data-tour="${target}"]`) : null,
      ),
      bar: box(document.querySelector("header")),
      wide: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

function inside(box: Box | null, width: number, height: number) {
  return (
    box !== null &&
    box.left >= 0 &&
    box.top >= 0 &&
    box.right <= width &&
    box.bottom <= height
  );
}

function overlap(a: Box, b: Box) {
  return (
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  );
}

async function expectPlaced(page: Page, target: string) {
  const coach = page.locator('[data-tutorial="coach"]');
  await expect(coach).toHaveAttribute("data-target", target);
  // Settled: the page has scrolled the tile into view and the bubble has followed. A scroll
  // can pause between two samples on a busy machine, so the bubble must also be on screen.
  const { width, height } = page.viewportSize()!;
  let last = "";
  await expect
    .poll(
      async () => {
        const box = await measure(page);
        const now = JSON.stringify(box);
        const still = now === last;
        last = now;
        return (
          still &&
          inside(box.coach, width, height) &&
          inside(box.arrow, width, height) &&
          inside(box.ring, width, height)
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const placed = await measure(page);
  expect(inside(placed.coach, width, height)).toBe(true);
  expect(inside(placed.arrow, width, height)).toBe(true);
  expect(inside(placed.ring, width, height)).toBe(true);
  // Never over the tile, unless the tile is too tall for the bubble beside it (a phone turned
  // sideways): then only over its lower part, its top (its name) left in view.
  const room =
    height - placed.bar!.bottom - (placed.tile!.bottom - placed.tile!.top);
  if (room >= placed.coach!.bottom - placed.coach!.top + 18 + 12)
    expect(overlap(placed.coach!, placed.tile!)).toBe(0);
  else
    expect(placed.coach!.top).toBeGreaterThanOrEqual(
      Math.max(placed.tile!.top, placed.bar!.bottom) + 56,
    );
  // Below the sticky top bar, never under it.
  expect(placed.coach!.top).toBeGreaterThanOrEqual(placed.bar!.bottom);
  expect(placed.wide).toBe(false);
  // Readable: the bubble's words at the page's own size.
  await expect(coach.locator("p")).toHaveCSS("font-size", /^1[3-6](\.\d+)?px$/);
}

for (const size of sizes)
  test(`the tour's main menu bubbles at ${size.width}×${size.height}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(size);
    const change = await standIn(page, {
      tutorial: { path: "beginner", stage: "tour_shop", skipped: false },
    });
    await page.goto("/#home");
    for (const { stage, target } of stops) {
      change({ tutorial: { path: "beginner", stage, skipped: false } });
      await page.reload();
      await expectPlaced(page, target);
    }
    if (size.width < 600) {
      // Turned sideways and back, then scrolled: the bubble follows its tile.
      await page.setViewportSize({ width: size.height, height: size.width });
      await expectPlaced(page, "play");
      await page.setViewportSize(size);
      await expectPlaced(page, "play");
      await page.mouse.wheel(0, 120);
      await expectPlaced(page, "play");
    }
  });
