import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { card, mockApi, reply } from "../decks/fixtures";
import { buildsFromLibrary, ownedWords, type CustomCard } from "./catalog";
import { CardsPage, resultWords } from "./CardsPage";

const player = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "player",
  status: "active",
  permissions: [],
  roles: ["player"],
} as unknown as Me;

// An administrator builds from the whole catalog (v0.3.1); a player from a library of their own.
const administrator = {
  ...player,
  permissions: ["library.unlimited"],
} as unknown as Me;

const bolt = card("Lightning Bolt");
// As a player who builds from a library sees them: each card says its copies.
const ownedBolt = card("Lightning Bolt", { owned: 2 });
const golem = card("Stand-in Golem", { owned: 0 });
// A made-up stand-in for the Godlike tier's custom cards, whose real names and text stay out of
// the repository.
const sigil: CustomCard = {
  id: "custom-1",
  name: "Stand-in Sigil",
  planeswalker: "stand-in",
  mana_cost: "{2}{U}",
  type_line: "Legendary Planeswalker — Stand-in",
  oracle_text: "+1: Draw a stand-in card.",
  flavor_text: null,
  power: null,
  toughness: null,
  loyalty: "4",
  rarity: "mythic",
  set_code: null,
  collector_number: null,
  artist: null,
  image_url: "/api/v1/custom-cards/custom-1/image?v=0123456789ab",
  playable: false,
  loaded: false,
  in_library: true,
  card: card("Stand-in Sigil", { custom: true }),
};

/** The edition a library item holds (v0.5.0). */
function libraryEdition(printingId: string, setName: string, code: string) {
  return {
    printing_id: printingId,
    set_code: code,
    set_name: setName,
    collector_number: "1",
    released_at: null,
    rarity: "common",
  };
}

function page(items: ReturnType<typeof card>[]) {
  return {
    items,
    total: items.length,
    page: 1,
    page_size: 60,
    milliseconds: 1,
  };
}

/** The API as the page first asks it: no catalog status yet and, below the Godlike tier, no
 * custom cards (the route answers as one that does not exist). */
function pageApi() {
  const api = mockApi();
  api.on("GET /api/v1/catalog", () => reply(404));
  api.on("GET /api/v1/custom-cards", () =>
    reply(404, { code: "not_found", message: "Not found." }),
  );
  api.on("GET /api/v1/me/alliance/cards", () =>
    reply(200, { alliance: null, name: null, custom: false, cards: [] }),
  );
  return api;
}

/** The query of each card search the page sent, in order. */
function searches(api: ReturnType<typeof mockApi>) {
  return api.calls
    .filter((call) => call.route === "GET /api/v1/cards")
    .map(
      (call) =>
        (call.options as { params: { query: Record<string, unknown> } }).params
          .query,
    );
}

beforeAll(() => {
  // jsdom has no modal dialogs; a card opens in one.
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => vi.restoreAllMocks());

describe("the Cards page", () => {
  it("lists the cards in the game, with no word of playability (v0.4.5)", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    render(<CardsPage me={player} heading={createRef()} />);
    expect(await screen.findByText("1 card")).toHaveAttribute("role", "status");
    expect(searches(api)[0]).not.toHaveProperty("playable");
    const tile = screen
      .getByRole("button", { name: "Lightning Bolt, Artifact" })
      .closest("li")!;
    expect(tile).not.toHaveTextContent(/playable/i);
    expect(
      screen.queryByRole("button", { name: /not playable yet/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.queryByLabelText("Playable here")).toBeNull();
  });

  it("names the cards the shown results hold while the next search runs", async () => {
    const api = pageApi();
    let answer: (value: unknown) => void = () => {};
    api.on(
      "GET /api/v1/cards",
      () => reply(200, page([bolt])),
      () => new Promise((resolve) => (answer = resolve)),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 card");
    fireEvent.change(screen.getByLabelText("Search cards"), {
      target: { value: "t:artifact" },
    });
    // The old results stay, and the line counts them until the new ones arrive.
    expect(await screen.findByText("1 card · searching…")).toBeInTheDocument();
    await vi.waitFor(() => expect(searches(api)).toHaveLength(2));
    answer(reply(200, page([bolt, golem])));
    expect(await screen.findByText("2 cards")).toBeInTheDocument();
  });

  it("clears its filters back to where it started", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 card");
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByLabelText("Rarity"), {
      target: { value: "rare" },
    });
    await vi.waitFor(() =>
      expect(searches(api).at(-1)).toMatchObject({ rarity: "rare" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await vi.waitFor(() =>
      expect(searches(api).at(-1)).not.toHaveProperty("rarity"),
    );
  });

  it("marks a player's copies, and keeps to their library when asked", async () => {
    const api = pageApi();
    api.on(
      "GET /api/v1/cards",
      () => reply(200, page([ownedBolt, golem])),
      () => reply(200, page([ownedBolt])),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    // The page browses every card in the game, the player's cards marked in it.
    expect(await screen.findByText("2 cards")).toBeInTheDocument();
    expect(searches(api)[0]).not.toHaveProperty("owned");
    expect(
      screen
        .getByRole("button", {
          name: "Lightning Bolt, Artifact, in your library: 2",
        })
        .closest("li"),
    ).toHaveTextContent("In your library: 2");
    expect(
      screen.getByRole("button", { name: /^Stand-in Golem, / }).closest("li"),
    ).toHaveTextContent("Not in your library");

    fireEvent.click(screen.getByRole("checkbox", { name: "In my library" }));
    expect(
      await screen.findByText("1 card in your library"),
    ).toBeInTheDocument();
    expect(searches(api).at(-1)).toMatchObject({ owned: true });
  });

  it("says nothing of a library to an account that builds from the whole catalog", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    api.on("GET /api/v1/library", () =>
      reply(200, { unlimited: true, alliance: null, cards: [] }),
    );
    render(<CardsPage me={administrator} heading={createRef()} />);
    await screen.findByText("1 card");
    expect(
      screen.queryByRole("checkbox", { name: "In my library" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Lightning Bolt, Artifact" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "My library" }));
    expect(
      await screen.findByText(/^You build from the whole catalog/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the player's library by edition, with copies and where they came from", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    api.on("GET /api/v1/library", () =>
      reply(200, {
        unlimited: false,
        alliance: "stand-in",
        cards: [
          {
            card: card("Arcane Signet", {
              owned: 1,
              image: { printing_id: "p-signet", faces: 0 },
            }),
            edition: libraryEdition("p-signet", "Commander Legends", "cmr"),
            copies: 1,
            sources: ["starter"],
          },
          {
            card: { ...ownedBolt, owned: 3 },
            edition: libraryEdition("p-bolt-m10", "Magic 2010", "m10"),
            copies: 2,
            sources: ["grandfathered", "starter"],
          },
          {
            card: { ...ownedBolt, owned: 3 },
            edition: libraryEdition("p-bolt-2ed", "Unlimited Edition", "2ed"),
            copies: 1,
            sources: ["pack"],
          },
          {
            card: card("Stand-in Walker", {
              type_line: "Legendary Planeswalker — Stand-in",
              owned: 4,
            }),
            edition: libraryEdition("p-walker", "Stand-in Set", "sis"),
            copies: 4,
            sources: ["alliance"],
          },
        ],
      }),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 card");
    const tab = screen.getByRole("tab", { name: "My library" });
    fireEvent.click(tab);
    expect(tab).toHaveAttribute("aria-selected", "true");
    // The cards themselves first (v0.5.0, the owner's request), one per edition (v0.5.0): each
    // with that edition's picture, name, copies and sources.
    const tiles = await screen.findByRole("list", { name: "Your library" });
    expect(screen.getByText("3 cards in 4 editions, 8 copies")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.queryByRole("table")).toBeNull();
    const tile = within(tiles)
      .getByRole("button", {
        name: "Lightning Bolt from Magic 2010 (M10 #1), Artifact, in your library: 2",
      })
      .closest("li")!;
    expect(tile).toHaveTextContent("Magic 2010 (M10 #1)");
    expect(tile).toHaveTextContent("In your library: 2");
    expect(tile).toHaveTextContent("Your earlier decks, Starter decks");
    expect(
      within(tiles).getByRole("button", {
        name: "Lightning Bolt from Unlimited Edition (2ED #1), Artifact, in your library: 1",
      }),
    ).toBeInTheDocument();
    expect(
      within(tiles)
        .getByRole("button", { name: /^Arcane Signet/ })
        .querySelector("img"),
    ).toHaveAttribute(
      "src",
      "/api/v1/card-images/printings/p-signet?size=normal",
    );
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "alliance" },
    });
    expect(within(tiles).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });

    // The list is a switch away, and the browser remembers it.
    const switches = screen.getByRole("group", { name: "Show cards as" });
    expect(
      within(switches).getByRole("button", { name: "Pictures" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(switches).getByRole("button", { name: "List" }));
    expect(localStorage.getItem("cd.cards.view.v1")).toBe("list");
    const table = screen.getByRole("table", { name: "Your library" });
    expect(screen.queryByRole("list", { name: "Your library" })).toBeNull();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Card", "Edition", "Type", "Copies", "From"]);
    const row = within(table)
      .getAllByRole("button", { name: "Lightning Bolt" })[0]!
      .closest("tr")!;
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual([
      "Magic 2010 (M10 #1)",
      "Artifact",
      "2",
      "Your earlier decks, Starter decks",
    ]);
    // Each source with the cards it gave, and what it gives.
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(
      [
        "Starter decks 2 cards",
        "Your alliance 1 card",
        "Packs you opened 1 card",
        "Your earlier decks 1 card",
      ],
    );
    expect(screen.getByRole("link", { name: "your profile" })).toHaveAttribute(
      "href",
      "#profile",
    );

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "alliance" },
    });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Stand-in Walker")).toBeInTheDocument();
    expect(screen.getByText("1 of 4 editions")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Find in your library"), {
      target: { value: "signet" },
    });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Arcane Signet")).toBeInTheDocument();
    // A set's name finds its cards too.
    fireEvent.change(screen.getByLabelText("Find in your library"), {
      target: { value: "unlimited" },
    });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Unlimited Edition (2ED #1)")).toBeVisible();
  });

  it("opens a card from the library with only the editions it holds (v0.5.0)", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    api.on("GET /api/v1/library", () =>
      reply(200, {
        unlimited: false,
        alliance: null,
        cards: [
          {
            card: { ...ownedBolt, owned: 2 },
            edition: libraryEdition("p-bolt-m10", "Magic 2010", "m10"),
            copies: 2,
            sources: ["pack"],
          },
        ],
      }),
    );
    api.on("GET /api/v1/cards/{card_id}", () => new Promise(() => {}));
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 card");
    fireEvent.click(screen.getByRole("tab", { name: "My library" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^Lightning Bolt from/ }),
    );
    await screen.findByRole("dialog", { name: "Lightning Bolt" });
    const asked = api.calls.find(
      (call) => call.route === "GET /api/v1/cards/{card_id}",
    )!.options as { params: { query: Record<string, unknown> } };
    expect(asked.params.query).toEqual({
      printing: "p-bolt-m10",
      printings: "owned",
    });
    // From All cards, every printing.
    fireEvent.click(screen.getByRole("button", { name: "Close the card" }));
    fireEvent.click(screen.getByRole("tab", { name: "All cards" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Lightning Bolt, Artifact" }),
    );
    const again = api.calls.filter(
      (call) => call.route === "GET /api/v1/cards/{card_id}",
    )[1]!.options as { params: { query?: Record<string, unknown> } };
    expect(again.params.query).toBeUndefined();
  });

  it("shows every tab as pictures or as a list, the same on each and remembered (v0.5.0)", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([ownedBolt, golem])));
    const teferi = card("Teferi, Temporal Archmage", {
      type_line: "Legendary Planeswalker — Teferi",
      owned: 4,
    });
    api.on("GET /api/v1/me/alliance/cards", () =>
      reply(200, {
        alliance: "teferi",
        name: "Teferi",
        custom: false,
        cards: [teferi],
      }),
    );
    const { unmount } = render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("2 cards");
    expect(screen.getByRole("list", { name: "Cards" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const table = screen.getByRole("table", { name: "Cards" });
    expect(screen.queryByRole("list", { name: "Cards" })).toBeNull();
    expect(
      within(table)
        .getAllByRole("row")
        .map((row) =>
          within(row)
            .queryAllByRole("cell")
            .map((cell) => cell.textContent),
        ),
    ).toEqual([[], ["Artifact", "2"], ["Artifact", "None"]]);
    // A name in the list opens the card, as its picture does.
    api.on("GET /api/v1/cards/{card_id}", () => new Promise(() => {}));
    fireEvent.click(
      within(table).getByRole("button", { name: "Lightning Bolt" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Lightning Bolt" }),
    ).toBeInTheDocument();

    // The alliance's tab follows the same switch.
    fireEvent.click(screen.getByRole("tab", { name: "Teferi's cards" }));
    const section = screen.getByRole("region", { name: "Teferi's cards" });
    expect(
      within(section).getByRole("table", { name: "Teferi's cards" }),
    ).toHaveTextContent("Teferi, Temporal Archmage");
    fireEvent.click(within(section).getByRole("button", { name: "Pictures" }));
    expect(
      within(section).getByRole("list", { name: "Teferi's cards" }),
    ).toBeInTheDocument();

    // A later visit opens as it was left.
    fireEvent.click(within(section).getByRole("button", { name: "List" }));
    unmount();
    render(<CardsPage me={player} heading={createRef()} />);
    expect(
      await screen.findByRole("table", { name: "Cards" }),
    ).toBeInTheDocument();
  });

  it("opens in pictures when the browser keeps nothing", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 card");
    expect(screen.getByRole("list", { name: "Cards" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("table", { name: "Cards" })).toBeInTheDocument();
  });

  it("shows nothing at all of the Godlike tier's cards below that tier, and an alliance tab with none", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 card");
    expect(
      api.calls.filter((call) => call.route === "GET /api/v1/custom-cards"),
    ).toHaveLength(1);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "All cards",
      "My library",
      "Alliance cards",
    ]);
    expect(document.body).not.toHaveTextContent(/godlike|custom/i);
    fireEvent.click(screen.getByRole("tab", { name: "Alliance cards" }));
    expect(
      await screen.findByText(/You are in no alliance yet/),
    ).toBeInTheDocument();
  });

  it("names the alliance tab for the allied Planeswalker and shows only their cards (v0.4.2)", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    const teferi = card("Teferi, Temporal Archmage", {
      type_line: "Legendary Planeswalker — Teferi",
      owned: 4,
    });
    const other = card("Teferi, Who Slows the Sunset", {
      type_line: "Legendary Planeswalker — Teferi",
      owned: 4,
    });
    api.on("GET /api/v1/me/alliance/cards", () =>
      reply(200, {
        alliance: "teferi",
        name: "Teferi",
        custom: false,
        cards: [teferi, other],
      }),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Teferi's cards" }));
    const section = screen.getByRole("region", { name: "Teferi's cards" });
    expect(section).toHaveTextContent("2 cards");
    expect(section).not.toHaveTextContent(/playable/i);
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Teferi, Temporal Archmage"),
      expect.stringContaining("Teferi, Who Slows the Sunset"),
    ]);
    expect(document.body).not.toHaveTextContent(/godlike/i);
  });

  it("shows the Godlike tier's cards on the tab of their Planeswalker's alliance, with whether the engine has loaded each", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    const herald = {
      ...sigil,
      id: "custom-2",
      name: "Stand-in Herald",
      loaded: true,
      playable: true,
    };
    api.on("GET /api/v1/custom-cards", () => reply(200, [sigil, herald]));
    api.on("GET /api/v1/me/alliance/cards", () =>
      reply(200, {
        alliance: "the-sphinx",
        name: "The Sphinx",
        custom: true,
        cards: [],
      }),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    fireEvent.click(
      await screen.findByRole("tab", { name: "The Sphinx's cards" }),
    );
    const section = screen.getByRole("region", { name: "The Sphinx's cards" });
    const first = within(section)
      .getByRole("heading", { name: /^Stand-in Sigil/ })
      .closest("li")!;
    expect(first).toHaveTextContent("+1: Draw a stand-in card.");
    expect(first).toHaveTextContent("Loyalty 4");
    expect(first).toHaveTextContent("Not loaded by this engine");
    expect(first).toHaveTextContent("In your library.");
    expect(first.querySelector("img")).toHaveAttribute("src", sigil.image_url);
    const second = within(section)
      .getByRole("heading", { name: /^Stand-in Herald/ })
      .closest("li")!;
    expect(second).toHaveTextContent("Playable");
    expect(second).not.toHaveTextContent("Not loaded");
  });
});

describe("the result line and a library's copies", () => {
  it("says which cards it counts", () => {
    expect(resultWords(1)).toBe("1 card");
    expect(resultWords(20123)).toBe("20,123 cards");
    expect(resultWords(2, true)).toBe("2 cards in your library");
    expect(resultWords(1, true)).toBe("1 card in your library");
  });

  it("reads a player's copies, and whether the account has a library", () => {
    expect(ownedWords(card("A", { owned: 3 }))).toBe("In your library: 3");
    expect(ownedWords(card("A", { owned: 0 }))).toBe("Not in your library");
    expect(ownedWords(card("A"))).toBeNull();
    const basic = card("Island", { type_line: "Basic Land — Island" });
    // A basic land is null for every account, so it tells nothing.
    expect(buildsFromLibrary([basic])).toBeUndefined();
    expect(buildsFromLibrary([basic, card("A", { owned: 0 })])).toBe(true);
    expect(buildsFromLibrary([basic, card("A")])).toBe(false);
    expect(buildsFromLibrary([])).toBeUndefined();
  });
});
