import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { card, mockApi, reply } from "../decks/fixtures";
import { WishButton, WishlistView, useWishlist } from "./Wishlist";

// The wishlist (v1.0.0, the deck workshop): a view inside Cards, and a button in a card's
// details.

const DECK = "00000000-0000-4000-8000-0000000000d1";
const bolt = { ...card("Lightning Bolt"), id: "bolt" };
const giant = { ...card("Hill Giant"), id: "giant" };
const wishes = (list: object[]) => ({ wishes: list });
const wanted = [
  { card: bolt, quantity: 4, deck_id: DECK, owned: 1 },
  { card: giant, quantity: 1, deck_id: null, owned: 0 },
];

function View({ onOpen = () => undefined }: { onOpen?: (c: unknown) => void }) {
  const hook = useWishlist();
  return <WishlistView wishes={hook} onOpen={onOpen} />;
}
function Button({ cardId }: { cardId: string }) {
  const hook = useWishlist();
  return <WishButton cardId={cardId} wishes={hook} />;
}

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

afterEach(() => vi.restoreAllMocks());

describe("the wishlist", () => {
  it("lists the cards wanted, with how many are owned and the deck each is for", async () => {
    const api = mockApi();
    api.on("GET /api/v1/me/wishlist", () => reply(200, wishes(wanted)));
    api.on("GET /api/v1/decks", () =>
      reply(200, [{ id: DECK, title: "Mono-Red Burn" }]),
    );
    const opened: unknown[] = [];
    render(<View onOpen={(found) => opened.push(found)} />);
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 cards, 5 copies wanted",
    );
    const rows = within(screen.getByRole("table", { name: "Your wishlist" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows[0]).toHaveTextContent("Lightning Bolt");
    expect(within(rows[0]!).getByRole("spinbutton")).toHaveValue(4);
    expect(rows[0]).toHaveTextContent("1Mono-Red Burn");
    expect(
      within(rows[0]!).getByRole("link", { name: "Mono-Red Burn" }),
    ).toHaveAttribute("href", `#deck/${DECK}/workshop`);
    // A card wished for no deck, of which the library holds none.
    expect(rows[1]).toHaveTextContent("Hill Giant");
    expect(rows[1]).toHaveTextContent("None–");
    // What a wish is, said on the page: it buys nothing.
    expect(screen.getByText(/A wish buys nothing/)).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Hill Giant" }).click(),
    );
    expect(opened).toEqual([giant]);
  });

  it("changes how many are wanted, keeping the deck, and takes a card off", async () => {
    const api = mockApi();
    api.on("GET /api/v1/me/wishlist", () => reply(200, wishes(wanted)));
    api.on("GET /api/v1/decks", () => reply(200, []));
    api.on("PUT /api/v1/me/wishlist/{card_id}", () =>
      reply(200, wishes([{ ...wanted[0], quantity: 2 }, wanted[1]!])),
    );
    api.on("DELETE /api/v1/me/wishlist/{card_id}", () =>
      reply(200, wishes([{ ...wanted[0], quantity: 2 }])),
    );
    render(<View />);
    await settle();
    const count = screen.getByRole("spinbutton", {
      name: "Copies of Lightning Bolt wanted",
    });
    fireEvent.change(count, { target: { value: "2" } });
    fireEvent.blur(count);
    await settle();
    expect(api.calls.at(-1)).toMatchObject({
      route: "PUT /api/v1/me/wishlist/{card_id}",
      options: {
        params: { path: { card_id: "bolt" } },
        body: { quantity: 2, deck_id: DECK },
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "2 cards, 3 copies wanted",
    );
    await act(async () =>
      screen
        .getByRole("button", { name: "Take Hill Giant off your wishlist" })
        .click(),
    );
    await settle();
    expect(api.calls.at(-1)).toMatchObject({
      route: "DELETE /api/v1/me/wishlist/{card_id}",
      options: { params: { path: { card_id: "giant" } } },
    });
    expect(screen.queryByText("Hill Giant")).toBeNull();
  });

  it("sends nothing for a number that did not change, and keeps a wish within its bounds", async () => {
    const api = mockApi();
    api.on("GET /api/v1/me/wishlist", () => reply(200, wishes([wanted[1]!])));
    api.on("PUT /api/v1/me/wishlist/{card_id}", () =>
      reply(200, wishes([{ ...wanted[1], quantity: 250 }])),
    );
    render(<View />);
    await settle();
    const count = screen.getByRole("spinbutton");
    fireEvent.blur(count);
    await settle();
    expect(api.calls.some((call) => call.route.startsWith("PUT"))).toBe(false);
    fireEvent.change(count, { target: { value: "9999" } });
    fireEvent.blur(count);
    await settle();
    expect(api.calls.at(-1)!.options).toMatchObject({
      body: { quantity: 250 },
    });
  });

  it("says when nothing is wished for, and why a change was refused", async () => {
    const api = mockApi();
    api.on("GET /api/v1/me/wishlist", () => reply(200, wishes([])));
    const view = render(<View />);
    await settle();
    expect(
      screen.getByText("Nothing is on your wishlist yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    view.unmount();

    api.on("GET /api/v1/me/wishlist", () => reply(200, wishes([wanted[1]!])));
    api.on("DELETE /api/v1/me/wishlist/{card_id}", () =>
      reply(404, {
        code: "not_found",
        message: "That card is not wished for.",
      }),
    );
    render(<View />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: /^Take Hill Giant off/ }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That card is not wished for.",
    );
  });
});

describe("a card's wish button", () => {
  it("adds a card to the wishlist and takes it off", async () => {
    const api = mockApi();
    api.on("GET /api/v1/me/wishlist", () => reply(200, wishes([])));
    api.on("PUT /api/v1/me/wishlist/{card_id}", () =>
      reply(
        200,
        wishes([{ card: giant, quantity: 1, deck_id: null, owned: 0 }]),
      ),
    );
    api.on("DELETE /api/v1/me/wishlist/{card_id}", () =>
      reply(200, wishes([])),
    );
    render(<Button cardId="giant" />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Add to your wishlist" }).click(),
    );
    await settle();
    expect(api.calls.at(-1)).toMatchObject({
      route: "PUT /api/v1/me/wishlist/{card_id}",
      options: {
        params: { path: { card_id: "giant" } },
        body: { quantity: 1 },
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "On your wishlist: 1 copy.",
    );
    await act(async () =>
      screen.getByRole("button", { name: "Take it off your wishlist" }).click(),
    );
    await settle();
    expect(
      screen.getByRole("button", { name: "Add to your wishlist" }),
    ).toBeInTheDocument();
  });

  it("is not shown until the wishlist is known", async () => {
    mockApi();
    render(<Button cardId="giant" />);
    await settle();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
