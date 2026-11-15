import { expect, test, type Page } from "@playwright/test";
import {
  openTable,
  type FakeTable,
  type TimelineEvent,
} from "./helpers/fakeTable";

// A replay (v1.0.0, docs/replays.md): a game that is over, played back step by step on a page
// of its own. The account, the game's summary and the card pictures are the fake table's
// (helpers/fakeTable.ts); the replay's routes are answered here as the API answers them. The
// journey against the real engine is in game.spec.ts: the Legacy game played to its end opens
// its replay from the result.

const at = { v: 2, epoch: 0, turn: 1, step: "precombat_main" };
const bolt = { ref: "o2", name: "Lightning Bolt", owner: 0 };
const bears = { ref: "o10", name: "Grizzly Bears", owner: 1 };

/** A short duel as its seat 0 saw it: a land, a Bolt at the Bears, and the next turn's draw. */
const EVENTS: TimelineEvent[] = [
  { ...at, seq: 1, type: "step", active: 0 },
  {
    ...at,
    seq: 2,
    type: "zone_change",
    from: "hand",
    to: "battlefield",
    player: 0,
    object: { ref: "o1", name: "Mountain", owner: 0 },
    tally: [
      [20, 6, 53, 0, 1],
      [20, 7, 52, 0, 1],
    ],
  },
  {
    ...at,
    seq: 3,
    type: "cast",
    player: 0,
    object: { ...bolt, mana_cost: "{R}" },
    cost: { paid: "{R}" },
    tally: [
      [20, 5, 53, 0, 1],
      [20, 7, 52, 0, 1],
    ],
  },
  { ...at, seq: 4, type: "resolve", player: 0, object: bolt },
  { ...at, seq: 5, type: "damage", target: bears, amount: 3, cause: bolt },
  {
    ...at,
    seq: 6,
    type: "zone_change",
    from: "battlefield",
    to: "graveyard",
    player: 1,
    object: { ...bears, ref: "o11", was: "o10" },
    why: "lethal_damage",
    tally: [
      [20, 5, 53, 1, 1],
      [20, 7, 52, 1, 0],
    ],
  },
  { ...at, seq: 7, turn: 2, step: "draw", type: "step", active: 1 },
  {
    ...at,
    seq: 8,
    turn: 2,
    step: "draw",
    type: "zone_change",
    from: "library",
    to: "hand",
    player: 1,
    object: { hidden: true, owner: 1 },
    tally: [
      [20, 5, 53, 1, 1],
      [20, 8, 51, 1, 0],
    ],
  },
];

interface Kept {
  marks: Record<string, unknown>[];
  note: string;
  /** Every change the page asked for, in order. */
  asked: { method: string; seq: number; body: unknown }[];
}

/** Opens the fake table's game as a replay: its header and events as the API gives them, and
 * the reader's marks kept as they are put. */
async function openReplay(
  page: Page,
): Promise<{ table: FakeTable; kept: Kept }> {
  const table = await openTable(page, { fixture: "duel" });
  const id = table.gameId;
  const kept: Kept = { marks: [], note: "", asked: [] };
  const header = () => ({
    game: {
      id,
      kind: "practice",
      format: "legacy",
      status: "finished",
      bot_skill: 3,
      turn_cap: 40,
      created_at: "2026-10-20T00:00:00Z",
      finished_at: "2026-10-20T00:20:00Z",
      result: {
        kind: "completed",
        turns: 2,
        winner_seat: 0,
        winner_seats: [0],
        conceded_seats: [],
        draw: false,
      },
      seats: table.fixture.summarySeats,
      your_seat: 0,
    },
    through: { seat: 0, yours: true, shared_by: null, grant_id: null },
    deck: { title: "Burn", version: 3, deck_id: null },
    starting: [
      { seat: 0, life: 20, team: null, shared_life: false },
      { seat: 1, life: 20, team: null, shared_life: false },
    ],
    events: EVENTS.length,
    turns: 2,
    kept_until: "2027-01-18T00:20:00Z",
    marks: kept.marks,
    note: kept.note,
    shares: [],
  });
  await page.route(`**/api/v1/games/${id}/replay`, (route) =>
    route.fulfill({ json: header() }),
  );
  await page.route(`**/api/v1/games/${id}/replay/events**`, (route) => {
    const since = Number(
      new URL(route.request().url()).searchParams.get("since") ?? 0,
    );
    // Two pages, as a long game's are read.
    const after = EVENTS.filter((event) => event.seq > since);
    const found = after.slice(0, 5);
    return route.fulfill({
      json: {
        game_id: id,
        perspective: "seat",
        seat: 0,
        turns: { "1": 0, "2": 1 },
        events: found,
        next: found.at(-1)?.seq ?? since,
        first: found[0]?.seq ?? 0,
        more: after.length > 5,
      },
    });
  });
  await page.route(`**/api/v1/games/${id}/replay/marks/*`, (route) => {
    const request = route.request();
    const seq = Number(new URL(request.url()).pathname.split("/").pop());
    const body = request.method() === "PUT" ? request.postDataJSON() : null;
    kept.asked.push({ method: request.method(), seq, body });
    kept.marks = kept.marks.filter((mark) => mark.seq !== seq);
    if (request.method() === "PUT" && seq === 0) kept.note = body.note;
    else if (request.method() === "PUT")
      kept.marks.push({
        seq,
        turn: 1,
        label: body.label,
        note: body.note,
        updated_at: "2026-10-21T00:00:00Z",
      });
    return route.fulfill({ json: header() });
  });
  // The table's game keeps its address while its page lives: the replay's is a page load of
  // its own (the query makes it one).
  await page.goto(`/?replay#replay/${id}`);
  await expect(
    page.getByRole("heading", { name: "The game, played back", level: 1 }),
  ).toBeVisible();
  return { table, kept };
}

const steps = (page: Page) => page.locator("li[data-seq]");
const row = (page: Page, name: RegExp) =>
  page.getByRole("row", { name }).getByRole("cell");

test.describe("a replay (v1.0.0)", () => {
  test("plays a game back step by step: the scoreboard follows, nothing is told early, and a bookmark is kept", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const { table, kept } = await openReplay(page);
    await expect(page.getByText("You won in 2 turns")).toBeVisible();
    await expect(page.getByText(/Your deck: Burn, version 3\./)).toBeVisible();

    // It stands at the first step; what comes next is not on the page.
    await expect(steps(page)).toHaveCount(1);
    await expect(steps(page).first()).toContainText("played Mountain.");
    await expect(page.getByText("Lightning Bolt")).toHaveCount(0);
    await expect(page.getByText(/Step 1 of 6 · turn 1 of 2/)).toBeVisible();
    await expect(row(page, /^alice/)).toHaveText(["20", "6", "53", "1", "0"]);

    // One step on, by its button: the Bolt is cast, and the hand is one card smaller.
    await page.getByRole("button", { name: "One step on" }).click();
    await expect(steps(page)).toHaveCount(2);
    await expect(steps(page).last()).toHaveAttribute("aria-current", "step");
    await expect(steps(page).last()).toContainText("cast Lightning Bolt for");
    await expect(row(page, /^alice/)).toHaveText(["20", "5", "53", "1", "0"]);

    // By the keys from the list: on to the death, with the rule that explains it.
    await page.getByRole("region", { name: "The game so far" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const died = steps(page).last();
    await expect(died).toContainText("Grizzly Bears died.");
    await expect(
      died.getByRole("link", { name: /^Rule 704\.5g, in How to play/ }),
    ).toBeVisible();
    await expect(row(page, /^Bot/)).toHaveText(["20", "7", "52", "0", "1"]);

    // A bookmark at this step, kept by the server and marked in the list.
    await page.getByRole("button", { name: "Bookmark this step" }).click();
    await page.getByLabel("Name").fill("The Bears die");
    await page.getByLabel("Note", { exact: true }).fill("Bolt was right.");
    await page.getByRole("button", { name: "Save bookmark" }).click();
    const bookmark = page.getByRole("button", {
      name: "Turn 1 · The Bears die",
    });
    await expect(bookmark).toBeVisible();
    await expect(died).toContainText("★ bookmarked");
    expect(kept.asked).toEqual([
      {
        method: "PUT",
        seq: 6,
        body: { label: "The Bears die", note: "Bolt was right." },
      },
    ]);

    // Play runs to the end of the game and stops there; the bookmark goes back to its step.
    await page.getByLabel("Speed").selectOption("4");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Play again" }),
    ).toBeVisible();
    await expect(steps(page).last()).toContainText("drew a hidden card.");
    await expect(row(page, /^Bot/)).toHaveText(["20", "8", "51", "0", "1"]);
    await bookmark.click();
    await expect(steps(page).last()).toContainText("Grizzly Bears died.");
    await page.screenshot({
      path: testInfo.outputPath("replay.jpg"),
      type: "jpeg",
      quality: 80,
      fullPage: true,
    });

    // Find goes to a step by its words.
    await page.getByLabel("Find a step").fill("mountain");
    await page.getByLabel("Find a step").press("Enter");
    await expect(steps(page)).toHaveCount(1);
    await expect(page.getByText("1 of 1 found")).toBeVisible();

    // Nothing is wider than the page.
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(await table.problems()).toEqual([]);
  });

  test("fits a phone: the controls stack, the note is kept, and nothing scrolls sideways", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { table, kept } = await openReplay(page);
    await expect(steps(page)).toHaveCount(1);
    for (const name of [
      "Previous turn",
      "One step back",
      "Play",
      "One step on",
      "Next turn",
    ])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    // Each control is large enough for a thumb.
    const play = await page
      .getByRole("button", { name: "Play", exact: true })
      .boundingBox();
    expect(play!.height).toBeGreaterThanOrEqual(40);
    await page.getByRole("button", { name: "Next turn" }).click();
    await expect(steps(page).last()).toContainText("drew a hidden card.");
    await page.screenshot({
      path: testInfo.outputPath("replay-phone.jpg"),
      type: "jpeg",
      quality: 80,
      fullPage: true,
    });
    await page
      .getByLabel("Your note on this game")
      .fill("Keep the Bolt for the Bears.");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByText("Saved. Only you see it.")).toBeVisible();
    expect(kept.asked.at(-1)).toEqual({
      method: "PUT",
      seq: 0,
      body: { label: "", note: "Keep the Bolt for the Bears." },
    });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(await table.problems()).toEqual([]);
  });
});
