import { test, expect } from "@playwright/test";
import { standIn } from "./accounts";

// The guided game's way into How to play (v0.9.8, the owner's report): "More in How to play: …"
// opened the guide in a new tab, and for an account still in its setup a new tab opens the welcome
// again. It opens the topic in a pop-up over the game now: no new tab, nothing in it that leads
// away, and the game goes on where it was. A stand-in account in the tutorial's demo stage, so no
// SysOp, no catalog and no engine: the guided game is scripted in the page.
const sizes = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

for (const size of sizes)
  test(`More in How to play is a pop-up in the guided game at ${size.width}×${size.height}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize(size);
    await standIn(page, {
      onboarding: "handle",
      handle: null,
      tutorial: { path: "beginner", stage: "demo", skipped: false },
    });
    await page.goto("/#tutorial/demo");
    const narration = page.locator('[data-tutorial="narration"]');
    await expect(narration).toBeVisible({ timeout: 30_000 });
    // The third lesson is the one in the owner's screenshot: Lands and mana.
    for (let lesson = 0; lesson < 2; lesson++)
      await narration.getByRole("button", { name: /^Next/ }).click();
    await expect(
      narration.getByRole("heading", { name: "Lands and mana" }),
    ).toBeVisible();
    const more = narration.getByRole("button", {
      name: "More in How to play: Lands and mana",
    });
    await expect(narration.getByRole("link")).toHaveCount(0);

    await more.click();
    const dialog = page.getByRole("dialog", { name: "Lands and mana" });
    await expect(dialog).toBeVisible();
    // No new tab, and the address has not moved from the guided game.
    expect(context.pages()).toHaveLength(1);
    await expect(page).toHaveURL(/#tutorial\/demo$/);
    await expect(dialog.getByRole("link")).toHaveCount(0);
    // Wholly in the window, with its words readable and its own scrolling.
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    await expect(dialog.locator("p").first()).toHaveCSS(
      "font-size",
      /^1[4-9](\.\d+)?px$/,
    );
    await page.screenshot({
      path: `test-results/tutorial/how-to-play-popup-${size.width}.png`,
    });

    // Escape closes it, and the guided game is where it was.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      narration.getByRole("heading", { name: "Lands and mana" }),
    ).toBeVisible();
    // Open again, closed by its own button, and the game goes on.
    await more.click();
    await page
      .getByRole("dialog", { name: "Lands and mana" })
      .getByRole("button", { name: "Back to the tutorial" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await narration.getByRole("button", { name: /^Next/ }).click();
    await expect(
      narration.getByRole("heading", { name: "Lands and mana" }),
    ).toHaveCount(0);
    expect(context.pages()).toHaveLength(1);
  });
