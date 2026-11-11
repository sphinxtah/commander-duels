import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { mockApi, openDialogs, reply } from "../decks/fixtures";
import type { OwnDeck, TablePlayer, TableView } from "./tables";
import { lobbyChanged, setLobbyLive } from "./lobby";
import { TablesPage } from "./TablesPage";

// The public queues are in the lobby since v0.8.7, from the Play page, and since v0.9.2 in its
// "Quick match" pop-up; their own tests are in queues.test.tsx, so here they are a stand-in.
vi.mock("../queues/FindGame", () => ({
  FindGame: ({ title }: { title?: string }) => (
    <section aria-label={`Queue: ${title ?? "Find a game"}`} />
  ),
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
    rules: { banned: true, not_legal: true, stand_in: true },
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
    open_seats: 0,
    ...fields,
  };
}

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/** The lobby's pages (v0.9.2): the tables the answer holds, on one page, with your own table.
 * The account has no friends to invite. */
function serveLobby(
  api: ReturnType<typeof mockApi>,
  answer: () => { data?: unknown },
) {
  api.on("GET /api/v1/tables/browse", () => {
    const tables = (answer().data ?? []) as TableView[];
    return reply(200, {
      tables,
      total: tables.length,
      page: 1,
      per_page: 20,
      yours: tables.find((found) => found.your_seat !== null) ?? null,
    });
  });
  api.on("GET /api/v1/friends", () =>
    reply(200, { friends: [], incoming: [], outgoing: [], waiting: [] }),
  );
}

/** "Open a table" (v0.9.2): its pop-up holds the form. */
async function openForm() {
  await act(async () =>
    screen.getByRole("button", { name: "Open a table" }).click(),
  );
  await settle();
}

/** The open pop-up's own controls. */
function form() {
  return within(screen.getByRole("dialog", { name: "Open a table" }));
}

beforeEach(() => {
  openDialogs();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("the lobby", () => {
  it("lists open tables without their decks, and opens a table", async () => {
    const api = mockApi();
    serveLobby(api, () => reply(200, [table()]));
    api.on("GET /api/v1/decks", () =>
      reply(200, [
        deck(),
        deck({ id: "deck-2", title: "Elves", format: "commander" }),
      ]),
    );
    api.on("POST /api/v1/tables", () =>
      reply(201, table({ host: "ada", your_seat: 0 })),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    // "Find a game" (v0.9.2): the tables waiting for players, as cards.
    const browser = screen.getByRole("region", { name: "Find a game" });
    const listed = within(browser).getByRole("listitem");
    expect(listed).toHaveTextContent("Hosted by bob");
    expect(listed).toHaveTextContent("Players1 of 2");
    expect(listed).toHaveTextContent("Open seats1");
    expect(
      within(listed).getByRole("link", { name: "Join bob's Legacy table" }),
    ).toHaveAttribute("href", `#tables/${CODE}`);

    // Commander: up to four seats, bots after the players, at a skill.
    await openForm();
    await act(async () =>
      screen.getByRole("radio", { name: /Commander/ }).click(),
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-2");
    expect(screen.getByLabelText("Seats")).toHaveValue("4");
    await act(async () =>
      screen.getByRole("radio", { name: /^Legacy/ }).click(),
    );
    expect(screen.queryByLabelText("Seats")).toBeNull();
    await act(async () =>
      screen.getByRole("button", { name: "Open the table" }).click(),
    );
    await settle();
    const opened = api.calls.find((c) => c.route === "POST /api/v1/tables")!;
    expect(opened.options).toMatchObject({
      body: {
        format: "legacy",
        seats: 2,
        bots: 0,
        visibility: "public",
        deck_id: "deck-1",
      },
    });
    expect(window.location.hash).toBe(`#tables/${CODE}`);
  });

  it("shows each table's rules, and lets the host choose them (v0.4.5)", async () => {
    const api = mockApi();
    serveLobby(api, () =>
      reply(200, [
        table(),
        table({
          code: "Tournament-code1",
          format: "commander",
          seats: 4,
          rules: { banned: false, not_legal: false, stand_in: false },
        }),
        table({
          code: "Bans-only-code12",
          rules: { banned: true, not_legal: false, stand_in: false },
        }),
      ]),
    );
    api.on("GET /api/v1/decks", () =>
      reply(200, [
        deck({ id: "deck-lotus", title: "Lotus", needs: ["banned"] }),
        deck(),
      ]),
    );
    api.on("POST /api/v1/tables", () =>
      reply(201, table({ host: "ada", your_seat: 0 })),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const [casual, tournament, bans] = within(
      screen.getByRole("region", { name: "Find a game" }),
    ).getAllByRole("listitem");
    expect(casual).toHaveTextContent("2 seats");
    expect(within(casual!).getByText("Casual")).toBeInTheDocument();
    expect(tournament).toHaveTextContent("4 seats");
    expect(
      within(tournament!).getByText("Tournament rules"),
    ).toBeInTheDocument();
    expect(tournament).toHaveTextContent(
      "Tournament rules: no banned cards, no cards not legal in Commander, and no stand-ins.",
    );
    expect(within(bans!).getByText("Banned cards allowed")).toBeInTheDocument();

    // A new table is casual: a deck holding a banned card may open it.
    await openForm();
    expect(
      form().getByRole("checkbox", { name: /^Banned cards/ }),
    ).toBeChecked();
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-lotus");
    await act(async () =>
      form()
        .getByRole("checkbox", { name: /^Tournament rules/ })
        .click(),
    );
    expect(
      form().getByRole("checkbox", { name: /^Banned cards/ }),
    ).not.toBeChecked();
    expect(
      form().getByRole("checkbox", { name: /^Cards not legal in Legacy/ }),
    ).not.toBeChecked();
    expect(
      within(screen.getByLabelText("Your deck")).getByRole("option", {
        name: "Lotus (holds banned cards)",
      }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-1");
    await act(async () =>
      screen.getByRole("button", { name: "Open the table" }).click(),
    );
    await settle();
    const opened = api.calls.find((c) => c.route === "POST /api/v1/tables")!;
    expect(opened.options).toMatchObject({
      body: {
        rules: { banned: false, not_legal: false, stand_in: false },
        deck_id: "deck-1",
      },
    });
    // Unticking Tournament rules goes back to casual.
    await act(async () =>
      form()
        .getByRole("checkbox", { name: /^Tournament rules/ })
        .click(),
    );
    expect(
      form().getByRole("checkbox", { name: /^Cards not legal in Legacy/ }),
    ).toBeChecked();
  });

  it("asks again as soon as the live lobby says the tables changed (v0.9.4)", async () => {
    const api = mockApi();
    let tables = [table()];
    serveLobby(api, () => reply(200, tables));
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const asked = () =>
      api.calls.filter((c) => c.route === "GET /api/v1/tables/browse").length;
    const before = asked();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    tables = [table(), table({ code: "Tb2e-code_654321", host: "cara" })];
    await act(async () => {
      setLobbyLive(true);
      lobbyChanged();
    });
    await settle();
    expect(asked()).toBeGreaterThan(before);
    expect(
      within(screen.getByRole("region", { name: "Find a game" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(2);
    await act(async () => setLobbyLive(false));
  });

  it("points to the table you sit at, and says why a table could not open", async () => {
    const api = mockApi();
    serveLobby(api, () =>
      reply(200, [table({ your_seat: 1, visibility: "private" })]),
    );
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("link", { name: "Go to your table" }),
    ).toHaveAttribute("href", `#tables/${CODE}`);
    expect(screen.getByText("Private")).toBeInTheDocument();
    await openForm();
    expect(screen.getByRole("button", { name: "Open a table" })).toBeDisabled();
  });

  it("is closed to an account that cannot play", () => {
    render(
      <TablesPage
        me={{ ...ada, permissions: ["profile.edit"] }}
        heading={createRef()}
      />,
    );
    expect(
      screen.getByText("This account cannot play games yet."),
    ).toBeInTheDocument();
  });
});

describe("a table", () => {
  it("seats a player with their deck, readies them, and opens the game when it starts", async () => {
    const api = mockApi();
    const seated = table({
      your_seat: 1,
      players: [
        seat({ seat: 0, taken: true, handle: "bob", host: true, ready: true }),
        seat({
          seat: 1,
          taken: true,
          handle: "ada",
          you: true,
          deck: "Red deck",
          deck_id: "deck-1",
        }),
      ],
    });
    api.on(
      "GET /api/v1/tables/{code}",
      () => reply(200, table()),
      () => reply(200, table()),
    );
    api.on("GET /api/v1/decks", () =>
      reply(200, [
        deck(),
        deck({
          id: "deck-3",
          title: "Locked",
          playable: false,
          collection_locked: true,
        }),
      ]),
    );
    api.on("POST /api/v1/tables/{code}/join", () => reply(200, seated));
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(
      screen.getByRole("heading", { name: "Legacy table" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Your deck")).getByRole("option", {
        name: "Locked (needs cards you don't own)",
      }),
    ).toBeDisabled();
    api.on("GET /api/v1/tables/{code}", () => reply(200, seated));
    await act(async () =>
      screen.getByRole("button", { name: "Take a seat" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/tables/{code}/join")!
        .options,
    ).toMatchObject({
      params: { path: { code: CODE } },
      body: { deck_id: "deck-1" },
    });
    // Seated: the invite link, Ready and Leave; another player's deck is never shown.
    expect(screen.getByLabelText("Invite link")).toHaveValue(
      `${window.location.origin}${window.location.pathname}#tables/${CODE}`,
    );
    expect(screen.getByText("Playing Red deck")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Leave the table" }),
    ).toBeInTheDocument();
    const ready = {
      ...seated,
      players: [seated.players[0]!, { ...seated.players[1]!, ready: true }],
    };
    api.on("PATCH /api/v1/tables/{code}/seat", () => reply(200, ready));
    // Meanwhile the host starts: the page follows the table into its game.
    api.on("GET /api/v1/tables/{code}", () =>
      reply(200, { ...ready, status: "started", game_id: "game-1" }),
    );
    await act(async () =>
      screen.getByRole("button", { name: "Ready" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "PATCH /api/v1/tables/{code}/seat")!
        .options,
    ).toMatchObject({ body: { ready: true } });
    expect(window.location.hash).toBe("#game/game-1");
  });

  it("lets the host start once everyone is ready", async () => {
    const api = mockApi();
    const hosting = table({
      host: "ada",
      your_seat: 0,
      can_start: true,
      players: [
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
        seat({ seat: 1, taken: true, handle: "bob", ready: true }),
      ],
    });
    api.on("GET /api/v1/tables/{code}", () => reply(200, hosting));
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    api.on("POST /api/v1/tables/{code}/start", () =>
      reply(200, { ...hosting, status: "started", game_id: "game-2" }),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(screen.getAllByText("Ready")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Close the table" }),
    ).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Start the game" }).click(),
    );
    await settle();
    expect(window.location.hash).toBe("#game/game-2");
  });

  it("says the table's rules, and greys the decks they do not take", async () => {
    const api = mockApi();
    api.on("GET /api/v1/tables/{code}", () =>
      reply(
        200,
        table({ rules: { banned: false, not_legal: false, stand_in: false } }),
      ),
    );
    api.on("GET /api/v1/decks", () =>
      reply(200, [
        deck({ id: "deck-odd", title: "Odd", needs: ["banned", "not_legal"] }),
        deck(),
      ]),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(screen.getByText("Tournament rules")).toBeInTheDocument();
    expect(screen.getByText(/^Hosted by bob\./)).toHaveTextContent(
      "Tournament rules: no banned cards, no cards not legal in Legacy, and no stand-ins.",
    );
    expect(
      within(screen.getByLabelText("Your deck")).getByRole("option", {
        name: "Odd (holds banned cards and cards not legal in Legacy)",
      }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-1");
  });

  it("says when a table is gone or closed", async () => {
    const api = mockApi();
    api.on("GET /api/v1/decks", () => reply(200, []));
    api.on("GET /api/v1/tables/{code}", () =>
      reply(404, { code: "http_404", message: "Not Found" }),
    );
    const { unmount } = render(
      <TablesPage me={ada} heading={createRef()} code={CODE} />,
    );
    await settle();
    expect(
      screen.getByRole("heading", { name: "There is no such table." }),
    ).toBeInTheDocument();
    unmount();
    api.on("GET /api/v1/tables/{code}", () =>
      reply(200, table({ status: "closed" })),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This table is closed.",
    );
    expect(screen.queryByRole("button", { name: "Take a seat" })).toBeNull();
  });
});

describe("best of three at a table (v0.5.0)", () => {
  it("tags a best-of-three table, and lets a Legacy host open one", async () => {
    const api = mockApi();
    serveLobby(api, () => reply(200, [table({ best_of: 3 })]));
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    api.on("POST /api/v1/tables", () =>
      reply(201, table({ host: "ada", your_seat: 0, best_of: 3 })),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    expect(
      within(screen.getByRole("listitem")).getByText("Best of three"),
    ).toBeInTheDocument();
    await openForm();
    await act(async () =>
      screen.getByRole("radio", { name: /^Best of three/ }).click(),
    );
    await act(async () =>
      screen.getByRole("button", { name: "Open the table" }).click(),
    );
    await settle();
    const opened = api.calls.find((c) => c.route === "POST /api/v1/tables")!;
    expect(opened.options).toMatchObject({
      body: { format: "legacy", best_of: 3 },
    });
  });
});

describe("Two-Headed Giant at a table (v0.5.1)", () => {
  function teams(fields: Partial<TableView> = {}): TableView {
    return table({
      format: "two_headed_giant",
      seats: 4,
      bots: 1,
      players: [
        seat({
          seat: 0,
          team: 0,
          taken: true,
          handle: "bob",
          host: true,
          ready: true,
        }),
        seat({ seat: 1, team: 0 }),
        seat({ seat: 2, team: 1, taken: true, handle: "cara" }),
        seat({ seat: 3, team: 1, player: "bot", taken: true, ready: true }),
      ],
      ...fields,
    });
  }

  it("lists a table's teams, and opens one with a bot teammate", async () => {
    const api = mockApi();
    serveLobby(api, () => reply(200, [teams()]));
    api.on("GET /api/v1/decks", () =>
      reply(200, [
        deck(),
        deck({ id: "deck-2", title: "Elves", format: "commander" }),
      ]),
    );
    api.on("POST /api/v1/tables", () =>
      reply(201, teams({ host: "ada", your_seat: 0 })),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const listed = screen.getByRole("listitem");
    expect(listed).toHaveTextContent("Two teams of two");
    expect(within(listed).getByLabelText("Teams")).toHaveTextContent(
      "Team 1: bob and an open seat",
    );
    expect(within(listed).getByLabelText("Teams")).toHaveTextContent(
      "Team 2: cara and a bot",
    );
    await openForm();
    await act(async () =>
      screen.getByRole("radio", { name: /^Two-Headed Giant/ }).click(),
    );
    // Legacy decks, and the rules are Legacy's.
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-1");
    expect(
      screen.getByRole("checkbox", { name: /^Cards not legal in Legacy/ }),
    ).toBeChecked();
    await act(async () =>
      screen.getByRole("radio", { name: /^A bot/ }).click(),
    );
    const other = screen.getByLabelText("The other team");
    expect(
      within(other).getByRole("option", { name: "Two bots" }),
    ).toBeDisabled();
    await act(async () => {
      (other as HTMLSelectElement).value = "1";
      other.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      screen.getByRole("button", { name: "Open the table" }).click(),
    );
    await settle();
    const opened = api.calls.find((c) => c.route === "POST /api/v1/tables")!;
    expect(opened.options).toMatchObject({
      body: {
        format: "two_headed_giant",
        seats: 4,
        bots: 2,
        bot_teammate: true,
        best_of: 1,
        deck_id: "deck-1",
      },
    });
  });

  it("seats a player in the team they choose, moves them, and says why they are not ready", async () => {
    const api = mockApi();
    const joined = teams({
      your_seat: 1,
      players: [
        seat({
          seat: 0,
          team: 0,
          taken: true,
          handle: "bob",
          host: true,
          ready: true,
        }),
        seat({
          seat: 1,
          team: 0,
          taken: true,
          handle: "ada",
          you: true,
          deck: "Red deck",
          deck_id: "deck-1",
        }),
        seat({ seat: 2, team: 1, taken: true, handle: "cara" }),
        seat({ seat: 3, team: 1, player: "bot", taken: true, ready: true }),
      ],
    });
    api.on("GET /api/v1/tables/{code}", () => reply(200, teams()));
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    api.on("POST /api/v1/tables/{code}/join", () => reply(200, joined));
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(
      screen.getByRole("heading", { name: "Two-Headed Giant table" }),
    ).toBeInTheDocument();
    const first = screen.getByRole("region", { name: "Team 1" });
    expect(within(first).getByText("bob")).toBeInTheDocument();
    const second = screen.getByRole("region", { name: "Team 2" });
    expect(within(second).getByText("Bot")).toBeInTheDocument();
    // Team 2 is full of a player and a bot: only Team 1 can be joined.
    expect(within(second).queryByRole("button", { name: /Join/ })).toBeNull();
    api.on("GET /api/v1/tables/{code}", () => reply(200, joined));
    await act(async () =>
      within(first).getByRole("button", { name: "Join Team 1" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/tables/{code}/join")!
        .options,
    ).toMatchObject({ body: { deck_id: "deck-1", team: 0 } });
    expect(
      screen.getByRole("region", { name: "Team 1 Your team" }),
    ).toBeInTheDocument();
    api.on("PATCH /api/v1/tables/{code}/seat", () =>
      reply(422, {
        code: "team_decks",
        message:
          "Your deck and bob's share Lightning Bolt. In Two-Headed Giant teammates' decks may share only basic lands: one of you needs another deck.",
      }),
    );
    await act(async () =>
      screen.getByRole("button", { name: "Ready" }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your deck and bob's share Lightning Bolt.",
    );
  });
});

describe("King's Table at a table (v0.8.7)", () => {
  const settings = {
    deck_format: "commander" as const,
    life: "generals_20_kings_40" as const,
    king_attacks_anyone: false,
    guarded_kings: false,
  };
  const life = (n: number) => (n === 1 || n === 4 ? 40 : 20);
  /** A King's Table seat, its team, role and life filled in as the API gives them. */
  function kseat(fields: Partial<TablePlayer> & { seat: number }): TablePlayer {
    return seat({
      team: Math.floor(fields.seat / 3),
      role: fields.seat === 1 || fields.seat === 4 ? "king" : "general",
      starting_life: life(fields.seat),
      ...fields,
    });
  }
  function kingsTable(fields: Partial<TableView> = {}): TableView {
    return table({
      format: "kings_table",
      seats: 6,
      bots: 2,
      kings_table: settings,
      players: [
        kseat({ seat: 0 }),
        kseat({ seat: 1, taken: true, handle: "bob", host: true, ready: true }),
        kseat({ seat: 2, player: "bot", taken: true }),
        kseat({ seat: 3 }),
        kseat({ seat: 4, player: "bot", taken: true }),
        kseat({ seat: 5, taken: true, handle: "cara" }),
      ],
      ...fields,
    });
  }
  const commanderDeck = deck({
    id: "deck-c",
    title: "Soldiers",
    format: "commander",
    card_count: 100,
  });

  it("tags its settings in the lobby, and opens with its settings, your seat and the bots' seats", async () => {
    const api = mockApi();
    serveLobby(api, () => reply(200, [kingsTable()]));
    api.on("GET /api/v1/decks", () => reply(200, [deck(), commanderDeck]));
    api.on("POST /api/v1/tables", () =>
      reply(201, kingsTable({ host: "ada", your_seat: 3 })),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    // The lobby tags its settings, and says who sits in each team.
    const listed = screen.getByRole("listitem");
    expect(within(listed).getByText("Two teams of three")).toBeInTheDocument();
    expect(within(listed).getByText("Commander decks")).toBeInTheDocument();
    expect(
      within(listed).getByText("Generals 20, Kings 40"),
    ).toBeInTheDocument();
    expect(
      within(listed).getByText("King can attack anyone: off"),
    ).toBeInTheDocument();
    expect(within(listed).getByLabelText("Teams")).toHaveTextContent(
      "Team A: an open seat, bob and a bot",
    );
    expect(within(listed).getByLabelText("Teams")).toHaveTextContent(
      "Team B: an open seat, a bot and cara",
    );

    await openForm();
    await act(async () =>
      screen.getByRole("radio", { name: /^King's Table/ }).click(),
    );
    // Commander decks by default: only those fit.
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-c");
    expect(
      screen.getByRole("radio", { name: /^Generals 20, Kings 40/ }),
    ).toHaveAccessibleName(/Each General starts at 20 life, each King at 40$/);
    await act(async () =>
      screen.getByRole("radio", { name: /^Generals 20, Kings 40/ }).click(),
    );
    // The house rule, and its guard (v0.9.7), which is offered only with it.
    const guard = screen.getByRole("checkbox", {
      name: /^Generals guard their King/,
    });
    expect(guard).toBeDisabled();
    await act(async () =>
      screen.getByRole("checkbox", { name: /^King can attack anyone/ }).click(),
    );
    await act(async () => guard.click());
    expect(guard).toBeChecked();
    // Team A's King by default; Team B's Right General instead, and bots in two seats.
    expect(screen.getByRole("radio", { name: /^Team A's King/ })).toBeChecked();
    await act(async () =>
      screen
        .getByRole("checkbox", { name: /^A bot as Team B's Right General/ })
        .click(),
    );
    await act(async () =>
      screen.getByRole("radio", { name: /^Team B's Right General/ }).click(),
    );
    // Your seat is never a bot's: the box for it is gone, and so is its tick.
    expect(
      screen.queryByRole("checkbox", {
        name: /^A bot as Team B's Right General/,
      }),
    ).toBeNull();
    for (const name of [
      /^A bot as Team A's Left General/,
      /^A bot as Team B's King/,
    ])
      await act(async () => screen.getByRole("checkbox", { name }).click());
    expect(
      screen.getByRole("radio", { name: /^Team B's King/ }),
    ).toHaveAccessibleName(/40 life to start$/);
    // Legacy decks instead: the Legacy deck fits.
    await act(async () =>
      screen.getByRole("radio", { name: /^Legacy decks/ }).click(),
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-1");
    await act(async () =>
      screen.getByRole("button", { name: "Open the table" }).click(),
    );
    await settle();
    const opened = api.calls.find((c) => c.route === "POST /api/v1/tables")!;
    expect(opened.options).toMatchObject({
      body: {
        format: "kings_table",
        seats: 6,
        bots: 2,
        seat: 3,
        bot_seats: [0, 4],
        best_of: 1,
        deck_id: "deck-1",
        kings_table: {
          deck_format: "legacy",
          life: "generals_20_kings_40",
          king_attacks_anyone: true,
          guarded_kings: true,
        },
      },
    });
    // No turn limit is named: the API gives the table 40 turns for each seat (v0.9.7).
    expect(
      (opened.options as { body: Record<string, unknown> }).body,
    ).not.toHaveProperty("turn_cap");
  });

  it("says the house rule's guard in the lobby, at the table and to its host (v0.9.7)", async () => {
    const api = mockApi();
    const guarded = {
      ...settings,
      king_attacks_anyone: true,
      guarded_kings: true,
    };
    const hosting = (kings: typeof settings) =>
      kingsTable({
        host: "ada",
        your_seat: 1,
        kings_table: kings,
        players: kingsTable().players.map((p) =>
          p.seat === 1
            ? {
                ...p,
                handle: "ada",
                you: true,
                deck: "Soldiers",
                deck_id: "deck-c",
              }
            : p,
        ),
      });
    let current = hosting({ ...settings, king_attacks_anyone: true });
    api.on("GET /api/v1/tables/{code}", () => reply(200, current));
    api.on("GET /api/v1/decks", () => reply(200, [commanderDeck]));
    api.on("PATCH /api/v1/tables/{code}", () => {
      current = hosting(guarded);
      return reply(200, current);
    });
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(
      screen.getByText(/^Commander decks for all six players/),
    ).toHaveTextContent(
      "House rule on: a King's creatures may attack any opponent, the other King included; spells and abilities still keep to range.",
    );
    const host = screen.getByRole("region", { name: "Change the table" });
    await act(async () =>
      within(host)
        .getByRole("checkbox", { name: /^Generals guard their King/ })
        .click(),
    );
    await settle();
    expect(
      api.calls
        .filter((c) => c.route === "PATCH /api/v1/tables/{code}")
        .map((c) => (c.options as { body: unknown }).body),
    ).toEqual([{ kings_table: { guarded_kings: true } }]);
    // The table says the rule as it now plays.
    expect(
      screen.getByText(/^Commander decks for all six players/),
    ).toHaveTextContent(
      "House rule on, Generals guarding their King: a King's creatures may attack any opposing General, and the other King once one of that King's Generals is defeated; spells and abilities still keep to range.",
    );
    expect(
      within(host).getByRole("checkbox", {
        name: /^Generals guard their King/,
      }),
    ).toBeChecked();
  });

  it("draws the six seats as the circle's two sides, shows the rules before anyone readies, and takes a seat", async () => {
    const api = mockApi();
    api.on("GET /api/v1/tables/{code}", () => reply(200, kingsTable()));
    api.on("GET /api/v1/decks", () => reply(200, [deck(), commanderDeck]));
    const joined = kingsTable({
      your_seat: 3,
      players: kingsTable().players.map((p) =>
        p.seat === 3
          ? {
              ...p,
              taken: true,
              handle: "ada",
              you: true,
              deck: "Soldiers",
              deck_id: "deck-c",
            }
          : p,
      ),
    });
    api.on("POST /api/v1/tables/{code}/join", () => reply(200, joined));
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(
      screen.getByRole("heading", { name: "King's Table table" }),
    ).toBeInTheDocument();
    // The settings, in sentences, before anyone is ready.
    expect(
      screen.getByText(/^Commander decks for all six players/),
    ).toHaveTextContent(
      "Each General starts at 20 life, each King at 40. House rule off",
    );
    // Team B across the table (5, 4, 3), team A on your side (0, 1, 2): each King in the middle.
    const across = screen.getByRole("list", { name: "Team B seats" });
    const near = screen.getByRole("list", { name: "Team A seats" });
    expect(
      within(across)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Team B's Left General",
      "Team B's King",
      "Team B's Right General",
    ]);
    expect(
      within(near)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Team A's Left General",
      "Team A's King",
      "Team A's Right General",
    ]);
    const king = within(near).getByRole("listitem", { name: "Team A's King" });
    expect(king).toHaveTextContent("♔ King");
    expect(king).toHaveTextContent("40 life");
    expect(king).toHaveTextContent("bob");
    expect(king).toHaveTextContent("Team A · King · 40 starting life");
    // Only the open seats offer themselves; the deck is a Commander one.
    expect(
      screen.getAllByRole("button", { name: /^Take this seat/ }),
    ).toHaveLength(2);
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-c");
    api.on("GET /api/v1/tables/{code}", () => reply(200, joined));
    await act(async () =>
      screen
        .getByRole("button", { name: "Take this seat: Team B's Right General" })
        .click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/tables/{code}/join")!
        .options,
    ).toMatchObject({ body: { deck_id: "deck-c", seat: 3 } });
    // Seated: your team at the bottom, and the open seat offers a move.
    expect(
      screen.getByRole("button", {
        name: "Move to this seat: Team A's Left General",
      }),
    ).toBeInTheDocument();
    const lists = screen.getAllByRole("list", { name: /seats$/ });
    expect(lists.map((list) => list.getAttribute("aria-label"))).toEqual([
      "Team A seats",
      "Team B seats",
    ]);
  });

  it("lets the host change the settings, the bots' seats and a player's seat, which clears readiness", async () => {
    const api = mockApi();
    const hosting = kingsTable({
      host: "ada",
      your_seat: 1,
      players: kingsTable().players.map((p) =>
        p.seat === 1
          ? {
              ...p,
              handle: "ada",
              you: true,
              deck: "Soldiers",
              deck_id: "deck-c",
            }
          : p,
      ),
    });
    api.on("GET /api/v1/tables/{code}", () => reply(200, hosting));
    api.on("GET /api/v1/decks", () => reply(200, [commanderDeck]));
    api.on("PATCH /api/v1/tables/{code}", () => reply(200, hosting));
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(
      screen.getByText(/makes every player not ready again/),
    ).toBeInTheDocument();
    const patches = () =>
      api.calls
        .filter((c) => c.route === "PATCH /api/v1/tables/{code}")
        .map((c) => (c.options as { body: unknown }).body);
    const host = screen.getByRole("region", { name: "Change the table" });
    await act(async () =>
      within(host)
        .getByRole("radio", { name: /^Everyone 20/ })
        .click(),
    );
    await settle();
    await act(async () =>
      screen
        .getByRole("button", {
          name: "Give Team A's Left General's seat to a bot",
        })
        .click(),
    );
    await settle();
    await act(async () =>
      screen
        .getByRole("button", { name: "Open Team B's King's seat for a player" })
        .click(),
    );
    await settle();
    await act(async () =>
      fireEvent.change(
        screen.getByRole("combobox", { name: "Move cara to another seat" }),
        { target: { value: "3" } },
      ),
    );
    await settle();
    expect(patches()).toEqual([
      { kings_table: { life: "all_20" } },
      { bot_seats: [2, 4, 0] },
      { bot_seats: [2] },
      { move: { seat: 5, to: 3 } },
    ]);
  });

  it("keeps the court's host in King A's seat and the court in its own (v0.9.8)", async () => {
    const api = mockApi();
    // The campaign's court with one friend invited: the host is King A, a General's seat waits
    // for the friend, the other General is a bot, and team B is the court's named bots.
    const court = kingsTable({
      host: "ada",
      your_seat: 1,
      campaign: "The Unbound Court",
      bots: 4,
      players: [
        kseat({ seat: 0 }),
        kseat({
          seat: 1,
          taken: true,
          handle: "ada",
          host: true,
          you: true,
          deck: "Soldiers",
          deck_id: "deck-c",
        }),
        kseat({ seat: 2, player: "bot", taken: true }),
        kseat({ seat: 3, player: "bot", taken: true, handle: "Nicol Bolas" }),
        kseat({ seat: 4, player: "bot", taken: true, handle: "The Sphinx" }),
        kseat({ seat: 5, player: "bot", taken: true, handle: "Liliana" }),
      ],
    });
    api.on("GET /api/v1/tables/{code}", () => reply(200, court));
    api.on("GET /api/v1/decks", () => reply(200, [commanderDeck]));
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    // The host does not move to the open General's seat, nor anyone else by the host's hand.
    expect(
      screen.queryByRole("button", { name: /^Move to this seat/ }),
    ).toBeNull();
    expect(screen.queryByRole("combobox", { name: /^Move / })).toBeNull();
    // The Generals' seats still change hands: the open one to a bot, the bot's to a player.
    expect(
      screen.getByRole("button", {
        name: "Give Team A's Left General's seat to a bot",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Open Team A's Right General's seat for a player",
      }),
    ).toBeInTheDocument();
    // The court's own seats open for nobody.
    expect(screen.queryByRole("button", { name: /^Open Team B's/ })).toBeNull();
  });

  it("says why a deck of the other format cannot get ready", async () => {
    const api = mockApi();
    const seated = kingsTable({
      your_seat: 0,
      players: kingsTable().players.map((p) =>
        p.seat === 0
          ? {
              ...p,
              taken: true,
              handle: "ada",
              you: true,
              deck: "Red deck",
              deck_id: "deck-1",
            }
          : p,
      ),
    });
    api.on("GET /api/v1/tables/{code}", () => reply(200, seated));
    api.on("GET /api/v1/decks", () => reply(200, [deck(), commanderDeck]));
    api.on("PATCH /api/v1/tables/{code}/seat", () =>
      reply(422, {
        code: "invalid_deck",
        message: "Red deck is a Legacy deck, not a Commander one.",
      }),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    // The host changed the decks to Commander after ada sat down with a Legacy deck.
    expect(
      screen.getByText(/Red deck is a Legacy deck, and this table plays/),
    ).toHaveTextContent(
      "Commander decks now: choose one of yours before you get ready.",
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("");
    await act(async () =>
      screen.getByRole("button", { name: "Ready" }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Red deck is a Legacy deck, not a Commander one. This table plays Commander decks now: choose one of yours, then get ready.",
    );
  });
});

describe("finding a game (v0.9.2)", () => {
  const bob = {
    id: "00000000-0000-4000-8000-0000000000b2",
    handle: "bob",
    avatar: "sigil",
    alliance: null,
    tier: { tier: 1, name: "Initiate", wins: 0, next: 10 },
    presence: { state: "online", appears_offline: false },
    friendship: "friends",
  };
  const cara = {
    ...bob,
    id: "00000000-0000-4000-8000-0000000000c3",
    handle: "cara",
    presence: null,
  };

  function query(api: ReturnType<typeof mockApi>) {
    const asked = api.calls.filter(
      (c) => c.route === "GET /api/v1/tables/browse",
    );
    return (asked[asked.length - 1]!.options as { params: { query: object } })
      .params.query;
  }

  it("filters the cards live, pages them, and keeps the choice", async () => {
    const api = mockApi();
    const many = Array.from({ length: 20 }, (_, index) =>
      table({ code: `Table-code-${String(index).padStart(4, "0")}` }),
    );
    api.on("GET /api/v1/tables/browse", (options) => {
      const { page } = (options as { params: { query: { page: number } } })
        .params.query;
      return reply(200, {
        tables: page === 2 ? [table({ code: "Last-table-code1" })] : many,
        total: 21,
        page,
        per_page: 20,
        yours: null,
      });
    });
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const browser = screen.getByRole("region", { name: "Find a game" });
    expect(within(browser).getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByText("21 tables · page 1 of 2")).toBeInTheDocument();
    expect(query(api)).toMatchObject({ page: 1, per_page: 20, friends: false });
    expect(query(api)).not.toHaveProperty("format");

    // A box unticked asks again at once, from the first page.
    await act(async () => screen.getByRole("button", { name: "Next" }).click());
    await settle();
    expect(query(api)).toMatchObject({ page: 2 });
    expect(within(browser).getAllByRole("listitem")).toHaveLength(1);
    await act(async () =>
      screen.getByRole("checkbox", { name: "King's Table" }).click(),
    );
    await settle();
    expect(query(api)).toMatchObject({
      page: 1,
      format: ["legacy", "commander", "two_headed_giant"],
    });
    await act(async () =>
      screen.getByRole("checkbox", { name: "Tournament rules" }).click(),
    );
    await act(async () =>
      screen.getByRole("checkbox", { name: "Friends' tables" }).click(),
    );
    await act(async () =>
      screen.getByRole("checkbox", { name: "Seats open" }).click(),
    );
    await settle();
    expect(query(api)).toMatchObject({
      rules: ["casual"],
      friends: true,
      open_seats: true,
      no_bots: false,
    });
    const perPage = screen.getByLabelText("Tables a page");
    await act(async () => {
      (perPage as HTMLSelectElement).value = "100";
      perPage.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(query(api)).toMatchObject({ per_page: 100, page: 1 });
    expect(
      JSON.parse(window.localStorage.getItem("cd.tables.filters")!),
    ).toMatchObject({ perPage: 100, friends: true, rules: ["casual"] });

    // No format ticked: nothing to ask for.
    for (const name of ["Legacy", "Commander", "Two-Headed Giant"])
      await act(async () => screen.getByRole("checkbox", { name }).click());
    await settle();
    expect(
      screen.getByText("Tick at least one format and one kind of rules."),
    ).toBeInTheDocument();
    expect(within(browser).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("orders the cards and searches by host (v0.9.3)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = mockApi();
      serveLobby(api, () => reply(200, [table()]));
      api.on("GET /api/v1/decks", () => reply(200, [deck()]));
      render(<TablesPage me={ada} heading={createRef()} />);
      await settle();
      expect(query(api)).not.toHaveProperty("sort");
      const order = screen.getByLabelText("Order");
      await act(async () => {
        (order as HTMLSelectElement).value = "players";
        order.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
      expect(query(api)).toMatchObject({ sort: "players", page: 1 });
      const host = screen.getByRole("searchbox", { name: "Host's name" });
      await act(async () => {
        fireEvent.change(host, { target: { value: "bob" } });
      });
      expect(query(api)).not.toHaveProperty("host");
      await act(async () => {
        vi.advanceTimersByTime(350);
      });
      await settle();
      expect(query(api)).toMatchObject({ host: "bob", sort: "players" });
      // The order is kept for next time; the search is not.
      const kept = JSON.parse(
        window.localStorage.getItem("cd.tables.filters")!,
      );
      expect(kept).toMatchObject({ sort: "players" });
      expect(kept).not.toHaveProperty("host");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says who invited you and which friends sit at a table", async () => {
    const api = mockApi();
    serveLobby(api, () =>
      reply(200, [
        table({
          visibility: "private",
          invited_by: "bob",
          friends: ["bob", "cara"],
        }),
      ]),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const card = screen.getByRole("listitem");
    expect(card).toHaveTextContent(
      "bob invited you. Your friends bob, cara sit here.",
    );
    expect(within(card).getByText("Private")).toBeInTheDocument();
  });

  it("opens a table with friends picked one by one", async () => {
    const api = mockApi();
    serveLobby(api, () => reply(200, []));
    api.on("GET /api/v1/friends", () =>
      reply(200, {
        friends: [cara, bob],
        incoming: [],
        outgoing: [],
        waiting: [],
      }),
    );
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    api.on("POST /api/v1/tables", () =>
      reply(201, table({ host: "ada", your_seat: 0 })),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    expect(
      screen.getByText(
        "No table is waiting for players. Open one, and invite your friends.",
      ),
    ).toBeInTheDocument();
    await openForm();
    // Online friends first.
    const picks = form().getAllByRole("checkbox", { name: /^(bob|cara)/ });
    expect(picks.map((box) => box.closest("label")!.textContent)).toEqual([
      expect.stringContaining("bob"),
      expect.stringContaining("cara"),
    ]);
    await act(async () =>
      form().getByRole("checkbox", { name: /^cara/ }).click(),
    );
    await act(async () =>
      form()
        .getByRole("button", { name: "Open the table and invite 1 friend" })
        .click(),
    );
    await settle();
    const opened = api.calls.find((c) => c.route === "POST /api/v1/tables")!;
    expect(opened.options).toMatchObject({ body: { invite: [cara.id] } });
    expect(window.location.hash).toBe(`#tables/${CODE}`);
  });

  it("holds the public queue in the Quick match pop-up, which #find opens", async () => {
    const api = mockApi();
    serveLobby(api, () => reply(200, []));
    window.location.hash = "#find";
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("region", { name: "Queue: Quick match" }),
    ).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Close" }).click(),
    );
    expect(
      screen.queryByRole("region", { name: "Queue: Quick match" }),
    ).toBeNull();
    expect(window.location.hash).toBe("#tables");
    await act(async () =>
      screen.getByRole("button", { name: "Quick match" }).click(),
    );
    expect(
      screen.getByRole("region", { name: "Queue: Quick match" }),
    ).toBeInTheDocument();
  });

  it("invites friends from a table's page", async () => {
    const api = mockApi();
    const mine = table({
      your_seat: 1,
      players: [
        seat({ seat: 0, taken: true, handle: "bob", host: true, ready: true }),
        seat({
          seat: 1,
          taken: true,
          handle: "ada",
          you: true,
          deck_id: "deck-1",
        }),
      ],
    });
    api.on("GET /api/v1/tables/{code}", () => reply(200, mine));
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    api.on("GET /api/v1/friends", () =>
      reply(200, {
        friends: [bob, cara],
        incoming: [],
        outgoing: [],
        waiting: [],
      }),
    );
    api.on("POST /api/v1/tables/{code}/invites", () =>
      reply(200, { invited: ["cara"], already: [] }),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Invite friends" }).click(),
    );
    await settle();
    const dialog = within(
      screen.getByRole("dialog", { name: "Invite friends" }),
    );
    // bob sits at the table already.
    expect(dialog.getByRole("checkbox", { name: /^bob/ })).toBeDisabled();
    await act(async () =>
      dialog.getByRole("checkbox", { name: /^cara/ }).click(),
    );
    await act(async () =>
      dialog.getByRole("button", { name: "Invite" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/tables/{code}/invites")!
        .options,
    ).toMatchObject({
      params: { path: { code: CODE } },
      body: { players: [cara.id] },
    });
    expect(screen.getByText("Invited cara.")).toBeInTheDocument();
  });
});
