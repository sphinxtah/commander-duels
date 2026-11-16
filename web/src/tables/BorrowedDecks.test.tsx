import { act, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { forgetRollout } from "../app/rollout";
import { mockApi, openDialogs, reply } from "../decks/fixtures";
import type { Loan } from "../decks/loans";
import type { OwnDeck, TablePlayer, TableView } from "./tables";
import { TablesPage } from "./TablesPage";

// A deck a friend lent, at a table (v1.0.0, docs/decks.md): among the player's choices only at a
// private table where its lender sits, and said why not elsewhere; the player's own deck that
// a friend has now is not theirs to choose; and a seat that plays a borrowed deck says so.

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

function table(fields: Partial<TableView> = {}): TableView {
  return {
    code: CODE,
    format: "legacy",
    visibility: "private",
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
    open_seats: 1,
    starter: false,
    profile_changed: false,
    spectators: "nobody",
    spectator_delay: 0,
    watching: false,
    ...fields,
  };
}

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
      id: "deck-bob",
      title: "Storm",
      format: "legacy",
      version: 2,
      card_count: 60,
      commanders: [],
    },
    lender: ref("u-bob", "bob"),
    borrower: ref("u-ada", "ada"),
    state: "accepted",
    offered_at: "2026-11-15T10:00:00Z",
    until: "2026-11-22T10:00:00Z",
    yours: false,
    ...fields,
  } as Loan;
}

async function settle() {
  for (let i = 0; i < 5; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function serve(
  shown: TableView,
  loans: { given?: Loan[]; taken?: Loan[] } = {},
  open = true,
) {
  const api = mockApi();
  const served = { table: shown };
  api.on("GET /api/v1/rollout", () =>
    reply(200, {
      workflows: [{ id: "deck_lending", name: "Lending", available: open }],
    }),
  );
  api.on("GET /api/v1/tables/{code}", () => reply(200, served.table));
  api.on("GET /api/v1/decks", () => reply(200, [deck()]));
  api.on("GET /api/v1/friends", () =>
    reply(200, { friends: [], incoming: [], outgoing: [], waiting: [] }),
  );
  api.on("GET /api/v1/loans", () =>
    reply(200, { given: [], taken: [], days: 7, limit: 20, ...loans }),
  );
  return { api, served };
}

const choices = () =>
  within(screen.getByLabelText("Your deck"))
    .getAllByRole("option")
    .map((option) => [
      option.textContent,
      (option as HTMLOptionElement).disabled,
    ]);

beforeEach(() => {
  openDialogs();
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  forgetRollout();
  window.location.hash = "";
});

describe("a borrowed deck at a table", () => {
  it("is a choice at a private table where its lender sits, and is sat down with", async () => {
    const { api, served } = serve(table(), { taken: [loan()] });
    api.on("POST /api/v1/tables/{code}/join", () => {
      served.table = table({
        your_seat: 1,
        open_seats: 0,
        players: [
          seat({
            seat: 0,
            taken: true,
            handle: "bob",
            host: true,
            ready: true,
          }),
          seat({
            seat: 1,
            taken: true,
            handle: "ada",
            you: true,
            deck: "Storm",
            deck_id: "deck-bob",
            borrowed: true,
          }),
        ],
      });
      return reply(200, served.table);
    });
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(choices()).toEqual([
      ["Red deck", false],
      ["Storm (borrowed from bob)", false],
    ]);
    const select = screen.getByLabelText("Your deck") as HTMLSelectElement;
    expect(
      within(select).getByRole("group", { name: "Lent to you" }),
    ).toBeInTheDocument();
    await act(async () => {
      select.value = "deck-bob";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      screen.getByRole("button", { name: "Take a seat" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/tables/{code}/join")!
        .options,
    ).toMatchObject({ body: { deck_id: "deck-bob" } });
    // The seat says so to the table; whose deck it is, it does not.
    const seats = screen.getAllByText("Borrowed deck");
    expect(seats.length).toBeGreaterThan(0);
    expect(
      (screen.getByLabelText("Your deck") as HTMLSelectElement).value,
    ).toBe("deck-bob");
  });

  it("is not a choice at a public table, nor where its lender does not sit: it says why", async () => {
    serve(table({ visibility: "public" }), { taken: [loan()] });
    const { unmount } = render(
      <TablesPage me={ada} heading={createRef()} code={CODE} />,
    );
    await settle();
    expect(choices()).toEqual([
      ["Red deck", false],
      [
        "Storm (borrowed from bob: only at a private table where bob sits)",
        true,
      ],
    ]);
    unmount();
    forgetRollout();

    serve(
      table({
        host: "cy",
        players: [
          seat({ seat: 0, taken: true, handle: "cy", host: true, ready: true }),
          seat({ seat: 1 }),
        ],
      }),
      { taken: [loan()] },
    );
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(choices()[1]).toEqual([
      "Storm (borrowed from bob: only at a private table where bob sits)",
      true,
    ]);
  });

  it("is left out where it is of another format, only offered, or lending is closed", async () => {
    serve(table(), {
      taken: [
        loan({ state: "offered" }),
        loan({
          id: "loan-2",
          deck: { ...loan().deck, id: "deck-edh", format: "commander" },
        }),
      ],
    });
    const { unmount } = render(
      <TablesPage me={ada} heading={createRef()} code={CODE} />,
    );
    await settle();
    expect(choices()).toEqual([["Red deck", false]]);
    unmount();
    forgetRollout();

    const { api } = serve(table(), { taken: [loan()] }, false);
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(choices()).toEqual([["Red deck", false]]);
    expect(api.calls.some((call) => call.route === "GET /api/v1/loans")).toBe(
      false,
    );
  });

  it("keeps the player's own deck that a friend has now out of their choices", async () => {
    serve(table(), {
      given: [
        loan({
          yours: true,
          lender: ref("u-ada", "ada"),
          borrower: ref("u-cy", "cy"),
          deck: { ...loan().deck, id: "deck-1", title: "Red deck" },
        }),
      ],
    });
    render(<TablesPage me={ada} heading={createRef()} code={CODE} />);
    await settle();
    expect(choices()).toEqual([["Red deck (lent to cy)", true]]);
    expect(screen.getByRole("button", { name: "Take a seat" })).toBeDisabled();
  });

  it("keeps it out of the decks a table is opened with, too", async () => {
    const { api } = serve(table(), {
      given: [
        loan({
          yours: true,
          lender: ref("u-ada", "ada"),
          borrower: ref("u-cy", "cy"),
          deck: { ...loan().deck, id: "deck-1", title: "Red deck" },
        }),
      ],
    });
    api.on("GET /api/v1/decks", () =>
      reply(200, [deck(), deck({ id: "deck-2", title: "Green deck" })]),
    );
    api.on("GET /api/v1/tables/browse", () =>
      reply(200, { tables: [], total: 0, page: 1, per_page: 20, yours: null }),
    );
    api.on("GET /api/v1/me/table-presets", () =>
      reply(200, { built_in: [], saved: [], limit: 12, paces: [] }),
    );
    render(<TablesPage me={ada} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Open a table" }).click(),
    );
    await settle();
    const form = within(screen.getByRole("dialog", { name: "Open a table" }));
    await act(async () => form.getByRole("radio", { name: /^Legacy/ }).click());
    const select = form.getByLabelText("Your deck") as HTMLSelectElement;
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => [
          option.textContent,
          (option as HTMLOptionElement).disabled,
        ]),
    ).toEqual([
      ["Red deck (lent to cy)", true],
      ["Green deck", false],
    ]);
    expect(select.value).toBe("deck-2");
  });
});
