import { test, expect, type Page } from "@playwright/test";
import { standIn } from "./accounts";
import { playWizard, startFromWizard, toSlide } from "./helpers/playWizard";

// The Play wizard (v1.0.0, the owner's request): from the main menu to "Start Game" by answering
// one question a slide, by mouse, by keyboard and on a phone; the last setup remembered and
// offered again; the account's games on a page of their own. A stand-in account whose options,
// decks and games the journey answers itself, so it needs neither SysOp nor the engine: the game
// a start makes is checked by the request it sends.

const GAME = "00000000-0000-4000-8000-00000000beef";

const options = {
  formats: [
    {
      id: "legacy",
      name: "Legacy",
      bots: [1],
      default_bots: 1,
      decks: [],
      best_of: [1, 3],
      turn_caps: { "1": 80 },
    },
    {
      id: "commander",
      name: "Commander",
      bots: [1, 2, 3],
      default_bots: 3,
      decks: [],
      best_of: [1],
      turn_caps: { "1": 80, "2": 120, "3": 160 },
    },
    {
      id: "kings_table",
      name: "King's Table",
      bots: [5],
      default_bots: 5,
      decks: [],
      best_of: [1],
      turn_caps: { "5": 240 },
      kings_table: {
        deck_format: "commander",
        life: "all_40",
        king_attacks_anyone: true,
        guarded_kings: false,
      },
    },
  ],
  deck_lists: false,
  own_decks: true,
  max_turn_cap: 400,
};

function deck(id: string, title: string, format: "legacy" | "commander") {
  return {
    id,
    title,
    format,
    visibility: "private",
    card_count: format === "legacy" ? 60 : 100,
    legal: true,
    playable: true,
    collection_locked: false,
    needs: [],
    identity: "R",
    commanders: [],
    latest_revision: null,
    source: "starter",
    archived: false,
    deleted_at: null,
    updated_at: "2026-11-14T10:00:00Z",
    removed_cards: [],
  };
}
const decks = [
  deck("00000000-0000-4000-8000-0000000000d1", "Skyward Patrol", "commander"),
  deck("00000000-0000-4000-8000-0000000000d2", "Graveyard Shift", "commander"),
  deck("00000000-0000-4000-8000-0000000000d3", "Red Burn", "legacy"),
];

/** A player who may play and build decks, with the Play page's requests answered here. Returns
 * the bodies of the games the page asked to start. */
async function player(page: Page, games: unknown[] = []) {
  await standIn(page, {
    handle: "pat",
    permissions: ["profile.edit", "games.play", "decks.edit"],
  });
  const started: Record<string, unknown>[] = [];
  await page.route("**/api/v1/practice-games/options", (route) =>
    route.fulfill({ json: options }),
  );
  await page.route("**/api/v1/decks?*", (route) =>
    route.fulfill({ json: decks }),
  );
  await page.route("**/api/v1/games?*", (route) =>
    route.fulfill({ json: games }),
  );
  await page.route("**/api/v1/matches", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/practice-games", async (route) => {
    started.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 201, json: { id: GAME } });
  });
  return started;
}

/** Nothing of the page is wider than the window. */
async function fits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("the Play wizard asks one thing a slide and starts the game from the last", async ({
  page,
}) => {
  const started = await player(page);
  await page.goto("/#play");
  const wizard = playWizard(page);
  await expect(
    wizard.getByRole("heading", { name: "Which format do you play?" }),
  ).toBeVisible();
  // The account's playable decks are Commander's and Legacy's: it opens on Legacy, which has
  // matches, so the wizard has a Games slide.
  await expect(
    wizard.getByRole("list", { name: "The Play wizard's slides" }),
  ).toHaveText(
    /1 of 5: Format.*2 of 5: Games.*3 of 5: The table's rules.*4 of 5: The bots.*5 of 5: Start Game/,
  );
  await wizard.getByRole("radio", { name: /Commander/ }).check();
  // Commander plays one game: no Games slide. Two Commander decks: a slide to choose one.
  await expect(
    wizard.getByRole("list", { name: "The Play wizard's slides" }),
  ).toHaveText(
    /1 of 5: Format.*2 of 5: The table's rules.*3 of 5: Your deck.*4 of 5: The bots.*5 of 5: Start Game/,
  );
  await wizard.getByRole("button", { name: "Next" }).click();
  await expect(
    wizard.getByRole("heading", { name: "What are the table's rules?" }),
  ).toBeFocused();
  await wizard.getByLabel("Turn limit").fill("30");
  await wizard.getByRole("button", { name: "Next" }).click();
  await wizard
    .getByLabel("Your deck")
    .selectOption({ label: "Graveyard Shift" });
  await wizard.getByRole("button", { name: "Next" }).click();
  await wizard.getByLabel("Bots", { exact: true }).selectOption("2");
  await wizard.getByLabel(/Bot skill/).fill("2");
  await wizard.getByRole("button", { name: "Back" }).click();
  await expect(wizard.getByLabel("Your deck")).toHaveValue(
    `own:${decks[1].id}`,
  );
  await wizard.getByRole("button", { name: "Next" }).click();
  await wizard.getByRole("button", { name: "Next" }).click();
  // The last slide: everything chosen, and the button.
  const summary = wizard.getByLabel("What you chose");
  await expect(summary).toContainText("Commander");
  await expect(summary).toContainText("Casual · 30 turns");
  await expect(summary).toContainText("Graveyard Shift");
  await expect(summary).toContainText("2 bots at skill 2 of 6");
  await wizard.getByRole("button", { name: "Start Game", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#game/${GAME}$`));
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({
    format: "commander",
    deck_id: decks[1].id,
    bot_skill: 2,
    turn_cap: 30,
    best_of: 1,
    bots: [{}, {}],
    rules: { banned: true, not_legal: true, stand_in: true },
  });

  // The next visit remembers it: the first slide offers the last setup, which leads straight to
  // the last slide.
  await page.goto("/#play");
  const again = wizard.getByRole("group", { name: "Your last setup" });
  await expect(again).toContainText(
    "Commander · Graveyard Shift · 2 bots at skill 2 · Casual",
  );
  await again
    .getByRole("button", { name: "Play again with your last setup" })
    .click();
  await expect(
    wizard.getByRole("heading", { name: "Ready to play" }),
  ).toBeFocused();
  await wizard.getByRole("button", { name: "Start Game", exact: true }).click();
  await expect.poll(() => started.length).toBe(2);
  expect(started[1]).toEqual(started[0]);
});

test("the Play wizard is walked by keyboard alone", async ({ page }) => {
  const started = await player(page);
  await page.goto("/#play");
  const wizard = playWizard(page);
  // The format's radios take the arrow keys, and Enter is Next on every slide.
  await wizard.getByRole("radio", { name: /Legacy/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(wizard.getByRole("radio", { name: /Commander/ })).toBeChecked();
  await page.keyboard.press("Enter");
  await expect(
    wizard.getByRole("heading", { name: "What are the table's rules?" }),
  ).toBeFocused();
  // From the heading, Tab reaches the slide's first choice, and its focus is drawn.
  await page.keyboard.press("Tab");
  await expect(
    wizard.getByRole("checkbox", { name: /^Banned cards/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    wizard.getByRole("heading", { name: "Which deck do you play?" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(wizard.getByLabel("Your deck")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(wizard.getByRole("button", { name: "Back" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(wizard.getByRole("button", { name: "Next" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    wizard.getByRole("heading", { name: "Who do you play against?" }),
  ).toBeFocused();
  await wizard.getByLabel(/Bot skill/).focus();
  await page.keyboard.press("Enter");
  await expect(
    wizard.getByRole("heading", { name: "Ready to play" }),
  ).toBeFocused();
  await wizard.getByRole("button", { name: "Start Game", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#game/${GAME}$`));
  expect(started[0]).toMatchObject({ format: "commander", bots: [{}, {}, {}] });
});

test("the Play wizard fits a phone, King's Table's seat included", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const started = await player(page);
  await page.goto("/#play");
  const wizard = playWizard(page);
  await wizard.getByRole("radio", { name: /King's Table/ }).check();
  await fits(page);
  for (const name of [
    "The table's rules",
    "Your seat",
    "Your deck",
    "The bots",
    "Start Game",
  ]) {
    await toSlide(page, name);
    await fits(page);
    // The slide's own button is in reach of a thumb's scroll: wholly inside the page's width.
    const button = wizard.locator('button[type="submit"]');
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await toSlide(page, "Your seat");
  await wizard.getByRole("radio", { name: /^Team B's King/ }).check();
  await startFromWizard(page);
  await expect(page).toHaveURL(new RegExp(`#game/${GAME}$`));
  expect(started[0]).toMatchObject({ format: "kings_table", seat: 4 });
});

test("the wizard's first slide opens the account's games, and a running game leads back", async ({
  page,
}) => {
  const running = {
    id: "00000000-0000-4000-8000-0000000000aa",
    kind: "practice",
    format: "commander",
    status: "active",
    your_seat: 0,
    seats: [
      {
        seat: 0,
        player: "human",
        handle: "pat",
        deck: "Skyward Patrol",
        left: null,
      },
      { seat: 1, player: "bot", handle: null, deck: null, left: null },
    ],
    campaign: null,
    match: null,
    kings_table: null,
    result: null,
    bot_skill: 4,
    turn_cap: 80,
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  await player(page, [running]);
  await page.goto("/#play");
  const wizard = playWizard(page);
  await expect(
    wizard
      .getByRole("complementary", { name: "Your running game" })
      .getByRole("link", { name: "Return to your game" }),
  ).toHaveAttribute("href", `#game/${running.id}`);
  await wizard.getByRole("link", { name: "Your games" }).click();
  await expect(page).toHaveURL(/#play\/games$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Your games." }),
  ).toBeVisible();
  const games = page.getByRole("region", { name: "Your games" });
  await expect(games).toContainText("Commander");
  await expect(games.getByRole("link", { name: "Resume" })).toHaveAttribute(
    "href",
    `#game/${running.id}`,
  );
  await expect(games.getByRole("button", { name: "Close" })).toBeVisible();
  await page.getByRole("link", { name: "Back to Play" }).click();
  await expect(page).toHaveURL(/#play$/);
  await expect(
    wizard.getByRole("heading", { name: "Which format do you play?" }),
  ).toBeVisible();
});
