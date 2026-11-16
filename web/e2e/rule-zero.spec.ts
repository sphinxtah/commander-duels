import { test, expect, type Page, type Route } from "@playwright/test";
import { standIn } from "./accounts";

// Rule Zero at the table (v1.0.0, docs/tables.md): a table says what it is for, in two parts
// that are never mistaken for each other. A host opens a table from a preset and saves it; the
// lobby finds tables by what their hosts describe; the host changes the table; a seated player
// reads the change before getting ready again, on a phone and by keyboard. A stand-in account
// whose tables the journey answers itself, so it needs neither SysOp nor the engine: what the
// pages send is checked by their requests. The same, against the real API and a real game, is
// in tables.spec.ts.

const CODE = "RuleZero-code_01";
const DECK = "00000000-0000-4000-8000-0000000000d1";
const CASUAL = { banned: true, not_legal: true, stand_in: true };

type Profile = {
  version: 1;
  intent: string;
  pace: string | null;
  duration: number | null;
  note: string;
  enforced: {
    custom_cards: boolean;
    reserved_list: boolean;
    game_changers: number | null;
  };
};

const INTENTS: Record<string, string> = {
  learning: "Learning game",
  precon: "Preconstructed decks",
  upgraded: "Upgraded casual",
  high_power: "High power",
  competitive: "Competitive",
  custom: "Custom",
};
const PACES: Record<string, string> = {
  relaxed: "Relaxed: time to ask and take back",
  steady: "Steady",
  brisk: "Brisk: short turns",
};

/** A profile as the API shows it: its words, and every rule checked on a deck. */
function shown(profile: Profile | null) {
  if (!profile) return null;
  const rules = [];
  if (!profile.enforced.custom_cards)
    rules.push({ code: "custom_cards", text: "No custom cards" });
  if (!profile.enforced.reserved_list)
    rules.push({ code: "reserved_list", text: "No Reserved List cards" });
  const most = profile.enforced.game_changers;
  if (most !== null)
    rules.push({
      code: "game_changers",
      text:
        most === 0
          ? "No Game Changers"
          : `At most ${most} Game Changers a deck`,
    });
  return {
    ...profile,
    intent_name: INTENTS[profile.intent],
    pace_name: profile.pace ? PACES[profile.pace] : null,
    enforced_rules: rules,
  };
}

function profile(fields: Partial<Profile> = {}): Profile {
  return {
    version: 1,
    intent: "upgraded",
    pace: "steady",
    duration: 90,
    note: "",
    enforced: { custom_cards: true, reserved_list: true, game_changers: 3 },
    ...fields,
  };
}

const BUILT_IN: Profile[] = [
  profile({
    intent: "learning",
    pace: "relaxed",
    duration: 120,
    note: "A learning game: questions are welcome, and a mistake may be taken back.",
    enforced: { custom_cards: true, reserved_list: true, game_changers: 0 },
  }),
  profile({
    intent: "precon",
    enforced: { custom_cards: true, reserved_list: true, game_changers: 0 },
  }),
  profile(),
  profile({
    intent: "high_power",
    duration: 60,
    enforced: { custom_cards: true, reserved_list: true, game_changers: null },
  }),
  profile({
    intent: "competitive",
    pace: "brisk",
    duration: 60,
    enforced: { custom_cards: true, reserved_list: true, game_changers: null },
  }),
  profile({
    intent: "custom",
    pace: null,
    duration: null,
    enforced: { custom_cards: true, reserved_list: true, game_changers: null },
  }),
];

type SeatShape = {
  seat: number;
  player: string;
  taken: boolean;
  handle: string | null;
  portrait: string | null;
  host: boolean;
  ready: boolean;
  you: boolean;
  deck: string | null;
  deck_id: string | null;
};

function seat(seat: number, fields: Partial<SeatShape> = {}): SeatShape {
  return {
    seat,
    player: "human",
    taken: false,
    handle: null,
    portrait: null,
    host: false,
    ready: false,
    you: false,
    deck: null,
    deck_id: null,
    ...fields,
  };
}

type TableShape = {
  code: string;
  format: string;
  visibility: string;
  status: string;
  seats: number;
  bots: number;
  bot_skill: number;
  turn_cap: number;
  rules: typeof CASUAL;
  best_of: number;
  host: string;
  players: SeatShape[];
  your_seat: number | null;
  can_start: boolean;
  game_id: string | null;
  created_at: string;
  open_seats: number;
  starter: boolean;
  profile: ReturnType<typeof shown>;
  profile_changed: boolean;
};

function table(fields: Partial<TableShape> = {}): TableShape {
  return {
    code: CODE,
    format: "commander",
    visibility: "public",
    status: "open",
    seats: 4,
    bots: 0,
    bot_skill: 4,
    turn_cap: 160,
    rules: CASUAL,
    best_of: 1,
    host: "bob",
    players: [
      seat(0, { taken: true, handle: "bob", host: true, ready: true }),
      seat(1),
      seat(2),
      seat(3),
    ],
    your_seat: null,
    can_start: false,
    game_id: null,
    created_at: new Date().toISOString(),
    open_seats: 3,
    starter: false,
    profile: null,
    profile_changed: false,
    ...fields,
  };
}

/** What the journey's tables hold, and what the pages sent. */
type Served = {
  /** The stand-in's own table, as its page is answered. */
  table: TableShape | null;
  lobby: TableShape[];
  saved: { id: string; name: string; profile: Profile; settings: unknown }[];
  browsed: URLSearchParams[];
  opened: Record<string, unknown>[];
  changed: Record<string, unknown>[];
  seated: Record<string, unknown>[];
  presetsSaved: Record<string, unknown>[];
};

/** A player who may sit at tables, with the tables' requests answered here. */
async function player(page: Page): Promise<Served> {
  await standIn(page, {
    handle: "pat",
    permissions: ["profile.edit", "games.play", "decks.edit"],
  });
  const served: Served = {
    table: null,
    lobby: [],
    saved: [],
    browsed: [],
    opened: [],
    changed: [],
    seated: [],
    presetsSaved: [],
  };
  const presets = () => ({
    built_in: BUILT_IN.map((built) => ({
      id: null,
      name: INTENTS[built.intent],
      built_in: true,
      profile: shown(built),
      settings: {},
    })),
    saved: served.saved.map((kept) => ({
      ...kept,
      built_in: false,
      profile: shown(kept.profile),
    })),
    limit: 20,
    paces: [],
  });
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, json: body });
  await page.route("**/api/v1/rollout", (route) =>
    json(route, { workflows: [] }),
  );
  await page.route(/\/api\/v1\/decks(\?|$)/, (route) =>
    json(route, [
      {
        id: DECK,
        title: "Skyward Patrol",
        format: "commander",
        visibility: "private",
        card_count: 100,
        legal: true,
        playable: true,
        collection_locked: false,
        needs: [],
        identity: "WU",
        commanders: [],
        latest_revision: null,
        source: "starter",
        archived: false,
        deleted_at: null,
        updated_at: "2026-11-14T10:00:00Z",
        removed_cards: [],
      },
    ]),
  );
  await page.route(/\/api\/v1\/friends$/, (route) =>
    json(route, { friends: [], incoming: [], outgoing: [], waiting: [] }),
  );
  await page.route(/\/api\/v1\/me\/table-presets(\/[^/]+)?$/, (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as {
        name: string;
        profile: Profile;
        settings: unknown;
      };
      served.presetsSaved.push(body);
      served.saved = [
        ...served.saved.filter(
          (kept) => kept.name.toLowerCase() !== body.name.toLowerCase(),
        ),
        { id: "00000000-0000-4000-8000-00000000a001", ...body },
      ];
    }
    if (request.method() === "DELETE") served.saved = [];
    return json(route, presets());
  });
  await page.route(/\/api\/v1\/tables\/browse/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    served.browsed.push(query);
    const intents = query.getAll("intent");
    const tables = served.lobby.filter(
      (found) =>
        intents.length === 0 ||
        intents.includes(
          (found.profile as { intent?: string } | null)?.intent ?? "",
        ),
    );
    return json(route, {
      tables,
      total: tables.length,
      page: 1,
      per_page: 20,
      yours: served.table,
    });
  });
  await page.route(/\/api\/v1\/tables$/, (route) => {
    if (route.request().method() !== "POST") return json(route, []);
    const body = route.request().postDataJSON() as Record<string, unknown>;
    served.opened.push(body);
    served.table = table({
      host: "pat",
      seats: body.seats as number,
      visibility: body.visibility as string,
      profile: shown((body.profile as Profile | undefined) ?? null),
      players: [
        seat(0, {
          taken: true,
          handle: "pat",
          host: true,
          ready: true,
          you: true,
          deck: "Skyward Patrol",
          deck_id: DECK,
        }),
        seat(1),
        seat(2),
        seat(3),
      ],
      your_seat: 0,
    });
    return json(route, served.table, 201);
  });
  await page.route(new RegExp(`/api/v1/tables/${CODE}$`), (route) => {
    if (!served.table)
      return json(route, { code: "not_found", message: "No such table." }, 404);
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        profile?: Profile | null;
      };
      served.changed.push(body);
      served.table = { ...served.table, profile: shown(body.profile ?? null) };
    }
    return json(route, served.table);
  });
  await page.route(new RegExp(`/api/v1/tables/${CODE}/seat$`), (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    served.seated.push(body);
    const ready = body.ready;
    if (served.table && typeof ready === "boolean")
      served.table = {
        ...served.table,
        profile_changed: ready ? false : served.table.profile_changed,
        players: served.table.players.map((found) =>
          found.you ? { ...found, ready } : found,
        ),
      };
    return json(route, served.table);
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

/** The edge an element is drawn with on its left: how a part is marked beside its words. */
function leftEdge(page: Page, text: string) {
  return page
    .getByText(text, { exact: false })
    .first()
    .evaluate((found) => {
      const line = found.closest("p") ?? found;
      return getComputedStyle(line).borderLeftStyle;
    });
}

test("a table is opened from a preset, found by what it describes, and changed by its host", async ({
  page,
}) => {
  const served = await player(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  served.lobby = [
    table({
      profile: shown(profile({ note: "Bring something fun." })),
    }),
    table({ code: "Plain-table-code1", host: "cara" }),
  ];
  await page.goto("/#tables");
  const lobby = page.getByRole("region", { name: "Find a game", exact: true });
  const cards = lobby.getByRole("listitem");
  await expect(cards).toHaveCount(2);
  // A card keeps what the host describes apart from what is checked on every deck: each line
  // under its own words, and drawn with its own edge.
  const described = cards.filter({ hasText: "Hosted by bob" });
  await expect(described).toContainText(
    "Host describes: Upgraded casual · Steady · about 90 minutes",
  );
  await expect(described).toContainText("Bring something fun.");
  await expect(described).toContainText(
    "Checked on every deck: At most 3 Game Changers a deck",
  );
  expect(await leftEdge(page, "Host describes:")).toBe("dashed");
  expect(await leftEdge(page, "Checked on every deck:")).toBe("solid");
  await expect(cards.filter({ hasText: "Hosted by cara" })).not.toContainText(
    "Host describes",
  );

  // On a wide screen the filters by description stand beside the others, unfolded.
  const filters = page.getByRole("group", { name: "Filters" });
  await expect(
    filters.getByRole("button", { name: /Kind of game, pace and length/ }),
  ).toBeHidden();
  await filters.getByRole("checkbox", { name: "Upgraded casual" }).check();
  await expect(cards).toHaveCount(1);
  await expect(
    page.getByText(
      "Only tables whose host describes them this way are listed.",
    ),
  ).toBeVisible();
  expect(served.browsed.at(-1)!.getAll("intent")).toEqual(["upgraded"]);
  await filters.getByLabel("Expected length").selectOption("90");
  await expect
    .poll(() => served.browsed.at(-1)!.get("max_duration"))
    .toBe("90");
  await filters.getByRole("checkbox", { name: "Upgraded casual" }).uncheck();
  await filters.getByLabel("Expected length").selectOption("");

  // Opening a table from a preset: the two parts are two groups of the form.
  await page.getByRole("button", { name: "Open a table", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Open a table" });
  await form.getByRole("radio", { name: /^Commander/ }).check();
  await form
    .getByLabel("Start from")
    .selectOption({ label: "Upgraded casual" });
  const tells = form.getByRole("group", {
    name: /Described: what you tell the players/,
  });
  await expect(tells).toContainText(
    "Nothing checks this. Players agree to it by getting ready.",
  );
  await expect(tells.getByLabel("Kind of game")).toHaveValue("upgraded");
  await tells
    .getByLabel("A note in your own words")
    .fill("Bring something fun.");
  await expect(tells).toContainText("20 of 280 characters");
  const checks = form.getByRole("group", {
    name: /Enforced: cards the server lets a deck hold/,
  });
  await expect(checks.getByLabel("Game Changers a deck may hold")).toHaveValue(
    "3",
  );
  await checks.getByRole("checkbox", { name: /Reserved List cards/ }).uncheck();

  // Saved under a name, to open the same table again.
  await form
    .getByLabel(/Save this table to open it again/)
    .fill("Friday night");
  await form.getByRole("button", { name: "Save the table" }).click();
  await expect(form.getByText("Saved as Friday night.")).toBeVisible();
  await expect(form.getByLabel("Start from")).toHaveValue(
    "saved:00000000-0000-4000-8000-00000000a001",
  );
  expect(served.presetsSaved).toHaveLength(1);
  expect(served.presetsSaved[0]).toMatchObject({
    name: "Friday night",
    profile: { intent: "upgraded", note: "Bring something fun." },
    settings: { format: "commander", seats: 4, visibility: "public" },
  });

  await form.getByRole("button", { name: "Open the table" }).click();
  await expect(page).toHaveURL(new RegExp(`#tables/${CODE}$`));
  expect(served.opened).toHaveLength(1);
  expect(served.opened[0]).toMatchObject({
    format: "commander",
    deck_id: DECK,
    profile: {
      version: 1,
      intent: "upgraded",
      pace: "steady",
      duration: 90,
      note: "Bring something fun.",
      enforced: { custom_cards: true, reserved_list: false, game_changers: 3 },
    },
  });

  // The table's own page: what it is for, each part under its name.
  const panel = page.getByRole("region", { name: "What this table is for" });
  await expect(
    panel.getByRole("heading", { name: /Described by the host/ }),
  ).toBeVisible();
  await expect(panel).toContainText("Kind of gameUpgraded casual");
  await expect(panel).toContainText("“Bring something fun.”");
  await expect(
    panel.getByRole("list", { name: "Checked on every deck" }),
  ).toHaveText("No Reserved List cardsAt most 3 Game Changers a deck");

  // The host changes what the table is for: said to change every player's readiness.
  const host = page.getByRole("region", {
    name: "Change what the table is for",
  });
  await expect(host).toContainText("makes every player not ready again");
  await host.getByRole("button", { name: "Change it" }).click();
  await expect(
    host.getByRole("button", { name: "Change the table" }),
  ).toBeDisabled();
  await host.getByLabel("Kind of game").selectOption({ label: "High power" });
  await host.getByRole("button", { name: "Change the table" }).click();
  await expect(panel).toContainText("Kind of gameHigh power");
  expect(served.changed).toEqual([
    {
      profile: {
        version: 1,
        intent: "high_power",
        pace: "steady",
        duration: 90,
        note: "Bring something fun.",
        enforced: {
          custom_cards: true,
          reserved_list: false,
          game_changers: 3,
        },
      },
    },
  ]);
  // The form closed with the change.
  await expect(host.getByRole("button", { name: "Change it" })).toBeVisible();
  await fits(page);
  expect(errors).toEqual([]);
});

test("on a phone a seated player reads the host's change and gets ready by keyboard", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const served = await player(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const seats = (ready: boolean) => [
    seat(0, { taken: true, handle: "bob", host: true, ready: true }),
    seat(1, {
      taken: true,
      handle: "pat",
      you: true,
      ready,
      deck: "Skyward Patrol",
      deck_id: DECK,
    }),
    seat(2),
    seat(3),
  ];
  served.lobby = [table({ profile: shown(profile()) })];

  // The lobby on a phone: the filters by description are folded behind one button.
  await page.goto("/#tables");
  const filters = page.getByRole("group", { name: "Filters" });
  const more = filters.getByRole("button", {
    name: /Kind of game, pace and length/,
  });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(
    filters.getByRole("checkbox", { name: "Upgraded casual" }),
  ).toBeHidden();
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await filters.getByRole("checkbox", { name: "Upgraded casual" }).check();
  await expect(more).toHaveText(/1 chosen/);
  await expect(
    page
      .getByRole("region", { name: "Find a game", exact: true })
      .getByRole("listitem"),
  ).toContainText("Host describes: Upgraded casual");
  await fits(page);

  // Seated at the table as it was described: ready by the plain button.
  served.table = table({
    profile: shown(profile()),
    players: seats(false),
    your_seat: 1,
  });
  await page.goto(`/#tables/${CODE}`);
  const panel = page.getByRole("region", { name: "What this table is for" });
  await expect(panel).toContainText("Kind of gameUpgraded casual");
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect(page.getByRole("button", { name: "Not ready" })).toBeVisible();
  expect(served.seated).toEqual([{ ready: true }]);
  await fits(page);

  // The host changes the table under them: not ready again, and a change to read.
  served.table = table({
    profile: shown(
      profile({
        intent: "high_power",
        note: "Bring your best.",
        enforced: {
          custom_cards: true,
          reserved_list: false,
          game_changers: 3,
        },
      }),
    ),
    players: seats(false),
    your_seat: 1,
    profile_changed: true,
  });
  const notice = page.getByRole("status", {
    name: "The host changed what this table is for",
  });
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice.getByRole("listitem")).toHaveText([
    "Kind of game: High power (was Upgraded casual)",
    "The host's note: “Bring your best.” (not said before)",
    "Now checked: No Reserved List cards",
  ]);
  // Each difference under its own part's name.
  await expect(
    notice.getByRole("heading", { name: /Described by the host/ }),
  ).toBeVisible();
  await expect(
    notice.getByRole("heading", { name: /Checked on every deck/ }),
  ).toBeVisible();
  // Getting ready is the acknowledgement's own button; the plain one is not offered.
  await expect(
    page.getByRole("button", { name: "Ready", exact: true }),
  ).toHaveCount(0);
  await fits(page);
  await page.screenshot({
    path: testInfo.outputPath("changed-390.jpg"),
    type: "jpeg",
    quality: 70,
    fullPage: true,
  });

  // By keyboard alone: the button takes focus, shows it, and Enter is the acknowledgement.
  const acknowledge = notice.getByRole("button", {
    name: "I have read it: ready",
  });
  await acknowledge.focus();
  await expect(acknowledge).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(notice).toHaveCount(0);
  expect(served.seated.at(-1)).toEqual({
    ready: true,
    acknowledge_profile: true,
  });
  await expect(page.getByRole("button", { name: "Not ready" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(errors).toEqual([]);
});
