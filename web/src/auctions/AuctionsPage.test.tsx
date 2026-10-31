import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { client } from "../api";
import { player } from "../shop/fixtures";
import { auctionApi } from "./api";
import { AuctionsAdmin } from "./AuctionsAdmin";
import { AuctionsPage } from "./AuctionsPage";
import {
  auction,
  boltFoil,
  compare,
  counterLeading,
  market,
  mineList,
  NOW,
  page,
  sellable,
  targets,
} from "./fixtures";
import { SellDialog } from "./SellDialog";
import type { AuctionItem } from "./types";

// Tivit's Auction House (v0.6.0) against made-up answers: the requests are auctionApi's, one by
// one; the top bar's tokens are the typed client's.

function ok<T>(data: T) {
  return Promise.resolve({ data });
}
function refused(code: string, message: string) {
  return Promise.resolve({ error: { code, message } });
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
beforeEach(() => {
  // Only the clock's date is fixed: the page's own timers run as ever.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(client, "GET").mockImplementation((async (path: string) => {
    if (path === "/api/v1/me/tokens")
      return { data: { balance: 12345 }, response: new Response() };
    return { error: { message: "no" }, response: new Response() };
  }) as never);
  vi.spyOn(auctionApi, "search").mockImplementation(() => ok(page) as never);
  vi.spyOn(auctionApi, "mine").mockImplementation(() => ok(mineList) as never);
  vi.spyOn(auctionApi, "targets").mockImplementation(
    () => ok(targets) as never,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

function show(hash = "#auctions/search") {
  window.location.hash = hash;
  return render(<AuctionsPage me={player} heading={createRef()} />);
}
/** Presses a folded transfer section's heading (v0.7.1): the toggle is the heading's only button. */
function unfold(region: HTMLElement) {
  const heading = within(region).getByRole("heading", { level: 2 });
  fireEvent.click(within(heading).getByRole("button"));
}

function tile(name: RegExp) {
  return within(screen.getByRole("list", { name: "Auctions" })).getByRole(
    "button",
    { name },
  );
}

describe("Tivit's Auction House", () => {
  it("shows the painting's banner with the tokens and counts, Madden's tabs and the market", async () => {
    show();
    expect(
      screen.getByRole("heading", { level: 1, name: "Tivit's Auction House" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("12,345")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "The auction house" });
    expect(
      within(nav).getByRole("link", { name: /Search the market/ }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(nav).getByRole("link", { name: /Transfer list/ }),
    ).toHaveAttribute("href", "#auctions/list");
    // Three auctions: the foil outbid, the Counterspell winning and ending, the etched Sol Ring.
    const outbid = await screen.findByRole("button", {
      name: /Lightning Bolt, Revised Edition \(3ED #162\), foil, current bid 240 tokens, Buy Now 900 tokens, 50 minutes left, Outbid/,
    });
    expect(outbid).toBeInTheDocument();
    expect(tile(/Counterspell.*Winning/)).toBeInTheDocument();
    expect(
      tile(/Sol Ring.*etched foil, starting bid 1,200 tokens/),
    ).toBeInTheDocument();
    // Under a minute left: red.
    expect(within(tile(/^Counterspell/)).getByText("30s")).toHaveAttribute(
      "data-urgent",
      "true",
    );
    expect(screen.getByText("3 live")).toBeInTheDocument();
  });

  it("searches with the filters set, and Reset clears them", async () => {
    show();
    await screen.findByRole("list", { name: "Auctions" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Card name" }), {
      target: { value: "bolt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mythic rare" }));
    fireEvent.click(screen.getByRole("button", { name: "Foil" }));
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Only with Buy Now" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), {
      target: { value: "price_low" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(auctionApi.search).toHaveBeenLastCalledWith(
        {
          q: "bolt",
          rarity: ["mythic"],
          finish: ["foil"],
          color: ["R"],
          buy_now_only: true,
          sort: "price_low",
          limit: 24,
          include_mine: true,
        },
        false,
      ),
    );
    expect(
      screen.getByRole("heading", { name: "Search results" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(auctionApi.search).toHaveBeenLastCalledWith(
        { sort: "ending", limit: 24, include_mine: true },
        false,
      ),
    );
  });

  it("pages with the cursor", async () => {
    vi.mocked(auctionApi.search).mockImplementation(
      (query) =>
        ok(
          query.cursor
            ? market([
                auction({ card: { ...boltFoil.card, name: "Page Two" } }),
              ])
            : market([boltFoil], "cursor-2"),
        ) as never,
    );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Next ▶" }));
    expect(
      await screen.findByRole("button", { name: /^Page Two/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "◀ Previous" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Page Two/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it("watches with the star", async () => {
    const watch = vi
      .spyOn(auctionApi, "watch")
      .mockImplementation(() => ok(undefined) as never);
    show();
    await screen.findByRole("list", { name: "Auctions" });
    const star = screen.getByRole("button", { name: "Watch Sol Ring" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(star);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Watch Sol Ring" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    expect(watch).toHaveBeenCalledWith(expect.stringMatching(/d1$/), true);
  });

  it("opens an auction, steps the bid by 5% and bids, with one key until it succeeds", async () => {
    const bid = vi
      .spyOn(auctionApi, "bid")
      .mockImplementationOnce(() =>
        refused("not_enough_tokens", "You need 252 tokens."),
      )
      .mockImplementation(
        (_id, amount) =>
          ok({
            ...boltFoil,
            current_bid: amount,
            high_bidder: "ada",
            leading: true,
            outbid: false,
            my_bid: amount,
            next_bid: amount + 14,
          }) as never,
      );
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /Lightning Bolt.*Outbid/ }),
    );
    const panel = await screen.findByRole("dialog", { name: "Lightning Bolt" });
    const input = within(panel).getByRole("spinbutton", {
      name: "Your bid in tokens",
    });
    expect(input).toHaveValue(252);
    expect(
      within(panel).getByRole("button", { name: /Lower the bid/ }),
    ).toBeDisabled();
    fireEvent.click(
      within(panel).getByRole("button", { name: "Raise the bid by 13 tokens" }),
    );
    expect(input).toHaveValue(265);
    fireEvent.click(
      within(panel).getByRole("button", { name: /Lower the bid/ }),
    );
    expect(input).toHaveValue(252);
    fireEvent.click(within(panel).getByRole("button", { name: "Make bid" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "You need 252 tokens.",
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bid).toHaveBeenCalledTimes(2));
    expect(bid.mock.calls[0]![2]).toBe(bid.mock.calls[1]![2]);
    expect(bid).toHaveBeenLastCalledWith(boltFoil.id, 252, expect.any(String));
    expect(
      await within(panel).findByText("Your bid of 252 tokens is the highest."),
    ).toBeInTheDocument();
    // Holding the high bid, there is nothing to raise against.
    expect(
      within(panel).getByRole("button", { name: "Make bid" }),
    ).toBeDisabled();
    expect(within(panel).getByText("Winning")).toBeInTheDocument();
  });

  it("confirms Buy Now with the price before buying", async () => {
    const buy = vi.spyOn(auctionApi, "buyNow").mockImplementation(
      () =>
        ok({
          ...boltFoil,
          status: "sold",
          sold_price: 900,
          buyer: "ada",
          leading: true,
        }) as never,
    );
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /Lightning Bolt.*Outbid/ }),
    );
    const panel = await screen.findByRole("dialog", { name: "Lightning Bolt" });
    fireEvent.click(
      within(panel).getByRole("button", { name: "Buy Now · 900" }),
    );
    const confirm = within(panel).getByRole("group", {
      name: "Confirm Buy Now",
    });
    expect(confirm).toHaveTextContent(
      "Buy Lightning Bolt (Foil) now for 900 tokens? You have 12,345 tokens, and will have 11,445 tokens left.",
    );
    expect(buy).not.toHaveBeenCalled();
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Buy for 900 tokens" }),
    );
    expect(
      await within(panel).findByText(
        "You bought Lightning Bolt for 900 tokens. It is in your library.",
      ),
    ).toBeInTheDocument();
    expect(buy).toHaveBeenCalledWith(boltFoil.id, expect.any(String));
  });

  it("compares the price with the same edition and finish's listings and recent sales", async () => {
    const asked = vi
      .spyOn(auctionApi, "compare")
      .mockImplementation(() => ok(compare) as never);
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: /Lightning Bolt.*Outbid/ }),
    );
    const panel = await screen.findByRole("dialog", { name: "Lightning Bolt" });
    fireEvent.click(
      within(panel).getByRole("button", { name: "Compare price" }),
    );
    const section = await within(panel).findByRole("region", {
      name: /Compare price/,
    });
    expect(asked).toHaveBeenCalledWith(boltFoil.card.printing_id, "foil");
    expect(
      within(section).getByRole("button", {
        name: /Open bob's: starting bid 180 tokens/,
      }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: /This auction/ }),
    ).toBeDisabled();
    expect(within(section).getByText(/Recently sold/)).toBeInTheDocument();
    // The average of 640 and 710.
    expect(within(section).getByText("675")).toBeInTheDocument();
  });

  it("the transfer list: withdraw before bids, relist prefilled, clear sold", async () => {
    const withdraw = vi
      .spyOn(auctionApi, "withdraw")
      .mockImplementation(
        () => ok({ ...mineList.active[0]!, status: "withdrawn" }) as never,
      );
    const clear = vi
      .spyOn(auctionApi, "clearMine")
      .mockImplementation(() => ok(undefined) as never);
    const relist = vi
      .spyOn(auctionApi, "relist")
      .mockImplementation(() => ok(mineList.unsold[0]!) as never);
    show("#auctions/list");
    const active = await screen.findByRole("region", { name: /Active/ });
    // The section shows before the listings load, so wait for them.
    expect(await within(active).findByText("2")).toBeInTheDocument();
    // Every section starts folded (v0.7.1): its rows are there once its heading is pressed.
    expect(
      within(active).queryByRole("button", { name: /^Withdraw/ }),
    ).toBeNull();
    unfold(active);
    expect(
      within(active).getByRole("button", { name: /Active/ }),
    ).toHaveAttribute("aria-expanded", "true");
    // Only the one without bids may be withdrawn.
    expect(
      within(active).getAllByRole("button", { name: /^Withdraw/ }),
    ).toHaveLength(1);
    fireEvent.click(
      within(active).getByRole("button", { name: "Withdraw Shivan Dragon" }),
    );
    expect(
      await screen.findByText(
        "You withdrew Shivan Dragon. It is back in your library.",
      ),
    ).toBeInTheDocument();
    expect(withdraw).toHaveBeenCalledWith(mineList.active[0]!.id);

    // Clear stays on the folded bar.
    fireEvent.click(screen.getByRole("button", { name: "Clear sold" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith("sold"));

    unfold(screen.getByRole("region", { name: /Unsold/ }));
    fireEvent.click(screen.getByRole("button", { name: "Relist Sol Ring" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Relist on the market",
    });
    expect(
      within(dialog).getByRole("spinbutton", { name: "Starting bid (tokens)" }),
    ).toHaveValue(900);
    expect(
      within(dialog).getByRole("spinbutton", { name: "Buy Now (tokens)" }),
    ).toHaveValue(1500);
    expect(
      within(dialog).getByRole("radio", { name: "12 hours" }),
    ).toBeChecked();
    expect(
      within(dialog).getByText("You receive 100% — no fee"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("radio", { name: "3 days" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Relist" }));
    await waitFor(() =>
      expect(relist).toHaveBeenCalledWith(mineList.unsold[0]!.id, {
        starting_bid: 900,
        buy_now: 1500,
        duration: "3d",
        key: expect.any(String),
      }),
    );
    expect(
      await screen.findByText("Sol Ring is back on the market for 3 days."),
    ).toBeInTheDocument();
  });

  it("the transfer targets: winning and outbid, won and lost, with Clear", async () => {
    const clear = vi
      .spyOn(auctionApi, "clearTargets")
      .mockImplementation(() => ok(undefined) as never);
    show("#auctions/targets");
    const active = await screen.findByRole("region", { name: /Active/ });
    unfold(active);
    // The section shows before the targets load, so wait for them.
    expect(await within(active).findByText("Outbid")).toBeInTheDocument();
    expect(within(active).getByText("Winning")).toBeInTheDocument();
    const won = screen.getByRole("region", { name: /Won/ });
    unfold(won);
    expect(
      within(won).getByText("Won", { selector: "[data-kind='won']" }),
    ).toBeInTheDocument();
    const lost = screen.getByRole("region", { name: /Lost/ });
    unfold(lost);
    expect(
      within(lost).getByText("Lost", { selector: "[data-kind='lost']" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear lost" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith("lost"));
  });

  it("follows the address between tabs, so Back and Forward work", async () => {
    show();
    await screen.findByRole("list", { name: "Auctions" });
    window.location.hash = "#auctions/targets";
    expect(
      await screen.findByRole("region", { name: /Won/ }),
    ).toBeInTheDocument();
    window.location.hash = "#auctions/search";
    expect(
      await screen.findByRole("list", { name: "Auctions" }),
    ).toBeInTheDocument();
  });
});

describe("the Sell dialog", () => {
  function sellAnswers() {
    vi.spyOn(auctionApi, "sellable").mockImplementation(
      () => ok({ items: sellable, next_cursor: null }) as never,
    );
    return vi.spyOn(auctionApi, "create").mockImplementation(
      (body) =>
        ok({
          items: Array.from({ length: body.quantity ?? 1 }, () =>
            auction({ mine: true }),
          ),
        }) as never,
    );
  }

  it("picks an edition and finish, checks the prices and lists copies at once", async () => {
    const create = sellAnswers();
    const listed = vi.fn();
    render(
      <SellDialog
        request={{ mode: "sell" }}
        onClose={vi.fn()}
        onListed={listed}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "List on the market" });
    const choices = await within(dialog).findAllByRole("radio", {
      name: /Lightning Bolt/,
    });
    expect(choices).toHaveLength(2);
    fireEvent.click(choices[0]!);
    expect(
      within(dialog).getByText("Copies to list (up to 2)"),
    ).toBeInTheDocument();
    const list = within(dialog).getByRole("button", { name: "List it" });
    expect(list).toBeDisabled();
    fireEvent.change(
      within(dialog).getByRole("spinbutton", { name: "Starting bid (tokens)" }),
      { target: { value: "100" } },
    );
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Set a Buy Now price" }),
    );
    fireEvent.change(
      within(dialog).getByRole("spinbutton", { name: "Buy Now (tokens)" }),
      { target: { value: "100" } },
    );
    expect(
      within(dialog).getByText("Buy Now must be more than the starting bid."),
    ).toBeInTheDocument();
    fireEvent.change(
      within(dialog).getByRole("spinbutton", { name: "Buy Now (tokens)" }),
      { target: { value: "400" } },
    );
    fireEvent.change(
      within(dialog).getByRole("spinbutton", { name: /Copies to list/ }),
      { target: { value: "3" } },
    );
    expect(within(dialog).getByText("List 1 to 2 copies.")).toBeInTheDocument();
    fireEvent.change(
      within(dialog).getByRole("spinbutton", { name: /Copies to list/ }),
      { target: { value: "2" } },
    );
    fireEvent.click(within(dialog).getByRole("radio", { name: "1 hour" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "List 2 copies" }),
    );
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        printing_id: sellable[0]!.card.printing_id,
        finish: "nonfoil",
        starting_bid: 100,
        buy_now: 400,
        duration: "1h",
        quantity: 2,
        key: expect.any(String),
      }),
    );
    expect(listed).toHaveBeenCalledWith(
      expect.any(Array),
      "2 copies of Lightning Bolt are on the market for 1 hour.",
    );
  });

  it("from My library, offers only that edition's finishes", async () => {
    sellAnswers();
    render(
      <SellDialog
        request={{
          mode: "sell",
          preset: {
            printingId: sellable[2]!.card.printing_id,
            name: "Counterspell",
          },
        }}
        onClose={vi.fn()}
        onListed={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "List on the market" });
    const only = await within(dialog).findByRole("radio", {
      name: /Counterspell/,
    });
    // One choice: chosen already.
    expect(only).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(auctionApi.sellable).toHaveBeenCalledWith("Counterspell");
  });
});

describe("Administration's Auctions tab", () => {
  const sysop = { ...player, kind: "sysop" as const, handle: "sysop" };
  const live: AuctionItem = counterLeading;

  it("shows the sales log and lets SysOp cancel a live auction with a reason", async () => {
    const list = vi
      .spyOn(auctionApi, "adminList")
      .mockImplementation(
        (status) =>
          ok(
            market(
              status === "active"
                ? [live]
                : [{ ...mineList.sold[0]!, mine: false }],
            ),
          ) as never,
      );
    const cancel = vi
      .spyOn(auctionApi, "adminCancel")
      .mockImplementation(() => ok({ ...live, status: "cancelled" }) as never);
    render(<AuctionsAdmin me={sysop} />);
    const table = await screen.findByRole("table");
    // The table shows before its rows load, so wait for them.
    expect(await within(table).findByText("carol")).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith("sold", null);
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), {
      target: { value: "active" },
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Cancel bob's auction of Counterspell",
      }),
    );
    const form = screen.getByRole("form", {
      name: "Cancel the auction of Counterspell",
    });
    const submit = within(form).getByRole("button", {
      name: "Cancel the auction",
    });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByRole("textbox"), {
      target: { value: "Shill bidding" },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith(live.id, "Shill bidding"),
    );
    expect(
      await screen.findByText(/ada's 60 tokens were returned/),
    ).toBeInTheDocument();
  });

  it("lets an administrator read it, but not cancel", async () => {
    vi.spyOn(auctionApi, "adminList").mockImplementation(
      () => ok(market([live])) as never,
    );
    render(<AuctionsAdmin me={player} />);
    await screen.findByRole("table");
    expect(
      screen.getByText(/Only SysOp cancels an auction/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Cancel bob's/ }),
    ).not.toBeInTheDocument();
  });
});
