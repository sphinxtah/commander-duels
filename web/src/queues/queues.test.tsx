import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { mockApi, reply } from "../decks/fixtures";
import type { components } from "../generated/api";
import {
  notificationLink,
  notificationWords,
  presenceRank,
  presenceWords,
  type NotificationItem,
  type Presence,
} from "../social/social";
import type { OwnDeck } from "../tables/tables";
import { FindGame, QueueFollower } from "./FindGame";
import {
  ordinal,
  QUEUE_POLL_MS,
  resetQueue,
  waited,
  type QueueInfo,
  type QueueStatus,
} from "./queue";
import {
  RematchPanel,
  REMATCH_POLL_MS,
  useRematch,
  type RematchView,
} from "./Rematch";

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

const GAME = "00000000-0000-4000-8000-00000000000a";
const NEXT = "00000000-0000-4000-8000-00000000000b";

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
    updated_at: "2026-10-22T10:00:00Z",
    removed_cards: [],
    ...fields,
  } as OwnDeck;
}

function place(fields: Partial<QueueStatus> = {}): QueueStatus {
  return {
    status: "none",
    format: null,
    seats: null,
    best_of: 1,
    humans_only: false,
    deck_id: null,
    deck: null,
    joined_at: null,
    waited_seconds: 0,
    position: null,
    waiting: 0,
    bots_in_seconds: null,
    game_id: null,
    reason: null,
    message: null,
    ...fields,
  };
}

function waitingPlace(fields: Partial<QueueStatus> = {}): QueueStatus {
  return place({
    status: "waiting",
    format: "legacy",
    seats: 2,
    deck_id: "deck-1",
    deck: "Red deck",
    joined_at: "2026-10-22T10:00:00Z",
    waited_seconds: 12,
    position: 1,
    waiting: 1,
    bots_in_seconds: 48,
    ...fields,
  });
}

const queues: QueueInfo[] = [
  {
    format: "legacy",
    seats: 2,
    best_of: 1,
    name: "Legacy · 2 players",
    waiting: 1,
  },
  {
    format: "legacy",
    seats: 2,
    best_of: 3,
    name: "Legacy · 2 players · best of three",
    waiting: 0,
  },
  {
    format: "commander",
    seats: 2,
    best_of: 1,
    name: "Commander · 2 players",
    waiting: 0,
  },
  {
    format: "commander",
    seats: 3,
    best_of: 1,
    name: "Commander · 3 players",
    waiting: 2,
  },
  {
    format: "commander",
    seats: 4,
    best_of: 1,
    name: "Commander · 4 players",
    waiting: 0,
  },
];

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

afterEach(() => {
  resetQueue();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("the words", () => {
  it("counts the time waited and the place in line", () => {
    expect(waited(7)).toBe("0:07");
    expect(waited(760.4)).toBe("12:40");
    expect([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
    ]);
  });

  it("tells friends a player waits in a queue, and the bell of a rematch", () => {
    const presence: Presence = {
      state: "in_queue",
      game_format: "commander",
      appears_offline: false,
    };
    expect(presenceWords(presence)).toBe("Looking for a Commander game");
    expect(presenceRank(presence)).toBe(
      presenceRank({ ...presence, state: "in_game" }),
    );
    const bell = {
      id: "n1",
      kind: "rematch",
      created_at: "2026-10-22T10:00:00Z",
      read: false,
      actor: { id: "u-bob", handle: "bob", avatar: "sigil", alliance: null },
      request_pending: true,
      messages: 0,
      game_id: GAME,
    } as NotificationItem;
    expect(notificationWords(bell)).toBe("bob offers a rematch.");
    expect(notificationLink(bell)).toBe(`#game/${GAME}`);
    expect(notificationWords({ ...bell, request_pending: false })).toBe(
      "bob offered a rematch.",
    );
  });
});

describe("finding a game", () => {
  it("joins a queue with a deck, shows the wait, and leaves it", async () => {
    const api = mockApi();
    api.on("GET /api/v1/queue", () => reply(200, place()));
    api.on("GET /api/v1/queues", () => reply(200, queues));
    api.on("GET /api/v1/decks", () =>
      reply(200, [
        deck(),
        deck({ id: "deck-2", title: "Kenrith", format: "commander" }),
        deck({ id: "deck-3", title: "Elves", format: "commander" }),
      ]),
    );
    api.on("POST /api/v1/queue", () =>
      reply(
        201,
        waitingPlace({
          format: "commander",
          seats: 3,
          deck_id: "deck-2",
          deck: "Kenrith",
          humans_only: true,
          bots_in_seconds: null,
          waiting: 3,
          position: 3,
        }),
      ),
    );
    api.on("DELETE /api/v1/queue", () =>
      reply(
        200,
        place({
          status: "left",
          reason: "left",
          format: "commander",
          seats: 3,
        }),
      ),
    );
    render(<FindGame me={ada} />);
    await settle();
    expect(
      screen.getByRole("radio", { name: /Legacy.*1 waiting/ }),
    ).toBeChecked();
    // Commander: each size its own queue, with how many wait in it.
    await act(async () =>
      screen.getByRole("radio", { name: /Commander.*2 waiting/ }).click(),
    );
    const size = screen.getByLabelText("Players");
    expect(size).toHaveValue("4");
    expect(
      within(size).getByRole("option", { name: "3 players (2 waiting)" }),
    ).toBeInTheDocument();
    await act(async () => {
      (size as HTMLSelectElement).value = "3";
      size.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(screen.getByLabelText("Your deck")).toHaveValue("deck-2");
    await act(async () =>
      screen.getByRole("checkbox", { name: /Players only/ }).click(),
    );
    await act(async () =>
      screen.getByRole("button", { name: "Find a game" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/queue")!.options,
    ).toEqual({
      body: {
        format: "commander",
        seats: 3,
        deck_id: "deck-2",
        humans_only: true,
        best_of: 1,
      },
    });
    // Only Legacy offers best of three.
    expect(screen.queryByRole("radio", { name: /Best of three/ })).toBeNull();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Looking for a Commander game for 3 players…",
    );
    expect(status).toHaveTextContent("Waited 0:12");
    expect(status).toHaveTextContent(
      "2 other players are waiting. You are 3rd in line.",
    );
    expect(status).toHaveTextContent("You wait for players only: no bots.");
    expect(status).toHaveTextContent("Playing Kenrith.");

    await act(async () =>
      screen.getByRole("button", { name: "Leave the queue" }).click(),
    );
    await settle();
    expect(api.calls.some((c) => c.route === "DELETE /api/v1/queue")).toBe(
      true,
    );
    expect(
      screen.getByRole("button", { name: "Find a game" }),
    ).toBeInTheDocument();
    // The form keeps the last wait's choices.
    expect(screen.getByLabelText("Players")).toHaveValue("3");
  });

  it("joins Legacy's best-of-three queue, a queue of its own (v0.5.0)", async () => {
    const api = mockApi();
    api.on("GET /api/v1/queue", () => reply(200, place()));
    api.on("GET /api/v1/queues", () =>
      reply(
        200,
        queues.map((q) => (q.best_of === 3 ? { ...q, waiting: 2 } : q)),
      ),
    );
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    api.on("POST /api/v1/queue", () =>
      reply(201, waitingPlace({ best_of: 3, waiting: 3, position: 3 })),
    );
    render(<FindGame me={ada} />);
    await settle();
    // The format counts both of Legacy's queues; each choice counts its own.
    expect(
      screen.getByRole("radio", { name: /Legacy.*3 waiting/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: /One game.*1 waiting/ }),
    ).toBeChecked();
    await act(async () =>
      screen.getByRole("radio", { name: /Best of three.*2 waiting/ }).click(),
    );
    await act(async () =>
      screen.getByRole("button", { name: "Find a game" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/queue")!.options,
    ).toEqual({
      body: {
        format: "legacy",
        seats: 2,
        deck_id: "deck-1",
        humans_only: false,
        best_of: 3,
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Looking for a Legacy best-of-three match…",
    );
  });

  it("counts the wait on, says when bots come, and follows into the game found", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi();
    api.on(
      "GET /api/v1/queue",
      () => reply(200, waitingPlace()),
      () =>
        reply(200, waitingPlace({ waited_seconds: 14, bots_in_seconds: 46 })),
      () => reply(200, waitingPlace({ status: "matched", game_id: GAME })),
    );
    api.on("GET /api/v1/queues", () => reply(200, queues));
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    render(<FindGame me={ada} />);
    await settle();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Looking for a Legacy game…");
    expect(status).toHaveTextContent("Nobody else is waiting yet.");
    expect(status).toHaveTextContent(
      "If too few players come, bots take the empty seats in 0:48.",
    );
    await act(() => vi.advanceTimersByTimeAsync(QUEUE_POLL_MS));
    expect(screen.getByRole("status")).toHaveTextContent("Waited 0:14");
    expect(window.location.hash).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(QUEUE_POLL_MS));
    expect(window.location.hash).toBe(`#game/${GAME}`);
  });

  it("follows from any page, but never into a game it did not see found", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi();
    // A game found before this page opened is not opened again.
    api.on("GET /api/v1/queue", () =>
      reply(200, place({ status: "matched", game_id: NEXT })),
    );
    const { unmount } = render(<QueueFollower />);
    await settle();
    expect(window.location.hash).toBe("");
    unmount();
    resetQueue();
    api.on(
      "GET /api/v1/queue",
      () => reply(200, waitingPlace()),
      () => reply(200, waitingPlace({ status: "matched", game_id: GAME })),
    );
    window.location.hash = "#decks";
    render(<QueueFollower />);
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(QUEUE_POLL_MS));
    expect(window.location.hash).toBe(`#game/${GAME}`);
  });

  it("says why the last wait ended, and what a join was refused for", async () => {
    const api = mockApi();
    api.on("GET /api/v1/queue", () =>
      reply(
        200,
        place({
          status: "refused",
          format: "legacy",
          seats: 2,
          reason: "game_limit",
          message:
            "You started another game. Join the queue again once it ends.",
        }),
      ),
    );
    api.on("GET /api/v1/queues", () => reply(200, queues));
    api.on("GET /api/v1/decks", () => reply(200, [deck()]));
    api.on("POST /api/v1/queue", () =>
      reply(409, {
        code: "at_a_table",
        message: "You sit at an open table. Leave it to join a queue.",
      }),
    );
    render(<FindGame me={ada} />);
    await settle();
    expect(
      screen.getByText(
        "You left the queue as your game started: You started another game. Join the queue again once it ends.",
      ),
    ).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Find a game" }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You sit at an open table. Leave it to join a queue.",
    );
  });

  it("asks for a deck first, and is not offered to an account that cannot play", async () => {
    const api = mockApi();
    api.on("GET /api/v1/queue", () => reply(200, place()));
    api.on("GET /api/v1/queues", () => reply(200, queues));
    api.on("GET /api/v1/decks", () => reply(200, [deck({ playable: false })]));
    const { unmount } = render(<FindGame me={ada} />);
    await settle();
    expect(
      screen.getByText(/You have no playable Legacy deck yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find a game" })).toBeDisabled();
    unmount();
    const { container } = render(
      <FindGame me={{ ...ada, permissions: ["games.play", "profile.edit"] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

type Summary = components["schemas"]["GameSummary"];

function summary(fields: Partial<Summary> = {}): Summary {
  return {
    id: GAME,
    kind: "table",
    format: "legacy",
    status: "finished",
    seats: [],
    your_seat: 0,
    bot_skill: 4,
    turn_cap: 60,
    created_at: "2026-10-22T10:00:00Z",
    finished_at: "2026-10-22T10:30:00Z",
    result: null,
    tokens: 50,
    ...fields,
  } as Summary;
}

function offer(fields: Partial<RematchView> = {}): RematchView {
  return {
    status: "none",
    kind: "table",
    origin: "lobby",
    can_offer: true,
    players: [
      { seat: 0, handle: "ada", portrait: null, answer: null, you: true },
      { seat: 1, handle: "bob", portrait: null, answer: null, you: false },
    ],
    your_answer: null,
    expires_at: null,
    expires_in: null,
    game_id: null,
    offered_by: null,
    declined_by: null,
    message: null,
    ...fields,
  };
}

function Result({ game = summary() }: { game?: Summary }) {
  const rematch = useRematch(GAME, game, true);
  return <RematchPanel rematch={rematch} />;
}

describe("the rematch", () => {
  it("plays a practice game again at once", async () => {
    const api = mockApi();
    api.on("GET /api/v1/games/{game_id}/rematch", () =>
      reply(200, offer({ kind: "practice", origin: "practice", players: [] })),
    );
    api.on("POST /api/v1/games/{game_id}/rematch", () =>
      reply(
        200,
        offer({
          kind: "practice",
          origin: "practice",
          players: [],
          status: "started",
          game_id: NEXT,
          can_offer: false,
        }),
      ),
    );
    render(<Result game={summary({ kind: "practice" })} />);
    await settle();
    expect(
      screen.getByText("Play again with the same deck, bots and rules."),
    ).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Rematch" }).click(),
    );
    await settle();
    expect(window.location.hash).toBe(`#game/${NEXT}`);
  });

  it("waits for the game's end to be recorded, and is not offered to an observer", async () => {
    const api = mockApi();
    render(<Result game={summary({ status: "active" })} />);
    render(<Result game={summary({ your_seat: null })} />);
    await settle();
    expect(api.calls).toEqual([]);
  });

  it("offers a table's players the same game, and opens it once everyone accepts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi();
    const open = offer({
      status: "open",
      can_offer: false,
      offered_by: "ada",
      your_answer: "yes",
      expires_in: 115,
      players: [
        { seat: 0, handle: "ada", portrait: null, answer: "yes", you: true },
        { seat: 1, handle: "bob", portrait: null, answer: null, you: false },
      ],
    });
    api.on(
      "GET /api/v1/games/{game_id}/rematch",
      () => reply(200, offer()),
      () => reply(200, open),
      () => reply(200, { ...open, status: "started", game_id: NEXT }),
    );
    api.on("POST /api/v1/games/{game_id}/rematch", () => reply(200, open));
    render(<Result />);
    await settle();
    expect(
      screen.getByText("Offer bob the same game again."),
    ).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Rematch" }).click(),
    );
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Rematch offered. Waiting for bob… 1:55 left.",
    );
    const answers = screen.getByRole("list", { name: "Answers" });
    expect(answers).toHaveTextContent("ada (you)Ready");
    expect(answers).toHaveTextContent("bobWaiting");
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(REMATCH_POLL_MS));
    await act(() => vi.advanceTimersByTimeAsync(REMATCH_POLL_MS));
    expect(window.location.hash).toBe(`#game/${NEXT}`);
  });

  it("lets the other player accept or decline", async () => {
    const api = mockApi();
    const asked = offer({
      status: "open",
      can_offer: false,
      offered_by: "bob",
      expires_in: 90,
      origin: "queue",
      players: [
        { seat: 0, handle: "ada", portrait: null, answer: null, you: true },
        { seat: 1, handle: "bob", portrait: null, answer: "yes", you: false },
      ],
    });
    api.on("GET /api/v1/games/{game_id}/rematch", () => reply(200, asked));
    api.on("POST /api/v1/games/{game_id}/rematch/decline", () =>
      reply(200, { ...asked, status: "declined", declined_by: "ada" }),
    );
    render(<Result />);
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent(
      "bob offers a rematch: the same seats and decks.",
    );
    expect(
      screen.getByRole("button", { name: "Accept rematch" }),
    ).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Decline" }).click(),
    );
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent(
      "ada declined the rematch.",
    );
    expect(
      api.calls.filter(
        (c) => c.route === "POST /api/v1/games/{game_id}/rematch/decline",
      ),
    ).toHaveLength(1);
  });

  it("declines an open offer when the player leaves the result screen", async () => {
    const api = mockApi();
    api.on("GET /api/v1/games/{game_id}/rematch", () =>
      reply(
        200,
        offer({ status: "open", can_offer: false, offered_by: "bob" }),
      ),
    );
    api.on("POST /api/v1/games/{game_id}/rematch/decline", () =>
      reply(200, offer({ status: "declined" })),
    );
    window.location.hash = `#game/${GAME}`;
    render(<Result />);
    await settle();
    await act(async () => {
      window.location.hash = "#tables";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle();
    expect(
      api.calls.filter(
        (c) => c.route === "POST /api/v1/games/{game_id}/rematch/decline",
      ),
    ).toHaveLength(1);
  });

  it("says why a rematch could not start, and when an offer ran out of time", async () => {
    const api = mockApi();
    api.on("GET /api/v1/games/{game_id}/rematch", () =>
      reply(
        200,
        offer({
          status: "failed",
          can_offer: false,
          message: "bob's deck cannot be played now.",
        }),
      ),
    );
    const { unmount } = render(<Result />);
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The rematch could not start: bob's deck cannot be played now.",
    );
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    api.on("GET /api/v1/games/{game_id}/rematch", () =>
      reply(200, offer({ status: "lapsed", can_offer: false })),
    );
    render(<Result />);
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The rematch offer ran out of time.",
    );
  });
});
