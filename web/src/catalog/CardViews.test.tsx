import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { card, mockApi, reply } from "../decks/fixtures";
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
      "A deck may hold as many copies as your library does.",
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
});
