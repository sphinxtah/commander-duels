import { act, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { forgetRollout } from "../app/rollout";
import { notificationLink, notificationWords } from "../social/social";
import { DecksPage } from "./DecksPage";
import type { DeckSummary } from "./decks";
import { deckDetail, mockApi, openDialogs, reply } from "./fixtures";
import type { Loan } from "./loans";

// Friend deck lending on the Decks page (v1.0.0), behind the gate deck_lending: a deck lent
// from its row after the page says what that means; the loan on the row; and the decks lent to
// the account, looked at, accepted, declined and given back.

const player = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "player",
  status: "active",
  handle: "ann",
  permissions: ["games.play", "decks.edit"],
  roles: ["player"],
} as unknown as Me;

const DECK = "00000000-0000-4000-8000-0000000000d1";
const { draft: _draft, ...detail } = deckDetail({
  id: DECK,
  title: "Zombie Horde",
} as never);
const zombies = { folder: null, tags: [], ...detail } as DeckSummary;

const ref = (id: string, handle: string): Loan["lender"] => ({
  id,
  handle,
  avatar: "sigil",
  alliance: null,
});
function loan(fields: Partial<Loan> = {}): Loan {
  return {
    id: "loan-1",
    deck: {
      id: DECK,
      title: "Zombie Horde",
      format: "commander",
      version: 3,
      card_count: 100,
      commanders: ["Gisa and Geralf"],
    },
    lender: ref("u-ann", "ann"),
    borrower: ref("u-bob", "bob"),
    state: "offered",
    offered_at: "2026-11-15T10:00:00Z",
    until: "2026-11-22T10:00:00Z",
    yours: true,
    ...fields,
  } as Loan;
}
const book = (given: Loan[] = [], taken: Loan[] = []) => ({
  given,
  taken,
  days: 7,
  limit: 20,
});

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/** The Decks page with lending open (or closed) to the account. */
function serve(open = true) {
  const api = mockApi();
  const served = { loans: book() };
  api.on("GET /api/v1/rollout", () =>
    reply(200, {
      workflows: [{ id: "deck_lending", name: "Lending", available: open }],
    }),
  );
  api.on("GET /api/v1/decks", () => reply(200, [zombies]));
  api.on("GET /api/v1/decks/starters", () => reply(200, []));
  api.on("GET /api/v1/loans", () => reply(200, served.loans));
  api.on("GET /api/v1/friends", () =>
    reply(200, {
      friends: [
        { id: "u-bob", handle: "bob", presence: "online" },
        { id: "u-cy", handle: "cy", presence: "offline" },
      ],
      incoming: [],
      outgoing: [],
      waiting: [],
    }),
  );
  return { api, served };
}

beforeEach(() => openDialogs());
afterEach(() => {
  vi.restoreAllMocks();
  forgetRollout();
});

describe("lending a deck", () => {
  it("is not offered where the workflow is closed to the account", async () => {
    const { api } = serve(false);
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    expect(screen.queryByRole("button", { name: "Lend" })).toBeNull();
    expect(api.calls.some((call) => call.route === "GET /api/v1/loans")).toBe(
      false,
    );
  });

  it("says what lending means, then offers the deck to the friend chosen", async () => {
    const { api, served } = serve();
    api.on("POST /api/v1/decks/{deck_id}/loans", () => {
      served.loans = book([loan()]);
      return reply(201, loan());
    });
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    await act(async () => screen.getByRole("button", { name: "Lend" }).click());
    await settle();
    const dialog = within(
      screen.getByRole("dialog", { name: "Lend Zombie Horde to a friend" }),
    );
    // What it means, before anything is sent: the owner's three decisions among it.
    const means = dialog
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(means[0]).toContain("plays it for 7 days");
    expect(means[1]).toBe(
      "They play it only at a private table where you sit too.",
    );
    expect(means[2]).toContain(
      "While they have it, you cannot play this deck yourself",
    );
    expect(means[4]).toContain("nothing changes hands");
    expect(dialog.getByRole("button", { name: "Offer it" })).toBeDisabled();
    await act(async () => dialog.getByRole("radio", { name: "bob" }).click());
    await act(async () =>
      dialog.getByRole("button", { name: "Offer it to bob" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/decks/{deck_id}/loans")!
        .options,
    ).toEqual({
      params: { path: { deck_id: DECK } },
      body: { player_id: "u-bob" },
    });
    expect(
      screen.getByText(
        "Zombie Horde is offered to bob. It is theirs to play once they accept.",
      ),
    ).toBeInTheDocument();
    // The row says so, and the deck is not lent twice.
    const row = screen
      .getByRole("link", { name: "Zombie Horde" })
      .closest("li")!;
    expect(row).toHaveTextContent(
      "Offered to bob, who has not answered yet. It is still yours to play.",
    );
    expect(within(row).queryByRole("button", { name: "Lend" })).toBeNull();
  });

  it("says a deck is with a friend, and takes it back", async () => {
    const { api, served } = serve();
    served.loans = book([loan({ state: "accepted" })]);
    api.on("DELETE /api/v1/loans/{loan_id}", () => {
      served.loans = book();
      return reply(200, served.loans);
    });
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    const row = screen
      .getByRole("link", { name: "Zombie Horde" })
      .closest("li")!;
    expect(row).toHaveTextContent(
      "Lent to bob until November 22: you cannot play it meanwhile.",
    );
    await act(async () =>
      within(row)
        .getByRole("button", { name: "Take it back: Zombie Horde" })
        .click(),
    );
    await settle();
    expect(api.calls.at(-1)).toMatchObject({
      route: "DELETE /api/v1/loans/{loan_id}",
      options: { params: { path: { loan_id: "loan-1" } } },
    });
    expect(row).not.toHaveTextContent("Lent to bob");
    expect(
      within(row).getByRole("button", { name: "Lend" }),
    ).toBeInTheDocument();
  });

  it("says why a deck was not lent", async () => {
    const { api } = serve();
    api.on("POST /api/v1/decks/{deck_id}/loans", () =>
      reply(422, {
        code: "not_lendable",
        message: "Zombie Horde holds custom cards, and those are not lent.",
      }),
    );
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    await act(async () => screen.getByRole("button", { name: "Lend" }).click());
    await settle();
    await act(async () => screen.getByRole("radio", { name: "cy" }).click());
    await act(async () =>
      screen.getByRole("button", { name: "Offer it to cy" }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Zombie Horde holds custom cards, and those are not lent.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("decks lent to you", () => {
  const offered = loan({
    id: "loan-2",
    yours: false,
    lender: ref("u-cy", "cy"),
    borrower: ref("u-ann", "ann"),
    deck: { ...loan().deck, id: "d-cy", title: "Elfball" },
  });

  it("are looked at, accepted and given back", async () => {
    const { api, served } = serve();
    served.loans = book([], [offered]);
    api.on("GET /api/v1/loans/{loan_id}/deck", () =>
      reply(200, {
        loan: offered,
        entries: [
          { card_id: "c1", location: "commander", quantity: 1 },
          { card_id: "c2", location: "main", quantity: 30 },
        ],
        cards: {
          c1: { id: "c1", name: "Ezuri, Renegade Leader" },
          c2: { id: "c2", name: "Forest" },
        },
      }),
    );
    api.on("POST /api/v1/loans/{loan_id}/accept", () => {
      served.loans = book([], [{ ...offered, state: "accepted" }]);
      return reply(200, served.loans);
    });
    api.on("DELETE /api/v1/loans/{loan_id}", () => {
      served.loans = book();
      return reply(200, served.loans);
    });
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    const section = within(
      screen.getByRole("region", { name: "Decks lent to you" }),
    );
    expect(section.getByRole("listitem")).toHaveTextContent(
      "ElfballCommander · 100 cards · Gisa and Geralf · from cy",
    );
    expect(section.getByRole("listitem")).toHaveTextContent(
      "cy offers it to you. Look at it, then accept or decline.",
    );
    // Where it is played is said with it.
    expect(
      section.getByText(/only at a private table where that friend sits too/),
    ).toBeInTheDocument();

    await act(async () =>
      section.getByRole("button", { name: "Look at it: Elfball" }).click(),
    );
    await settle();
    const list = within(
      screen.getByRole("dialog", { name: "Elfball, from cy" }),
    );
    expect(list.getByText(/Version 3, as it was lent/)).toBeInTheDocument();
    expect(
      list.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["1 × Ezuri, Renegade Leader", "30 × Forest"]);
    await act(async () => list.getByRole("button", { name: "Close" }).click());

    await act(async () =>
      section.getByRole("button", { name: "Accept: Elfball" }).click(),
    );
    await settle();
    expect(section.getByRole("listitem")).toHaveTextContent(
      "Yours to play until November 22.",
    );
    expect(section.queryByRole("button", { name: /^Accept/ })).toBeNull();
    await act(async () =>
      section.getByRole("button", { name: "Give it back: Elfball" }).click(),
    );
    await settle();
    expect(
      screen.queryByRole("region", { name: "Decks lent to you" }),
    ).toBeNull();
  });

  it("are declined", async () => {
    const { api, served } = serve();
    served.loans = book([], [offered]);
    api.on("POST /api/v1/loans/{loan_id}/decline", () => {
      served.loans = book();
      return reply(200, served.loans);
    });
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Decline: Elfball" }).click(),
    );
    await settle();
    expect(api.calls.at(-1)).toMatchObject({
      route: "POST /api/v1/loans/{loan_id}/decline",
      options: { params: { path: { loan_id: "loan-2" } } },
    });
    expect(screen.queryByText("Elfball")).toBeNull();
  });
});

describe("the bell", () => {
  it("says a friend offers a deck, and leads to the Decks page", () => {
    const item = {
      kind: "deck_offered",
      actor: { id: "u-cy", handle: "cy" },
      request_pending: false,
      messages: 0,
    } as never;
    expect(notificationWords(item)).toBe("cy offers to lend you a deck.");
    expect(notificationLink(item)).toBe("#decks");
  });
});
