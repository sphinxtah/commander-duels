import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef, StrictMode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { customCard } from "../alliance/fixtures";
import { DeckEditor } from "./DeckEditor";
import type { DeckEntry } from "./decks";
import {
  card,
  customSummary,
  deckDetail,
  edition,
  entry,
  mockApi,
  openDialogs,
  problem,
  reply,
  validation,
} from "./fixtures";

const bolt = card("Lightning Bolt", {
  mana_cost: "{R}",
  type_line: "Instant",
  colors: ["R"],
});
const mountain = card("Mountain", {
  mana_cost: null,
  mana_value: 0,
  type_line: "Basic Land — Mountain",
  produced_mana: ["R"],
  copy_limit: 0,
});
const DECK = "GET /api/v1/decks/{deck_id}";
const DRAFT = "PUT /api/v1/decks/{deck_id}/draft";
// The editor saves a moment after the last change.
const SAVED = { timeout: 4000 };
// Its search asks a moment after the deck arrives, and the first results wait on that and on the
// first draw of the whole editor: on a busy machine (every test file at once) more than the
// default second.
const FOUND = { timeout: 4000 };

beforeAll(openDialogs);
afterEach(() => vi.restoreAllMocks());
// Most of these read the deck's list, which since v0.6.2 is a switch away from its pictures; the
// pictures have their own tests at the end.
beforeEach(() => localStorage.setItem("cd.decks.view.v1", "list"));

function deck(version: number, entries = [entry(bolt, 4)]) {
  return deckDetail({
    draft: { version, entries },
    cards: { [bolt.id]: bolt, [mountain.id]: mountain },
    validation: validation({ legal: false, playable: false }),
  });
}
/** A saved draft: the entries as sent, unless the server gave them editions (v0.5.0). */
function saved(version: number, entries?: DeckEntry[]) {
  return (options: unknown) =>
    reply(200, {
      version,
      updated_at: "2026-10-20T10:00:00Z",
      entries:
        entries ?? (options as { body: { entries: DeckEntry[] } }).body.entries,
      validation: validation(),
      cards: {},
    });
}
function finding(api: ReturnType<typeof mockApi>) {
  api.on("GET /api/v1/cards", () =>
    reply(200, { items: [mountain], total: 1, page: 1, page_size: 24 }),
  );
}
function addMountain() {
  const found = screen.getByRole("button", { name: /^Mountain/ });
  fireEvent.click(
    within(found.closest("li")!).getByRole("button", { name: "Add" }),
  );
}
function drafts(api: ReturnType<typeof mockApi>) {
  return api.calls
    .filter((call) => call.route === DRAFT)
    .map((call) => (call.options as { body: unknown }).body);
}
/** The query of each card search the finder sent, in order. */
function searches(api: ReturnType<typeof mockApi>) {
  return api.calls
    .filter((call) => call.route === "GET /api/v1/cards")
    .map(
      (call) =>
        (call.options as { params: { query: Record<string, unknown> } }).params
          .query,
    );
}

// As a player who builds from a library sees them (v0.3.1): every card but a basic land (the
// Mountain, owned null) says its copies.
const ownedBolt = { ...bolt, owned: 1 };
const golem = card("Stand-in Golem", { owned: 0 });

// These run on the editor's real clock, a search and a save or two each: more than the default
// five seconds on a busy machine, and more than the waits above add up to.
describe("the deck editor", { timeout: 15_000 }, () => {
  it("saves a change on its own, with the version it was based on", async () => {
    const api = mockApi();
    api.on(DECK, () => reply(200, deck(3)));
    api.on(DRAFT, saved(4));
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    await screen.findByRole("button", { name: /^Mountain/ }, FOUND);
    addMountain();
    expect(screen.getByText("Unsaved changes…")).toBeInTheDocument();
    expect(
      await screen.findByText("All changes saved", undefined, SAVED),
    ).toBeInTheDocument();
    expect(drafts(api)).toEqual([
      { version: 3, entries: [entry(bolt, 4), entry(mountain, 1)] },
    ]);
    // The server's validation replaces the one the deck opened with.
    expect(
      screen.getByText(
        "Ready to play: legal, and every card is playable here.",
      ),
    ).toBeInTheDocument();
  });

  it("asks what to keep when another tab saved first, and can combine both", async () => {
    const api = mockApi();
    api.on(
      DECK,
      () => reply(200, deck(3)),
      // Another tab took the bolts down to two and saved version 4.
      () => reply(200, deck(4, [entry(bolt, 2)])),
    );
    api.on(
      DRAFT,
      () => reply(409, { code: "draft_conflict", message: "Changed." }),
      saved(5),
    );
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    await screen.findByRole("button", { name: /^Mountain/ }, FOUND);
    addMountain();
    const dialog = await screen.findByRole(
      "dialog",
      { name: "This deck changed somewhere else" },
      SAVED,
    );
    expect(dialog).toHaveTextContent("Lightning Bolthere 4, saved 2");
    expect(dialog).toHaveTextContent("Mountainhere 1, saved 0");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Combine/ }));
    await waitFor(() => expect(drafts(api)).toHaveLength(2), SAVED);
    expect(drafts(api)[1]).toEqual({
      version: 4,
      entries: [entry(bolt, 4), entry(mountain, 1)],
    });
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
  });

  it("takes the saved version without sending anything", async () => {
    const api = mockApi();
    api.on(
      DECK,
      () => reply(200, deck(3)),
      () => reply(200, deck(4, [entry(bolt, 2)])),
    );
    api.on(DRAFT, () =>
      reply(409, { code: "draft_conflict", message: "Changed." }),
    );
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    await screen.findByRole("button", { name: /^Mountain/ }, FOUND);
    addMountain();
    const dialog = await screen.findByRole(
      "dialog",
      { name: "This deck changed somewhere else" },
      SAVED,
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Use the saved version" }),
    );
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    expect(screen.getByLabelText("2 copies")).toBeInTheDocument();
    expect(drafts(api)).toHaveLength(1);
  });

  it("keeps the first edit when StrictMode's other request for the deck answers after it", async () => {
    // StrictMode (pnpm dev, and so the browser journeys) asks for the deck twice. The answer
    // to the mount it throws away is held back until a bolt has been taken out.
    const api = mockApi();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opened = () => reply(200, deck(1, [entry(bolt, 5)]));
    api.on(DECK, () => held.then(opened), opened);
    api.on(DRAFT, saved(2));
    finding(api);
    render(
      <StrictMode>
        <DeckEditor deckId="deck-1" heading={createRef()} />
      </StrictMode>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "One fewer Lightning Bolt" }),
    );
    await act(async () => release());
    expect(api.calls.filter((call) => call.route === DECK)).toHaveLength(2);
    expect(screen.getByLabelText("4 copies")).toBeInTheDocument();
    expect(
      await screen.findByText("All changes saved", undefined, SAVED),
    ).toBeInTheDocument();
    expect(drafts(api)).toEqual([{ version: 1, entries: [entry(bolt, 4)] }]);
    expect(screen.getByLabelText("4 copies")).toBeInTheDocument();
  });

  it("names the cards that left the deck because the game cannot play them, until dismissed (v0.4.5)", async () => {
    const api = mockApi();
    api.on(DECK, () =>
      reply(200, {
        ...deck(3),
        removed_cards: [
          {
            name: "Temple of Khonshu",
            quantity: 2,
            reason: "The game engine has no implementation of this card yet.",
            removed_at: "2026-10-22T10:00:00Z",
          },
        ],
      }),
    );
    api.on("DELETE /api/v1/decks/{deck_id}/removed-cards", () =>
      reply(200, { ...deck(3), removed_cards: [] }),
    );
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    const note = await screen.findByRole("region", {
      name: "Cards that left this deck",
    });
    expect(note).toHaveTextContent(
      "2 Temple of Khonshu: The game engine has no implementation of this card yet.",
    );
    fireEvent.click(within(note).getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Cards that left this deck" }),
      ).toBeNull(),
    );
    // The finder asks for cards legal in the format; every card it finds is in the game.
    await screen.findByRole("button", { name: /^Mountain/ }, FOUND);
    expect(searches(api)[0]).toMatchObject({ legal: "legacy" });
    expect(searches(api)[0]).not.toHaveProperty("playable");
  });

  it("starts the finder on the player's library, with copies, and switches to all cards", async () => {
    const api = mockApi();
    api.on(DECK, () =>
      reply(
        200,
        deckDetail({
          draft: { version: 1, entries: [entry(ownedBolt, 1)] },
          cards: { [ownedBolt.id]: ownedBolt },
        }),
      ),
    );
    api.on(
      "GET /api/v1/cards",
      () =>
        reply(200, {
          items: [ownedBolt, mountain],
          total: 2,
          page: 1,
          page_size: 24,
        }),
      () =>
        reply(200, {
          items: [ownedBolt, golem],
          total: 2,
          page: 1,
          page_size: 24,
        }),
    );
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    const finder = await screen.findByRole("region", { name: "Add cards" });
    const found = await within(finder).findByRole(
      "button",
      { name: /^Mountain/ },
      FOUND,
    );
    expect(searches(api)[0]).toMatchObject({ owned: true });
    const library = within(finder).getByRole("radio", { name: "My library" });
    expect(library).toBeChecked();
    expect(
      within(finder).getByRole("button", { name: /^Lightning Bolt/ })
        .parentElement,
    ).toHaveTextContent("In your library: 1");
    // A basic land is never limited, so nothing is said of it.
    expect(found.closest("li")).not.toHaveTextContent(/your library/);

    fireEvent.click(within(finder).getByRole("radio", { name: "All cards" }));
    expect(
      within(finder).getByText(/Cards you don't own can be added/),
    ).toBeInTheDocument();
    const other = await within(finder).findByRole(
      "button",
      { name: /^Stand-in Golem/ },
      FOUND,
    );
    expect(other.closest("li")).toHaveTextContent("Not in your library");
    expect(searches(api).at(-1)).not.toHaveProperty("owned");
  });

  it("offers no library switch to an account that builds from the whole catalog", async () => {
    const api = mockApi();
    api.on(DECK, () => reply(200, deckDetail()));
    api.on("GET /api/v1/cards", () =>
      reply(200, { items: [bolt], total: 1, page: 1, page_size: 24 }),
    );
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    await screen.findByRole("button", { name: /^Lightning Bolt/ }, FOUND);
    expect(screen.queryByRole("radio", { name: "My library" })).toBeNull();
    expect(screen.queryByText(/your library/)).toBeNull();
  });

  it("says a deck needs cards the player doesn't own, and keeps it from the practice table", async () => {
    const api = mockApi();
    api.on(DECK, () =>
      reply(
        200,
        deckDetail({
          draft: { version: 1, entries: [entry(ownedBolt, 4)] },
          cards: { [ownedBolt.id]: ownedBolt },
          validation: validation({
            playable: false,
            errors: [
              problem({
                message:
                  "This deck holds 4 copies of Lightning Bolt; your library has 1 copy.",
                remedy: "Remove 3, or wait until your library holds more.",
                card_ids: [ownedBolt.id],
                quantity: 4,
              }),
            ],
          }),
        }),
      ),
    );
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    expect(
      await screen.findByText(/^Legal, but it needs cards you don't own/),
    ).toHaveAttribute("data-state", "locked");
    const found = screen
      .getByText(/^This deck holds 4 copies of Lightning Bolt/)
      .closest("li")!;
    expect(found).toHaveTextContent(
      "Needs cards you don't own: This deck holds 4 copies of Lightning Bolt; your library has 1 copy. Remove 3, or wait until your library holds more.",
    );
    expect(found.querySelector("svg")).not.toBeNull();
    // The row itself says how many the library holds.
    const row = screen
      .getByRole("button", { name: "Remove Lightning Bolt" })
      .closest("li")!;
    expect(row).toHaveTextContent("You own 1");
    expect(row).toHaveAttribute("data-locked", "true");
    // No way to the table: the deck cannot start a game.
    expect(
      screen.queryByRole("link", { name: "Play it at the practice table" }),
    ).toBeNull();
    expect(
      screen.getByText("Not playable: it needs cards you don't own."),
    ).toBeInTheDocument();
  });

  it("says which tables take a deck holding a banned card", async () => {
    const api = mockApi();
    api.on(DECK, () =>
      reply(
        200,
        deckDetail({
          draft: { version: 1, entries: [entry(bolt, 4)] },
          cards: { [bolt.id]: bolt },
          needs: ["banned"],
          validation: validation({
            needs: ["banned"],
            warnings: [
              problem({
                code: "card.banned",
                kind: "banned",
                message:
                  "Lightning Bolt is banned in Legacy: the deck plays only at tables that allow banned cards.",
                remedy: "Remove it to play at any table.",
                card_ids: [bolt.id],
                quantity: null,
              }),
            ],
          }),
        }),
      ),
    );
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    expect(
      await screen.findByText(
        "Ready to play at tables that allow banned cards.",
      ),
    ).toHaveAttribute("data-state", "playable");
    expect(
      screen.getByText(/^Lightning Bolt is banned in Legacy/).closest("li"),
    ).toHaveTextContent(
      "Casual tables only: Lightning Bolt is banned in Legacy: the deck plays only at tables that allow banned cards. Remove it to play at any table.",
    );
    // The practice table is casual unless told otherwise: the deck may go there.
    expect(
      screen.getByRole("link", { name: "Play it at the practice table" }),
    ).toBeInTheDocument();
  });

  it("offers a player only the editions their library holds, and adds one (v0.5.0)", async () => {
    const api = mockApi();
    const revised = edition("p-revised", "Revised Edition", 2);
    const fourth = edition("p-fourth", "Fourth Edition", 1);
    const king = card("Goblin King", {
      owned: 3,
      editions: [revised, fourth],
    });
    const seventh: DeckEntry = { ...entry(king, 1), printing_id: "p-seventh" };
    api.on(DECK, () =>
      reply(
        200,
        deckDetail({
          draft: { version: 1, entries: [seventh, entry(mountain, 59)] },
          cards: { [king.id]: king, [mountain.id]: mountain },
          validation: validation({
            playable: false,
            errors: [
              problem({
                message:
                  "This deck holds 1 copy of Goblin King from Seventh Edition; your library has none of that edition.",
                remedy:
                  "You own Goblin King from Revised Edition and Fourth Edition: switch this copy to them.",
                card_ids: [king.id],
                quantity: 1,
              }),
            ],
          }),
          switched_editions: [
            {
              name: "Goblin King",
              quantity: 2,
              before: "Fifth Edition (5ED #1)",
              after: "Revised Edition (3ED #1)",
              switched_at: "2026-10-23T10:00:00Z",
            },
          ],
        }),
      ),
    );
    api.on("GET /api/v1/cards", () =>
      reply(200, { items: [king], total: 1, page: 1, page_size: 24 }),
    );
    api.on("GET /api/v1/cards/{card_id}", () => new Promise(() => {}));
    api.on(DRAFT, saved(2));
    api.on("DELETE /api/v1/decks/{deck_id}/switched-editions", () =>
      reply(200, { ...deckDetail(), switched_editions: [] }),
    );
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    // The deploy's note: what moved to the editions the library holds.
    const note = await screen.findByRole("region", {
      name: "Editions switched to the ones you own",
    });
    expect(note).toHaveTextContent(
      "2 Goblin King: from Fifth Edition (5ED #1) to Revised Edition (3ED #1)",
    );
    fireEvent.click(within(note).getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", {
          name: "Editions switched to the ones you own",
        }),
      ).toBeNull(),
    );
    // The row names an edition the library lacks, and holds it back.
    const row = screen
      .getByRole("button", { name: "Remove Goblin King" })
      .closest("li")!;
    expect(row).toHaveTextContent("an edition not in your library");
    expect(row).toHaveTextContent("You don't own this edition");
    expect(row).toHaveAttribute("data-locked", "true");
    // Its details list only the library's editions (the server's choice).
    fireEvent.click(within(row).getByRole("button", { name: /^Goblin King/ }));
    await screen.findByRole("dialog", { name: "Goblin King" });
    const asked = api.calls.find(
      (call) => call.route === "GET /api/v1/cards/{card_id}",
    )!.options as { params: { query: Record<string, unknown> } };
    expect(asked.params.query).toEqual({
      printing: "p-seventh",
      printings: "owned",
    });
    fireEvent.click(screen.getByRole("button", { name: "Close the card" }));

    // A copy added from the finder takes an edition the library holds and the deck leaves.
    const finder = await screen.findByRole("region", { name: "Add cards" });
    const found = await within(finder).findByRole(
      "button",
      { name: /^Goblin King/ },
      FOUND,
    );
    fireEvent.click(
      within(found.closest("li")!).getByRole("button", { name: "Add" }),
    );
    await waitFor(() => expect(drafts(api)).toHaveLength(1), SAVED);
    expect(drafts(api)[0]).toEqual({
      version: 1,
      entries: [
        seventh,
        entry(mountain, 59),
        { ...entry(king, 1), printing_id: "p-revised" },
      ],
    });
    expect(
      await screen.findByText("All changes saved", undefined, SAVED),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: /^Goblin King/ })
        .some((button) => button.textContent?.includes("Revised Edition")),
    ).toBe(true);
  });

  it("takes the editions the server gave a save (v0.5.0)", async () => {
    const api = mockApi();
    const king = card("Goblin King", {
      owned: 2,
      editions: [edition("p-revised", "Revised Edition", 2)],
    });
    api.on(DECK, () =>
      reply(
        200,
        deckDetail({
          draft: { version: 1, entries: [] },
          cards: { [king.id]: king, [mountain.id]: mountain },
        }),
      ),
    );
    api.on("GET /api/v1/cards", () =>
      reply(200, { items: [mountain], total: 1, page: 1, page_size: 24 }),
    );
    // The server named an edition for the copies the save named none for.
    api.on(
      DRAFT,
      saved(2, [
        entry(mountain, 1),
        { ...entry(king, 1), printing_id: "p-revised" },
      ]),
    );
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    await screen.findByRole("button", { name: /^Mountain/ }, FOUND);
    addMountain();
    expect(
      await screen.findByText("All changes saved", undefined, SAVED),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Goblin King/ }),
    ).toHaveTextContent("Revised Edition");
  });

  it("says when the deck is not there", async () => {
    const api = mockApi();
    api.on(DECK, () => reply(404, { code: "not_found", message: "No." }));
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    expect(
      await screen.findByRole("heading", { name: "No such deck." }),
    ).toBeInTheDocument();
  });
});

// Made-up stand-ins for the Godlike tier's custom cards (v0.4.0): never the owner's own.
const sigil = customSummary("Stand-in Sigil", {
  status: "not_implemented",
  status_reason: "not_loaded",
  status_detail: "Not loaded by this engine: a game here cannot play it.",
  playable: false,
});
const paragon = customSummary("Placeholder Paragon", {
  type_line: "Legendary Creature — Stand-in",
  mana_cost: "{W}{U}{B}{R}{G}",
  color_identity: ["W", "U", "B", "R", "G"],
  commander: true,
  loyalty: null,
  power: "5",
  toughness: "5",
});

describe("Godlike cards in the deck editor", { timeout: 15_000 }, () => {
  it("offers a Godlike account its custom cards with their images, and adds them", async () => {
    const api = mockApi();
    api.on(DECK, () => reply(200, deck(3)));
    api.on(DRAFT, saved(4));
    api.on("GET /api/v1/custom-cards", () =>
      reply(200, [
        customCard("Stand-in Sigil", { card: sigil }),
        customCard("Placeholder Paragon", {
          card: paragon,
          loaded: true,
          playable: true,
        }),
      ]),
    );
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    const shelf = (
      await screen.findByText("Godlike cards", undefined, FOUND)
    ).closest("details")!;
    const row = within(shelf)
      .getByRole("button", { name: /^Stand-in Sigil/ })
      .closest("li")!;
    expect(row.querySelector("img")).toHaveAttribute("src", sigil.custom_image);
    expect(row).toHaveTextContent("Not playable");
    expect(row).toHaveTextContent("In your library: 4");
    // A Legacy deck: no commander button, even for a legendary creature.
    const paragonRow = within(shelf)
      .getByRole("button", { name: /^Placeholder Paragon/ })
      .closest("li")!;
    expect(paragonRow).toHaveTextContent("Playable");
    expect(
      within(paragonRow).queryByRole("button", { name: "Commander" }),
    ).toBeNull();
    fireEvent.click(
      within(row).getByRole("button", { name: "Add Stand-in Sigil" }),
    );
    await waitFor(() => expect(drafts(api)).toHaveLength(1), SAVED);
    expect(drafts(api)[0]).toEqual({
      version: 3,
      entries: [entry(bolt, 4), entry(sigil, 1)],
    });
    // The deck shows it, and opening it shows its own image and text, not the catalog's page.
    const listed = screen
      .getByRole("button", { name: "Remove Stand-in Sigil" })
      .closest("li")!;
    fireEvent.click(
      within(listed).getByRole("button", { name: /^Stand-in Sigil/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Stand-in Sigil",
    });
    expect(dialog).toHaveTextContent("+1: Draw a stand-in card.");
    expect(dialog).toHaveTextContent("Not loaded by this engine");
    expect(dialog.querySelector("img")).toHaveAttribute(
      "src",
      sigil.custom_image,
    );
    expect(api.calls.map((call) => call.route)).not.toContain(
      "GET /api/v1/cards/{card_id}",
    );
  });

  it("offers a Commander deck only the custom cards its commander's identity allows", async () => {
    const api = mockApi();
    const leader = card("Stand-in Leader", {
      type_line: "Legendary Creature — Stand-in",
      color_identity: ["U"],
      commander: true,
    });
    api.on(DECK, () =>
      reply(
        200,
        deckDetail({
          format: "commander",
          draft: { version: 1, entries: [entry(leader, 1, "commander")] },
          cards: { [leader.id]: leader },
        }),
      ),
    );
    api.on("GET /api/v1/custom-cards", () =>
      reply(200, [
        customCard("Stand-in Sigil", { card: sigil }),
        customCard("Placeholder Paragon", { card: paragon }),
      ]),
    );
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    const shelf = (
      await screen.findByText("Godlike cards", undefined, FOUND)
    ).closest("details")!;
    expect(
      within(shelf).getByRole("button", { name: /^Stand-in Sigil/ }),
    ).toBeInTheDocument();
    expect(
      within(shelf).queryByRole("button", { name: /^Placeholder Paragon/ }),
    ).toBeNull();
    // Without the filter, the five-color one shows, with its commander button.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /^Only cards this deck can use/ }),
    );
    const paragonRow = within(shelf)
      .getByRole("button", { name: /^Placeholder Paragon/ })
      .closest("li")!;
    expect(
      within(paragonRow).getByRole("button", { name: "Commander" }),
    ).toBeInTheDocument();
  });

  it("shows nothing of them below the Godlike tier", async () => {
    const api = mockApi();
    api.on(DECK, () => reply(200, deck(3)));
    api.on("GET /api/v1/custom-cards", () =>
      reply(404, { code: "not_found", message: "Not found." }),
    );
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    await screen.findByRole("button", { name: /^Mountain/ }, FOUND);
    expect(screen.queryByText("Godlike cards")).toBeNull();
  });
});

describe("the deck as its cards (v0.6.2)", { timeout: 15_000 }, () => {
  // The owner's request: pictures by default, the list the other view.
  beforeEach(() => localStorage.removeItem("cd.decks.view.v1"));
  const leader = card("Stand-in Leader", {
    type_line: "Legendary Creature — Stand-in",
    commander: true,
    image: { printing_id: "p-leader", faces: 0 },
  });
  function commanderDeck() {
    return deckDetail({
      format: "commander",
      draft: {
        version: 1,
        entries: [
          entry(leader, 1, "commander"),
          entry(bolt, 1),
          entry(mountain, 30),
        ],
      },
      cards: { [leader.id]: leader, [bolt.id]: bolt, [mountain.id]: mountain },
      validation: validation({ format: "commander" }),
    });
  }

  it("shows the commander first, then the deck by type, each card with its copies", async () => {
    const api = mockApi();
    api.on(DECK, () => reply(200, commanderDeck()));
    api.on("GET /api/v1/cards/{card_id}", () => new Promise(() => {}));
    finding(api);
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    const switches = await screen.findByRole("group", {
      name: "Show cards as",
    });
    expect(
      within(switches).getByRole("button", { name: "Pictures" }),
    ).toHaveAttribute("aria-pressed", "true");
    const sections = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"))
      .filter((name) => name === "Commander" || name === "Main deck");
    expect(sections).toEqual(["Commander", "Main deck"]);
    const commander = within(
      screen.getByRole("region", { name: "Commander" }),
    ).getByRole("list", { name: "Commander" });
    const picture = within(commander).getByRole("button", {
      name: "Stand-in Leader, 1 copy",
    });
    expect(picture.querySelector("img")).toHaveAttribute(
      "src",
      "/api/v1/card-images/printings/p-leader?size=normal",
    );
    expect(
      screen.getByRole("list", { name: "Main deck: Instants" }),
    ).toHaveTextContent("Lightning Bolt");
    const lands = screen.getByRole("list", { name: "Main deck: Lands" });
    expect(
      within(lands).getByRole("button", { name: "Mountain, 30 copies" }),
    ).toHaveTextContent("×30");
    // No list rows: the pictures stand in their place.
    expect(screen.queryByRole("button", { name: "Lightning Bolt" })).toBeNull();

    // A picture opens the card as its name in the list does.
    fireEvent.click(
      screen.getByRole("button", { name: "Lightning Bolt, 1 copy" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Lightning Bolt" }),
    ).toBeInTheDocument();
    // Its details, of the deck's entry: the editions the library holds.
    const asked = api.calls.find(
      (call) => call.route === "GET /api/v1/cards/{card_id}",
    )!.options as {
      params: { path: { card_id: string }; query: Record<string, unknown> };
    };
    expect(asked.params.path.card_id).toBe(bolt.id);
    expect(asked.params.query).toMatchObject({ printings: "owned" });
    fireEvent.click(screen.getByRole("button", { name: "Close the card" }));

    // The copies change below the picture, as in the list.
    fireEvent.click(
      screen.getByRole("button", { name: "One more Lightning Bolt" }),
    );
    expect(
      screen.getByRole("button", { name: "Lightning Bolt, 2 copies" }),
    ).toHaveTextContent("×2");
    expect(screen.getByText("Unsaved changes…")).toBeInTheDocument();
    expect(
      within(commander).getByRole("button", {
        name: "One more Stand-in Leader",
      }),
    ).toBeDisabled();
  });

  it("switches to the list, and the browser remembers it", async () => {
    const api = mockApi();
    api.on(DECK, () => reply(200, commanderDeck()));
    finding(api);
    const { unmount } = render(
      <DeckEditor deckId="deck-1" heading={createRef()} />,
    );
    const switches = await screen.findByRole("group", {
      name: "Show cards as",
    });
    fireEvent.click(within(switches).getByRole("button", { name: "List" }));
    expect(localStorage.getItem("cd.decks.view.v1")).toBe("list");
    expect(
      screen.getByRole("button", { name: "Lightning Bolt" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Main deck: Lands" })).toBeNull();
    unmount();
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    expect(
      await screen.findByRole("button", { name: "Lightning Bolt" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Show cards as" })).getByRole(
        "button",
        { name: "List" },
      ),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
