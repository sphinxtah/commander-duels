import { test, expect, type Page, type Route } from "@playwright/test";
import { standIn } from "./accounts";

// The deck workshop (v1.0.0, docs/decks.md): a deck's Workshop page (its versions compared and
// restored, its results by the version played, the cards it lacks with their owned substitutes
// swapped into the draft and undone), the Decks page's shelves and organizer, and the wishlist
// in Cards. A stand-in account whose decks the journey answers itself, so it needs neither SysOp
// nor the engine, and can show results and missing cards a fresh installation has none of. The
// organizer, a real restore and the empty states run against the real API in decks.spec.ts.

const DECK = "00000000-0000-4000-8000-0000000000d1";
const OTHER = "00000000-0000-4000-8000-0000000000d2";

function summary(id: string, title: string, fields: object = {}) {
  return {
    id,
    title,
    format: "legacy",
    visibility: "private",
    card_count: 60,
    legal: true,
    playable: true,
    collection_locked: false,
    needs: [],
    identity: "R",
    commanders: [],
    latest_revision: 2,
    source: "import",
    archived: false,
    deleted_at: null,
    updated_at: "2026-11-14T10:00:00Z",
    removed_cards: [],
    folder: null as string | null,
    tags: [] as string[],
    ...fields,
  };
}

function version(number: number) {
  return {
    number,
    title: "Mono-Red Burn",
    created_at: `2026-11-0${number}T10:00:00Z`,
    legal: true,
    playable: true,
    catalog_revision: 1,
    format_version: 1,
    content_hash: `hash-${number}`,
  };
}

const card = (id: string, name: string, type = "Instant") => ({
  id,
  name,
  type_line: type,
  mana_cost: "{R}",
  playable: true,
});

const ENTRIES = [
  { card_id: "bolt", location: "main", quantity: 4 },
  { card_id: "mountain", location: "main", quantity: 56 },
];

const record = (games: number, wins: number, losses: number) => ({
  games,
  wins,
  losses,
  draws: games - wins - losses,
  win_rate: games ? wins / games : null,
  small_sample: games < 10,
});
const split = (
  fields: object,
  games: number,
  wins: number,
  losses: number,
) => ({
  ...record(games, wins, losses),
  format: "legacy",
  mode: "practice",
  opposition: "bots",
  bot_skill: 4,
  ...fields,
});

/** What the journey's deck holds, and what the pages sent. */
type Served = {
  decks: ReturnType<typeof summary>[];
  draft: { version: number; entries: typeof ENTRIES };
  wished: number;
  drafts: { version: number; entries: unknown[] }[];
  organized: unknown[];
  restored: unknown[];
  wishes: unknown[];
};

async function player(page: Page): Promise<Served> {
  await standIn(page, {
    handle: "pat",
    permissions: ["profile.edit", "games.play", "decks.edit"],
  });
  const served: Served = {
    decks: [
      summary(DECK, "Mono-Red Burn", {
        folder: "Tournament",
        tags: ["budget"],
      }),
      summary(OTHER, "Elves", { identity: "G" }),
    ],
    draft: { version: 7, entries: ENTRIES },
    wished: 0,
    drafts: [],
    organized: [],
    restored: [],
    wishes: [],
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, json: body });
  const lacks = () =>
    served.draft.entries.some((entry) => entry.card_id === "shock")
      ? { deck_id: DECK, missing: 0, complete: true, cards: [] }
      : {
          deck_id: DECK,
          missing: 3,
          complete: false,
          cards: [
            {
              card: card("bolt", "Lightning Bolt"),
              needed: 4,
              owned: 1,
              missing: 3,
              wished: served.wished,
              auctions: 2,
              packs: [
                { product_id: "p1", name: "Alpha Booster", set_code: "lea" },
              ],
            },
          ],
        };
  const wishlist = () => ({
    wishes: served.wished
      ? [
          {
            card: card("bolt", "Lightning Bolt"),
            quantity: served.wished,
            deck_id: DECK,
            owned: 1,
          },
        ]
      : [],
  });
  await page.route("**/api/v1/rollout", (route) =>
    json(route, { workflows: [] }),
  );
  await page.route(/\/api\/v1\/decks\/starters$/, (route) => json(route, []));
  await page.route(/\/api\/v1\/decks(\?.*)?$/, (route) =>
    json(route, served.decks),
  );
  await page.route(/\/api\/v1\/decks\/organize$/, (route) => {
    const body = route.request().postDataJSON() as {
      deck_ids: string[];
      folder?: string;
      add_tags: string[];
    };
    served.organized.push(body);
    served.decks = served.decks.map((deck) =>
      body.deck_ids.includes(deck.id)
        ? {
            ...deck,
            folder: body.folder ?? deck.folder,
            tags: [...new Set([...deck.tags, ...body.add_tags])],
          }
        : deck,
    );
    return json(route, served.decks);
  });
  await page.route(new RegExp(`/api/v1/decks/${DECK}$`), (route) =>
    json(route, {
      ...served.decks[0],
      notes: "",
      share_code: null,
      cards: {},
      revisions: [version(1), version(2)],
      draft: served.draft,
    }),
  );
  await page.route(new RegExp(`/api/v1/decks/${DECK}/diff`), (route) => {
    const query = new URL(route.request().url()).searchParams;
    const before = query.get("before")!;
    const after = query.get("after") ?? "draft";
    const differs = before === "1" || after === "1";
    return json(route, {
      deck_id: DECK,
      before,
      after,
      added: differs ? 1 : 0,
      removed: differs ? 3 : 0,
      same: !differs,
      lines: differs
        ? [
            {
              card_id: "bolt",
              name: "Lightning Bolt",
              location: "main",
              before: 4,
              after: 1,
            },
            {
              card_id: "pyro",
              name: "Pyroblast",
              location: "sideboard",
              before: 0,
              after: 1,
            },
          ]
        : [],
    });
  });
  await page.route(
    new RegExp(`/api/v1/decks/${DECK}/revisions/\\d+/restore$`),
    (route) => {
      served.restored.push(route.request().postDataJSON());
      served.draft = { ...served.draft, version: served.draft.version + 1 };
      return json(route, {
        version: served.draft.version,
        entries: served.draft.entries,
        cards: {},
        validation: {},
        updated_at: "2026-11-15T10:00:00Z",
      });
    },
  );
  await page.route(new RegExp(`/api/v1/decks/${DECK}/performance$`), (route) =>
    json(route, {
      deck_id: DECK,
      record: record(16, 9, 6),
      splits: [
        split({}, 12, 7, 4),
        split(
          { mode: "table", opposition: "players", bot_skill: null },
          4,
          2,
          2,
        ),
      ],
      versions: [
        {
          number: 2,
          title: "Mono-Red Burn",
          created_at: "2026-11-02T10:00:00Z",
          record: record(4, 3, 1),
          splits: [split({}, 4, 3, 1)],
        },
        {
          number: 1,
          title: "Mono-Red Burn",
          created_at: "2026-11-01T10:00:00Z",
          record: record(12, 6, 5),
          splits: [split({}, 12, 6, 5)],
        },
      ],
    }),
  );
  await page.route(new RegExp(`/api/v1/decks/${DECK}/missing$`), (route) =>
    json(route, lacks()),
  );
  await page.route(new RegExp(`/api/v1/decks/${DECK}/substitutions`), (route) =>
    json(route, {
      deck_id: DECK,
      card: card("bolt", "Lightning Bolt"),
      substitutes: [
        {
          card: card("shock", "Shock"),
          spare: 5,
          score: 72,
          reasons: ["Also an instant", "Costs one mana, as it does"],
        },
      ],
      note: null,
    }),
  );
  await page.route(new RegExp(`/api/v1/decks/${DECK}/draft$`), (route) => {
    const body = route.request().postDataJSON() as Served["draft"];
    served.drafts.push(body);
    served.draft = { version: body.version + 1, entries: body.entries };
    return json(route, {
      ...served.draft,
      cards: {},
      validation: {},
      updated_at: "2026-11-15T10:00:00Z",
    });
  });
  await page.route(/\/api\/v1\/me\/wishlist(\/[^/]+)?$/, (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { quantity: number };
      served.wishes.push(body);
      served.wished = body.quantity;
    }
    if (request.method() === "DELETE") served.wished = 0;
    return json(route, wishlist());
  });
  return served;
}

/** Nothing of the page is wider than the window. */
async function fits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("a deck's Workshop: versions compared and restored, results by version, a substitute swapped in and undone", async ({
  page,
}) => {
  const served = await player(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/#deck/${DECK}/workshop`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Mono-Red Burn" }),
  ).toBeVisible();

  // Versions: the newest against the draft first; then an older one, card by card.
  await expect(
    page.getByText(/From version 2 to the draft: The two hold the same cards/),
  ).toBeVisible();
  await page.getByLabel("From").selectOption("1");
  const compared = page.getByRole("table", {
    name: "Version 1 compared with The draft",
  });
  await expect(compared.getByRole("row")).toHaveText([
    "CardVersion 1The draftChange",
    "Main deck",
    "Lightning Bolt41−3 removed",
    "Sideboard",
    "Pyroblast–1+1 added",
  ]);

  // Restoring asks first: Escape keeps the draft, and nothing is sent.
  await page
    .getByRole("button", { name: "Restore version 1 into the draft" })
    .click();
  const restore = page.getByRole("dialog", {
    name: "Restore version 1 into the draft?",
  });
  await expect(restore.getByRole("listitem")).toHaveText([
    "No saved version is rewritten.",
    "Every game keeps the version it played, and its result.",
    "The draft as it is now is replaced.",
  ]);
  await expect(
    restore.getByRole("button", { name: "Keep the draft" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(restore).toBeHidden();
  expect(served.restored).toEqual([]);
  await page
    .getByRole("button", { name: "Restore version 1 into the draft" })
    .click();
  await restore.getByRole("button", { name: "Restore version 1" }).click();
  await expect(
    page.getByText(
      "Version 1 is the draft now. No saved version and no game's record changed.",
    ),
  ).toBeVisible();
  expect(served.restored).toEqual([{ version: 7 }]);

  // Results: in all, by the version played, and told apart; a short record is marked.
  await page.getByRole("tab", { name: "Results" }).click();
  await expect(page.getByRole("region", { name: "In all" })).toContainText(
    "9 won, 6 lost, 1 drawn",
  );
  await expect(
    page.getByRole("table", { name: "By the version played" }).getByRole("row"),
  ).toHaveText([
    "VersionSavedGamesRecordWin rate",
    /^Version 2Nov 2, 20264 few games3 won, 1 lost75%$/,
    /^Version 1Nov 1, 2026126 won, 5 lost, 1 drawn50%$/,
  ]);
  await page.getByLabel("Games of").selectOption("2");
  await expect(
    page.getByRole("table", { name: "Told apart" }).getByRole("row"),
  ).toHaveCount(2);

  // Missing cards: a wish for the copies missing, then a substitute the library holds.
  await page.getByRole("tab", { name: "Missing cards" }).click();
  await expect(
    page.getByText("The draft lacks 3 copies across 1 card."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Wish for 3 × Lightning Bolt" })
    .click();
  await expect(page.getByText("On your wishlist (3).")).toBeVisible();
  expect(served.wishes).toEqual([{ quantity: 3, deck_id: DECK }]);
  await page
    .getByRole("button", { name: "Substitutes you own for Lightning Bolt" })
    .click();
  const offered = page.getByRole("list", {
    name: "Substitutes for Lightning Bolt",
  });
  await expect(offered).toContainText("5 to spare · alike 72 of 100");
  await expect(offered).toContainText("Also an instant");
  await offered
    .getByRole("button", {
      name: "Swap 3 × Lightning Bolt for Shock in the draft",
    })
    .click();
  await expect(
    page.getByText(
      /Swapped 3 × Lightning Bolt for Shock in the draft\. No saved version changed\./,
    ),
  ).toBeVisible();
  // Sent with the version the restore left, and only the missing copies gave way.
  expect(served.drafts).toEqual([
    {
      version: 8,
      entries: [
        { card_id: "bolt", location: "main", quantity: 1 },
        { card_id: "mountain", location: "main", quantity: 56 },
        { card_id: "shock", location: "main", quantity: 3 },
      ],
    },
  ]);
  await expect(
    page.getByText(/Your library holds every card of this deck's draft/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo the swap" }).click();
  await expect(
    page.getByText("The swap is undone: the draft is as it was."),
  ).toBeVisible();
  expect(served.drafts[1]).toEqual({ version: 9, entries: ENTRIES });
  await expect(
    page.getByText("The draft lacks 3 copies across 1 card."),
  ).toBeVisible();

  // The wish is on the account's wishlist, a view of Cards, with the deck it is for.
  await page.goto("/#cards");
  await page.getByRole("tab", { name: "Wishlist" }).click();
  const wished = page.getByRole("table", { name: "Your wishlist" });
  await expect(
    wished.getByRole("row", { name: /Lightning Bolt/ }),
  ).toContainText("Mono-Red Burn");
  await expect(
    wished.getByRole("link", { name: "Mono-Red Burn" }),
  ).toHaveAttribute("href", `#deck/${DECK}/workshop`);
  expect(errors).toEqual([]);
});

test("on a phone the shelves, the organizer and the Workshop fit, and are walked by keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const served = await player(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#decks");
  const shelves = page.getByRole("search", { name: "Find a deck" });
  await expect(shelves.getByLabel("Folder")).toBeVisible();
  const burn = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: "Mono-Red Burn" }) });
  await expect(burn).toContainText("In Tournament");
  await fits(page);

  // The list narrows as the filters are set.
  await shelves.getByRole("checkbox", { name: /^budget/ }).check();
  await expect(page.getByText("1 of 2 decks")).toBeVisible();
  await page.getByRole("button", { name: "Show every deck" }).click();
  await expect(page.getByText("2 decks", { exact: true })).toBeVisible();

  // The organizer, by keyboard: tick with Space, type, and Enter sends the form.
  await page.getByRole("button", { name: "Organize decks" }).click();
  await page.getByRole("checkbox", { name: "Organize Elves" }).focus();
  await page.keyboard.press("Space");
  const organizer = page.getByRole("region", { name: "Organize 1 deck" });
  await organizer.getByLabel("Move to a folder").fill("Tribal");
  await expect(organizer.getByRole("status")).toContainText(
    "This changes 1 deck, all of them or none:",
  );
  await fits(page);
  await page.keyboard.press("Enter");
  await expect(page.getByText("1 deck organized.")).toBeVisible();
  expect(served.organized).toEqual([
    {
      deck_ids: [OTHER],
      folder: "Tribal",
      unfile: false,
      add_tags: [],
      remove_tags: [],
    },
  ]);
  await expect(
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: "Elves" }) }),
  ).toContainText("In Tribal");

  // The Workshop, each part within the window.
  await burn.getByRole("link", { name: "Workshop" }).click();
  await expect(page).toHaveURL(new RegExp(`#deck/${DECK}/workshop$`));
  await page.getByLabel("From").selectOption("1");
  await expect(page.getByText("−3 removed")).toBeVisible();
  await fits(page);
  // The tabs are reached and chosen by keyboard.
  await page.getByRole("tab", { name: "Results" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("table", { name: "By the version played" }),
  ).toBeVisible();
  await fits(page);
  await page.getByRole("tab", { name: "Missing cards" }).click();
  await page
    .getByRole("button", { name: "Substitutes you own for Lightning Bolt" })
    .click();
  await expect(
    page.getByRole("list", { name: "Substitutes for Lightning Bolt" }),
  ).toBeVisible();
  await fits(page);
  expect(errors).toEqual([]);
});
