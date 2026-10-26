import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { auctionApi } from "../auctions/api";
import { bolt as boltCard } from "../auctions/fixtures";
import { card } from "../decks/fixtures";
import { LIBRARY_PAGE, MyLibrary } from "./MyLibrary";

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

  it("filters finely under Filters (v0.6.2): set, rarity, finish, colour, type and mana value", async () => {
    const view = library(0);
    answer({
      ...view,
      cards: [
        { ...view.cards[0]!, card: { ...bolt, colors: ["R"] } },
        {
          card: card("Teferi, Temporal Archmage", {
            colors: ["U"],
            type_line: "Legendary Planeswalker — Teferi",
            mana_value: 6,
          }),
          copies: 4,
          edition: {
            ...edition,
            printing_id: "teferi-c16",
            set_code: "c16",
            set_name: "Commander 2016",
            rarity: "mythic",
          },
          sources: ["alliance"],
          finishes: { nonfoil: 4, foil: 0, etched: 0 },
          sellable: 0,
        },
      ],
    });
    render(
      <MyLibrary
        onOpen={vi.fn()}
        onZoom={vi.fn()}
        view="list"
        onView={vi.fn()}
      />,
    );
    const table = await screen.findByRole("table", { name: "Your library" });
    const rows = () => within(table).getAllByRole("row").length - 1;
    expect(rows()).toBe(2);
    const toggle = screen.getByRole("button", { name: "Filters" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const panel = screen.getByRole("group", { name: "Filter your library" });
    // Only the library's own sets and rarities are offered.
    expect(
      within(panel)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(
      expect.arrayContaining([
        "Any set",
        "Commander 2016 (C16)",
        "Revised Edition (3ED)",
      ]),
    );
    expect(
      within(within(panel).getByRole("group", { name: "Rarity" }))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Common", "Mythic rare"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Mythic rare" }));
    expect(rows()).toBe(1);
    expect(within(table).getByText("Teferi, Temporal Archmage")).toBeVisible();
    expect(screen.getByText("1 of 2 editions")).toBeInTheDocument();
    // The Filters button counts what is set.
    expect(screen.getByRole("button", { expanded: true })).toHaveTextContent(
      /^Filters\s*1 set$/,
    );
    fireEvent.click(
      within(panel).getByRole("button", { name: "Clear filters" }),
    );
    expect(rows()).toBe(2);
    fireEvent.click(within(panel).getByRole("button", { name: "Foil" }));
    expect(within(table).getByText("Lightning Bolt")).toBeVisible();
    expect(rows()).toBe(1);
    fireEvent.click(within(panel).getByRole("button", { name: "Foil" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: /Blue/ }));
    expect(rows()).toBe(1);
    expect(within(table).getByText("Teferi, Temporal Archmage")).toBeVisible();
    fireEvent.click(within(panel).getByRole("checkbox", { name: /Blue/ }));
    fireEvent.change(within(panel).getByLabelText("Type"), {
      target: { value: "planeswalker" },
    });
    expect(rows()).toBe(1);
    fireEvent.change(within(panel).getByLabelText("Type"), {
      target: { value: "" },
    });
    fireEvent.change(within(panel).getByLabelText("Mana value from"), {
      target: { value: "2" },
    });
    expect(rows()).toBe(1);
    fireEvent.change(within(panel).getByLabelText("Mana value from"), {
      target: { value: "" },
    });
    fireEvent.change(within(panel).getByLabelText("Set"), {
      target: { value: "3ed" },
    });
    expect(rows()).toBe(1);
    expect(within(table).getByText("Lightning Bolt")).toBeVisible();
    fireEvent.change(within(panel).getByLabelText("Set"), {
      target: { value: "" },
    });
    fireEvent.change(within(panel).getByLabelText("Sort by"), {
      target: { value: "mana_value" },
    });
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      expect.stringContaining("Lightning Bolt"),
      expect.stringContaining("Teferi"),
    ]);
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

  it("draws a big library a page at a time, and a filter starts again at one page (v0.6.5)", async () => {
    const view = library(0);
    const many = LIBRARY_PAGE + 30;
    answer({
      ...view,
      cards: Array.from({ length: many }, (_, index) => ({
        ...view.cards[0]!,
        card: card(`Card ${index}`),
        edition: { ...edition, printing_id: `p-${index}` },
      })),
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
    expect(within(tiles).getAllByRole("listitem")).toHaveLength(LIBRARY_PAGE);
    fireEvent.click(
      screen.getByRole("button", { name: "Show more (30 left)" }),
    );
    expect(within(tiles).getAllByRole("listitem")).toHaveLength(many);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Card" },
    });
    expect(within(tiles).getAllByRole("listitem")).toHaveLength(LIBRARY_PAGE);
  });
});
