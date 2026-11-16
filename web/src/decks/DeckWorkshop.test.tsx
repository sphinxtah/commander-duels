import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeckWorkshop } from "./DeckWorkshop";
import type { DeckDetail, RevisionSummary } from "./decks";
import { card, deckDetail, mockApi, openDialogs, reply } from "./fixtures";

// A deck's Workshop (v1.0.0): its versions compared and restored into the draft, its results
// by the version played, and the cards it lacks with their substitutes.

const ID = "00000000-0000-4000-8000-0000000000d1";

function version(number: number, fields: Partial<RevisionSummary> = {}) {
  return {
    number,
    title: "Burn",
    created_at: `2026-11-0${number}T10:00:00Z`,
    legal: true,
    playable: true,
    catalog_revision: 1,
    format_version: 1,
    content_hash: `hash-${number}`,
    ...fields,
  } as RevisionSummary;
}

function burn(fields: Partial<DeckDetail> = {}): DeckDetail {
  return deckDetail({
    id: ID,
    title: "Burn",
    format: "legacy",
    card_count: 60,
    revisions: [version(1), version(2)],
    draft: {
      version: 7,
      entries: [
        { card_id: "bolt", location: "main", quantity: 4 },
        { card_id: "mountain", location: "main", quantity: 56 },
      ],
    },
    ...fields,
  } as never);
}

function diff(before: string, after: string, fields: object = {}) {
  return {
    deck_id: ID,
    before,
    after,
    added: 0,
    removed: 0,
    same: true,
    lines: [],
    ...fields,
  };
}
const changed = {
  added: 2,
  removed: 3,
  same: false,
  lines: [
    {
      card_id: "bolt",
      name: "Lightning Bolt",
      location: "main",
      before: 4,
      after: 1,
    },
    { card_id: "shock", name: "Shock", location: "main", before: 0, after: 1 },
    {
      card_id: "pyro",
      name: "Pyroblast",
      location: "sideboard",
      before: 0,
      after: 1,
    },
  ],
};

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

type Api = ReturnType<typeof mockApi>;
/** The deck, and a diff answered by the sides asked for. */
function serve(deck: DeckDetail = burn()) {
  const api = mockApi();
  const served = { deck };
  api.on("GET /api/v1/decks/{deck_id}", () => reply(200, served.deck));
  api.on("GET /api/v1/decks/{deck_id}/diff", (options) => {
    const { before, after } = (
      options as { params: { query: { before: string; after: string } } }
    ).params.query;
    // Version 1 differs from everything later; version 2 is the draft.
    return reply(
      200,
      diff(before, after, before === "1" || after === "1" ? changed : {}),
    );
  });
  return { api, served };
}
function sent(api: Api, route: string) {
  return api.calls.filter((call) => call.route === route).at(-1)?.options as {
    body?: unknown;
    params?: { path?: unknown; query?: unknown };
  };
}

beforeEach(() => openDialogs());
afterEach(() => vi.restoreAllMocks());

describe("a deck's Workshop", () => {
  it("opens on its versions, with the ways to the editor and the decks", async () => {
    serve();
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("heading", { level: 1, name: "Burn" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open it in the editor" }),
    ).toHaveAttribute("href", `#deck/${ID}`);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Versions",
      "Results",
      "Missing cards",
    ]);
    expect(screen.getByRole("tab", { name: "Versions" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("says that a deck is not there", async () => {
    const api = mockApi();
    api.on("GET /api/v1/decks/{deck_id}", () =>
      reply(404, { code: "not_found", message: "No such deck." }),
    );
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("heading", { name: "There is no such deck." }),
    ).toBeVisible();
  });
});

describe("the Workshop's versions", () => {
  it("compares the newest version with the draft first, and any two sides asked", async () => {
    const { api } = serve();
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    expect(sent(api, "GET /api/v1/decks/{deck_id}/diff").params).toEqual({
      path: { deck_id: ID },
      query: { before: "2", after: "draft" },
    });
    expect(
      screen.getByText(
        /From version 2 to the draft: The two hold the same cards/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2" } });
    await settle();
    expect(sent(api, "GET /api/v1/decks/{deck_id}/diff").params).toMatchObject({
      query: { before: "1", after: "2" },
    });
    expect(
      screen.getByText(
        /From version 1 to version 2: 2 copies added, 3 copies removed\./,
      ),
    ).toBeInTheDocument();
    // Card by card, under the place each is in; a change is said by its sign and in words.
    const rows = within(screen.getByRole("table"))
      .getAllByRole("row")
      .map((row) => row.textContent);
    expect(rows).toEqual([
      "CardVersion 1Version 2Change",
      "Main deck",
      "Lightning Bolt41−3 removed",
      "Shock–1+1 added",
      "Sideboard",
      "Pyroblast–1+1 added",
    ]);
  });

  it("lists the saved versions, newest first, and compares one with the draft", async () => {
    const { api } = serve();
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    const versions = within(
      screen.getByRole("region", { name: "Saved versions" }),
    );
    expect(
      versions.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      expect.stringMatching(/^Version 2Burn · saved Nov 2, 2026 · Playable/),
      expect.stringMatching(/^Version 1Burn · saved Nov 1, 2026 · Playable/),
    ]);
    await act(async () =>
      versions
        .getByRole("button", { name: "Compare version 1 with the draft" })
        .click(),
    );
    await settle();
    expect(sent(api, "GET /api/v1/decks/{deck_id}/diff").params).toMatchObject({
      query: { before: "1", after: "draft" },
    });
  });

  it("says what a deck with no saved version can do", async () => {
    serve(burn({ revisions: [] }));
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    expect(
      screen.getByText(/This deck has no saved version yet/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("From")).toBeNull();
  });

  it("restores a version into the draft after saying what that means", async () => {
    const { api, served } = serve();
    api.on("POST /api/v1/decks/{deck_id}/revisions/{number}/restore", () => {
      served.deck = burn({
        draft: { version: 8, entries: served.deck.draft.entries },
      });
      return reply(200, {
        version: 8,
        entries: [],
        cards: {},
        validation: {},
        updated_at: "2026-11-15T10:00:00Z",
      });
    });
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen
        .getByRole("button", { name: "Restore version 1 into the draft" })
        .click(),
    );
    await settle();
    const dialog = within(
      screen.getByRole("dialog", {
        name: "Restore version 1 into the draft?",
      }),
    );
    expect(
      dialog.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      "No saved version is rewritten.",
      "Every game keeps the version it played, and its result.",
      "The draft as it is now is replaced.",
    ]);
    // What it changes in the draft: the draft compared with the version.
    expect(
      dialog.getByText(
        /In the draft this changes: 2 copies added, 3 copies removed\./,
      ),
    ).toBeInTheDocument();
    // The draft is the newest version, so there is nothing of it to save first.
    expect(dialog.queryByRole("checkbox")).toBeNull();
    await act(async () =>
      dialog.getByRole("button", { name: "Restore version 1" }).click(),
    );
    await settle();
    expect(
      sent(api, "POST /api/v1/decks/{deck_id}/revisions/{number}/restore"),
    ).toEqual({
      params: { path: { deck_id: ID, number: 1 } },
      body: { version: 7 },
    });
    expect(
      api.calls.some(
        (call) => call.route === "POST /api/v1/decks/{deck_id}/revisions",
      ),
    ).toBe(false);
    expect(
      screen.getByText(
        /Version 1 is the draft now\. No saved version and no game's record changed\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers to save a draft no version holds before it is replaced", async () => {
    const api = mockApi();
    api.on("GET /api/v1/decks/{deck_id}", () => reply(200, burn()));
    // The draft differs from every version.
    api.on("GET /api/v1/decks/{deck_id}/diff", (options) => {
      const { before, after } = (
        options as { params: { query: { before: string; after: string } } }
      ).params.query;
      return reply(200, diff(before, after, changed));
    });
    const order: string[] = [];
    api.on("POST /api/v1/decks/{deck_id}/revisions", () => {
      order.push("saved");
      return reply(201, version(3));
    });
    api.on("POST /api/v1/decks/{deck_id}/revisions/{number}/restore", () => {
      order.push("restored");
      return reply(200, { version: 8, entries: [], cards: {}, validation: {} });
    });
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen
        .getByRole("button", { name: "Restore version 2 into the draft" })
        .click(),
    );
    await settle();
    const keep = screen.getByRole("checkbox", {
      name: /Save the draft as a version first/,
    });
    expect(keep).toBeChecked();
    await act(async () =>
      screen.getByRole("button", { name: "Restore version 2" }).click(),
    );
    await settle();
    expect(order).toEqual(["saved", "restored"]);
  });

  it("keeps the draft when asked to, and says when the deck changed elsewhere", async () => {
    const { api } = serve();
    api.on("POST /api/v1/decks/{deck_id}/revisions/{number}/restore", () =>
      reply(409, { code: "draft_conflict", message: "The draft changed." }),
    );
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen
        .getByRole("button", { name: "Restore version 1 into the draft" })
        .click(),
    );
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Restore version 1" }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This deck changed somewhere else since this page opened.",
    );
    await act(async () =>
      screen.getByRole("button", { name: "Keep the draft" }).click(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/is the draft now/)).toBeNull();
  });
});

describe("the Workshop's results", () => {
  const record = (games: number, wins: number, losses: number) => ({
    games,
    wins,
    losses,
    draws: games - wins - losses,
    win_rate: games ? wins / games : null,
    small_sample: games < 10,
  });
  const split = (
    fields: object,
    games: number,
    wins: number,
    losses: number,
  ) => ({
    ...record(games, wins, losses),
    format: "legacy",
    mode: "practice",
    opposition: "bots",
    bot_skill: 4,
    ...fields,
  });

  async function open(results: unknown) {
    const { api } = serve();
    api.on("GET /api/v1/decks/{deck_id}/performance", () =>
      reply(200, results),
    );
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    await act(async () => screen.getByRole("tab", { name: "Results" }).click());
    await settle();
  }

  it("shows the record in all, by the version played and told apart, each with its sample", async () => {
    await open({
      deck_id: ID,
      record: record(16, 9, 6),
      splits: [
        split({}, 12, 7, 4),
        split(
          { mode: "table", opposition: "players", bot_skill: null },
          4,
          2,
          2,
        ),
      ],
      versions: [
        {
          number: 2,
          title: "Burn",
          created_at: "2026-11-02T10:00:00Z",
          record: record(4, 3, 1),
          splits: [split({}, 4, 3, 1)],
        },
        {
          number: 1,
          title: "Burn",
          created_at: "2026-11-01T10:00:00Z",
          record: record(12, 6, 5),
          splits: [
            split({}, 8, 4, 3),
            split(
              { mode: "table", opposition: "players", bot_skill: null },
              4,
              2,
              2,
            ),
          ],
        },
      ],
    });
    const all = screen.getByRole("region", { name: "In all" });
    expect(all).toHaveTextContent("Games16");
    expect(all).toHaveTextContent("Record9 won, 6 lost, 1 drawn");
    expect(all).toHaveTextContent("Win rate56%");
    expect(all).not.toHaveTextContent("says little");

    const byVersion = within(
      screen.getByRole("table", { name: "By the version played" }),
    )
      .getAllByRole("row")
      .map((row) => row.textContent);
    expect(byVersion).toEqual([
      "VersionSavedGamesRecordWin rate",
      // Four games: said beside the number, not left to the reader.
      "Version 2Nov 2, 20264 few games3 won, 1 lost75%",
      "Version 1Nov 1, 202612 6 won, 5 lost, 1 drawn50%".replace("12 ", "12"),
    ]);

    const splits = () =>
      within(screen.getByRole("table", { name: "Told apart" }))
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.textContent);
    expect(splits()).toEqual([
      "LegacyPracticeBots at skill 4127 won, 4 lost, 1 drawn58%",
      "LegacyTablePlayers4 few games2 won, 2 lost50%",
    ]);
    // Of one version alone.
    fireEvent.change(screen.getByLabelText("Games of"), {
      target: { value: "2" },
    });
    expect(splits()).toEqual([
      "LegacyPracticeBots at skill 44 few games3 won, 1 lost75%",
    ]);
  });

  it("says a short record says little, and that a deck never played has none", async () => {
    await open({
      deck_id: ID,
      record: record(3, 1, 2),
      splits: [split({}, 3, 1, 2)],
      versions: [],
    });
    expect(screen.getByRole("region", { name: "In all" })).toHaveTextContent(
      "Fewer than ten games: a record this short says little.",
    );
  });

  it("says when no game has been played with a saved version", async () => {
    await open({
      deck_id: ID,
      record: record(0, 0, 0),
      splits: [],
      versions: [],
    });
    expect(
      screen.getByText(
        /No game has ended with a saved version of this deck yet/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("the Workshop's missing cards", () => {
  const bolt = { ...card("Lightning Bolt"), id: "bolt" };
  const shock = { ...card("Shock"), id: "shock", type_line: "Instant" };
  function lacking(fields: object = {}) {
    return {
      deck_id: ID,
      missing: 3,
      complete: false,
      cards: [
        {
          card: bolt,
          needed: 4,
          owned: 1,
          missing: 3,
          wished: 0,
          auctions: 2,
          packs: [{ product_id: "p1", name: "Alpha Booster", set_code: "lea" }],
          ...fields,
        },
      ],
    };
  }

  async function open(api: Api) {
    render(<DeckWorkshop deckId={ID} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen.getByRole("tab", { name: "Missing cards" }).click(),
    );
    await settle();
  }

  it("says what the draft lacks, with where each card might be had", async () => {
    const { api } = serve();
    api.on("GET /api/v1/decks/{deck_id}/missing", () => reply(200, lacking()));
    await open(api);
    expect(
      screen.getByText(/The draft lacks 3 copies across 1 card\./),
    ).toBeInTheDocument();
    const row = within(screen.getByRole("list", { name: "Missing cards" }));
    expect(row.getByRole("listitem")).toHaveTextContent(
      "Lightning BoltThe deck plays 4, you own 1: 3 missing",
    );
    expect(
      row.getByRole("link", { name: "2 open auctions at Tivit's" }),
    ).toHaveAttribute("href", "#auctions/search");
    expect(row.getByRole("listitem")).toHaveTextContent(
      "May be in Leng's packs: Alpha Booster",
    );
  });

  it("wishes for the copies missing, for this deck, and takes the wish back", async () => {
    const { api } = serve();
    const served = { wished: 0 };
    api.on("GET /api/v1/decks/{deck_id}/missing", () =>
      reply(200, lacking({ wished: served.wished })),
    );
    api.on("PUT /api/v1/me/wishlist/{card_id}", () => {
      served.wished = 3;
      return reply(200, { wishes: [] });
    });
    api.on("DELETE /api/v1/me/wishlist/{card_id}", () => {
      served.wished = 0;
      return reply(200, { wishes: [] });
    });
    await open(api);
    await act(async () =>
      screen
        .getByRole("button", { name: "Wish for 3 × Lightning Bolt" })
        .click(),
    );
    await settle();
    expect(sent(api, "PUT /api/v1/me/wishlist/{card_id}")).toEqual({
      params: { path: { card_id: "bolt" } },
      body: { quantity: 3, deck_id: ID },
    });
    expect(screen.getByText(/On your wishlist \(3\)\./)).toBeInTheDocument();
    await act(async () =>
      screen
        .getByRole("button", { name: "Take Lightning Bolt off your wishlist" })
        .click(),
    );
    await settle();
    expect(
      screen.getByRole("button", { name: "Wish for 3 × Lightning Bolt" }),
    ).toBeInTheDocument();
  });

  it("offers owned substitutes with their reasons, swaps one into the draft, and undoes it", async () => {
    const { api } = serve();
    const served = { complete: false };
    api.on("GET /api/v1/decks/{deck_id}/missing", () =>
      reply(
        200,
        served.complete
          ? { deck_id: ID, missing: 0, complete: true, cards: [] }
          : lacking(),
      ),
    );
    api.on("GET /api/v1/decks/{deck_id}/substitutions", () =>
      reply(200, {
        deck_id: ID,
        card: bolt,
        substitutes: [
          {
            card: shock,
            spare: 5,
            score: 72,
            reasons: ["Also an instant", "Costs one mana, as it does"],
          },
        ],
        note: null,
      }),
    );
    let version = 7;
    api.on("PUT /api/v1/decks/{deck_id}/draft", (options) => {
      const body = (options as { body: { entries: unknown[] } }).body;
      version += 1;
      served.complete = body.entries.some(
        (entry) => (entry as { card_id: string }).card_id === "shock",
      );
      return reply(200, {
        version,
        entries: body.entries,
        cards: {},
        validation: {},
        updated_at: "2026-11-15T10:00:00Z",
      });
    });
    await open(api);
    await act(async () =>
      screen
        .getByRole("button", { name: "Substitutes you own for Lightning Bolt" })
        .click(),
    );
    await settle();
    expect(
      sent(api, "GET /api/v1/decks/{deck_id}/substitutions").params,
    ).toEqual({
      path: { deck_id: ID },
      query: { card_id: "bolt" },
    });
    const offered = within(
      screen.getByRole("list", { name: "Substitutes for Lightning Bolt" }),
    );
    expect(offered.getAllByRole("listitem")[0]).toHaveTextContent(
      "ShockInstant · 5 to spare · alike 72 of 100",
    );
    expect(offered.getByText("Also an instant")).toBeInTheDocument();
    // How alike is not how strong: said where the number is.
    expect(screen.getByText(/not of how strong either is/)).toBeInTheDocument();

    await act(async () =>
      offered
        .getByRole("button", {
          name: "Swap 3 × Lightning Bolt for Shock in the draft",
        })
        .click(),
    );
    await settle();
    // Only the copies missing give way, in the draft the page read.
    expect(sent(api, "PUT /api/v1/decks/{deck_id}/draft")).toEqual({
      params: { path: { deck_id: ID } },
      body: {
        version: 7,
        entries: [
          { card_id: "bolt", location: "main", quantity: 1 },
          { card_id: "mountain", location: "main", quantity: 56 },
          { card_id: "shock", location: "main", quantity: 3 },
        ],
      },
    });
    const swapNote = screen.getByText(
      /Swapped 3 × Lightning Bolt for Shock in the draft\. No saved version changed\./,
    );
    expect(swapNote).toBeInTheDocument();
    expect(
      screen.getByText(/Your library holds every card of this deck's draft/),
    ).toBeInTheDocument();

    await act(async () =>
      screen.getByRole("button", { name: "Undo the swap" }).click(),
    );
    await settle();
    // The draft as it was, sent with the version the swap made.
    expect(sent(api, "PUT /api/v1/decks/{deck_id}/draft").body).toEqual({
      version: 8,
      entries: [
        { card_id: "bolt", location: "main", quantity: 4 },
        { card_id: "mountain", location: "main", quantity: 56 },
      ],
    });
    expect(
      screen.getByText("The swap is undone: the draft is as it was."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo the swap" })).toBeNull();
  });

  it("says why no substitute is offered", async () => {
    const { api } = serve();
    api.on("GET /api/v1/decks/{deck_id}/missing", () => reply(200, lacking()));
    api.on("GET /api/v1/decks/{deck_id}/substitutions", () =>
      reply(200, {
        deck_id: ID,
        card: bolt,
        substitutes: [],
        note: "Nothing you own is close enough to offer.",
      }),
    );
    await open(api);
    await act(async () =>
      screen
        .getByRole("button", { name: "Substitutes you own for Lightning Bolt" })
        .click(),
    );
    await settle();
    expect(
      screen.getByText("Nothing you own is close enough to offer."),
    ).toBeInTheDocument();
  });

  it("swaps nothing when the deck changed elsewhere, and reads it again", async () => {
    const { api } = serve();
    api.on("GET /api/v1/decks/{deck_id}/missing", () => reply(200, lacking()));
    api.on("GET /api/v1/decks/{deck_id}/substitutions", () =>
      reply(200, {
        deck_id: ID,
        card: bolt,
        substitutes: [
          { card: shock, spare: 1, score: 60, reasons: ["An instant"] },
        ],
      }),
    );
    api.on("PUT /api/v1/decks/{deck_id}/draft", () =>
      reply(409, { code: "draft_conflict", message: "The draft changed." }),
    );
    await open(api);
    await act(async () =>
      screen
        .getByRole("button", { name: "Substitutes you own for Lightning Bolt" })
        .click(),
    );
    await settle();
    const before = api.calls.filter(
      (call) => call.route === "GET /api/v1/decks/{deck_id}",
    ).length;
    // One spare copy: one copy is swapped, not the three missing.
    await act(async () =>
      screen
        .getByRole("button", {
          name: "Swap 1 × Lightning Bolt for Shock in the draft",
        })
        .click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This deck changed somewhere else since this page opened, so nothing was swapped.",
    );
    expect(
      api.calls.filter((call) => call.route === "GET /api/v1/decks/{deck_id}")
        .length,
    ).toBeGreaterThan(before);
    expect(screen.queryByRole("button", { name: "Undo the swap" })).toBeNull();
  });

  it("says when the library holds every card", async () => {
    const { api } = serve();
    api.on("GET /api/v1/decks/{deck_id}/missing", () =>
      reply(200, { deck_id: ID, missing: 0, complete: true, cards: [] }),
    );
    await open(api);
    expect(
      screen.getByText(/Your library holds every card of this deck's draft/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Missing cards" })).toBeNull();
  });
});
