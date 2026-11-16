import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { mockApi, openDialogs, reply } from "../decks/fixtures";
import { keepRead, keptRead, type Presets, type ProfileView } from "./profile";
import type { OwnDeck, TablePlayer, TableView } from "./tables";
import { TablesPage } from "./TablesPage";

// Rule Zero at the table (v1.0.0, docs/tables.md): the screens over a table's profile. Opening a
// table from a preset and saving one; finding tables by what their hosts describe; a profile's
// two parts told apart on a card and on the table's page; the host's change; and the change a
// seated player reads before getting ready again.

vi.mock("../queues/FindGame", () => ({
  FindGame: () => <section aria-label="Queue" />,
}));

const ada = {
  id: "00000000-0000-4000-8000-0000000000a1",
  kind: "player",
  status: "active",
  onboarding: "complete",
  tutorial: { path: null, stage: "done", skipped: false },
  handle: "ada",
  display_name: "Ada",
  email: null,
  avatar: "sigil",
  locale: "en",
  csrf_token: "token",
  permissions: ["games.play", "decks.edit", "profile.edit"],
  roles: ["player"],
  preferences: { large_text: false, reduced_motion: false },
} as unknown as Me;

const CODE = "Tb1e-code_123456";
const CASUAL = { banned: true, not_legal: true, stand_in: true };

function deck(fields: Partial<OwnDeck> = {}): OwnDeck {
  return {
    id: "deck-1",
    title: "Red deck",
    format: "legacy",
    visibility: "private",
    card_count: 60,
    legal: true,
    playable: true,
    collection_locked: false,
    needs: [],
    identity: "R",
    commanders: [],
    latest_revision: null,
    source: "import",
    archived: false,
    deleted_at: null,
    updated_at: "2026-10-21T10:00:00Z",
    removed_cards: [],
    ...fields,
  } as OwnDeck;
}

function seat(fields: Partial<TablePlayer> & { seat: number }): TablePlayer {
  return {
    player: "human",
    taken: false,
    handle: null,
    portrait: null,
    host: false,
    ready: false,
    you: false,
    deck: null,
    deck_id: null,
    borrowed: false,
    ...fields,
  };
}

function table(fields: Partial<TableView> = {}): TableView {
  return {
    code: CODE,
    format: "legacy",
    visibility: "public",
    status: "open",
    seats: 2,
    bots: 0,
    bot_skill: 4,
    turn_cap: 60,
    rules: CASUAL,
    best_of: 1,
    host: "bob",
    players: [
      seat({ seat: 0, taken: true, handle: "bob", host: true, ready: true }),
      seat({ seat: 1 }),
    ],
    your_seat: null,
    can_start: false,
    game_id: null,
    created_at: "2026-10-21T10:00:00Z",
    open_seats: 1,
    starter: false,
    profile_changed: false,
    ...fields,
  };
}

function profile(fields: Partial<ProfileView> = {}): ProfileView {
  return {
    version: 1,
    intent: "upgraded",
    pace: "steady",
    duration: 90,
    note: "",
    enforced: { custom_cards: true, reserved_list: true, game_changers: 3 },
    intent_name: "Upgraded casual",
    pace_name: "Steady",
    enforced_rules: [
      { code: "game_changers", text: "At most 3 Game Changers a deck" },
    ],
    ...fields,
  };
}

const highPower = profile({
  intent: "high_power",
  intent_name: "High power",
  duration: 60,
  enforced: { custom_cards: true, reserved_list: false, game_changers: null },
  enforced_rules: [{ code: "reserved_list", text: "No Reserved List cards" }],
});
const learning = profile({
  intent: "learning",
  intent_name: "Learning game",
  pace: "relaxed",
  pace_name: "Relaxed: time to ask and take back",
  duration: 120,
  note: "A learning game: questions are welcome, and a mistake may be taken back.",
  enforced: { custom_cards: true, reserved_list: true, game_changers: 0 },
  enforced_rules: [{ code: "game_changers", text: "No Game Changers" }],
});

function presets(saved: Presets["saved"] = []): Presets {
  const builtIn = (shown: ProfileView) => ({
    id: null,
    name: shown.intent_name,
    built_in: true,
    profile: shown,
    settings: {},
  });
  return {
    built_in: [
      builtIn(learning),
      builtIn(profile()),
      builtIn({
        ...highPower,
        enforced: {
          custom_cards: true,
          reserved_list: true,
          game_changers: null,
        },
        enforced_rules: [],
      }),
    ],
    saved,
    limit: 20,
    paces: [],
  };
}

const friday = {
  id: "p1",
  name: "Friday night",
  built_in: false,
  profile: highPower,
  settings: {
    format: "commander" as const,
    seats: 4,
    bots: 1,
    bot_skill: 5,
    visibility: "private" as const,
    rules: { banned: false, not_legal: false, stand_in: false },
    best_of: 1 as const,
  },
};

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function serveLobby(api: ReturnType<typeof mockApi>, tables: TableView[]) {
  api.on("GET /api/v1/tables/browse", () =>
    reply(200, {
      tables,
      total: tables.length,
      page: 1,
      per_page: 20,
      yours: tables.find((found) => found.your_seat !== null) ?? null,
    }),
  );
  api.on("GET /api/v1/friends", () =>
    reply(200, { friends: [], incoming: [], outgoing: [], waiting: [] }),
  );
  api.on("GET /api/v1/decks", () =>
    reply(200, [
      deck(),
      deck({ id: "deck-2", title: "Elves", format: "commander" }),
    ]),
  );
}

async function openForm() {
  await act(async () =>
    screen.getByRole("button", { name: "Open a table" }).click(),
  );
  await settle();
  return within(screen.getByRole("dialog", { name: "Open a table" }));
}

function choose(select: HTMLElement, value: string) {
  fireEvent.change(select, { target: { value } });
}

/** The body of the last request the page sent to a route. */
function sent(api: ReturnType<typeof mockApi>, route: string) {
  return api.calls.filter((call) => call.route === route).at(-1)?.options as {
    body?: Record<string, unknown>;
    params?: { query?: Record<string, unknown>; path?: unknown };
  };
}

beforeEach(() => {
  openDialogs();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("opening a table that says what it is for", () => {
  it("opens with no profile unless the host starts from one", async () => {
    const api = mockApi();
    serveLobby(api, []);
    api.on("GET /api/v1/me/table-presets", () => reply(200, presets()));
    api.on("POST /api/v1/tables", () => reply(201, table({ your_seat: 0 })));
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const form = await openForm();
    expect(form.getByLabelText("Start from")).toHaveValue("");
    // No description: nothing of a profile is asked.
    expect(form.queryByLabelText("Kind of game")).toBeNull();
    await act(async () =>
      form.getByRole("button", { name: "Open the table" }).click(),
    );
    await settle();
    expect(sent(api, "POST /api/v1/tables").body).not.toHaveProperty("profile");
  });

  it("starts from a built-in preset and sends what the host made of it", async () => {
    const api = mockApi();
    serveLobby(api, []);
    api.on("GET /api/v1/me/table-presets", () => reply(200, presets()));
    api.on("POST /api/v1/tables", () => reply(201, table({ your_seat: 0 })));
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const form = await openForm();
    const start = form.getByLabelText("Start from");
    expect(
      within(start)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "No description: any deck the table's rules take",
      "Learning game",
      "Upgraded casual",
      "High power",
    ]);
    choose(start, "built:upgraded");

    // The two parts are two groups, each saying who holds the players to it.
    const described = within(
      form.getByRole("group", { name: /Described: what you tell the players/ }),
    );
    expect(
      described.getByText(
        "Nothing checks this. Players agree to it by getting ready.",
      ),
    ).toBeInTheDocument();
    expect(described.getByLabelText("Kind of game")).toHaveValue("upgraded");
    expect(described.getByLabelText("Pace")).toHaveValue("steady");
    expect(described.getByLabelText("Expected length")).toHaveValue("90");
    const enforced = within(
      form.getByRole("group", {
        name: /Enforced: cards the server lets a deck hold/,
      }),
    );
    expect(
      enforced.getByLabelText("Game Changers a deck may hold"),
    ).toHaveValue("3");
    expect(
      enforced.getByRole("checkbox", { name: /Reserved List cards/ }),
    ).toBeChecked();

    fireEvent.change(described.getByLabelText("A note in your own words"), {
      target: { value: "Bring something fun." },
    });
    choose(described.getByLabelText("Pace"), "");
    await act(async () =>
      enforced.getByRole("checkbox", { name: /Reserved List cards/ }).click(),
    );
    await act(async () =>
      form.getByRole("button", { name: "Open the table" }).click(),
    );
    await settle();
    expect(sent(api, "POST /api/v1/tables").body).toMatchObject({
      format: "legacy",
      profile: {
        version: 1,
        intent: "upgraded",
        pace: null,
        duration: 90,
        note: "Bring something fun.",
        enforced: {
          custom_cards: true,
          reserved_list: false,
          game_changers: 3,
        },
      },
    });
    expect(window.location.hash).toBe(`#tables/${CODE}`);
  });

  it("saves a table to open again, starts from it with its settings, and removes it", async () => {
    const api = mockApi();
    serveLobby(api, []);
    api.on("GET /api/v1/me/table-presets", () => reply(200, presets()));
    api.on("PUT /api/v1/me/table-presets", () => reply(200, presets([friday])));
    api.on("DELETE /api/v1/me/table-presets/{preset_id}", () =>
      reply(200, presets()),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const form = await openForm();
    const start = form.getByLabelText("Start from");
    choose(start, "built:high_power");
    const name = form.getByLabelText(/Save this table to open it again/);
    expect(form.getByRole("button", { name: "Save the table" })).toBeDisabled();
    fireEvent.change(name, { target: { value: " Friday night " } });
    await act(async () =>
      form.getByRole("button", { name: "Save the table" }).click(),
    );
    await settle();
    // The profile as the form holds it, with the table's other settings.
    expect(sent(api, "PUT /api/v1/me/table-presets").body).toEqual({
      name: "Friday night",
      profile: {
        version: 1,
        intent: "high_power",
        pace: "steady",
        duration: 60,
        note: "",
        enforced: {
          custom_cards: true,
          reserved_list: true,
          game_changers: null,
        },
      },
      settings: {
        format: "legacy",
        seats: 2,
        bots: 0,
        bot_skill: 4,
        visibility: "public",
        rules: CASUAL,
        best_of: 1,
      },
    });
    expect(form.getByRole("status")).toHaveTextContent(
      "Saved as Friday night.",
    );
    // The choice follows the saved table, which is listed with the account's own.
    expect(start).toHaveValue("saved:p1");
    expect(form.getByText("1 of 20 saved")).toBeInTheDocument();

    // Started from again, it brings its settings: the format, seats, bots, who may join, rules.
    choose(start, "");
    choose(start, "saved:p1");
    expect(form.getByRole("radio", { name: /^Commander/ })).toBeChecked();
    expect(form.getByLabelText("Seats")).toHaveValue("4");
    expect(form.getByLabelText("Bots")).toHaveValue("1");
    expect(form.getByLabelText("Who may join")).toHaveValue("private");
    expect(
      form.getByRole("checkbox", { name: /^Tournament rules/ }),
    ).toBeChecked();
    expect(form.getByLabelText("Kind of game")).toHaveValue("high_power");
    expect(
      form.getByRole("checkbox", { name: /Reserved List cards/ }),
    ).not.toBeChecked();
    // The form was drawn again from the saved table: its name is the one to save under.
    expect(form.getByLabelText(/Save this table to open it again/)).toHaveValue(
      "Friday night",
    );

    await act(async () =>
      form.getByRole("button", { name: "Remove Friday night" }).click(),
    );
    await settle();
    expect(
      sent(api, "DELETE /api/v1/me/table-presets/{preset_id}").params,
    ).toEqual({ path: { preset_id: "p1" } });
    expect(form.getByRole("status")).toHaveTextContent("Removed Friday night.");
    // The form keeps what it holds, started from its kind of game.
    expect(start).toHaveValue("built:high_power");
    expect(form.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("says why a table could not be saved", async () => {
    const api = mockApi();
    serveLobby(api, []);
    api.on("GET /api/v1/me/table-presets", () => reply(200, presets()));
    api.on("PUT /api/v1/me/table-presets", () =>
      reply(409, {
        code: "preset_limit",
        message:
          "An account saves at most 20 tables: remove one to save another.",
      }),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const form = await openForm();
    choose(form.getByLabelText("Start from"), "built:learning");
    const name = form.getByLabelText(/Save this table to open it again/);
    fireEvent.change(name, { target: { value: "One more" } });
    // Enter in the name saves the table; it does not open it.
    fireEvent.keyDown(name, { key: "Enter" });
    await settle();
    expect(form.getByRole("alert")).toHaveTextContent(
      "An account saves at most 20 tables",
    );
    expect(api.calls.some((call) => call.route === "POST /api/v1/tables")).toBe(
      false,
    );
  });
});

describe("the lobby, by what the hosts describe", () => {
  it("keeps what is described apart from what is checked on a table's card", async () => {
    const api = mockApi();
    serveLobby(api, [
      table({
        profile: profile({ note: "Bring something fun." }),
      }),
      table({
        code: "No-profile-code1",
        host: "cara",
        profile: profile({
          intent: "custom",
          intent_name: "Custom",
          pace: null,
          pace_name: null,
          duration: null,
          enforced_rules: [],
        }),
      }),
      table({ code: "Plain-table-code", host: "dan" }),
    ]);
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const [described, custom, plain] = within(
      screen.getByRole("region", { name: "Find a game" }),
    ).getAllByRole("listitem");
    expect(described).toHaveTextContent(
      "Host describes: Upgraded casual · Steady · about 90 minutes",
    );
    expect(described).toHaveTextContent("Bring something fun.");
    expect(described).toHaveTextContent(
      "Checked on every deck: At most 3 Game Changers a deck",
    );
    expect(custom).toHaveTextContent("Host describes: Custom");
    expect(custom).toHaveTextContent(
      "Checked on every deck: nothing beyond the format",
    );
    // A table that describes nothing says nothing of either.
    expect(plain).not.toHaveTextContent("Host describes");
    expect(plain).not.toHaveTextContent("Checked on every deck");
  });

  it("finds tables by kind of game, pace and length, and keeps the choice", async () => {
    const api = mockApi();
    serveLobby(api, [table({ profile: profile() })]);
    const view = render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const query = () => sent(api, "GET /api/v1/tables/browse").params!.query!;
    // Nothing asked: every table, described or not.
    expect(query()).not.toHaveProperty("intent");
    expect(query()).not.toHaveProperty("pace");
    expect(query()).not.toHaveProperty("max_duration");
    expect(screen.queryByText(/nothing checks it/)).toBeNull();

    const filters = within(screen.getByRole("group", { name: "Filters" }));
    // On a phone the three groups are folded behind this button.
    const more = filters.getByRole("button", {
      name: "Kind of game, pace and length",
    });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await act(async () => more.click());
    expect(more).toHaveAttribute("aria-expanded", "true");
    await act(async () =>
      filters.getByRole("checkbox", { name: "Upgraded casual" }).click(),
    );
    await act(async () =>
      filters.getByRole("checkbox", { name: "High power" }).click(),
    );
    await act(async () =>
      filters.getByRole("checkbox", { name: "Brisk" }).click(),
    );
    choose(filters.getByLabelText("Expected length"), "60");
    await settle();
    expect(query()).toMatchObject({
      intent: ["upgraded", "high_power"],
      pace: ["brisk"],
      max_duration: 60,
      page: 1,
    });
    expect(more).toHaveTextContent("Kind of game, pace and length · 4 chosen");
    // What a filter by description means is said: the host's word, which nothing checks.
    expect(
      screen.getByText(
        /Only tables whose host describes them this way are listed\. A description is the host's word: nothing checks it\./,
      ),
    ).toBeInTheDocument();

    // The browser keeps them: the lobby opens on them again, unfolded.
    view.unmount();
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("checkbox", { name: "Upgraded casual" }),
    ).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Brisk" })).toBeChecked();
    expect(screen.getByLabelText("Expected length")).toHaveValue("60");
    expect(
      screen.getByRole("button", { name: /Kind of game, pace and length/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(query()).toMatchObject({ intent: ["upgraded", "high_power"] });
  });
});

describe("a table's page", () => {
  /** The table as the server has it: each asking is answered with what stands then. */
  function servePage(api: ReturnType<typeof mockApi>, first: TableView) {
    const served = { table: first };
    api.on("GET /api/v1/tables/{code}", () => reply(200, served.table));
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    api.on("GET /api/v1/friends", () =>
      reply(200, { friends: [], incoming: [], outgoing: [], waiting: [] }),
    );
    return served;
  }
  const guest = (fields: Partial<TablePlayer> = {}) => [
    seat({ seat: 0, taken: true, handle: "bob", host: true, ready: true }),
    seat({
      seat: 1,
      taken: true,
      handle: "ada",
      you: true,
      deck: "Red deck",
      deck_id: "deck-1",
      ...fields,
    }),
  ];
  const hosting = [
    seat({
      seat: 0,
      taken: true,
      handle: "ada",
      host: true,
      ready: true,
      you: true,
      deck: "Red deck",
      deck_id: "deck-1",
    }),
    seat({ seat: 1 }),
  ];

  it("says what the table is for in two parts that cannot be mistaken for each other", async () => {
    const api = mockApi();
    servePage(
      api,
      table({ profile: profile({ note: "Bring something fun." }) }),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    const panel = within(
      screen.getByRole("region", { name: "What this table is for" }),
    );
    const described = panel
      .getByRole("heading", { name: /Described by the host/ })
      .closest("div")!;
    expect(described).toHaveTextContent(
      "Nothing checks this. Players agree to it by getting ready.",
    );
    expect(described).toHaveTextContent("Kind of gameUpgraded casual");
    expect(described).toHaveTextContent("PaceSteady");
    expect(described).toHaveTextContent("Expected lengthabout 90 minutes");
    expect(described).toHaveTextContent("“Bring something fun.”");
    const enforced = panel
      .getByRole("heading", { name: /Checked on every deck/ })
      .closest("div")!;
    expect(enforced).toHaveTextContent(
      "The server refuses a deck that breaks one of these",
    );
    expect(
      within(enforced as HTMLElement)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["At most 3 Game Changers a deck"]);
    // What is described is not in the checked part, nor the other way round.
    expect(enforced).not.toHaveTextContent("Upgraded casual");
    expect(described).not.toHaveTextContent("Game Changers");
  });

  it("says so where a described table checks nothing, and nothing where a table describes nothing", async () => {
    const api = mockApi();
    servePage(api, table({ profile: profile({ enforced_rules: [] }) }));
    const view = render(
      <TablesPage me={ada} heading={createRef()} code={CODE} />,
    );
    await settle();
    expect(
      screen.getByRole("region", { name: "What this table is for" }),
    ).toHaveTextContent("Nothing: any deck the format takes may sit down.");
    view.unmount();
    servePage(api, table());
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(
      screen.queryByRole("region", { name: "What this table is for" }),
    ).toBeNull();
    // Only the host is offered to describe it.
    expect(screen.queryByRole("button", { name: "Describe it" })).toBeNull();
  });

  it("lets the host describe the table, change it and take the description away", async () => {
    const api = mockApi();
    const plain = table({ host: "ada", your_seat: 0, players: hosting });
    const served = servePage(api, plain);
    api.on("GET /api/v1/me/table-presets", () => reply(200, presets()));
    api.on("PATCH /api/v1/tables/{code}", (options) => {
      const body = (options as { body: { profile: unknown } }).body;
      served.table = body.profile ? { ...plain, profile: learning } : plain;
      return reply(200, served.table);
    });
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    const host = () =>
      within(
        screen.getByRole("region", {
          name: /Describe this table|Change what the table is for/,
        }),
      );
    await act(async () =>
      host().getByRole("button", { name: "Describe it" }).click(),
    );
    await settle();
    // It starts as a description of the host's own, which a preset fills in.
    expect(host().getByLabelText("Kind of game")).toHaveValue("custom");
    choose(host().getByLabelText("Start from"), "built:learning");
    expect(host().getByLabelText("Kind of game")).toHaveValue("learning");
    expect(host().getByLabelText("Game Changers a deck may hold")).toHaveValue(
      "0",
    );
    await act(async () =>
      host().getByRole("button", { name: "Describe the table" }).click(),
    );
    await settle();
    expect(sent(api, "PATCH /api/v1/tables/{code}").body).toEqual({
      profile: {
        version: 1,
        intent: "learning",
        pace: "relaxed",
        duration: 120,
        note: learning.note,
        enforced: { custom_cards: true, reserved_list: true, game_changers: 0 },
      },
    });
    // The table took it: the form closes, and the page shows the profile.
    expect(
      screen.getByRole("region", { name: "What this table is for" }),
    ).toHaveTextContent("Learning game");
    expect(
      host().getByText(/makes every player not ready again/),
    ).toBeVisible();

    await act(async () =>
      host().getByRole("button", { name: "Change it" }).click(),
    );
    await settle();
    // Nothing to send while the form says what the table says.
    expect(
      host().getByRole("button", { name: "Change the table" }),
    ).toBeDisabled();
    await act(async () =>
      host().getByRole("button", { name: "Take the description away" }).click(),
    );
    await settle();
    expect(sent(api, "PATCH /api/v1/tables/{code}").body).toEqual({
      profile: null,
    });
    expect(
      screen.queryByRole("region", { name: "What this table is for" }),
    ).toBeNull();
  });

  it("offers no description to the host of a starter-deck table or the campaign's court", async () => {
    const api = mockApi();
    servePage(
      api,
      table({ host: "ada", your_seat: 0, players: hosting, starter: true }),
    );
    api.on("GET /api/v1/starter-tables/offers", () => reply(200, undefined));
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Describe it" })).toBeNull();
  });

  it("keeps what a seated player has read, and shows a change as what differs", async () => {
    const api = mockApi();
    const changed = table({
      your_seat: 1,
      players: guest(),
      profile: highPower,
      profile_changed: true,
    });
    const served = servePage(
      api,
      table({ your_seat: 1, players: guest(), profile: profile() }),
    );
    api.on("PATCH /api/v1/tables/{code}/seat", () => {
      served.table = {
        ...changed,
        profile_changed: false,
        players: guest({ ready: true }),
      };
      return reply(200, served.table);
    });
    const view = render(
      <TablesPage me={ada} heading={createRef()} code={CODE} />,
    );
    await settle();
    // Seated and nothing unread: the browser keeps the profile as read.
    expect(keptRead(CODE)).toEqual(profile());
    expect(
      screen.getByRole("button", { name: "Ready", pressed: false }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("status", {
        name: "The host changed what this table is for",
      }),
    ).toBeNull();

    // The host changes the table; the page's next asking finds it.
    view.unmount();
    served.table = changed;
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    const notice = within(
      screen.getByRole("status", {
        name: "The host changed what this table is for",
      }),
    );
    expect(
      notice.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      "Kind of game: High power (was Upgraded casual)",
      "Expected length: about 60 minutes (was about 90 minutes)",
      "No longer checked: At most 3 Game Changers a deck",
      "Now checked: No Reserved List cards",
    ]);
    // Each line under its own part.
    expect(
      notice.getByRole("heading", { name: /Described by the host/ }),
    ).toBeInTheDocument();
    expect(
      notice.getByRole("heading", { name: /Checked on every deck/ }),
    ).toBeInTheDocument();
    // What was read stays what was read until the player says they have read the change.
    expect(keptRead(CODE)).toEqual(profile());
    // Getting ready is the acknowledgement's own button: the plain one is not offered.
    expect(screen.queryByRole("button", { name: "Ready" })).toBeNull();
    await act(async () =>
      notice.getByRole("button", { name: "I have read it: ready" }).click(),
    );
    await settle();
    expect(sent(api, "PATCH /api/v1/tables/{code}/seat").body).toEqual({
      ready: true,
      acknowledge_profile: true,
    });
    expect(
      screen.queryByRole("status", {
        name: "The host changed what this table is for",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Not ready", pressed: true }),
    ).toBeInTheDocument();
    expect(keptRead(CODE)).toEqual(highPower);
  });

  it("shows a change whole where the browser kept nothing, and a description taken away", async () => {
    const api = mockApi();
    servePage(
      api,
      table({
        your_seat: 1,
        players: guest(),
        profile: highPower,
        profile_changed: true,
      }),
    );
    const view = render(
      <TablesPage me={ada} heading={createRef()} code={CODE} />,
    );
    await settle();
    const notice = screen.getByRole("status", {
      name: "The host changed what this table is for",
    });
    expect(notice).toHaveTextContent(
      "Read what it is for now, above: what the host describes, and what is checked on every deck.",
    );
    expect(within(notice).queryAllByRole("listitem")).toHaveLength(0);
    view.unmount();

    keepRead(CODE, profile());
    servePage(
      api,
      table({ your_seat: 1, players: guest(), profile_changed: true }),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    const removed = screen.getByRole("status", {
      name: "The host changed what this table is for",
    });
    expect(removed).toHaveTextContent(
      "The host took the table's description away. Only the table's own rules are checked on a deck now.",
    );
    expect(removed).toHaveTextContent(
      "No longer checked: At most 3 Game Changers a deck",
    );
  });

  it("says why getting ready was refused, and asks again", async () => {
    const api = mockApi();
    servePage(
      api,
      table({
        your_seat: 1,
        players: guest(),
        profile: highPower,
        profile_changed: true,
      }),
    );
    api.on("PATCH /api/v1/tables/{code}/seat", () =>
      reply(422, {
        code: "deck_not_allowed",
        message:
          "This table allows no Reserved List cards: Black Lotus. Choose another deck, or a table that allows them.",
      }),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "I have read it: ready" }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This table allows no Reserved List cards: Black Lotus.",
    );
    // Still unread: the deck is changed, and the same button asks again.
    expect(
      screen.getByRole("button", { name: "I have read it: ready" }),
    ).toBeEnabled();
  });
});
