import { act, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { mockApi, reply } from "../decks/fixtures";
import type { components } from "../generated/api";
import { PracticeTable } from "./PracticeTable";

type DeckSummary = components["schemas"]["DeckSummary"];

const sysop = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "sysop",
  status: "active",
  onboarding: "complete",
  handle: "sysop",
  display_name: "SysOp",
  email: null,
  avatar: "tower",
  locale: "en",
  csrf_token: "token",
  permissions: ["games.play", "decks.edit", "cards.any"],
  roles: ["sysop"],
  preferences: { large_text: false, reduced_motion: false },
} as unknown as Me;

const options = {
  formats: [
    {
      id: "legacy",
      name: "Legacy",
      bots: [1],
      default_bots: 1,
      decks: ["legacy-mono-red-burn"],
    },
    {
      id: "commander",
      name: "Commander",
      bots: [1, 2, 3],
      default_bots: 3,
      decks: ["commander-mono-red-raiders"],
    },
  ],
  deck_lists: true,
  own_decks: true,
};

function summary(fields: Partial<DeckSummary>): DeckSummary {
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
    updated_at: "2026-10-20T10:00:00Z",
    removed_cards: [],
    ...fields,
  };
}

/** Lets every answer already given, and the renders it causes, land. */
async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/**
 * The address a "Play it" link leads to. jsdom fires hashchange later, as a task: waiting for it
 * keeps it (and the previous test's reset to "") from reaching the table after it has mounted,
 * which a browser never does and which would ask for the deck a second time.
 */
async function navigate(hash: string) {
  await new Promise<void>((resolve) => {
    const arrived = (event: HashChangeEvent) => {
      if (!event.newURL.endsWith(hash)) return;
      window.removeEventListener("hashchange", arrived);
      resolve();
    };
    window.addEventListener("hashchange", arrived);
    window.location.hash = hash;
  });
}

/**
 * The table in StrictMode (as `pnpm dev`, and so the browser journeys, render it), opened by a
 * deck builder's "Play it" link. StrictMode runs the mount effects twice, so the options are
 * asked for twice; `late` (1 or 2) is the answer held back until the deck has been chosen.
 */
async function openTable(deck: DeckSummary, late: 1 | 2) {
  await navigate(`#play?deck=${deck.id}`);
  const api = mockApi();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const now = () => reply(200, structuredClone(options));
  const later = () => held.then(now);
  api.on(
    "GET /api/v1/practice-games/options",
    ...(late === 1 ? [later, now] : [now, later]),
  );
  api.on("GET /api/v1/decks", () => reply(200, [deck]));
  api.on("GET /api/v1/games", () => reply(200, []));
  render(
    <StrictMode>
      <PracticeTable me={sysop} />
    </StrictMode>,
  );
  await settle();
  await act(async () => release());
  await settle();
  return api;
}

afterEach(() => vi.restoreAllMocks());

describe("the practice table", () => {
  it.each([1, 2] as const)(
    "keeps the Commander deck a Play it link chose when options answer %i lands last (CI run #44)",
    async (late) => {
      const api = await openTable(
        summary({ id: "deck-9", title: "Kenrith", format: "commander" }),
        late,
      );
      expect(
        api.calls.filter(
          (c) => c.route === "GET /api/v1/practice-games/options",
        ),
      ).toHaveLength(2);
      expect(screen.getByRole("radio", { name: /Commander/ })).toBeChecked();
      expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-9");
      expect(screen.getByLabelText("Bots")).toHaveValue("3");
    },
  );

  it("keeps the Legacy deck a Play it link chose when an options answer lands last", async () => {
    await openTable(summary({ id: "deck-7", title: "Burn" }), 2);
    expect(screen.getByRole("radio", { name: /Legacy/ })).toBeChecked();
    expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-7");
  });

  it("offers SysOp the engine's fixture decks beside its own", async () => {
    await openTable(summary({ id: "deck-7", title: "Burn" }), 2);
    const deck = screen.getByLabelText("Your deck");
    expect(
      within(deck).getByRole("option", { name: "Any free fixture deck" }),
    ).toBeInTheDocument();
    expect(deck.querySelector('optgroup[label="Your decks"]')).not.toBeNull();
    expect(
      deck.querySelector('optgroup[label="Fixture decks"] option'),
    ).toHaveValue("legacy-mono-red-burn");
  });

  it("still clears the deck and sets that format's bots when the format changes", async () => {
    await openTable(
      summary({ id: "deck-9", title: "Kenrith", format: "commander" }),
      2,
    );
    await act(async () =>
      screen.getByRole("radio", { name: /Legacy/ }).click(),
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("");
    expect(screen.queryByLabelText("Bots")).toBeNull();
    await act(async () =>
      screen.getByRole("radio", { name: /Commander/ }).click(),
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("");
    expect(screen.getByLabelText("Bots")).toHaveValue("3");
  });
});

describe("the practice table for a player (v0.3.1)", () => {
  const player = {
    ...sysop,
    kind: "player",
    handle: "pat",
    permissions: ["games.play", "decks.edit", "profile.edit"],
    roles: ["player"],
  } as unknown as Me;
  // The engine's fixture decks are SysOp's alone: a player's lists are empty.
  const playerOptions = {
    ...options,
    formats: options.formats.map((f) => ({ ...f, decks: [] })),
    deck_lists: false,
  };
  const starters = [
    summary({
      id: "deck-a",
      title: "Skyward Patrol",
      format: "commander",
      card_count: 100,
    }),
    summary({
      id: "deck-b",
      title: "Graveyard Shift",
      format: "commander",
      card_count: 100,
    }),
  ];

  async function sitDown(decks: DeckSummary[]) {
    await navigate("#play");
    const api = mockApi();
    api.on("GET /api/v1/practice-games/options", () =>
      reply(200, structuredClone(playerOptions)),
    );
    api.on("GET /api/v1/decks", () => reply(200, decks));
    api.on("GET /api/v1/games", () => reply(200, []));
    api.on("POST /api/v1/practice-games", () =>
      reply(503, { code: "games_busy", message: "Busy." }),
    );
    render(
      <StrictMode>
        <PracticeTable me={player} />
      </StrictMode>,
    );
    await settle();
    return api;
  }

  it("lists only their own decks, opens where they have one and plays the first", async () => {
    const api = await sitDown(starters);
    // Their only playable decks are the Commander starter decks.
    expect(screen.getByRole("radio", { name: /Commander/ })).toBeChecked();
    const deck = screen.getByLabelText("Your deck");
    expect(deck).toHaveValue("own:deck-a");
    expect(
      within(deck)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Skyward Patrol", "Graveyard Shift"]);
    // No empty group for the fixture decks, and no fixture deck to fall back on.
    expect(deck.querySelectorAll("optgroup")).toHaveLength(1);
    expect(screen.queryByText(/fixture deck/i)).toBeNull();
    // The bots' decks are the table's choice: Commander bots play the starter decks.
    const bot = screen.getByLabelText("Bot 1's deck");
    expect(bot).toHaveValue("");
    expect(
      within(bot).getByRole("option", { name: "Chosen by the table" }),
    ).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Start the game" }).click(),
    );
    await settle();
    const started = api.calls.find(
      (c) => c.route === "POST /api/v1/practice-games",
    )!;
    expect(started.options).toMatchObject({
      body: { format: "commander", deck_id: "deck-a", bots: [{}, {}, {}] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/busy/);
  });

  it("plays by casual rules unless the player chooses others (v0.4.5)", async () => {
    const api = await sitDown([
      summary({
        id: "deck-l",
        title: "Lotus Storm",
        format: "commander",
        needs: ["banned"],
      }),
      ...starters,
    ]);
    const deck = screen.getByLabelText("Your deck");
    expect(deck).toHaveValue("own:deck-l");
    await act(async () =>
      screen.getByRole("checkbox", { name: /^Banned cards/ }).click(),
    );
    expect(
      within(deck).getByRole("option", {
        name: "Lotus Storm (holds banned cards)",
      }),
    ).toBeDisabled();
    expect(deck).toHaveValue("own:deck-a");
    expect(
      screen.getByRole("checkbox", { name: /^Tournament rules/ }),
    ).not.toBeChecked();
    await act(async () =>
      screen.getByRole("button", { name: "Start the game" }).click(),
    );
    await settle();
    const started = api.calls.find(
      (c) => c.route === "POST /api/v1/practice-games",
    )!;
    expect(started.options).toMatchObject({
      body: { deck_id: "deck-a", rules: { banned: false, not_legal: true } },
    });
  });

  it("says which decks need cards the library does not hold", async () => {
    await sitDown([
      summary({ id: "deck-a", title: "Skyward Patrol", format: "commander" }),
      summary({
        id: "deck-b",
        title: "Borrowed Burn",
        format: "commander",
        playable: false,
        collection_locked: true,
      }),
    ]);
    const locked = within(screen.getByLabelText("Your deck")).getByRole(
      "option",
      { name: "Borrowed Burn (needs cards you don't own)" },
    );
    expect(locked).toBeDisabled();
  });

  it("is told to build or fix a deck when they have none to play", async () => {
    await sitDown([
      summary({ id: "deck-c", title: "Half built", playable: false }),
    ]);
    expect(screen.getByRole("radio", { name: /Legacy/ })).toBeChecked();
    expect(screen.queryByLabelText("Your deck")).toBeNull();
    expect(
      screen.getByText(/You have no playable Legacy deck yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Decks" })).toHaveAttribute(
      "href",
      "#decks",
    );
    expect(
      screen.getByRole("button", { name: "Start the game" }),
    ).toBeDisabled();
  });

  it("says so for the format they choose, too", async () => {
    await sitDown(starters);
    await act(async () =>
      screen.getByRole("radio", { name: /Legacy/ }).click(),
    );
    expect(
      screen.getByText(/You have no playable Legacy deck yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start the game" }),
    ).toBeDisabled();
    await act(async () =>
      screen.getByRole("radio", { name: /Commander/ }).click(),
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-a");
    expect(
      screen.getByRole("button", { name: "Start the game" }),
    ).toBeEnabled();
  });
});

describe("best of three at the practice table (v0.5.0)", () => {
  it("offers Legacy a best-of-three match, and leads back to a running one", async () => {
    await navigate("#play");
    const api = mockApi();
    api.on("GET /api/v1/practice-games/options", () =>
      reply(200, {
        ...structuredClone(options),
        formats: options.formats.map((f) => ({
          ...f,
          best_of: f.id === "legacy" ? [1, 3] : [1],
        })),
      }),
    );
    api.on("GET /api/v1/decks", () =>
      reply(200, [summary({ id: "deck-r", title: "Red", format: "legacy" })]),
    );
    api.on("GET /api/v1/games", () => reply(200, []));
    api.on("GET /api/v1/matches", () =>
      reply(200, [
        {
          id: "00000000-0000-4000-8000-00000000aaaa",
          kind: "practice",
          format: "legacy",
          best_of: 3,
          status: "sideboarding",
          game_number: 2,
          players: [
            { seat: 0, player: "human", handle: "root" },
            { seat: 1, player: "bot", handle: null },
          ].map((seat, index) => ({
            ...seat,
            portrait: null,
            you: index === 0,
            game_wins: index === 0 ? 1 : 0,
            ready: index === 1,
            left: null,
            deck_cards: null,
          })),
          games: [],
          your_seat: 0,
          game_id: null,
          chooser_seat: 1,
          starting_seat: 1,
          sideboard_until: null,
          winner_seat: null,
          draw: false,
          end_reason: null,
          waiting: null,
          created_at: "2026-10-22T10:00:00Z",
          finished_at: null,
        },
      ]),
    );
    api.on("POST /api/v1/practice-games", () =>
      reply(503, { code: "games_busy", message: "Busy." }),
    );
    render(<PracticeTable me={sysop} />);
    await settle();
    const matches = screen.getByRole("list", { name: "Your matches" });
    expect(matches).toHaveTextContent(
      "Best of three · 1–0 · Sideboarding for game 2",
    );
    expect(
      within(matches).getByRole("link", { name: "Resume" }),
    ).toHaveAttribute("href", "#match/00000000-0000-4000-8000-00000000aaaa");
    // Conceding it asks first (v0.5.1): Keep playing sends nothing.
    const dialogs = HTMLDialogElement.prototype;
    dialogs.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    dialogs.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    api.on("POST /api/v1/matches/{match_id}/concede", () => reply(200, {}));
    await act(async () =>
      within(matches)
        .getByRole("button", { name: "Concede the match" })
        .click(),
    );
    const confirm = screen.getByRole("dialog", { name: "Concede the match?" });
    expect(confirm).toHaveTextContent(
      "You lose the match. The games you won still count.",
    );
    await act(async () =>
      within(confirm).getByRole("button", { name: "Keep playing" }).click(),
    );
    expect(
      api.calls.filter((c) => c.route.startsWith("POST /api/v1/matches")),
    ).toEqual([]);
    await act(async () =>
      within(matches)
        .getByRole("button", { name: "Concede the match" })
        .click(),
    );
    await act(async () =>
      within(screen.getByRole("dialog", { name: "Concede the match?" }))
        .getByRole("button", { name: "Concede the match" })
        .click(),
    );
    await settle();
    expect(
      api.calls.find(
        (c) => c.route === "POST /api/v1/matches/{match_id}/concede",
      )!.options,
    ).toMatchObject({
      params: { path: { match_id: "00000000-0000-4000-8000-00000000aaaa" } },
    });
    expect(screen.getByRole("radio", { name: /^One game/ })).toBeChecked();
    await act(async () =>
      screen.getByRole("radio", { name: /^Best of three/ }).click(),
    );
    await act(async () =>
      screen.getByRole("button", { name: "Start the game" }).click(),
    );
    await settle();
    const started = api.calls.find(
      (c) => c.route === "POST /api/v1/practice-games",
    )!;
    expect(started.options).toMatchObject({
      body: { format: "legacy", best_of: 3 },
    });
    // Commander plays one game.
    await act(async () =>
      screen.getByRole("radio", { name: /Commander/ }).click(),
    );
    expect(screen.queryByRole("radio", { name: /^Best of three/ })).toBeNull();
  });
});

describe("Two-Headed Giant at the practice table (v0.5.0, early)", () => {
  const player = {
    ...sysop,
    kind: "player",
    handle: "pat",
    permissions: ["games.play", "decks.edit", "profile.edit"],
    roles: ["player"],
  } as unknown as Me;
  const giantOptions = {
    formats: [
      ...options.formats.map((f) => ({ ...f, decks: [], best_of: [1] })),
      {
        id: "two_headed_giant",
        name: "Two-Headed Giant",
        bots: [3],
        default_bots: 3,
        decks: [],
        best_of: [1],
      },
    ],
    deck_lists: false,
    own_decks: true,
  };
  const legacy = summary({ id: "deck-l", title: "Red deck", format: "legacy" });
  const commander = summary({
    id: "deck-c",
    title: "Skyward Patrol",
    format: "commander",
    card_count: 100,
  });
  const finished = {
    id: "game-1",
    kind: "practice",
    format: "two_headed_giant",
    status: "finished",
    seats: [
      { seat: 0, player: "human", handle: "pat", deck: "Red deck" },
      { seat: 1, player: "bot", handle: null, deck: null },
      { seat: 2, player: "bot", handle: null, deck: null },
      { seat: 3, player: "bot", handle: null, deck: null },
    ],
    your_seat: 0,
    bot_skill: 4,
    turn_cap: 60,
    created_at: "2026-10-22T10:00:00Z",
    finished_at: "2026-10-22T10:20:00Z",
    result: {
      kind: "completed",
      winner_seat: 0,
      winner_seats: [0, 1],
      draw: false,
      turns: 11,
      conceded_seats: [],
    },
    tokens: 28,
  };

  it("plays the player's Legacy decks with a bot teammate against two bots", async () => {
    await navigate("#play");
    const api = mockApi();
    api.on("GET /api/v1/practice-games/options", () =>
      reply(200, structuredClone(giantOptions)),
    );
    api.on("GET /api/v1/decks", () => reply(200, [legacy, commander]));
    api.on("GET /api/v1/games", () => reply(200, [finished]));
    api.on("GET /api/v1/matches", () => reply(200, []));
    api.on("POST /api/v1/practice-games", () =>
      reply(503, { code: "games_busy", message: "Busy." }),
    );
    render(
      <StrictMode>
        <PracticeTable me={player} />
      </StrictMode>,
    );
    await settle();
    const giant = screen.getByRole("radio", { name: /Two-Headed Giant/ });
    expect(giant.closest("label")).toHaveTextContent(
      "Early · a bot teammate against two bots, 30 life a team",
    );
    await act(async () => giant.click());
    // Two-Headed Giant plays Legacy decks: the player's own, not the Commander one.
    const deck = screen.getByLabelText("Your deck");
    expect(deck).toHaveValue("own:deck-l");
    expect(
      within(deck)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Red deck"]);
    expect(screen.queryByLabelText("Bots")).toBeNull();
    for (const label of [
      "Teammate's deck",
      "Opponent 1's deck",
      "Opponent 2's deck",
    ])
      expect(screen.getByLabelText(label)).toHaveValue("");
    await act(async () =>
      screen.getByRole("button", { name: "Start the game" }).click(),
    );
    await settle();
    const started = api.calls.find(
      (c) => c.route === "POST /api/v1/practice-games",
    )!;
    expect(started.options).toMatchObject({
      body: {
        format: "two_headed_giant",
        deck_id: "deck-l",
        bots: [{}, {}, {}],
      },
    });
    // A game the team won: the player won it too.
    const game = screen
      .getAllByText("Two-Headed Giant")
      .map((element) => element.closest("li"))
      .find((item) => item !== null);
    expect(game).toHaveTextContent("Won in 11 turns");
  });
});
