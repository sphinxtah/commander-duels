import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { card, mockApi, reply } from "../decks/fixtures";
import {
  buildsFromLibrary,
  namesPlayability,
  ownedWords,
  type CustomCard,
} from "./catalog";
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
const unsupported = card("Temple of Khonshu", {
  status: "catalog_only",
  status_reason: "not_implemented",
  playable: false,
});
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
  in_library: true,
};

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

afterEach(() => vi.restoreAllMocks());

describe("the Cards page", () => {
  it("opens on playable cards only, and shows the others when asked", async () => {
    const api = pageApi();
    api.on(
      "GET /api/v1/cards",
      () => reply(200, page([bolt])),
      () => reply(200, page([bolt, unsupported])),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    expect(await screen.findByText("1 playable card")).toBeInTheDocument();
    expect(searches(api)[0]).toMatchObject({ playable: true });
    expect(
      screen.queryByRole("button", { name: /^Temple of Khonshu/ }),
    ).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", {
      name: "Show cards not playable yet",
    });
    toggle.focus();
    fireEvent.click(toggle);
    expect(await screen.findByText("2 cards")).toBeInTheDocument();
    expect(searches(api).at(-1)).not.toHaveProperty("playable");
    // Shown with its badge, which says it cannot be played yet.
    const temple = screen
      .getByRole("button", { name: /^Temple of Khonshu, / })
      .closest("li")!;
    expect(temple).toHaveTextContent("Not playable");
    // The same button, still focused, now hides them again.
    expect(document.activeElement).toBe(toggle);
    expect(toggle).toHaveAccessibleName("Hide cards not playable yet");
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
    await screen.findByText("1 playable card");
    fireEvent.click(
      screen.getByRole("button", { name: "Show cards not playable yet" }),
    );
    // The old results are playable cards, and the line says so until the new ones arrive.
    expect(
      await screen.findByText("1 playable card · searching…"),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(searches(api)).toHaveLength(2));
    answer(reply(200, page([bolt, unsupported])));
    expect(await screen.findByText("2 cards")).toBeInTheDocument();
  });

  it("says the filter is set aside only once results answer that search", async () => {
    const api = pageApi();
    let answer: (value: unknown) => void = () => {};
    api.on(
      "GET /api/v1/cards",
      () => reply(200, page([bolt])),
      () => new Promise((resolve) => (answer = resolve)),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 playable card");
    fireEvent.change(screen.getByLabelText("Search cards"), {
      target: { value: "status:catalog_only" },
    });
    expect(
      await screen.findByText("1 playable card · searching…"),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(searches(api)).toHaveLength(2));
    answer(reply(200, page([unsupported])));
    expect(
      await screen.findByText(/^1 card · your search names playability/),
    ).toBeInTheDocument();
  });

  it("lets a search that names playability decide it", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([unsupported])));
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 playable card");
    fireEvent.change(screen.getByLabelText("Search cards"), {
      target: { value: "status:catalog_only" },
    });
    // Said in the live result line, so screen readers hear why the others appear.
    expect(
      await screen.findByText(
        "1 card · your search names playability, so the “Playable here” filter is set aside",
      ),
    ).toHaveAttribute("role", "status");
    expect(searches(api).at(-1)).toMatchObject({ q: "status:catalog_only" });
    expect(searches(api).at(-1)).not.toHaveProperty("playable");
    expect(
      screen.queryByRole("button", { name: /cards not playable yet/ }),
    ).not.toBeInTheDocument();
  });

  it("clears its filters back to playable cards only", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 playable card");
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByLabelText("Playable here"), {
      target: { value: "" },
    });
    expect(await screen.findByText("1 card")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("1 playable card")).toBeInTheDocument();
    expect(searches(api).at(-1)).toMatchObject({ playable: true });
  });

  it("marks a player's copies, and keeps to their library when asked", async () => {
    const api = pageApi();
    api.on(
      "GET /api/v1/cards",
      () => reply(200, page([ownedBolt, golem])),
      () => reply(200, page([ownedBolt])),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    // The page browses the whole catalog (CAT), the player's cards marked in it.
    expect(await screen.findByText("2 playable cards")).toBeInTheDocument();
    expect(searches(api)[0]).not.toHaveProperty("owned");
    expect(
      screen
        .getByRole("button", {
          name: "Lightning Bolt, Artifact, Playable, in your library: 2",
        })
        .closest("li"),
    ).toHaveTextContent("In your library: 2");
    expect(
      screen.getByRole("button", { name: /^Stand-in Golem, / }).closest("li"),
    ).toHaveTextContent("Not in your library");

    fireEvent.click(screen.getByRole("checkbox", { name: "In my library" }));
    expect(
      await screen.findByText("1 playable card in your library"),
    ).toBeInTheDocument();
    expect(searches(api).at(-1)).toMatchObject({ owned: true, playable: true });
  });

  it("says nothing of a library to an account that builds from the whole catalog", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    api.on("GET /api/v1/library", () =>
      reply(200, { unlimited: true, alliance: null, cards: [] }),
    );
    render(<CardsPage me={administrator} heading={createRef()} />);
    await screen.findByText("1 playable card");
    expect(
      screen.queryByRole("checkbox", { name: "In my library" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Lightning Bolt, Artifact, Playable",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "My library" }));
    expect(
      await screen.findByText(/^You build from the whole catalog/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the player's library, with copies and where they came from", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    api.on("GET /api/v1/library", () =>
      reply(200, {
        unlimited: false,
        alliance: "stand-in",
        cards: [
          {
            card: card("Arcane Signet", { owned: 1 }),
            copies: 1,
            sources: ["starter"],
          },
          { card: ownedBolt, copies: 2, sources: ["grandfathered", "starter"] },
          {
            card: card("Stand-in Walker", {
              type_line: "Legendary Planeswalker — Stand-in",
              owned: 4,
            }),
            copies: 4,
            sources: ["alliance"],
          },
        ],
      }),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 playable card");
    const tab = screen.getByRole("tab", { name: "My library" });
    fireEvent.click(tab);
    expect(tab).toHaveAttribute("aria-selected", "true");
    const table = await screen.findByRole("table", { name: "Your library" });
    expect(screen.getByText("3 cards, 7 copies")).toHaveAttribute(
      "role",
      "status",
    );
    const row = screen
      .getByRole("button", { name: "Lightning Bolt" })
      .closest("tr")!;
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["Artifact", "2", "Your earlier decks, Starter decks"]);
    // Each source with its count and what it gives.
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(
      [
        "Starter decks 2 cards",
        "Your alliance 1 card",
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
    expect(screen.getByText("1 of 3 cards")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Find in your library"), {
      target: { value: "signet" },
    });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Arcane Signet")).toBeInTheDocument();
  });

  it("shows nothing at all of the Godlike tier's cards below that tier", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 playable card");
    expect(
      api.calls.filter((call) => call.route === "GET /api/v1/custom-cards"),
    ).toHaveLength(1);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "All cards",
      "My library",
    ]);
    expect(document.body).not.toHaveTextContent(/godlike|custom/i);
  });

  it("shows the Godlike tier's cards in a tab of their own, not playable here yet", async () => {
    const api = pageApi();
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    api.on("GET /api/v1/custom-cards", () => reply(200, [sigil]));
    render(<CardsPage me={player} heading={createRef()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Godlike cards" }));
    const section = screen.getByRole("region", { name: "Godlike cards" });
    expect(
      within(section).getByRole("heading", { name: /^Stand-in Sigil/ }),
    ).toBeInTheDocument();
    expect(section).toHaveTextContent("+1: Draw a stand-in card.");
    expect(section).toHaveTextContent("Loyalty 4");
    expect(section).toHaveTextContent("Not playable here yet");
    expect(section).toHaveTextContent("In your library.");
    expect(section.querySelector("img")).toHaveAttribute(
      "src",
      sigil.image_url,
    );
  });
});

describe("the result line and playability terms", () => {
  it("says which cards it counts", () => {
    expect(resultWords(1, "true")).toBe("1 playable card");
    expect(resultWords(20123, "true")).toBe("20,123 playable cards");
    expect(resultWords(2, "")).toBe("2 cards");
    expect(resultWords(1, "false")).toBe("1 card not playable yet");
    expect(resultWords(2, "true", true)).toBe(
      "2 playable cards in your library",
    );
    expect(resultWords(1, "", true)).toBe("1 card in your library");
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

  it("knows a query that sets playability itself", () => {
    for (const q of [
      "is:playable",
      "-is:unsupported t:elf",
      "t:elf (is:supported or c:g)",
      "STATUS:implemented",
      "status=suspended",
      'is:"unsupported"',
      "(t:elf)is:unsupported",
      "--is:unsupported",
    ])
      expect(namesPlayability(q), q).toBe(true);
    // Words, quoted phrases and exact names are not terms, as the server reads them.
    for (const q of [
      "",
      "playable",
      "o:status",
      "t:elf",
      "this:playable",
      'o:"draw status:x"',
      '"is:playable"',
      "!status:x",
    ])
      expect(namesPlayability(q), q).toBe(false);
  });
});
