import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { card, edition, mockApi, reply } from "../decks/fixtures";
import type { CardDetail, PrintingSummary } from "./catalog";
import { CardDetails } from "./CardViews";

function printing(
  id: string,
  artist: string,
  fields: Partial<PrintingSummary> = {},
): PrintingSummary {
  return {
    id,
    set_code: "tst",
    set_name: `Set ${id}`,
    collector_number: "1",
    lang: "en",
    released_at: "2026-01-01",
    rarity: "common",
    finishes: ["nonfoil"],
    frame: "2015",
    promo: false,
    digital: false,
    artist,
    faces: 0,
    removed: false,
    ...fields,
  };
}

function detail(printings: PrintingSummary[], count: number): CardDetail {
  return {
    ...card("Lightning Bolt", {
      image: {
        printing_id: printings[0]!.id,
        faces: 0,
        artist: "Newest Artist",
      },
    }),
    engine_name: "Lightning Bolt",
    review: false,
    capabilities: {},
    all_legalities: {},
    printings,
    printing_count: count,
    rulings: [],
    tags: [],
    related: [],
    removed: false,
  } as CardDetail;
}

afterEach(() => vi.restoreAllMocks());

describe("a card's details", () => {
  it("credits the artist of the image on show", async () => {
    const api = mockApi();
    api.on("GET /api/v1/cards/{card_id}", () =>
      reply(
        200,
        detail(
          [printing("p1", "Newest Artist"), printing("p2", "Older Artist")],
          2,
        ),
      ),
    );
    render(<CardDetails cardId="card-lightning-bolt" />);
    expect(
      await screen.findByText(/^Illustrated by Newest Artist\./),
    ).toBeVisible();
    // A card shown on its own asks for no particular printing.
    expect(api.calls[0]?.options).toEqual({
      params: { path: { card_id: "card-lightning-bolt" }, query: undefined },
    });
    fireEvent.mouseEnter(screen.getByRole("button", { name: /^Set p2 TST/ }));
    expect(screen.getByText(/^Illustrated by Older Artist\./)).toBeVisible();
    // An account that builds from the whole catalog has no library to speak of.
    expect(screen.queryByText("Your library")).toBeNull();
  });

  it("says how many copies the player's library holds", async () => {
    const api = mockApi();
    api.on(
      "GET /api/v1/cards/{card_id}",
      () => reply(200, { ...detail([printing("p1", "Artist")], 1), owned: 3 }),
      () => reply(200, { ...detail([printing("p1", "Artist")], 1), owned: 0 }),
    );
    const { unmount } = render(<CardDetails cardId="card-lightning-bolt" />);
    const owned = (await screen.findByText("Your library")).closest("div")!;
    expect(owned).toHaveTextContent("In your library: 3");
    expect(owned).toHaveTextContent(
      "A deck may hold the editions your library holds, as many copies of each as it does.",
    );
    unmount();
    render(<CardDetails cardId="card-lightning-bolt" />);
    const none = (await screen.findByText("Your library")).closest("div")!;
    expect(none).toHaveTextContent("Not in your library");
    expect(none).toHaveTextContent(/cannot start a game until your library/);
  });

  it("asks for a deck entry's chosen printing and keeps it after Show all", async () => {
    const api = mockApi();
    // The chosen printing is older than the ones listed first; the API adds it to the list.
    const chosen = printing("old", "Alpha Artist", { set_name: "Alpha" });
    api.on("GET /api/v1/cards/{card_id}", () =>
      reply(200, detail([printing("p1", "Newest Artist"), chosen], 700)),
    );
    api.on("GET /api/v1/cards/{card_id}/printings", () =>
      reply(200, [
        printing("p1", "Newest Artist"),
        printing("p2", "Older Artist"),
      ]),
    );
    render(
      <CardDetails
        cardId="card-lightning-bolt"
        chosenPrinting="old"
        onChoosePrinting={() => {}}
      />,
    );
    expect(
      await screen.findByText(/^Illustrated by Alpha Artist\./),
    ).toBeVisible();
    expect(api.calls[0]?.options).toEqual({
      params: {
        path: { card_id: "card-lightning-bolt" },
        query: { printing: "old" },
      },
    });
    // More than 500 printings: "Show all" says what it loads, and the chosen one stays listed.
    fireEvent.click(
      screen.getByRole("button", { name: "Show the newest 500 printings" }),
    );
    expect(
      await screen.findByRole("button", { name: /^Set p2 TST/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Alpha TST/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: /^Show the newest/ }),
    ).not.toBeInTheDocument();
  });

  it("shows only the edition a pack held, opened from the pack (v0.5.0)", async () => {
    const api = mockApi();
    const pulled = printing("p-revised", "Revised Artist", {
      set_name: "Revised Edition",
      set_code: "3ed",
    });
    api.on("GET /api/v1/cards/{card_id}", () =>
      reply(200, {
        ...detail([pulled], 1),
        owned: 2,
        editions: [edition("p-revised", "Revised Edition", 2)],
      }),
    );
    render(
      <CardDetails
        cardId="card-goblin-king"
        chosenPrinting="p-revised"
        printings="chosen"
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Edition (1)" }),
    ).toBeVisible();
    expect(api.calls[0]?.options).toEqual({
      params: {
        path: { card_id: "card-goblin-king" },
        query: { printing: "p-revised", printings: "chosen" },
      },
    });
    expect(
      screen
        .getAllByRole("button", { name: /3ED #1/ })
        .map((item) => item.textContent),
    ).toEqual(["Revised Edition 3ED #1 · common · 2026"]);
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
    expect(screen.getByText(/^Illustrated by Revised Artist\./)).toBeVisible();
  });

  it("lists the editions the library holds, opened from the library or a deck (v0.5.0)", async () => {
    const api = mockApi();
    const revised = printing("p-revised", "A", { set_name: "Revised Edition" });
    const seventh = printing("p-seventh", "B", { set_name: "Seventh Edition" });
    api.on("GET /api/v1/cards/{card_id}", () =>
      reply(200, {
        ...detail([seventh, revised], 2),
        owned: 2,
        editions: [edition("p-revised", "Revised Edition", 2)],
      }),
    );
    const chosen: (string | null)[] = [];
    render(
      <CardDetails
        cardId="card-goblin-king"
        chosenPrinting="p-seventh"
        printings="owned"
        onChoosePrinting={(id) => chosen.push(id)}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Your editions (2)" }),
    ).toBeVisible();
    expect(api.calls[0]?.options).toMatchObject({
      params: { query: { printing: "p-seventh", printings: "owned" } },
    });
    // The library line names each edition and its copies.
    expect(
      screen.getByRole("list", { name: "Your editions" }),
    ).toHaveTextContent("Revised Edition (REV #1): 2");
    // A deck's copy may name only an edition the library holds: no "any printing", and the
    // entry's own edition, which the library lacks, says so.
    expect(screen.queryByRole("button", { name: /^Any printing/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Seventh Edition/ }),
    ).toHaveTextContent("not in your library");
    fireEvent.click(screen.getByRole("button", { name: /^Revised Edition/ }));
    expect(chosen).toEqual(["p-revised"]);
    expect(
      screen.getByRole("button", { name: /^Revised Edition/ }),
    ).toHaveTextContent("2 in your library");
  });

  it("says a card is not in the game, as a version a game played may still name one (v0.4.5)", async () => {
    const api = mockApi();
    api.on("GET /api/v1/cards/{card_id}", () =>
      reply(404, { code: "not_found", message: "Not found." }),
    );
    render(<CardDetails cardId="card-temple-of-khonshu" />);
    expect(
      await screen.findByText(
        "This card is not in the game: the game engine cannot play it.",
      ),
    ).toHaveAttribute("role", "status");
  });

  it("shows no status for a card the game can play, unless the engine's wording differs", async () => {
    const api = mockApi();
    api.on(
      "GET /api/v1/cards/{card_id}",
      () => reply(200, detail([printing("p1", "Artist")], 1)),
      () =>
        reply(200, {
          ...detail([printing("p1", "Artist")], 1),
          text_differs: true,
        }),
    );
    const { unmount } = render(<CardDetails cardId="card-lightning-bolt" />);
    await screen.findByText(/^Illustrated by /);
    expect(screen.queryByText("Status")).toBeNull();
    expect(document.body).not.toHaveTextContent(/playable/i);
    unmount();
    render(<CardDetails cardId="card-lightning-bolt" />);
    expect(await screen.findByText("Status")).toBeInTheDocument();
    expect(screen.getByText(/wording of this card may differ/)).toBeVisible();
  });
});
