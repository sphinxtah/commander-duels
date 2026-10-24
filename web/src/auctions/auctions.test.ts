import { describe, expect, it } from "vitest";
import {
  auctionNotice,
  auctionNoticeLink,
  auctionNoticeWords,
  bidOutcome,
  editionLine,
  filtersSet,
  finishesWords,
  increment,
  itemName,
  marketQuery,
  milestone,
  noMarketFilters,
  priceProblem,
  standing,
  stepDown,
  stepUp,
  tabOf,
  timeLeft,
  timeLeftWords,
  urgent,
} from "./auctions";
import { auction, bolt, boltFoil, inMinutes, NOW } from "./fixtures";
import { awardLink, notificationWords } from "../social/social";
import type { NotificationItem } from "../social/social";

describe("the auction house's arithmetic", () => {
  it("raises a bid by 5%, rounded up, and never by less than 1 token", () => {
    expect(increment(1)).toBe(1);
    expect(increment(19)).toBe(1);
    expect(increment(21)).toBe(2);
    expect(increment(240)).toBe(12);
    expect(increment(1001)).toBe(51);
    expect(stepUp(240)).toBe(252);
  });

  it("steps the bid down to the amount whose raise reaches it, never under the least bid", () => {
    expect(stepDown(252, 240)).toBe(240);
    expect(stepDown(stepUp(stepUp(100)), 100)).toBe(stepUp(100));
    expect(stepDown(100, 100)).toBe(100);
    expect(stepDown(90, 100)).toBe(100);
  });

  it("says what a bid does: too low, a bid, or Buy Now", () => {
    const item = auction({ next_bid: 252, buy_now: 900 });
    expect(bidOutcome(item, 251)).toBe("too_low");
    expect(bidOutcome(item, 252)).toBe("bid");
    expect(bidOutcome(item, 900)).toBe("buys");
    expect(bidOutcome({ ...item, buy_now: null }, 5000)).toBe("bid");
    expect(bidOutcome(item, Number.NaN)).toBe("too_low");
  });

  it("checks the prices as the server does", () => {
    expect(priceProblem("", "")).toMatch(/at least 1/);
    expect(priceProblem("0", "")).toMatch(/at least 1/);
    expect(priceProblem("1.5", "")).toMatch(/whole number/);
    expect(priceProblem("100", "")).toBe("");
    expect(priceProblem("100", "100")).toMatch(/more than the starting bid/);
    expect(priceProblem("100", "101")).toBe("");
  });
});

describe("time left", () => {
  it("counts down as Madden shows it, urgent under a minute", () => {
    expect(timeLeft(inMinutes(60 * 50 + 5), NOW)).toBe("2d 2h");
    expect(timeLeft(inMinutes(3 * 60 + 7), NOW)).toBe("3h 07m");
    expect(timeLeft(inMinutes(12.5), NOW)).toBe("12m 30s");
    expect(timeLeft(inMinutes(0.75), NOW)).toBe("45s");
    expect(timeLeft(inMinutes(-1), NOW)).toBe("Ended");
    expect(urgent(inMinutes(0.75), NOW)).toBe(true);
    expect(urgent(inMinutes(2), NOW)).toBe(false);
    expect(urgent(inMinutes(-1), NOW)).toBe(false);
    expect(timeLeftWords(inMinutes(61), NOW)).toBe("1 hour 1 minute left");
    expect(timeLeftWords(inMinutes(0.2), NOW)).toBe("less than a minute left");
  });

  it("speaks only at the milestones", () => {
    expect(milestone(inMinutes(90), NOW)).toBe("");
    expect(milestone(inMinutes(59), NOW)).toBe("Less than an hour left.");
    expect(milestone(inMinutes(30), NOW)).toBe("Less than an hour left.");
    expect(milestone(inMinutes(9), NOW)).toBe("Less than ten minutes left.");
    expect(milestone(inMinutes(0.5), NOW)).toBe("Less than a minute left.");
    expect(milestone(inMinutes(-0.1), NOW)).toBe("The auction has ended.");
  });
});

describe("words", () => {
  it("names an edition and an item", () => {
    expect(editionLine(bolt)).toBe("Revised Edition (3ED #162)");
    expect(itemName(boltFoil)).toBe(
      "Lightning Bolt, Revised Edition (3ED #162), foil",
    );
  });

  it("says the library's copies by finish", () => {
    expect(finishesWords({ nonfoil: 2, foil: 1, etched: 0 })).toBe(
      "2 + 1 foil",
    );
    expect(finishesWords({ nonfoil: 0, foil: 0, etched: 1 })).toBe("1 etched");
    expect(finishesWords({ nonfoil: 3, foil: 0, etched: 0 })).toBe("3");
    expect(finishesWords(undefined)).toBe("");
  });

  it("says where the viewer stands", () => {
    expect(standing(boltFoil, NOW)?.label).toBe("Outbid");
    expect(standing(auction({ leading: true }), NOW)?.kind).toBe("leading");
    expect(standing(auction({ mine: true }), NOW)?.label).toBe("Your listing");
    expect(standing(auction(), NOW)).toBeNull();
    const sold = auction({ status: "sold", buyer: "ada", my_bid: 300 });
    expect(standing(sold, NOW, "ada")?.label).toBe("Won");
    expect(standing(sold, NOW, "bob")?.label).toBe("Lost");
    expect(standing({ ...sold, mine: true }, NOW)?.label).toBe("Sold");
    expect(
      standing(auction({ status: "expired", mine: true }), NOW)?.label,
    ).toBe("Unsold");
  });
});

describe("the market's filters", () => {
  it("asks only for the filters set", () => {
    expect(marketQuery(noMarketFilters)).toEqual({ sort: "ending", limit: 24 });
    const filters = {
      ...noMarketFilters,
      q: " bolt ",
      set: "3ED",
      rarity: ["rare", "mythic"],
      finish: ["foil" as const],
      color: ["R"],
      type: "Instant",
      minBid: "1,000",
      maxBid: "",
      maxBuyNow: "5000",
      buyNowOnly: true,
      maxTimeLeft: "600",
      sort: "price_low" as const,
    };
    expect(marketQuery(filters, "next-page")).toEqual({
      q: "bolt",
      set: "3ed",
      rarity: ["rare", "mythic"],
      finish: ["foil"],
      color: ["R"],
      type: "Instant",
      min_bid: 1000,
      max_buy_now: 5000,
      buy_now_only: true,
      max_time_left: 600,
      sort: "price_low",
      limit: 24,
      cursor: "next-page",
    });
    expect(filtersSet(filters)).toBe(10);
    expect(filtersSet({ ...noMarketFilters, sort: "newest" })).toBe(0);
  });

  it("keeps the tab in the address", () => {
    expect(tabOf("#auctions")).toBe("search");
    expect(tabOf("#auctions/list")).toBe("list");
    expect(tabOf("#auctions/targets")).toBe("targets");
    expect(tabOf("#auctions/nonsense")).toBe("search");
  });
});

describe("the bell's auction notifications", () => {
  const base = {
    id: "n1",
    actor: null,
    created_at: "2026-10-24T11:00:00Z",
    read: false,
    messages: 0,
    request_pending: false,
  };
  function bell(kind: string, auction?: object): NotificationItem {
    return { ...base, kind, auction } as unknown as NotificationItem;
  }

  it("says each of the five kinds and leads to its screen", () => {
    const named = {
      id: "a1",
      name: "Lightning Bolt",
      finish: "foil",
      price: 1200,
    };
    expect(notificationWords(bell("auction_outbid", named))).toBe(
      "You were outbid on Lightning Bolt (foil); your 1,200 tokens came back.",
    );
    expect(notificationWords(bell("auction_won", named))).toBe(
      "You won Lightning Bolt (foil) for 1,200 tokens. It is in your library.",
    );
    expect(notificationWords(bell("auction_sold", named))).toBe(
      "Lightning Bolt (foil) sold for 1,200 tokens. The tokens are yours.",
    );
    expect(notificationWords(bell("auction_unsold"))).toBe(
      "Your auction did not sell. The card is back in your library.",
    );
    expect(
      notificationWords(
        bell("auction_cancelled", { name: "Sol Ring", reason: "a mistake" }),
      ),
    ).toBe(
      "The auction of Sol Ring was cancelled by SysOp: a mistake. Cards and bids were returned.",
    );
    expect(awardLink(bell("auction_outbid"))).toBe("#auctions/targets");
    expect(awardLink(bell("auction_won"))).toBe("#auctions/targets");
    expect(awardLink(bell("auction_sold"))).toBe("#auctions/list");
    expect(awardLink(bell("auction_unsold"))).toBe("#auctions/list");
    expect(auctionNoticeLink("auction_cancelled")).toBe("#auctions/list");
    expect(auctionNotice({ kind: "message" })).toBeNull();
    expect(auctionNoticeWords("auction_won", {})).toMatch(/You won an auction/);
  });
});
