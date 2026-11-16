import { act, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { forgetRollout } from "../app/rollout";
import { mockApi, openDialogs, reply } from "../decks/fixtures";
import type { OwnDeck, TablePlayer, TableView } from "./tables";
import { TablesPage } from "./TablesPage";
import type { Spectators, SpectatorView, Watchable } from "./watching";

// Spectators at a table (v1.0.0, docs/tables.md): the host's "Who may watch" as the table opens
// and on its page, a player's friends invited to watch and their removal, what one who may watch
// is shown, and the lobby's games to watch. Behind the gate `spectators`.

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
  permissions: ["games.play", "decks.edit", "profile.edit"],
  roles: ["player"],
  preferences: { large_text: false, reduced_motion: false },
} as unknown as Me;

const CODE = "Tb1e-code_123456";
const GAME = "00000000-0000-4000-8000-00000000009a";

const person = (id: string, handle: string) => ({
  id,
  handle,
  avatar: "sigil",
  alliance: null,
  presence: "online",
});
const cy = person("00000000-0000-4000-8000-0000000000c1", "cy");
const dee = person("00000000-0000-4000-8000-0000000000d1", "dee");

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

/** A two-player table; `as` says who looks at it: its host ada, or someone who does not sit. */
function table(
  as: "host" | "outside",
  fields: Partial<TableView> = {},
): TableView {
  const hosting = as === "host";
  return {
    code: CODE,
    format: "legacy",
    visibility: "private",
    status: "open",
    seats: 2,
    bots: 0,
    bot_skill: 4,
    turn_cap: 80,
    rules: { banned: true, not_legal: true, stand_in: true },
    best_of: 1,
    host: hosting ? "ada" : "bob",
    players: [
      seat({
        seat: 0,
        taken: true,
        handle: hosting ? "ada" : "bob",
        host: true,
        ready: true,
        you: hosting,
        deck_id: hosting ? "deck-1" : null,
      }),
      seat({ seat: 1, taken: true, handle: "eve", ready: true }),
    ],
    your_seat: hosting ? 0 : null,
    can_start: hosting,
    game_id: null,
    created_at: "2026-11-16T10:00:00Z",
    open_seats: 0,
    starter: false,
    profile_changed: false,
    spectators: "nobody",
    spectator_delay: 0,
    watching: false,
    ...fields,
  };
}

function invited(
  player: typeof cy,
  fields: Partial<SpectatorView> = {},
): SpectatorView {
  return {
    player,
    invited_by: "ada",
    yours: true,
    you: false,
    ...fields,
  } as SpectatorView;
}

function list(fields: Partial<Spectators> = {}): Spectators {
  return {
    setting: "invited",
    delay_seconds: 0,
    invited: [],
    limit: 20,
    can_invite: true,
    can_remove: true,
    ...fields,
  };
}

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function serve(open = true) {
  const api = mockApi();
  api.on("GET /api/v1/rollout", () =>
    reply(200, {
      workflows: [{ id: "spectators", name: "Spectators", available: open }],
    }),
  );
  api.on("GET /api/v1/decks", () => reply(200, [deck()]));
  api.on("GET /api/v1/friends", () =>
    reply(200, {
      friends: [cy, dee],
      incoming: [],
      outgoing: [],
      waiting: [],
    }),
  );
  return api;
}

/** The lobby, with no table waiting. */
function serveLobby(api: ReturnType<typeof mockApi>, watchable: Watchable[]) {
  api.on("GET /api/v1/tables/browse", () =>
    reply(200, { tables: [], total: 0, page: 1, per_page: 20, yours: null }),
  );
  api.on("GET /api/v1/spectating", () => reply(200, watchable));
}

const called = (api: ReturnType<typeof mockApi>, route: string) =>
  api.calls.filter((call) => call.route === route);

beforeEach(() => {
  openDialogs();
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  forgetRollout();
  window.location.hash = "";
});

describe("who may watch, as a table opens", () => {
  it("is the host's choice, nobody unless they say so, and anyone only at a public table", async () => {
    const api = serve();
    serveLobby(api, []);
    api.on("POST /api/v1/tables", () => reply(201, table("host")));
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Open a table" }).click(),
    );
    await settle();
    const form = within(screen.getByRole("dialog", { name: "Open a table" }));
    const watch = form.getByLabelText("Who may watch") as HTMLSelectElement;
    expect(watch.value).toBe("nobody");
    const choose = async (select: HTMLSelectElement, value: string) =>
      act(async () => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await choose(watch, "anyone");
    expect(watch.value).toBe("anyone");
    // A private table invites its spectators: anyone is a public table's alone.
    await choose(
      form.getByLabelText("Who may join") as HTMLSelectElement,
      "private",
    );
    expect(watch.value).toBe("invited");
    expect(
      within(watch).getByRole("option", { name: /^Anyone/ }),
    ).toHaveProperty("disabled", true);
    await act(async () =>
      form.getByRole("button", { name: /^Open the table/ }).click(),
    );
    await settle();
    expect(called(api, "POST /api/v1/tables")[0]!.options).toMatchObject({
      body: { visibility: "private", spectators: "invited" },
    });
  });

  it("is not offered while spectators are not the account's to reach", async () => {
    const api = serve(false);
    serveLobby(api, []);
    api.on("POST /api/v1/tables", () => reply(201, table("host")));
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Open a table" }).click(),
    );
    await settle();
    const form = within(screen.getByRole("dialog", { name: "Open a table" }));
    expect(form.queryByLabelText("Who may watch")).toBeNull();
    await act(async () =>
      form.getByRole("button", { name: /^Open the table/ }).click(),
    );
    await settle();
    expect(called(api, "POST /api/v1/tables")[0]!.options).toMatchObject({
      body: { spectators: "nobody" },
    });
    expect(called(api, "GET /api/v1/spectating")).toHaveLength(0);
  });
});

describe("a table's spectators, on its page", () => {
  it("lets the host change who may watch, invite friends to watch and remove them", async () => {
    const api = serve();
    const served = { table: table("host"), list: list() };
    api.on("GET /api/v1/tables/{code}", () => reply(200, served.table));
    api.on("GET /api/v1/tables/{code}/spectators", () =>
      reply(200, served.list),
    );
    api.on("PATCH /api/v1/tables/{code}", () => {
      served.table = table("host", { spectators: "invited" });
      return reply(200, served.table);
    });
    api.on("POST /api/v1/tables/{code}/spectators", () => {
      served.list = list({ invited: [invited(cy)] });
      return reply(200, served.list);
    });
    api.on("DELETE /api/v1/tables/{code}/spectators/{player_id}", () => {
      served.list = list();
      return reply(200, served.list);
    });
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    const panel = within(screen.getByRole("region", { name: "Spectators" }));
    // Nobody watches yet: nothing to invite to, and the list is not asked for.
    expect(
      panel.queryByRole("button", { name: "Invite friends to watch" }),
    ).toBeNull();
    expect(called(api, "GET /api/v1/tables/{code}/spectators")).toHaveLength(0);
    const watch = panel.getByLabelText("Who may watch") as HTMLSelectElement;
    await act(async () => {
      watch.value = "invited";
      watch.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(
      called(api, "PATCH /api/v1/tables/{code}")[0]!.options,
    ).toMatchObject({ body: { spectators: "invited" } });
    expect(
      panel.getByText("Nobody is invited to watch yet."),
    ).toBeInTheDocument();

    await act(async () =>
      panel.getByRole("button", { name: "Invite friends to watch" }).click(),
    );
    await settle();
    const dialog = within(
      screen.getByRole("dialog", { name: "Invite friends to watch" }),
    );
    await act(async () =>
      dialog.getByRole("checkbox", { name: /^cy/ }).click(),
    );
    await act(async () =>
      dialog.getByRole("button", { name: "Invite to watch" }).click(),
    );
    await settle();
    expect(
      called(api, "POST /api/v1/tables/{code}/spectators")[0]!.options,
    ).toMatchObject({
      params: { path: { code: CODE } },
      body: { players: [cy.id] },
    });
    expect(panel.getByText("Invited cy to watch.")).toBeInTheDocument();
    const row = within(panel.getByRole("list", { name: "Invited to watch" }));
    expect(row.getByRole("listitem")).toHaveTextContent("cyInvited by you");

    await act(async () =>
      row
        .getByRole("button", { name: "Remove cy from the spectators" })
        .click(),
    );
    await settle();
    expect(
      called(api, "DELETE /api/v1/tables/{code}/spectators/{player_id}")[0]!
        .options,
    ).toMatchObject({ params: { path: { code: CODE, player_id: cy.id } } });
    expect(panel.queryByRole("list", { name: "Invited to watch" })).toBeNull();
  });

  it("shows one who may watch the way to the game, and lets them stop watching", async () => {
    const api = serve();
    const served = {
      table: table("outside", {
        status: "started",
        spectators: "invited",
        watching: true,
        game_id: GAME,
      }),
    };
    api.on("GET /api/v1/tables/{code}", () => reply(200, served.table));
    api.on("GET /api/v1/tables/{code}/spectators", () =>
      reply(
        200,
        list({
          can_invite: false,
          can_remove: false,
          invited: [
            invited(
              { ...cy, id: ada.id!, handle: "ada" },
              {
                invited_by: "bob",
                yours: false,
                you: true,
              },
            ),
            invited(dee, { invited_by: "eve", yours: false }),
          ],
        }),
      ),
    );
    api.on("DELETE /api/v1/tables/{code}/spectators/{player_id}", () => {
      served.table = table("outside", {
        status: "started",
        spectators: "invited",
      });
      return reply(200, list({ can_invite: false, can_remove: false }));
    });
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    const panel = within(screen.getByRole("region", { name: "Spectators" }));
    expect(panel.getByText(/You may watch this game, live\./)).toBeTruthy();
    expect(panel.getByRole("link", { name: "Watch the game" })).toHaveAttribute(
      "href",
      `#game/${GAME}`,
    );
    // Arriving at a running game does not open it unasked.
    expect(window.location.hash).toBe("");
    // The setting is the host's, and another's invitation is not theirs to withdraw.
    expect(panel.queryByLabelText("Who may watch")).toBeNull();
    expect(
      panel.queryByRole("button", { name: "Remove dee from the spectators" }),
    ).toBeNull();
    expect(
      panel.queryByRole("button", { name: "Invite friends to watch" }),
    ).toBeNull();
    await act(async () =>
      panel.getByRole("button", { name: "Stop watching this table" }).click(),
    );
    await settle();
    expect(
      called(api, "DELETE /api/v1/tables/{code}/spectators/{player_id}")[0]!
        .options,
    ).toMatchObject({ params: { path: { player_id: ada.id } } });
  });

  it("takes one who waited at the table to its game as it starts", async () => {
    vi.useFakeTimers();
    const api = serve();
    const served = {
      table: table("outside", { spectators: "invited", watching: true }),
    };
    api.on("GET /api/v1/tables/{code}", () => reply(200, served.table));
    api.on("GET /api/v1/tables/{code}/spectators", () =>
      reply(200, list({ can_invite: false, can_remove: false })),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(
      screen.getByText(/You may watch this table’s game once it starts/),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    served.table = table("outside", {
      status: "started",
      spectators: "invited",
      watching: true,
      game_id: GAME,
    });
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(window.location.hash).toBe(`#game/${GAME}`);
  });

  it("has no panel while spectators are not the account's to reach", async () => {
    const api = serve(false);
    api.on("GET /api/v1/tables/{code}", () =>
      reply(200, table("host", { spectators: "invited" })),
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(screen.queryByRole("region", { name: "Spectators" })).toBeNull();
    expect(called(api, "GET /api/v1/tables/{code}/spectators")).toHaveLength(0);
  });
});

describe("the lobby's games to watch", () => {
  it("lists the tables the account may watch: a running game to watch, a waiting table to open", async () => {
    const api = serve();
    serveLobby(api, [
      {
        code: CODE,
        format: "commander",
        host: "bob",
        players: ["bob", "eve"],
        game_id: GAME,
        invited: false,
        delay_seconds: 60,
      },
      {
        code: "Other-code_654321",
        format: "legacy",
        host: "cy",
        players: ["cy"],
        game_id: null,
        invited: true,
        delay_seconds: 0,
      },
    ]);
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    const section = within(
      screen.getByRole("region", { name: "Watch a game" }),
    );
    const rows = section.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent(
      "Commanderbob, eve · Open to anyone · a minute behind",
    );
    expect(
      section.getByRole("link", { name: "Watch bob's Commander table" }),
    ).toHaveAttribute("href", `#game/${GAME}`);
    expect(rows[1]).toHaveTextContent("Legacycy · You were invited · live");
    expect(
      section.getByRole("link", {
        name: "Open cy's Legacy table, which has not started",
      }),
    ).toHaveAttribute("href", "#tables/Other-code_654321");
  });

  it("is not shown with nothing to watch", async () => {
    const api = serve();
    serveLobby(api, []);
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    expect(screen.queryByRole("region", { name: "Watch a game" })).toBeNull();
  });
});
