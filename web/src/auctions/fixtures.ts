import type {
  AuctionCard,
  AuctionItem,
  AuctionPage,
  AuctionTargets,
  ComparePrices,
  SellableItem,
  TransferList,
} from "./types";

// Made-up auction house data for the tests and the screenshots, in the contract's shape.

/** A fixed moment the fixtures' times are counted from. */
export const NOW = Date.parse("2026-10-24T12:00:00Z");

export function inMinutes(minutes: number, from = NOW): string {
  return new Date(from + minutes * 60_000).toISOString();
}

export const bolt: AuctionCard = {
  concept_id: "c0000000-0000-4000-8000-000000000001",
  printing_id: "p0000000-0000-4000-8000-000000000001",
  name: "Lightning Bolt",
  type_line: "Instant",
  colors: ["R"],
  set_code: "3ed",
  set_name: "Revised Edition",
  collector_number: "162",
  rarity: "common",
  released_at: "1994-04-01",
  image: null,
};

export const counterspell: AuctionCard = {
  concept_id: "c0000000-0000-4000-8000-000000000002",
  printing_id: "p0000000-0000-4000-8000-000000000002",
  name: "Counterspell",
  type_line: "Instant",
  colors: ["U"],
  set_code: "mh2",
  set_name: "Modern Horizons 2",
  collector_number: "267",
  rarity: "uncommon",
  released_at: "2021-06-18",
  image: null,
};

export const solRing: AuctionCard = {
  concept_id: "c0000000-0000-4000-8000-000000000003",
  printing_id: "p0000000-0000-4000-8000-000000000003",
  name: "Sol Ring",
  type_line: "Artifact",
  colors: [],
  set_code: "c21",
  set_name: "Commander 2021",
  collector_number: "263",
  rarity: "uncommon",
  released_at: "2021-04-23",
  image: null,
};

export const dragon: AuctionCard = {
  concept_id: "c0000000-0000-4000-8000-000000000004",
  printing_id: "p0000000-0000-4000-8000-000000000004",
  name: "Shivan Dragon",
  type_line: "Creature — Dragon",
  colors: ["R"],
  set_code: "lea",
  set_name: "Limited Edition Alpha",
  collector_number: "174",
  rarity: "rare",
  released_at: "1993-08-05",
  image: null,
};

let next = 0;

/** An auction, live for an hour, nobody's bid on it yet. */
export function auction(fields: Partial<AuctionItem> = {}): AuctionItem {
  next += 1;
  return {
    id: `a0000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    card: bolt,
    finish: "nonfoil",
    seller: "bob",
    starting_bid: 100,
    buy_now: 500,
    current_bid: null,
    high_bidder: null,
    bids: 0,
    next_bid: 100,
    duration: "1h",
    created_at: inMinutes(-10),
    ends_at: inMinutes(50),
    status: "active",
    sold_price: null,
    buyer: null,
    mine: false,
    leading: false,
    outbid: false,
    watching: false,
    my_bid: null,
    ...fields,
  };
}

export function market(items: AuctionItem[], next_cursor: string | null = null): AuctionPage {
  return { items, next_cursor, total: items.length };
}

export const boltFoil = auction({
  id: "a0000000-0000-4000-8000-0000000000b1",
  finish: "foil",
  current_bid: 240,
  high_bidder: "carol",
  bids: 3,
  next_bid: 252,
  buy_now: 900,
  outbid: true,
  my_bid: 220,
  watching: true,
});
export const counterLeading = auction({
  id: "a0000000-0000-4000-8000-0000000000c1",
  card: counterspell,
  current_bid: 60,
  starting_bid: 40,
  high_bidder: "ada",
  bids: 2,
  next_bid: 63,
  buy_now: null,
  leading: true,
  my_bid: 60,
  watching: true,
  ends_at: inMinutes(0.5),
});
export const solEtched = auction({
  id: "a0000000-0000-4000-8000-0000000000d1",
  card: solRing,
  finish: "etched",
  starting_bid: 1200,
  next_bid: 1200,
  buy_now: 2500,
  ends_at: inMinutes(60 * 30),
  duration: "3d",
});

export const page = market([boltFoil, counterLeading, solEtched]);

export const compare: ComparePrices = {
  items: [
    auction({ finish: "foil", starting_bid: 180, next_bid: 180, buy_now: 700 }),
    boltFoil,
  ],
  recent_sales: [
    { price: 640, sold_at: inMinutes(-90) },
    { price: 710, sold_at: inMinutes(-60 * 26) },
  ],
};

export const mineList: TransferList = {
  active: [
    auction({
      id: "a0000000-0000-4000-8000-0000000000e1",
      card: dragon,
      seller: "ada",
      mine: true,
      starting_bid: 5000,
      next_bid: 5000,
      buy_now: 12000,
      duration: "24h",
      ends_at: inMinutes(60 * 20),
    }),
    auction({
      id: "a0000000-0000-4000-8000-0000000000e2",
      seller: "ada",
      mine: true,
      current_bid: 150,
      high_bidder: "bob",
      bids: 1,
      next_bid: 158,
    }),
  ],
  sold: [
    auction({
      id: "a0000000-0000-4000-8000-0000000000e3",
      card: counterspell,
      seller: "ada",
      mine: true,
      status: "sold",
      sold_price: 75,
      buyer: "carol",
      current_bid: 75,
      bids: 4,
      ends_at: inMinutes(-30),
    }),
  ],
  unsold: [
    auction({
      id: "a0000000-0000-4000-8000-0000000000e4",
      card: solRing,
      seller: "ada",
      mine: true,
      status: "expired",
      starting_bid: 900,
      buy_now: 1500,
      duration: "12h",
      ends_at: inMinutes(-120),
    }),
  ],
};

export const targets: AuctionTargets = {
  active: [boltFoil, counterLeading],
  won: [
    auction({
      id: "a0000000-0000-4000-8000-0000000000f1",
      card: solRing,
      status: "sold",
      sold_price: 1800,
      buyer: "ada",
      leading: true,
      my_bid: 1800,
      ends_at: inMinutes(-15),
    }),
  ],
  lost: [
    auction({
      id: "a0000000-0000-4000-8000-0000000000f2",
      card: dragon,
      status: "sold",
      sold_price: 9000,
      buyer: "carol",
      my_bid: 8000,
      ends_at: inMinutes(-200),
    }),
  ],
};

export const sellable: SellableItem[] = [
  { card: bolt, finish: "nonfoil", copies: 3, sellable: 2 },
  { card: bolt, finish: "foil", copies: 1, sellable: 1 },
  { card: counterspell, finish: "nonfoil", copies: 4, sellable: 4 },
];
