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
import { DeckEditor } from "./DeckEditor";
import {
  card,
  deckDetail,
  entry,
  mockApi,
  openDialogs,
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

  it("says when the deck is not there", async () => {
    const api = mockApi();
    api.on(DECK, () => reply(404, { code: "not_found", message: "No." }));
    render(<DeckEditor deckId="deck-1" heading={createRef()} />);
    expect(
      await screen.findByRole("heading", { name: "No such deck." }),
    ).toBeInTheDocument();
  });
});
