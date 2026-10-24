import { act, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { mockApi, reply } from "../decks/fixtures";
import type { OwnDeck, TablePlayer, TableView } from "./tables";
import { TablesPage } from "./TablesPage";

const ada = {
  id: "00000000-0000-4000-8000-0000000000a1",
  kind: "player",
  status: "active",
  onboarding: "complete",
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
    ...fields,
  };
}

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("the lobby", () => {
  it("lists open tables without their decks, and opens a table", async () => {
    const api = mockApi();
    api.on("GET /api/v1/tables", () => reply(200, [table()]));
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
    const listed = screen.getByRole("listitem");
    expect(listed).toHaveTextContent("Hosted by bob · 1 of 2 players");
    expect(
      within(listed).getByRole("link", { name: "Join bob's Legacy table" }),
    ).toHaveAttribute("href", `#tables/${CODE}`);

    // Commander: up to four seats, bots after the players, at a skill.
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
    api.on("GET /api/v1/tables", () =>
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
    const [casual, tournament, bans] = screen.getAllByRole("listitem");
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
    expect(
      screen.getByRole("checkbox", { name: /^Banned cards/ }),
    ).toBeChecked();
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-lotus");
    await act(async () =>
      screen.getByRole("checkbox", { name: /^Tournament rules/ }).click(),
    );
    expect(
      screen.getByRole("checkbox", { name: /^Banned cards/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /^Cards not legal in Legacy/ }),
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
      body: { rules: { banned: false, not_legal: false, stand_in: false }, deck_id: "deck-1" },
    });
    // Unticking Tournament rules goes back to casual.
    await act(async () =>
      screen.getByRole("checkbox", { name: /^Tournament rules/ }).click(),
    );
    expect(
      screen.getByRole("checkbox", { name: /^Cards not legal in Legacy/ }),
    ).toBeChecked();
  });

  it("points to the table you sit at, and says why a table could not open", async () => {
    const api = mockApi();
    api.on("GET /api/v1/tables", () =>
      reply(200, [table({ your_seat: 1, visibility: "private" })]),
    );
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("link", { name: "Go to your table" }),
    ).toHaveAttribute("href", `#tables/${CODE}`);
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open the table" }),
    ).toBeDisabled();
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
      reply(200, table({ rules: { banned: false, not_legal: false, stand_in: false } })),
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
    api.on("GET /api/v1/tables", () => reply(200, [table({ best_of: 3 })]));
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    api.on("POST /api/v1/tables", () =>
      reply(201, table({ host: "ada", your_seat: 0, best_of: 3 })),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    expect(
      within(screen.getByRole("listitem")).getByText("Best of three"),
    ).toBeInTheDocument();
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
    api.on("GET /api/v1/tables", () => reply(200, [teams()]));
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
