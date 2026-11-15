import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { mockApi, reply } from "../decks/fixtures";
import type { components } from "../generated/api";
import { GamesList } from "./GamesList";
import { PlayWizard } from "./PlayWizard";

type DeckSummary = components["schemas"]["DeckSummary"];

const sysop = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "sysop",
  status: "active",
  onboarding: "complete",
  tutorial: { path: null, stage: "done", skipped: false },
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

/** Goes to a slide by its name along the top of the wizard. */
async function goTo(name: string) {
  await act(async () =>
    screen
      .getByRole("button", {
        name: new RegExp(`^Slide \\d+ of \\d+: ${name}$`),
      })
      .click(),
  );
}
/** The wizard's slides, as their names along the top. */
function slideNames(): string[] {
  return within(screen.getByRole("list", { name: "The Play wizard's slides" }))
    .getAllByRole("button")
    .map((button) => button.querySelector("em")?.textContent ?? "");
}
/** The last slide's summary line for a slide, by its name. */
function chosen(name: string): HTMLElement {
  const term = within(screen.getByLabelText("What you chose")).getByText(name, {
    selector: "dt",
  });
  return term.parentElement as HTMLElement;
}
/** Presses "Start Game" on the last slide. */
async function startGame() {
  await goTo("Start Game");
  await act(async () =>
    screen.getByRole("button", { name: "Start Game" }).click(),
  );
  await settle();
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
      <PlayWizard me={sysop} />
    </StrictMode>,
  );
  await settle();
  await act(async () => release());
  await settle();
  return api;
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the Play wizard, opened by a Play it link", () => {
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
      // The link leads to the last slide, the deck it asked for chosen (v1.0.0).
      expect(
        screen.getByRole("heading", { name: "Ready to play" }),
      ).toBeInTheDocument();
      expect(chosen("Format")).toHaveTextContent("Commander");
      expect(chosen("Your deck")).toHaveTextContent("Kenrith");
      expect(chosen("The bots")).toHaveTextContent("3 bots at skill 4 of 6");
      await goTo("Format");
      expect(screen.getByRole("radio", { name: /Commander/ })).toBeChecked();
      await goTo("Your deck");
      expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-9");
      await goTo("The bots");
      expect(screen.getByLabelText("Bots")).toHaveValue("3");
    },
  );

  it("keeps the Legacy deck a Play it link chose when an options answer lands last", async () => {
    await openTable(summary({ id: "deck-7", title: "Burn" }), 2);
    expect(chosen("Your deck")).toHaveTextContent("Burn");
    await goTo("Format");
    expect(screen.getByRole("radio", { name: /Legacy/ })).toBeChecked();
    await goTo("Your deck");
    expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-7");
  });

  it("offers SysOp the engine's fixture decks beside its own", async () => {
    await openTable(summary({ id: "deck-7", title: "Burn" }), 2);
    await goTo("Your deck");
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
    await goTo("Format");
    await act(async () =>
      screen.getByRole("radio", { name: /Legacy/ }).click(),
    );
    await goTo("Your deck");
    expect(screen.getByLabelText("Your deck")).toHaveValue("");
    await goTo("The bots");
    expect(screen.queryByLabelText("Bots")).toBeNull();
    await goTo("Format");
    await act(async () =>
      screen.getByRole("radio", { name: /Commander/ }).click(),
    );
    await goTo("Your deck");
    expect(screen.getByLabelText("Your deck")).toHaveValue("");
    await goTo("The bots");
    expect(screen.getByLabelText("Bots")).toHaveValue("3");
  });
});

describe("the Play wizard for a player (v0.3.1)", () => {
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
        <PlayWizard me={player} />
      </StrictMode>,
    );
    await settle();
    return api;
  }

  it("lists only their own decks, opens where they have one and plays the first", async () => {
    const api = await sitDown(starters);
    // Their only playable decks are the Commander starter decks.
    expect(screen.getByRole("radio", { name: /Commander/ })).toBeChecked();
    await goTo("Your deck");
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
    await goTo("The bots");
    const bot = screen.getByLabelText("Bot 1's deck");
    expect(bot).toHaveValue("");
    expect(
      within(bot).getByRole("option", { name: "Chosen by the table" }),
    ).toBeInTheDocument();
    await startGame();
    const started = api.calls.find(
      (c) => c.route === "POST /api/v1/practice-games",
    )!;
    expect(started.options).toMatchObject({
      body: { format: "commander", deck_id: "deck-a", bots: [{}, {}, {}] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/busy/);
  });

  it("gives a game 40 turns for each player unless the player types a limit (v0.9.7)", async () => {
    const api = await sitDown(starters);
    const limit = () => screen.getByRole("spinbutton", { name: /^Turn limit/ });
    const setBots = async (count: string) => {
      await goTo("The bots");
      fireEvent.change(screen.getByLabelText("Bots"), {
        target: { value: count },
      });
      await goTo("The table's rules");
    };
    // Commander against three bots: four players, 160 turns.
    await goTo("The table's rules");
    expect(limit()).toHaveValue(160);
    expect(limit().closest("label")).toHaveTextContent(
      "40 turns for each player",
    );
    // The limit follows the table: one bot is a duel, 80 turns.
    await setBots("1");
    expect(limit()).toHaveValue(80);
    await setBots("2");
    expect(limit()).toHaveValue(120);
    await startGame();
    expect(chosen("The table's rules")).toHaveTextContent(
      "120 turns (40 for each player)",
    );
    const started = () =>
      api.calls
        .filter((c) => c.route === "POST /api/v1/practice-games")
        .map((c) => (c.options as { body: Record<string, unknown> }).body);
    // Nothing typed: no limit is sent, and the API gives the table its own.
    expect(started()[0]).not.toHaveProperty("turn_cap");
    // A limit the player types is theirs, whatever the table: it is sent, and it stays when
    // the bots change. The field then says what the table's own would be.
    await goTo("The table's rules");
    fireEvent.change(limit(), { target: { value: "25" } });
    expect(limit().closest("label")).toHaveTextContent(
      "instead of the table's 120",
    );
    await setBots("3");
    expect(limit()).toHaveValue(25);
    await startGame();
    expect(chosen("The table's rules")).toHaveTextContent("25 turns");
    expect(started()[1]).toMatchObject({ turn_cap: 25 });
    // More than the most a game may ask is that most; an emptied field is the table's again.
    await goTo("The table's rules");
    fireEvent.change(limit(), { target: { value: "9999" } });
    expect(limit()).toHaveValue(400);
    fireEvent.change(limit(), { target: { value: "" } });
    expect(limit()).toHaveValue(160);
    await startGame();
    expect(started()[2]).not.toHaveProperty("turn_cap");
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
    await goTo("Your deck");
    expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-l");
    await goTo("The table's rules");
    await act(async () =>
      screen.getByRole("checkbox", { name: /^Banned cards/ }).click(),
    );
    expect(
      screen.getByRole("checkbox", { name: /^Tournament rules/ }),
    ).not.toBeChecked();
    // The rules come before the deck: one they refuse is greyed, with the reason.
    await goTo("Your deck");
    const deck = screen.getByLabelText("Your deck");
    expect(
      within(deck).getByRole("option", {
        name: "Lotus Storm (holds banned cards)",
      }),
    ).toBeDisabled();
    expect(deck).toHaveValue("own:deck-a");
    await startGame();
    expect(chosen("The table's rules")).toHaveTextContent(
      "Cards not legal in Commander and stand-ins allowed",
    );
    const started = api.calls.find(
      (c) => c.route === "POST /api/v1/practice-games",
    )!;
    expect(started.options).toMatchObject({
      body: {
        deck_id: "deck-a",
        rules: { banned: false, not_legal: true, stand_in: true },
      },
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
    await goTo("Your deck");
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
    await goTo("Your deck");
    expect(screen.queryByLabelText("Your deck")).toBeNull();
    expect(
      screen.getByText(/You have no playable Legacy deck yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Decks" })).toHaveAttribute(
      "href",
      "#decks",
    );
    // The slide does not move on without a deck, and says why; nor does the last one start.
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByText("You need a deck to go on.")).toBeInTheDocument();
    await goTo("Start Game");
    expect(chosen("Your deck")).toHaveTextContent("No playable Legacy deck");
    expect(screen.getByRole("button", { name: "Start Game" })).toBeDisabled();
    expect(screen.getByText("Choose a deck to start.")).toBeInTheDocument();
  });

  it("says so for the format they choose, too", async () => {
    await sitDown(starters);
    await act(async () =>
      screen.getByRole("radio", { name: /Legacy/ }).click(),
    );
    await goTo("Your deck");
    expect(
      screen.getByText(/You have no playable Legacy deck yet/),
    ).toBeInTheDocument();
    await goTo("Start Game");
    expect(screen.getByRole("button", { name: "Start Game" })).toBeDisabled();
    await goTo("Format");
    await act(async () =>
      screen.getByRole("radio", { name: /Commander/ }).click(),
    );
    await goTo("Your deck");
    expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-a");
    await goTo("Start Game");
    expect(screen.getByRole("button", { name: "Start Game" })).toBeEnabled();
  });
});

describe("best of three in the Play wizard (v0.5.0)", () => {
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
    render(<PlayWizard me={sysop} />);
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
    // Legacy has matches: the wizard has a Games slide for it.
    expect(slideNames()).toEqual([
      "Format",
      "Games",
      "The table's rules",
      "Your deck",
      "The bots",
      "Start Game",
    ]);
    await goTo("Games");
    expect(screen.getByRole("radio", { name: /^One game/ })).toBeChecked();
    await act(async () =>
      screen.getByRole("radio", { name: /^Best of three/ }).click(),
    );
    await startGame();
    expect(chosen("Games")).toHaveTextContent("Best of three");
    const started = api.calls.find(
      (c) => c.route === "POST /api/v1/practice-games",
    )!;
    expect(started.options).toMatchObject({
      body: { format: "legacy", best_of: 3 },
    });
    // Commander plays one game: a slide with one possible answer is left out.
    await goTo("Format");
    await act(async () =>
      screen.getByRole("radio", { name: /Commander/ }).click(),
    );
    expect(slideNames()).not.toContain("Games");
  });
});

describe("Two-Headed Giant in the Play wizard (v0.5.0)", () => {
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
        <PlayWizard me={player} />
      </StrictMode>,
    );
    await settle();
    const giant = screen.getByRole("radio", { name: /Two-Headed Giant/ });
    expect(giant.closest("label")).toHaveTextContent(
      "A bot teammate against two bots, 30 life a team",
    );
    await act(async () => giant.click());
    // Two-Headed Giant plays Legacy decks: the player's own, not the Commander one. It is their
    // one Legacy deck, so the wizard has no slide to ask for it (v1.0.0).
    expect(slideNames()).toEqual([
      "Format",
      "The table's rules",
      "The bots",
      "Start Game",
    ]);
    await goTo("The bots");
    expect(screen.queryByLabelText("Bots")).toBeNull();
    for (const label of [
      "Teammate's deck",
      "Opponent 1's deck",
      "Opponent 2's deck",
    ])
      expect(screen.getByLabelText(label)).toHaveValue("");
    await startGame();
    expect(chosen("Your deck")).toHaveTextContent("Red deck");
    expect(
      within(chosen("Your deck")).queryByRole("button", { name: /Change/ }),
    ).toBeNull();
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
  });

  it("lists a game the team won as won by the player, among their games", async () => {
    const api = mockApi();
    api.on("GET /api/v1/games", () => reply(200, [finished]));
    api.on("GET /api/v1/matches", () => reply(200, []));
    render(<GamesList me={player} />);
    await settle();
    const list = screen.getByRole("region", { name: "Your games" });
    expect(
      within(list).getByText("Two-Headed Giant").closest("li"),
    ).toHaveTextContent("Won in 11 turns");
  });
});

describe("King's Table in the Play wizard (v0.8.7)", () => {
  const kingsFormat = {
    id: "kings_table",
    name: "King's Table",
    bots: [5],
    default_bots: 5,
    best_of: [1],
    kings_table: {
      deck_format: "commander",
      life: "all_40",
      king_attacks_anyone: false,
    },
  };
  const legacy = summary({ id: "deck-l", title: "Red deck", format: "legacy" });
  const commander = summary({
    id: "deck-c",
    title: "Skyward Patrol",
    format: "commander",
    card_count: 100,
  });
  const allFixtures = [
    "legacy-mono-red-burn",
    "legacy-mono-blue-skies",
    "commander-mono-red-raiders",
    "commander-mono-blue-flyers",
  ];

  async function open(me: Me, decks: string[]) {
    await navigate("#play");
    const api = mockApi();
    api.on("GET /api/v1/practice-games/options", () =>
      reply(200, {
        formats: [
          ...options.formats,
          { ...kingsFormat, decks: structuredClone(decks) },
        ],
        deck_lists: false,
        own_decks: true,
      }),
    );
    api.on("GET /api/v1/decks", () => reply(200, [legacy, commander]));
    api.on("GET /api/v1/games", () => reply(200, []));
    api.on("GET /api/v1/matches", () => reply(200, []));
    api.on("POST /api/v1/practice-games", () =>
      reply(503, { code: "games_busy", message: "Busy." }),
    );
    render(<PlayWizard me={me} />);
    await settle();
    const choice = screen.getByRole("radio", { name: /King's Table/ });
    expect(choice.closest("label")).toHaveTextContent(
      "Five bots: two teams of three, a King and two Generals each, in the seat you choose",
    );
    await act(async () => choice.click());
    return api;
  }

  it("plays you and five bots in the seat and with the settings you choose", async () => {
    const player = {
      ...sysop,
      kind: "player",
      handle: "pat",
      permissions: ["games.play", "decks.edit", "profile.edit"],
      roles: ["player"],
    } as unknown as Me;
    const api = await open(player, []);
    // King's Table has a slide for the seat; the player's one Commander deck needs none.
    expect(slideNames()).toEqual([
      "Format",
      "The table's rules",
      "Your seat",
      "The bots",
      "Start Game",
    ]);
    // Commander decks by default: the player's Commander deck, not the Legacy one.
    await goTo("Start Game");
    expect(chosen("Your deck")).toHaveTextContent("Skyward Patrol");
    // Each life preset says what it gives, and each seat its team, role and starting life.
    await goTo("The table's rules");
    expect(
      screen
        .getByRole("radio", { name: /^Generals 20, Kings 40/ })
        .closest("label"),
    ).toHaveTextContent("Each General starts at 20 life, each King at 40");
    await act(async () =>
      screen.getByRole("radio", { name: /^Generals 20, Kings 40/ }).click(),
    );
    await goTo("Your seat");
    expect(screen.getByRole("radio", { name: /^Team A's King/ })).toBeChecked();
    expect(
      screen
        .getByRole("radio", { name: /^Team B's Left General/ })
        .closest("label"),
    ).toHaveTextContent("20 life to start");
    await act(async () =>
      screen.getByRole("radio", { name: /^Team B's Right General/ }).click(),
    );
    // The five bots, in seat order without yours.
    await goTo("The bots");
    expect(screen.queryByLabelText("Bots")).toBeNull();
    for (const label of [
      "Deck for Team A's Left General",
      "Deck for Team A's King",
      "Deck for Team A's Right General",
      "Deck for Team B's King",
      "Deck for Team B's Left General",
    ])
      expect(screen.getByLabelText(label)).toHaveValue("");
    // Legacy decks instead: the player's Legacy deck.
    await goTo("The table's rules");
    await act(async () =>
      screen.getByRole("radio", { name: /^Legacy decks/ }).click(),
    );
    // The house rule's guard (v0.9.7) belongs to the house rule: it is offered only with it.
    const guard = () =>
      screen.getByRole("checkbox", { name: /^Generals guard their King/ });
    expect(guard()).toBeDisabled();
    expect(guard()).not.toBeChecked();
    await act(async () =>
      screen.getByRole("checkbox", { name: /^King can attack anyone/ }).click(),
    );
    expect(guard()).toBeEnabled();
    expect(guard().closest("label")).toHaveTextContent(
      "Except the other King, whom a King's creatures may attack only once one of that King's Generals is defeated",
    );
    await act(async () => guard().click());
    expect(guard()).toBeChecked();
    // Six players at 40 turns each (v0.9.7).
    expect(screen.getByRole("spinbutton", { name: /^Turn limit/ })).toHaveValue(
      240,
    );
    await startGame();
    expect(chosen("Your deck")).toHaveTextContent("Red deck");
    expect(chosen("Your seat")).toHaveTextContent(
      "Team B's Right General · 20 life to start",
    );
    const started = api.calls.filter(
      (c) => c.route === "POST /api/v1/practice-games",
    );
    expect(started[0]!.options).toMatchObject({
      body: {
        format: "kings_table",
        seat: 3,
        deck_id: "deck-l",
        best_of: 1,
        bots: [{}, {}, {}, {}, {}],
        kings_table: {
          deck_format: "legacy",
          life: "generals_20_kings_40",
          king_attacks_anyone: true,
          guarded_kings: true,
        },
      },
    });
    // The house rule off again takes its guard with it.
    await goTo("The table's rules");
    await act(async () =>
      screen.getByRole("checkbox", { name: /^King can attack anyone/ }).click(),
    );
    expect(guard()).not.toBeChecked();
    expect(guard()).toBeDisabled();
    await startGame();
    expect(started.length).toBe(1);
    expect(
      api.calls.filter((c) => c.route === "POST /api/v1/practice-games")[1]!
        .options,
    ).toMatchObject({
      body: {
        kings_table: { king_attacks_anyone: false, guarded_kings: false },
      },
    });
  });

  it("offers SysOp the fixture decks of the chosen deck format, for each bot", async () => {
    await open(sysop, allFixtures);
    await goTo("The bots");
    const fixtures = (label: string) =>
      within(screen.getByLabelText(label))
        .getAllByRole("option")
        .map((o) => o.textContent);
    expect(fixtures("Deck for Team B's King")).toEqual([
      "Chosen by the table",
      "Skyward Patrol",
      "Mono-red raiders",
      "Mono-blue flyers",
    ]);
    await goTo("The table's rules");
    await act(async () =>
      screen.getByRole("radio", { name: /^Legacy decks/ }).click(),
    );
    await goTo("The bots");
    expect(fixtures("Deck for Team B's King")).toEqual([
      "Chosen by the table",
      "Red deck",
      "Mono-red burn",
      "Mono-blue skies",
    ]);
    await goTo("Your deck");
    expect(fixtures("Your deck")).toEqual([
      "Any free fixture deck",
      "Red deck",
      "Mono-red burn",
      "Mono-blue skies",
    ]);
  });
});

describe("closing the campaign's court among your games (v0.9.8)", () => {
  type GameSummary = components["schemas"]["GameSummary"];
  const player = {
    ...sysop,
    kind: "player",
    handle: "pat",
    permissions: ["games.play", "decks.edit", "profile.edit"],
    roles: ["player"],
  } as unknown as Me;

  function running(id: string, encounter: number): GameSummary {
    return {
      id,
      status: "active",
      kind: "practice",
      format: encounter === 15 ? "kings_table" : "commander",
      your_seat: encounter === 15 ? 1 : 0,
      seats: [
        { seat: 0, player: "bot", handle: null, deck: null, left: null },
        { seat: 1, player: "human", handle: "pat", deck: null, left: null },
      ],
      campaign: {
        encounter,
        opponent: "sphinx",
        name: "The Sphinx",
        title: encounter === 15 ? "The Unbound Court" : "The Fractured Throne",
        hints: false,
        deck: "own",
        finale: "public",
        outcome: null,
        challenge: false,
      },
      match: null,
      kings_table: null,
      result: null,
      created_at: new Date().toISOString(),
    } as unknown as GameSummary;
  }

  async function open(games: GameSummary[]) {
    await navigate("#play/games");
    const api = mockApi();
    api.on("GET /api/v1/matches", () => reply(200, []));
    api.on("GET /api/v1/games", () => reply(200, games));
    api.on("POST /api/v1/games/{game_id}/close", () => reply(200, {}));
    const dialogs = HTMLDialogElement.prototype;
    dialogs.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    dialogs.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
    render(
      <StrictMode>
        <GamesList me={player} />
      </StrictMode>,
    );
    await settle();
    return api;
  }

  const closes = (api: ReturnType<typeof mockApi>) =>
    api.calls.filter((call) => call.route.endsWith("/close")).length;

  it("asks first, since a court its player closes is a court lost", async () => {
    const api = await open([
      running("00000000-0000-4000-8000-00000000c015", 15),
    ]);
    await act(async () =>
      screen.getByRole("button", { name: "Close" }).click(),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Close the court and lose it?",
    });
    expect(dialog).toHaveTextContent("you go back to ward 14");
    expect(dialog).toHaveTextContent("for an hour is lost the same way");
    expect(closes(api)).toBe(0);
    // Keeping the court sends nothing.
    await act(async () =>
      within(dialog).getByRole("button", { name: "Keep the court" }).click(),
    );
    await settle();
    expect(closes(api)).toBe(0);
    // Closing it is said once more on the button, and then sent.
    await act(async () =>
      screen.getByRole("button", { name: "Close" }).click(),
    );
    await act(async () =>
      within(
        screen.getByRole("dialog", { name: "Close the court and lose it?" }),
      )
        .getByRole("button", { name: "Close and lose it" })
        .click(),
    );
    await settle();
    expect(closes(api)).toBe(1);
  });

  it("closes any other game at once, a ward's duel included", async () => {
    const api = await open([
      running("00000000-0000-4000-8000-00000000c014", 14),
    ]);
    await act(async () =>
      screen.getByRole("button", { name: "Close" }).click(),
    );
    await settle();
    expect(closes(api)).toBe(1);
    expect(
      screen.queryByRole("dialog", { name: "Close the court and lose it?" }),
    ).toBeNull();
  });
});

describe("the Play wizard's slides (v1.0.0)", () => {
  const player = {
    ...sysop,
    id: "00000000-0000-4000-8000-000000000002",
    kind: "player",
    handle: "pat",
    permissions: ["games.play", "decks.edit", "profile.edit"],
    roles: ["player"],
  } as unknown as Me;
  const playerOptions = {
    ...options,
    formats: options.formats.map((f) => ({ ...f, decks: [] })),
    deck_lists: false,
  };
  const decks = [
    summary({ id: "deck-a", title: "Skyward Patrol", format: "commander" }),
    summary({ id: "deck-b", title: "Graveyard Shift", format: "commander" }),
  ];
  const running = {
    id: "00000000-0000-4000-8000-0000000000aa",
    kind: "practice",
    format: "commander",
    status: "active",
    your_seat: 0,
    seats: [
      { seat: 0, player: "human", handle: "pat", deck: null, left: null },
      { seat: 1, player: "bot", handle: null, deck: null, left: null },
    ],
    campaign: null,
    match: null,
    kings_table: null,
    result: null,
    created_at: new Date().toISOString(),
  };

  async function open(games: unknown[] = []) {
    await navigate("#play");
    const api = mockApi();
    api.on("GET /api/v1/practice-games/options", () =>
      reply(200, structuredClone(playerOptions)),
    );
    api.on("GET /api/v1/decks", () => reply(200, decks));
    api.on("GET /api/v1/games", () => reply(200, games));
    api.on("GET /api/v1/matches", () => reply(200, []));
    api.on("POST /api/v1/practice-games", () =>
      reply(201, { id: "00000000-0000-4000-8000-00000000beef" }),
    );
    const view = render(
      <StrictMode>
        <PlayWizard me={player} />
      </StrictMode>,
    );
    await settle();
    return { api, view };
  }
  const posted = (api: ReturnType<typeof mockApi>) =>
    api.calls
      .filter((c) => c.route === "POST /api/v1/practice-games")
      .map((c) => (c.options as { body: Record<string, unknown> }).body);

  it("asks one thing a slide, named and numbered, with Back and Next", async () => {
    await open();
    expect(slideNames()).toEqual([
      "Format",
      "The table's rules",
      "Your deck",
      "The bots",
      "Start Game",
    ]);
    const wizard = screen.getByRole("region", {
      name: "Which format do you play?",
    });
    expect(wizard).toHaveTextContent("PLAY · SLIDE 1 OF 5");
    expect(
      screen
        .getByRole("button", { name: "Slide 1 of 5: Format" })
        .closest("li"),
    ).toHaveAttribute("aria-current", "step");
    // The first slide has no way back: the account's games are opened from there instead.
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("link", { name: "Your games" })).toHaveAttribute(
      "href",
      "#play/games",
    );
    // Only this slide's question is asked.
    expect(screen.queryByLabelText("Your deck")).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    // Next moves on, and the new slide's heading takes the focus.
    await act(async () => screen.getByRole("button", { name: "Next" }).click());
    const heading = screen.getByRole("heading", {
      name: "What are the table's rules?",
    });
    expect(heading).toHaveFocus();
    expect(wizard).toHaveTextContent("PLAY · SLIDE 2 OF 5");
    expect(
      screen
        .getByRole("button", { name: "Slide 1 of 5: Format" })
        .closest("li"),
    ).toHaveAttribute("data-done", "true");
    expect(screen.queryByRole("radio", { name: /Legacy/ })).toBeNull();
    // Enter in a field is Next, as the button is.
    fireEvent.submit(heading.closest("form")!);
    expect(
      screen.getByRole("heading", { name: "Which deck do you play?" }),
    ).toHaveFocus();
    await act(async () => screen.getByRole("button", { name: "Back" }).click());
    expect(
      screen.getByRole("heading", { name: "What are the table's rules?" }),
    ).toBeInTheDocument();
    // The last slide says what was chosen, each line with its way back, and starts the game.
    await goTo("Start Game");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(chosen("Format")).toHaveTextContent("Commander");
    expect(chosen("The table's rules")).toHaveTextContent(
      "Casual · 160 turns (40 for each player)",
    );
    expect(chosen("Your deck")).toHaveTextContent("Skyward Patrol");
    expect(chosen("The bots")).toHaveTextContent(
      "3 bots at skill 4 of 6Their decks chosen by the table",
    );
    await act(async () =>
      within(chosen("Your deck"))
        .getByRole("button", { name: "Change your deck" })
        .click(),
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-a");
  });

  it("remembers the last setup, and offers to play it again from the first slide", async () => {
    const first = await open();
    // Nothing remembered yet: nothing offered.
    expect(screen.queryByRole("group", { name: "Your last setup" })).toBeNull();
    await goTo("Your deck");
    fireEvent.change(screen.getByLabelText("Your deck"), {
      target: { value: "own:deck-b" },
    });
    await goTo("The bots");
    fireEvent.change(screen.getByLabelText("Bots"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/^Bot skill/), {
      target: { value: "2" },
    });
    await startGame();
    expect(window.location.hash).toBe(
      "#game/00000000-0000-4000-8000-00000000beef",
    );
    first.view.unmount();

    // The next visit: every slide is on the last choice, and the first slide offers them all.
    const { api } = await open();
    const again = screen.getByRole("group", { name: "Your last setup" });
    expect(again).toHaveTextContent(
      "Commander · Graveyard Shift · 1 bot at skill 2 · Casual",
    );
    await goTo("The bots");
    expect(screen.getByLabelText("Bots")).toHaveValue("1");
    expect(screen.getByLabelText(/^Bot skill/)).toHaveValue("2");
    // Changed on the way, the offer is still the last game's own setup.
    fireEvent.change(screen.getByLabelText("Bots"), { target: { value: "3" } });
    await goTo("Format");
    await act(async () =>
      within(screen.getByRole("group", { name: "Your last setup" }))
        .getByRole("button", { name: "Play again with your last setup" })
        .click(),
    );
    expect(
      screen.getByRole("heading", { name: "Ready to play" }),
    ).toHaveFocus();
    expect(chosen("Your deck")).toHaveTextContent("Graveyard Shift");
    expect(chosen("The bots")).toHaveTextContent("1 bot at skill 2 of 6");
    await act(async () =>
      screen.getByRole("button", { name: "Start Game" }).click(),
    );
    await settle();
    expect(posted(api)[0]).toMatchObject({
      format: "commander",
      deck_id: "deck-b",
      bot_skill: 2,
      bots: [{}],
    });
  });

  it("remembers nothing of a start that was refused", async () => {
    const { api } = await open();
    api.on("POST /api/v1/practice-games", () =>
      reply(409, { code: "game_limit", message: "One game at a time." }),
    );
    await startGame();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You already have a game running. Resume it, or close it in Your games, first.",
    );
    expect(localStorage.length).toBe(0);
  });

  it("leads back to a game still running, from every slide", async () => {
    await open([running]);
    const banner = screen.getByRole("complementary", {
      name: "Your running game",
    });
    expect(banner).toHaveTextContent("You have a game running. Commander");
    expect(
      within(banner).getByRole("link", { name: "Return to your game" }),
    ).toHaveAttribute("href", `#game/${running.id}`);
    await goTo("The bots");
    expect(
      screen.getByRole("link", { name: "Return to your game" }),
    ).toBeInTheDocument();
  });

  it("shows no way back to a game the player is out of", async () => {
    await open([
      {
        ...running,
        seats: [{ ...running.seats[0]!, left: "conceded" }, running.seats[1]!],
      },
    ]);
    expect(
      screen.queryByRole("link", { name: "Return to your game" }),
    ).toBeNull();
  });
});
