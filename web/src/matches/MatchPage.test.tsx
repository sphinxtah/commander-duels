import { act, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, openDialogs, reply } from "../decks/fixtures";
import { matchPlayer, matchView, sideboardCard } from "./fixtures";
import { MatchPage } from "./MatchPage";
import type { MatchView, SideboardCard } from "./matches";

const MATCH = "00000000-0000-4000-8000-00000000aaaa";
const NEXT_GAME = "00000000-0000-4000-8000-00000000bbbb";

function pool(cards: SideboardCard[]) {
  const main = cards.reduce((sum, card) => sum + card.main, 0);
  const sideboard = cards.reduce((sum, card) => sum + card.sideboard, 0);
  return { deck: "Red", can_sideboard: true, main, sideboard, cards };
}

const deck = [
  sideboardCard("Hill Giant", 0, 3),
  sideboardCard("Lightning Bolt", 4, 0),
  sideboardCard("Mountain", 56, 0),
];

/** Ada lost game 1 to Bob, so she chooses who plays first in game 2. */
function sideboarding(fields: Partial<MatchView> = {}): MatchView {
  return matchView({
    chooser_seat: 0,
    players: [
      matchPlayer({
        seat: 0,
        handle: "ada",
        you: true,
        deck_cards: pool(deck),
      }),
      matchPlayer({ seat: 1, handle: "bob", game_wins: 1 }),
    ],
    games: [
      {
        game: 1,
        id: "00000000-0000-4000-8000-000000000001",
        status: "finished",
        result: {
          kind: "completed",
          winner_seat: 1,
          draw: false,
          turns: 7,
          conceded_seats: [],
        },
        tokens: 0,
      },
    ],
    ...fields,
  });
}

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function show() {
  render(<MatchPage matchId={MATCH} heading={createRef()} />);
}

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("sideboarding between games", () => {
  it("swaps cards, checks Legacy's rules, saves, chooses and readies", async () => {
    const api = mockApi();
    api.on("GET /api/v1/matches/{match_id}", () => reply(200, sideboarding()));
    const swapped = [
      sideboardCard("Hill Giant", 1, 2),
      sideboardCard("Lightning Bolt", 3, 1),
      sideboardCard("Mountain", 56, 0),
    ];
    api.on("PUT /api/v1/matches/{match_id}/sideboard", () =>
      reply(
        200,
        sideboarding({
          players: [
            matchPlayer({
              seat: 0,
              handle: "ada",
              you: true,
              deck_cards: pool(swapped),
            }),
            matchPlayer({ seat: 1, handle: "bob", game_wins: 1 }),
          ],
        }),
      ),
    );
    api.on("POST /api/v1/matches/{match_id}/ready", () =>
      reply(200, sideboarding({ status: "playing", game_id: NEXT_GAME })),
    );
    show();
    await settle();
    expect(
      screen.getByRole("heading", { name: "Your match against bob" }),
    ).toBeInTheDocument();
    expect(screen.getByText("bob won in 7 turns")).toBeInTheDocument();
    expect(screen.getByLabelText("1 game win")).toBeInTheDocument();
    expect(screen.getByText(/Main deck/)).toHaveTextContent("Main deck 60");

    // One Bolt out leaves 59 in the main deck: not a Legacy deck, and not ready.
    await act(async () =>
      screen
        .getByRole("button", {
          name: "Move one Lightning Bolt to the sideboard",
        })
        .click(),
    );
    expect(screen.getByRole("list", { name: "Problems" })).toHaveTextContent(
      "The main deck has 59 cards; Legacy needs at least 60.",
    );
    const readyButton = screen.getByRole("button", {
      name: "Ready for game 2",
    });
    expect(readyButton).toBeDisabled();
    // A Giant in for it makes a deck again.
    await act(async () =>
      screen
        .getByRole("button", { name: "Move one Hill Giant to the main deck" })
        .click(),
    );
    expect(screen.queryByRole("list", { name: "Problems" })).toBeNull();
    expect(screen.getByLabelText("1 in the main deck")).toBeInTheDocument();

    // She lost: she draws first. Ready saves the arrangement, then readies with her choice.
    await act(async () =>
      screen.getByRole("radio", { name: /Draw first/ }).click(),
    );
    await act(async () => readyButton.click());
    await settle();
    const saved = api.calls.find(
      (call) => call.route === "PUT /api/v1/matches/{match_id}/sideboard",
    )!;
    expect(saved.options).toMatchObject({
      body: {
        cards: [
          { card_id: "id-Hill Giant", main: 1, sideboard: 2 },
          { card_id: "id-Lightning Bolt", main: 3, sideboard: 1 },
          { card_id: "id-Mountain", main: 56, sideboard: 0 },
        ],
      },
    });
    const readied = api.calls.find(
      (call) => call.route === "POST /api/v1/matches/{match_id}/ready",
    )!;
    expect(readied.options).toMatchObject({
      body: { ready: true, play_first: false },
    });
    // The next game started: the page follows into it.
    expect(window.location.hash).toBe(`#game/${NEXT_GAME}`);
    expect(
      api.calls.filter((call) => call.route.startsWith("PUT")),
    ).toHaveLength(1);
  });

  it("waits for the other player, who chooses, and can be unready", async () => {
    const api = mockApi();
    const waiting = sideboarding({
      chooser_seat: 1,
      sideboard_until: new Date(Date.now() + 272_000).toISOString(),
      players: [
        matchPlayer({
          seat: 0,
          handle: "ada",
          you: true,
          ready: true,
          game_wins: 1,
          deck_cards: pool(deck),
        }),
        matchPlayer({ seat: 1, handle: "bob" }),
      ],
    });
    api.on("GET /api/v1/matches/{match_id}", () => reply(200, waiting));
    api.on("POST /api/v1/matches/{match_id}/ready", () =>
      reply(200, sideboarding({ chooser_seat: 1 })),
    );
    show();
    await settle();
    expect(screen.getByText(/You are ready/)).toHaveTextContent(
      "You are ready. Waiting for bob…",
    );
    expect(
      screen.getByText("bob lost the last game and chooses who plays first."),
    ).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent(
      /Game 2 starts by itself in 4:3\d/,
    );
    expect(screen.queryByRole("radio", { name: /Play first/ })).toBeNull();
    // Ready, the cards stay as they are.
    expect(
      screen.getByRole("button", {
        name: "Move one Lightning Bolt to the sideboard",
      }),
    ).toBeDisabled();
    const sideboarded = within(screen.getByRole("list", { name: "Score" }));
    expect(sideboarded.getByText("Ready")).toBeInTheDocument();
    expect(sideboarded.getByText("Sideboarding")).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Not ready" }).click(),
    );
    await settle();
    const unready = api.calls.find(
      (call) => call.route === "POST /api/v1/matches/{match_id}/ready",
    )!;
    expect(unready.options).toMatchObject({ body: { ready: false } });
  });

  it("says why the next game waits, and a deck without a sideboard just readies", async () => {
    const api = mockApi();
    api.on("GET /api/v1/matches/{match_id}", () =>
      reply(
        200,
        sideboarding({
          waiting:
            "Every game slot on the server is in use: the next game starts as soon as one frees.",
          players: [
            matchPlayer({
              seat: 0,
              handle: "ada",
              you: true,
              deck_cards: {
                deck: null,
                can_sideboard: false,
                main: 0,
                sideboard: 0,
                cards: [],
              },
            }),
            matchPlayer({ seat: 1, player: "bot", ready: true }),
          ],
        }),
      ),
    );
    show();
    await settle();
    expect(screen.getByText(/no sideboard/)).toBeInTheDocument();
    expect(
      screen.getByText(/slot on the server is in use/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Your match against the bot" }),
    ).toBeInTheDocument();
  });
});

describe("the match page", () => {
  it("follows a match into its game in play", async () => {
    const api = mockApi();
    api.on("GET /api/v1/matches/{match_id}", () =>
      reply(200, sideboarding({ status: "playing", game_id: NEXT_GAME })),
    );
    show();
    await settle();
    expect(window.location.hash).toBe(`#game/${NEXT_GAME}`);
  });

  it("shows how a finished match ended, and what each game paid", async () => {
    const api = mockApi();
    api.on("GET /api/v1/matches/{match_id}", () =>
      reply(
        200,
        matchView({
          status: "finished",
          winner_seat: 0,
          end_reason: "games",
          players: [
            matchPlayer({ seat: 0, handle: "ada", you: true, game_wins: 2 }),
            matchPlayer({ seat: 1, handle: "bob", game_wins: 1 }),
          ],
          games: [1, 2, 3].map((game) => ({
            game,
            id: `00000000-0000-4000-8000-00000000000${game}`,
            status: "finished" as const,
            result: {
              kind: "completed",
              winner_seat: game === 2 ? 1 : 0,
              draw: false,
              turns: 6,
              conceded_seats: [],
            },
            tokens: game === 2 ? 0 : 50,
          })),
        }),
      ),
    );
    show();
    await settle();
    expect(screen.getByText("You won the match, 2–1.")).toBeInTheDocument();
    expect(screen.getAllByText("50 tokens")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Concede the match" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: /Sideboard/ })).toBeNull();
  });

  it("concedes the match after asking", async () => {
    openDialogs();
    const api = mockApi();
    api.on("GET /api/v1/matches/{match_id}", () => reply(200, sideboarding()));
    api.on("POST /api/v1/matches/{match_id}/concede", () =>
      reply(
        200,
        sideboarding({
          status: "finished",
          winner_seat: 1,
          end_reason: "conceded",
        }),
      ),
    );
    show();
    await settle();
    const buttons = screen.getAllByRole("button", {
      name: "Concede the match",
    });
    await act(async () => buttons[0]!.click());
    expect(
      screen.getByRole("heading", { name: "Concede the match?" }),
    ).toBeInTheDocument();
    await act(async () =>
      screen
        .getAllByRole("button", { name: "Concede the match" })
        .at(-1)!
        .click(),
    );
    await settle();
    expect(
      api.calls.some(
        (call) => call.route === "POST /api/v1/matches/{match_id}/concede",
      ),
    ).toBe(true);
  });

  it("says when there is no such match", async () => {
    const api = mockApi();
    api.on("GET /api/v1/matches/{match_id}", () =>
      reply(404, { code: "http_404" }),
    );
    show();
    await settle();
    expect(
      screen.getByRole("heading", { name: "There is no such match." }),
    ).toBeInTheDocument();
  });
});
