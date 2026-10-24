import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { auctionApi } from "../auctions/api";
import { bolt as boltCard } from "../auctions/fixtures";
import { card } from "../decks/fixtures";
import { MyLibrary } from "./MyLibrary";

// My library in v0.6.0: each edition's copies by finish, a foil held glows, and Sell lists copies
// in Tivit's Auction House.

const bolt = card("Lightning Bolt");
const edition = {
  printing_id: boltCard.printing_id,
  set_code: "3ed",
  set_name: "Revised Edition",
  collector_number: "162",
  released_at: null,
  rarity: "common",
};

function library(sellable: number) {
  return {
    unlimited: false,
    alliance: null,
    cards: [
      {
        card: bolt,
        copies: 3,
        edition,
        sources: ["pack"],
        finishes: { nonfoil: 2, foil: 1, etched: 0 },
        sellable,
      },
    ],
  };
}

beforeAll(() => {
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

function answer(body: unknown) {
  vi.spyOn(client, "GET").mockImplementation((async () => ({
    data: body,
    response: new Response(),
  })) as never);
}

describe("My library's finishes and Sell", () => {
  it("shows the copies by finish, glows for a foil held, and opens the Sell dialog on that edition", async () => {
    answer(library(2));
    const sellable = vi.spyOn(auctionApi, "sellable").mockResolvedValue({
      data: {
        items: [
          { card: boltCard, finish: "nonfoil", copies: 2, sellable: 1 },
          { card: boltCard, finish: "foil", copies: 1, sellable: 1 },
          {
            card: { ...boltCard, printing_id: "another" },
            finish: "nonfoil",
            copies: 1,
            sellable: 1,
          },
        ],
        next_cursor: null,
      },
    });
    render(
      <MyLibrary
        onOpen={vi.fn()}
        onZoom={vi.fn()}
        view="pictures"
        onView={vi.fn()}
      />,
    );
    const tiles = await screen.findByRole("list", { name: "Your library" });
    const tile = within(tiles).getAllByRole("listitem")[0]!;
    expect(tile).toHaveTextContent("2 + 1 foil");
    expect(tile.querySelector("div[class*='cardImage']")?.className).toMatch(
      /glow/,
    );
    fireEvent.click(
      within(tile).getByRole("button", {
        name: "Sell Lightning Bolt from Revised Edition (3ED #162)",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "List on the market",
    });
    // Only this edition's two finishes, the other printing left out.
    expect(
      await within(dialog).findAllByRole("radio", { name: /Lightning Bolt/ }),
    ).toHaveLength(2);
    expect(sellable).toHaveBeenCalledWith("Lightning Bolt");
  });

  it("offers no Sell where nothing may be sold", async () => {
    answer(library(0));
    render(
      <MyLibrary
        onOpen={vi.fn()}
        onZoom={vi.fn()}
        view="list"
        onView={vi.fn()}
      />,
    );
    const table = await screen.findByRole("table", { name: "Your library" });
    expect(within(table).getByText("2 + 1 foil")).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /^Sell/ })).toBeNull();
  });
});
