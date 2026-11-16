import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { forgetRollout } from "../app/rollout";
import { DecksPage } from "./DecksPage";
import type { DeckSummary } from "./decks";
import { deckDetail, mockApi, openDialogs, reply } from "./fixtures";
import { SampleHand } from "./SampleHand";
import { restartSandbox } from "./sandbox";

// The all-card practice sandbox on the Decks page (v1.0.0), behind the gate sandbox: a sandbox
// deck made, listed apart, played from its own Sandbox button after the page says it earns
// nothing, and made a normal deck once its cards are owned. And the Workshop's sample hands.

const player = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "player",
  status: "active",
  handle: "ann",
  permissions: ["games.play", "decks.edit"],
  roles: ["player"],
} as unknown as Me;

function summary(fields: Partial<DeckSummary>): DeckSummary {
  const { draft: _draft, ...detail } = deckDetail(fields as never);
  return { folder: null, tags: [], ...detail } as DeckSummary;
}
const own = summary({ id: "d-own", title: "Red deck", format: "commander" });
const tried = summary({
  id: "d-try",
  title: "Dragons to try",
  format: "commander",
  sandbox: true,
});

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function serve(decks: DeckSummary[], open = true) {
  const api = mockApi();
  const served = { decks };
  api.on("GET /api/v1/rollout", () =>
    reply(200, {
      workflows: [{ id: "sandbox", name: "Sandbox", available: open }],
    }),
  );
  api.on("GET /api/v1/decks", () => reply(200, served.decks));
  api.on("GET /api/v1/decks/starters", () => reply(200, []));
  return { api, served };
}

beforeEach(() => {
  openDialogs();
  window.location.hash = "";
});
afterEach(() => {
  vi.restoreAllMocks();
  forgetRollout();
  window.location.hash = "";
});

describe("sandbox decks", () => {
  it("are not offered where the sandbox is closed to the account", async () => {
    serve([own], false);
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    expect(
      screen.queryByRole("button", { name: "New sandbox deck" }),
    ).toBeNull();
  });

  it("are made as their own kind of deck, after the page says what one is", async () => {
    const { api } = serve([own]);
    api.on("POST /api/v1/decks", () => reply(201, { id: "d-new" }));
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "New sandbox deck" }).click(),
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "A new sandbox deck" }),
    );
    expect(
      dialog.getByText(
        /built from every card in the game, whether you own it or not/,
      ),
    ).toBeInTheDocument();
    expect(dialog.getByText(/nowhere a game counts/)).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Name"), {
      target: { value: "Dragons" },
    });
    await act(async () =>
      dialog.getByRole("radio", { name: /^Legacy/ }).click(),
    );
    await act(async () =>
      dialog.getByRole("button", { name: "Create" }).click(),
    );
    await settle();
    expect(
      api.calls.find((call) => call.route === "POST /api/v1/decks")!.options,
    ).toMatchObject({
      body: { title: "Dragons", format: "legacy", sandbox: true },
    });
    expect(window.location.hash).toBe("#deck/d-new");
    // The ordinary button still makes an ordinary deck.
    await act(async () =>
      screen.getByRole("button", { name: "New deck" }).click(),
    );
    expect(
      screen.getByRole("dialog", { name: "A new deck" }),
    ).toBeInTheDocument();
  });

  it("are listed apart, marked, and offer the sandbox and nothing a game counts in", async () => {
    serve([own, tried]);
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("heading", { name: "Sandbox decks" }),
    ).toBeInTheDocument();
    const apart = within(screen.getByRole("list", { name: "Sandbox decks" }));
    const row = within(apart.getByRole("listitem"));
    expect(
      row.getByRole("link", { name: "Dragons to try" }),
    ).toBeInTheDocument();
    expect(row.getByText("Sandbox deck")).toBeInTheDocument();
    expect(row.getByText("Ready for the sandbox")).toBeInTheDocument();
    expect(
      row.getByRole("button", { name: "Sandbox: Dragons to try" }),
    ).toBeEnabled();
    // Not convertible yet, and never lent.
    expect(row.queryByRole("button", { name: /^Convert/ })).toBeNull();
    expect(row.queryByRole("button", { name: "Lend" })).toBeNull();
    // The normal deck is in the other list, with no Sandbox button.
    const normal = screen
      .getByRole("link", { name: "Red deck" })
      .closest("li")!;
    expect(within(normal).getByText("Ready to play")).toBeInTheDocument();
    expect(
      within(normal).queryByRole("button", { name: /^Sandbox/ }),
    ).toBeNull();
    expect(apart.queryByRole("link", { name: "Red deck" })).toBeNull();
  });

  it("start a sandbox game from the deck, with the bots, their decks, or bots that do nothing", async () => {
    const { api } = serve([own, tried]);
    api.on("POST /api/v1/practice-games", () => reply(201, { id: "g-1" }));
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Sandbox: Dragons to try" }).click(),
    );
    const dialog = within(
      screen.getByRole("dialog", {
        name: "Play Dragons to try in the sandbox",
      }),
    );
    // What it earns is said before it starts.
    expect(
      dialog.getByText(/A sandbox game earns nothing: no tokens/),
    ).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Opponents"), {
      target: { value: "2" },
    });
    // A bot plays one of the player's decks, normal or sandbox, or a deck of the game's own.
    const second = dialog.getByLabelText("Bot 2's deck");
    expect(
      within(second)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "A deck of the game's own",
      "Red deck",
      "Dragons to try (sandbox deck)",
    ]);
    fireEvent.change(second, { target: { value: "d-own" } });
    fireEvent.change(dialog.getByLabelText(/^Bot skill/), {
      target: { value: "2" },
    });
    await act(async () =>
      dialog.getByRole("checkbox", { name: "Bots that do nothing" }).click(),
    );
    await act(async () =>
      dialog.getByRole("button", { name: "Start the sandbox game" }).click(),
    );
    await settle();
    expect(
      api.calls.find((call) => call.route === "POST /api/v1/practice-games")!
        .options,
    ).toEqual({
      body: {
        format: "commander",
        deck_id: "d-try",
        bots: [{}, { deck_id: "d-own" }],
        bot_skill: 2,
        sandbox: true,
        passive: true,
      },
    });
    expect(window.location.hash).toBe("#game/g-1");
  });

  it("say why a sandbox game did not start", async () => {
    const { api } = serve([tried]);
    api.on("POST /api/v1/practice-games", () =>
      reply(409, {
        code: "game_limit",
        message: "Finish or close your running game before starting another.",
      }),
    );
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Sandbox: Dragons to try" }).click(),
    );
    await act(async () =>
      screen.getByRole("button", { name: "Start the sandbox game" }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Finish or close your running game before starting another.",
    );
    expect(window.location.hash).toBe("");
  });

  it("are copied from a deck that needs cards its owner lacks, to try it as it is", async () => {
    const lacking = summary({
      id: "d-lack",
      title: "Imported list",
      format: "legacy",
      playable: false,
      collection_locked: true,
    });
    const { api } = serve([own, lacking]);
    api.on("POST /api/v1/decks", () => reply(201, { id: "d-copy" }));
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    // Only a deck its owner cannot play for want of cards offers it.
    expect(
      screen.queryByRole("button", {
        name: "Copy as a sandbox deck: Red deck",
      }),
    ).toBeNull();
    await act(async () =>
      screen
        .getByRole("button", { name: "Copy as a sandbox deck: Imported list" })
        .click(),
    );
    await settle();
    expect(
      api.calls.find((call) => call.route === "POST /api/v1/decks")!.options,
    ).toMatchObject({
      body: {
        title: "Imported list (sandbox)",
        format: "legacy",
        sandbox: true,
        source: { kind: "duplicate", deck_id: "d-lack" },
      },
    });
    expect(window.location.hash).toBe("#deck/d-copy");
  });

  it("become normal decks once their cards are owned", async () => {
    const { api, served } = serve([own, { ...tried, convertible: true }]);
    api.on("POST /api/v1/sandbox/decks/{deck_id}/convert", () => {
      served.decks = [own, { ...tried, sandbox: false }];
      return reply(200, { id: "d-try" });
    });
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen
        .getByRole("button", {
          name: "Convert to a normal deck: Dragons to try",
        })
        .click(),
    );
    await settle();
    expect(api.calls.at(-2)).toMatchObject({
      route: "POST /api/v1/sandbox/decks/{deck_id}/convert",
      options: { params: { path: { deck_id: "d-try" } } },
    });
    expect(
      screen.getByText(/Dragons to try is a normal deck now/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sandbox decks" })).toBeNull();
  });
});

describe("restarting a sandbox game", () => {
  it("closes the running game, then plays its setup again", async () => {
    const api = mockApi();
    api.on("POST /api/v1/games/{game_id}/close", () =>
      reply(200, { id: "g-1" }),
    );
    api.on("POST /api/v1/games/{game_id}/rematch", () =>
      reply(200, { game_id: "g-2" }),
    );
    expect(await restartSandbox("g-1", true)).toEqual({ id: "g-2" });
    expect(api.calls.map((call) => call.route)).toEqual([
      "POST /api/v1/games/{game_id}/close",
      "POST /api/v1/games/{game_id}/rematch",
    ]);
    // A game already over is only played again.
    api.calls.length = 0;
    expect(await restartSandbox("g-1", false)).toEqual({ id: "g-2" });
    expect(api.calls.map((call) => call.route)).toEqual([
      "POST /api/v1/games/{game_id}/rematch",
    ]);
  });

  it("asks again while the server has no room for the new game yet", async () => {
    const api = mockApi();
    api.on("POST /api/v1/games/{game_id}/close", () =>
      reply(200, { id: "g-1" }),
    );
    const answers = [
      reply(429, {
        code: "games_busy",
        message: "At most 2 games run at once; try again in a minute.",
      }),
      reply(409, {
        code: "game_running",
        message: "The game has not ended yet.",
      }),
      reply(200, { game_id: "g-2" }),
    ];
    api.on("POST /api/v1/games/{game_id}/rematch", () => answers.shift()!);
    const waited: number[] = [];
    const pause = async (ms: number) => {
      waited.push(ms);
    };
    expect(await restartSandbox("g-1", true, pause)).toEqual({ id: "g-2" });
    expect(waited).toEqual([2000, 2000]);
    // Any other refusal is said at once.
    api.on("POST /api/v1/games/{game_id}/rematch", () =>
      reply(409, { code: "rematch_unavailable", message: "Start a new one." }),
    );
    waited.length = 0;
    expect(await restartSandbox("g-1", false, pause)).toEqual({
      error: "Start a new one.",
    });
    expect(waited).toEqual([]);
  });

  it("says why it could not", async () => {
    const api = mockApi();
    api.on("POST /api/v1/games/{game_id}/close", () =>
      reply(503, {
        code: "engine_unavailable",
        message: "The engine is away.",
      }),
    );
    expect(await restartSandbox("g-1", true)).toEqual({
      error: "The engine is away.",
    });
  });
});

describe("the Workshop's sample hands", () => {
  const deck = deckDetail({
    format: "commander",
    cards: {
      m: { id: "m", name: "Mountain", type_line: "Basic Land — Mountain" },
      b: { id: "b", name: "Lightning Bolt", type_line: "Instant" },
    } as never,
  });
  const draft = {
    version: 1,
    entries: [
      { card_id: "m", quantity: 6, location: "main" },
      { card_id: "b", quantity: 6, location: "main" },
    ],
  } as never;
  /** A chance that leaves the order as it is: six Mountains, then the Bolts. */
  const still = () => 0.999999;

  it("draws seven, takes the game's mulligan and draws on", async () => {
    render(<SampleHand deck={deck} draft={draft} random={still} />);
    expect(screen.queryByRole("list", { name: "The hand" })).toBeNull();
    await act(async () =>
      screen.getByRole("button", { name: "Draw a sample hand" }).click(),
    );
    const hand = () =>
      within(screen.getByRole("list", { name: "The hand" })).getAllByRole(
        "listitem",
      );
    expect(hand()).toHaveLength(7);
    expect(screen.getByRole("status")).toHaveTextContent(
      "7 cards, 6 of them lands. No mulligan taken.",
    );
    // Commander: three or more players by default, so the first mulligan is free.
    await act(async () =>
      screen.getByRole("button", { name: "Mulligan" }).click(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 mulligan taken.");
    await act(async () =>
      screen.getByRole("button", { name: "Mulligan" }).click(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Choose 1 to put on the bottom of your library.",
    );
    expect(screen.getByRole("button", { name: "Draw a card" })).toBeDisabled();
    await act(async () =>
      screen
        .getAllByRole("button", { name: "To the bottom: Mountain" })[0]
        .click(),
    );
    expect(hand()).toHaveLength(6);
    await act(async () =>
      screen.getByRole("button", { name: "Draw a card" }).click(),
    );
    expect(hand()).toHaveLength(7);
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 mulligans taken, 1 card drawn since.",
    );
  });

  it("says so where the main deck is too small for a hand", () => {
    render(
      <SampleHand
        deck={deck}
        draft={{ version: 1, entries: [] } as never}
        random={still}
      />,
    );
    expect(
      screen.getByText(/The main deck holds 0 cards: an opening hand is seven/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Draw/ })).toBeNull();
  });
});
