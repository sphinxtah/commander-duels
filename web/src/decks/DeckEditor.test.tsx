import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { customCard } from "../alliance/fixtures";
import { DeckEditor } from "./DeckEditor";
import {
  card,
  customSummary,
  deckDetail,
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

function deck(version: number, entries = [entry(bolt, 4)]) {
  return deckDetail({
    draft: { version, entries },
    cards: { [bolt.id]: bolt, [mountain.id]: mountain },
    validation: validation({ legal: false, playable: false }),
  });
}
function saved(version: number) {
  return reply(200, {
    version,
    updated_at: "2026-10-20T10:00:00Z",
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
    api.on(DRAFT, () => saved(4));
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
      () => saved(5),
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
    api.on(DRAFT, () => saved(2));
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
    api.on(DRAFT, () => saved(4));
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
