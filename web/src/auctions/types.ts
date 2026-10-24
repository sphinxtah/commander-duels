// Tivit's Auction House (v0.6.0): the API's shapes, written by hand from the contract the API and
// the web were built to at the same time (docs/auctions.md). At the merge these become the
// generated types (components["schemas"][...]) as the shop's are; nothing else here changes.

export type Finish = "nonfoil" | "foil" | "etched";
export type Duration = "1h" | "3h" | "12h" | "24h" | "3d";
export type AuctionStatus =
  "active" | "sold" | "expired" | "withdrawn" | "cancelled";
export type Rarity =
  "common" | "uncommon" | "rare" | "mythic" | "special" | "bonus";
export type AuctionSort =
  "ending" | "newest" | "price_low" | "price_high" | "buy_now_low";

/** One edition (printing) of a card, as an auction names it. */
export interface AuctionCard {
  concept_id: string;
  printing_id: string;
  name: string;
  type_line: string;
  /** "W", "U", "B", "R", "G"; empty for a colourless card. */
  colors: string[];
  set_code: string;
  set_name: string;
  collector_number: string;
  rarity: Rarity | string;
  released_at: string | null;
  /** The edition's picture, as the library uses. */
  image: string | null;
}

/** One copy of one card, in one edition and one finish, for sale. */
export interface AuctionItem {
  id: string;
  card: AuctionCard;
  finish: Finish;
  /** The seller's handle. */
  seller: string;
  starting_bid: number;
  buy_now: number | null;
  current_bid: number | null;
  high_bidder: string | null;
  bids: number;
  /** The least bid the auction takes now. */
  next_bid: number;
  duration: Duration;
  created_at: string;
  ends_at: string;
  status: AuctionStatus;
  sold_price: number | null;
  buyer: string | null;
  /** From the viewer's side: their own listing; they hold the high bid; they bid and were
   * outbid; they watch it. */
  mine: boolean;
  leading: boolean;
  outbid: boolean;
  watching: boolean;
  /** The viewer's highest bid. */
  my_bid: number | null;
}

export interface AuctionPage {
  items: AuctionItem[];
  next_cursor: string | null;
  total: number;
}

export interface RecentSale {
  price: number;
  sold_at: string;
}

/** GET /auctions/compare: the same edition and finish's live listings, lowest first. */
export interface ComparePrices {
  items: AuctionItem[];
  recent_sales: RecentSale[];
}

/** GET /auctions/targets: Madden's Transfer Targets. */
export interface AuctionTargets {
  active: AuctionItem[];
  won: AuctionItem[];
  lost: AuctionItem[];
}

/** GET /auctions/mine: Madden's Transfer List. */
export interface TransferList {
  active: AuctionItem[];
  sold: AuctionItem[];
  unsold: AuctionItem[];
}

/** An edition and finish the viewer may list. */
export interface SellableItem {
  card: AuctionCard;
  finish: Finish;
  copies: number;
  sellable: number;
}

export interface SellablePage {
  items: SellableItem[];
  next_cursor: string | null;
}

/** POST /auctions. */
export interface NewAuction {
  printing_id: string;
  finish: Finish;
  starting_bid: number;
  buy_now: number | null;
  duration: Duration;
  quantity?: number;
  key: string;
}

/** POST /auctions/{id}/relist. */
export interface Relisting {
  starting_bid: number;
  buy_now: number | null;
  duration: Duration;
  key: string;
}

/** The library's items gain their copies by finish and how many may be listed (v0.6.0). */
export interface LibraryFinishes {
  finishes: Record<Finish, number>;
  sellable: number;
}

/** The bell's five auction kinds (v0.6.0). */
export type AuctionNoticeKind =
  | "auction_outbid"
  | "auction_won"
  | "auction_sold"
  | "auction_unsold"
  | "auction_cancelled";

/**
 * What an auction's notification says of it. The contract names only the kinds and that each
 * leads to the auction house with the auction as its subject; this is the shape the bell reads
 * when the API sends it (`auction` on the notification), and each field may be missing.
 */
export interface AuctionNoticeInfo {
  id?: string;
  name?: string;
  finish?: Finish;
  /** What it sold or was won for, or the bid that was outbid. */
  price?: number | null;
  /** SysOp's reason, for a cancelled auction. */
  reason?: string | null;
}
