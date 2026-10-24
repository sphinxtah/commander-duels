import { useEffect, useState } from "react";
import { printingImage } from "../catalog/catalog";
import type { MarketQuery } from "./api";
import type {
  AuctionCard,
  AuctionItem,
  AuctionNoticeInfo,
  AuctionNoticeKind,
  AuctionSort,
  Duration,
  Finish,
} from "./types";

// Tivit's Auction House (v0.6.0): what the screens say of auctions, and the arithmetic they share
// with the server. The server decides every price, bid and ending; these only show its answers
// and keep the bid stepper on amounts it will take.

/** #auctions/<tab>: the three screens of Madden's transfer market. */
export type AuctionTab = "search" | "list" | "targets";
export const AUCTION_TABS: AuctionTab[] = ["search", "list", "targets"];
export const tabNames: Record<AuctionTab, string> = {
  search: "Search the market",
  list: "Transfer list",
  targets: "Transfer targets",
};

/** The tab an address names; #auctions alone is the market's search. */
export function tabOf(hash: string): AuctionTab {
  const tab = hash.replace(/^#/, "").toLowerCase().split(/[/?]/)[1];
  return AUCTION_TABS.includes(tab as AuctionTab)
    ? (tab as AuctionTab)
    : "search";
}

export function tabHref(tab: AuctionTab): string {
  return `#auctions/${tab}`;
}

/** 1,234 tokens. */
export function tokens(amount: number): string {
  return `${amount.toLocaleString("en-US")} ${amount === 1 ? "token" : "tokens"}`;
}

/** 1,234, for prices beside a coin. */
export function amount(value: number): string {
  return value.toLocaleString("en-US");
}

export const finishNames: Record<Finish, string> = {
  nonfoil: "Nonfoil",
  foil: "Foil",
  etched: "Etched foil",
};

export const durationNames: Record<Duration, string> = {
  "1h": "1 hour",
  "3h": "3 hours",
  "12h": "12 hours",
  "24h": "24 hours",
  "3d": "3 days",
};
export const DURATIONS = Object.keys(durationNames) as Duration[];

export const rarityNames: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  mythic: "Mythic rare",
  special: "Special",
  bonus: "Bonus",
};

export const sortNames: Record<AuctionSort, string> = {
  ending: "Ending soonest",
  newest: "Newest listings",
  price_low: "Price: low to high",
  price_high: "Price: high to low",
  buy_now_low: "Buy Now: low to high",
};

/** The colours' pips, in WUBRG order, with colourless last. */
export const COLORS = ["W", "U", "B", "R", "G", "C"] as const;
export const colorNames: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colourless",
};

/** The time-left filter's choices, in seconds. */
export const timeLeftChoices: { label: string; seconds: number }[] = [
  { label: "Under 1 minute", seconds: 60 },
  { label: "Under 10 minutes", seconds: 600 },
  { label: "Under 1 hour", seconds: 3600 },
  { label: "Under 3 hours", seconds: 3 * 3600 },
  { label: "Under 12 hours", seconds: 12 * 3600 },
  { label: "Under 24 hours", seconds: 24 * 3600 },
];

/** "Revised Edition (3ED #162)". */
export function editionLine(
  card: Pick<AuctionCard, "set_name" | "set_code" | "collector_number">,
): string {
  return `${card.set_name} (${card.set_code.toUpperCase()} #${card.collector_number})`;
}

/** "Lightning Bolt, Revised Edition (3ED #162), foil": how an auction is named aloud. */
export function itemName(item: Pick<AuctionItem, "card" | "finish">): string {
  const finish =
    item.finish === "nonfoil" ? "" : `, ${finishNames[item.finish]}`;
  return `${item.card.name}, ${editionLine(item.card)}${finish.toLowerCase()}`;
}

/** The edition's picture: the auction's own, else the catalog's of its printing. */
export function cardImage(
  card: Pick<AuctionCard, "image" | "printing_id">,
  size: "normal" | "large" | "png" = "normal",
): string {
  if (card.image && size === "normal") return card.image;
  return printingImage(card.printing_id, size);
}

/**
 * The least raise on a bid: 5% of it, rounded up, and never less than 1 token. The server
 * reckons the next bid the same way: the starting bid first, then current + this.
 */
export function increment(current: number): number {
  return Math.max(1, Math.ceil(current * 0.05));
}

/** The bid stepper's next amount up from a value. */
export function stepUp(value: number): number {
  return value + increment(value);
}

/** The bid stepper's next amount down, never under the least bid the auction takes. */
export function stepDown(value: number, least: number): number {
  if (value <= least) return least;
  // The amount whose raise lands on (or just over) this value, so up then down comes back.
  let lower = least;
  while (stepUp(lower) < value) lower = stepUp(lower);
  return lower;
}

/** What a bid of this amount does: below the least bid, a bid, or at Buy Now, buys. */
export function bidOutcome(
  item: Pick<AuctionItem, "next_bid" | "buy_now">,
  value: number,
): "too_low" | "bid" | "buys" {
  if (!Number.isFinite(value) || value < item.next_bid) return "too_low";
  if (item.buy_now !== null && value >= item.buy_now) return "buys";
  return "bid";
}

/** The price an auction shows: its high bid, else its starting bid. */
export function shownPrice(
  item: Pick<AuctionItem, "current_bid" | "starting_bid">,
): number {
  return item.current_bid ?? item.starting_bid;
}

/** Milliseconds left until an auction ends; never below zero. */
export function msLeft(endsAt: string, now: number): number {
  return Math.max(0, Date.parse(endsAt) - now);
}

/**
 * Time left as Madden shows it: "2d 4h", "5h 12m", "12m 05s", "45s"; "Ended" at zero. Under a
 * minute it is urgent (red on screen).
 */
export function timeLeft(endsAt: string, now: number): string {
  const total = Math.ceil(msLeft(endsAt, now) / 1000);
  if (total <= 0) return "Ended";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** The same in words for screen readers: "2 days 4 hours left". */
export function timeLeftWords(endsAt: string, now: number): string {
  const total = Math.ceil(msLeft(endsAt, now) / 1000);
  if (total <= 0) return "ended";
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${unit(days, "day")} ${unit(hours, "hour")} left`;
  if (hours > 0)
    return `${unit(hours, "hour")} ${unit(minutes, "minute")} left`;
  if (minutes > 0) return `${unit(minutes, "minute")} left`;
  return "less than a minute left";
}

export function urgent(endsAt: string, now: number): boolean {
  const left = msLeft(endsAt, now);
  return left > 0 && left < 60_000;
}

/**
 * The milestone an auction's countdown has reached, for the live region: it speaks when this
 * changes (an hour left, ten minutes, one minute, ended), never every second.
 */
export function milestone(endsAt: string, now: number): string {
  const left = msLeft(endsAt, now);
  if (left <= 0) return "The auction has ended.";
  if (left < 60_000) return "Less than a minute left.";
  if (left < 600_000) return "Less than ten minutes left.";
  if (left < 3_600_000) return "Less than an hour left.";
  return "";
}

/** The clock the countdowns read, ticking every second while the page shows. */
export function useNow(every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
}

export type Standing = {
  kind: "mine" | "leading" | "outbid" | "won" | "lost" | "sold" | "ended";
  label: string;
};

/** What an auction's state says on its badge, from the viewer's side (`viewer`, their handle). */
export function standing(
  item: AuctionItem,
  now: number,
  viewer?: string | null,
): Standing | null {
  const live = item.status === "active" && msLeft(item.ends_at, now) > 0;
  if (item.status === "sold") {
    if (item.mine) return { kind: "sold", label: "Sold" };
    if ((viewer && item.buyer === viewer) || item.leading)
      return { kind: "won", label: "Won" };
    if (item.my_bid !== null) return { kind: "lost", label: "Lost" };
    return { kind: "ended", label: "Sold" };
  }
  if (!live && item.status === "active" && !item.mine) {
    // Past its end, before the server's answer settles it.
    if (item.leading) return { kind: "leading", label: "Ending…" };
  }
  if (!live) {
    if (item.status === "withdrawn")
      return { kind: "ended", label: "Withdrawn" };
    if (item.status === "cancelled")
      return { kind: "ended", label: "Cancelled" };
    if (item.my_bid !== null && !item.mine)
      return { kind: "lost", label: "Lost" };
    return { kind: "ended", label: item.mine ? "Unsold" : "Ended" };
  }
  if (item.mine) return { kind: "mine", label: "Your listing" };
  if (item.leading) return { kind: "leading", label: "Winning" };
  if (item.outbid) return { kind: "outbid", label: "Outbid" };
  return null;
}

/** The library's copies by finish in words: "2 + 1 foil", "1 etched", "3". */
export function finishesWords(
  finishes: Partial<Record<Finish, number>> | undefined,
): string {
  if (!finishes) return "";
  const parts: string[] = [];
  if (finishes.nonfoil) parts.push(String(finishes.nonfoil));
  if (finishes.foil) parts.push(`${finishes.foil} foil`);
  if (finishes.etched) parts.push(`${finishes.etched} etched`);
  return parts.join(" + ");
}

/** The market's filters as the form holds them: text, so a box may be empty. */
export interface MarketFilters {
  q: string;
  set: string;
  rarity: string[];
  finish: Finish[];
  color: string[];
  type: string;
  minBid: string;
  maxBid: string;
  minBuyNow: string;
  maxBuyNow: string;
  buyNowOnly: boolean;
  maxTimeLeft: string;
  sort: AuctionSort;
}

export const noMarketFilters: MarketFilters = {
  q: "",
  set: "",
  rarity: [],
  finish: [],
  color: [],
  type: "",
  minBid: "",
  maxBid: "",
  minBuyNow: "",
  maxBuyNow: "",
  buyNowOnly: false,
  maxTimeLeft: "",
  sort: "ending",
};

function whole(value: string): number | undefined {
  const number = Number(value.replace(/[,\s]/g, ""));
  return value.trim() && Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : undefined;
}

/** The filters as GET /auctions takes them; empty ones are left out. */
export function marketQuery(
  filters: MarketFilters,
  cursor?: string | null,
): MarketQuery {
  const query: MarketQuery = { sort: filters.sort, limit: 24 };
  if (filters.q.trim()) query.q = filters.q.trim();
  if (filters.set.trim()) query.set = filters.set.trim().toLowerCase();
  if (filters.rarity.length) query.rarity = filters.rarity;
  if (filters.finish.length) query.finish = filters.finish;
  if (filters.color.length) query.color = filters.color;
  if (filters.type.trim()) query.type = filters.type.trim();
  const numbers: [keyof MarketFilters, keyof MarketQuery][] = [
    ["minBid", "min_bid"],
    ["maxBid", "max_bid"],
    ["minBuyNow", "min_buy_now"],
    ["maxBuyNow", "max_buy_now"],
    ["maxTimeLeft", "max_time_left"],
  ];
  for (const [field, key] of numbers) {
    const value = whole(filters[field] as string);
    if (value !== undefined) (query as Record<string, unknown>)[key] = value;
  }
  if (filters.buyNowOnly) query.buy_now_only = true;
  if (cursor) query.cursor = cursor;
  return query;
}

/** How many filters are set, for the Reset button and the phone's folded panel. */
export function filtersSet(filters: MarketFilters): number {
  return (Object.keys(noMarketFilters) as (keyof MarketFilters)[]).filter(
    (key) =>
      key !== "sort" &&
      JSON.stringify(filters[key]) !== JSON.stringify(noMarketFilters[key]),
  ).length;
}

/** A client key for one request that spends or lists: a retry reuses it, so it happens once. */
export function requestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** The price form's checks, as the server makes them: a starting bid of at least 1 token, and a
 * Buy Now above it. Empty when the prices are fine. */
export function priceProblem(startingBid: string, buyNow: string): string {
  const start = Number(startingBid);
  if (!startingBid.trim() || !Number.isInteger(start) || start < 1)
    return "The starting bid is a whole number of tokens, at least 1.";
  if (buyNow.trim()) {
    const buy = Number(buyNow);
    if (!Number.isInteger(buy) || buy <= start)
      return "Buy Now must be more than the starting bid.";
  }
  return "";
}

// The bell (v0.6.0): the five kinds of auction notification, each leading to the screen it
// concerns.

const NOTICE_KINDS: AuctionNoticeKind[] = [
  "auction_outbid",
  "auction_won",
  "auction_sold",
  "auction_unsold",
  "auction_cancelled",
];

/** A notification's kind and auction, when it is one of the auction house's. */
export function auctionNotice(item: {
  kind: string;
}): { kind: AuctionNoticeKind; auction: AuctionNoticeInfo } | null {
  if (!NOTICE_KINDS.includes(item.kind as AuctionNoticeKind)) return null;
  const auction =
    (item as { auction?: AuctionNoticeInfo | null }).auction ?? {};
  return { kind: item.kind as AuctionNoticeKind, auction };
}

/** Outbid and won lead to the transfer targets; sold, unsold and cancelled to the transfer list.
 * A cancelled auction may be one the viewer bid on: the API names it for the seller and the
 * bidder alike, so it opens the transfer list, where the seller's card is back, and the targets'
 * Lost holds the bidder's. */
export function auctionNoticeLink(kind: AuctionNoticeKind): string {
  return kind === "auction_outbid" || kind === "auction_won"
    ? tabHref("targets")
    : tabHref("list");
}

export function auctionNoticeWords(
  kind: AuctionNoticeKind,
  auction: AuctionNoticeInfo,
): string {
  const name = auction.name
    ? `${auction.name}${auction.finish && auction.finish !== "nonfoil" ? ` (${finishNames[auction.finish].toLowerCase()})` : ""}`
    : "";
  const price =
    auction.price !== undefined && auction.price !== null
      ? tokens(auction.price)
      : "";
  switch (kind) {
    case "auction_outbid":
      return name
        ? `You were outbid on ${name}${price ? `; your ${price} came back` : ""}.`
        : "You were outbid on an auction; your bid came back.";
    case "auction_won":
      return name
        ? `You won ${name}${price ? ` for ${price}` : ""}. It is in your library.`
        : "You won an auction. The card is in your library.";
    case "auction_sold":
      return name
        ? `${name} sold${price ? ` for ${price}` : ""}. The tokens are yours.`
        : "Your auction sold. The tokens are yours.";
    case "auction_unsold":
      return name
        ? `${name} did not sell. It is back in your library.`
        : "Your auction did not sell. The card is back in your library.";
    case "auction_cancelled":
      return `${name ? `The auction of ${name}` : "An auction"} was cancelled by SysOp${auction.reason ? `: ${auction.reason}` : ""}. Cards and bids were returned.`;
  }
}
