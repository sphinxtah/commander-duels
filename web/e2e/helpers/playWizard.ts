import type { Locator, Page } from "@playwright/test";

// The Play wizard (v1.0.0): Play asks one thing a slide, so a journey that starts a practice game
// goes to the slide that holds each choice, by the slide's name along the top, and starts the game
// from the last one.

/** The wizard on the Play page. */
export function playWizard(page: Page): Locator {
  return page.locator("#practice");
}

/** Goes to a slide by its name: "Format", "Games", "The table's rules", "Your seat", "Your deck",
 * "The bots" or "Start Game". */
export async function toSlide(page: Page, name: string): Promise<void> {
  await playWizard(page)
    .getByRole("button", { name: new RegExp(`^Slide \\d+ of \\d+: ${name}$`) })
    .click();
}

/** Presses "Start Game" on the last slide. */
export async function startFromWizard(page: Page): Promise<void> {
  await toSlide(page, "Start Game");
  await playWizard(page)
    .getByRole("button", { name: "Start Game", exact: true })
    .click();
}
