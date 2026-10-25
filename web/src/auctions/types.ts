// Tivit's Auction House (v0.6.0): the API's shapes, from the generated contract.

import type { components } from "../generated/api";

type Schemas = components["schemas"];

export type Finish = "nonfoil" | "foil" | "etched";
export type Duration =
  "1h" | "3h" | "12h" | "24h" | "3d" | "7d" | "30d" | "unlimited";
export type AuctionStatus =
  "active" | "sold" | "expired" | "withdrawn" | "cancelled";
export type Rarity =
  "common" | "uncommon" | "rare" | "mythic" | "special" | "bonus";
export type AuctionSort =
  "ending" | "newest" | "price_low" | "price_high" | "buy_now_low";

/** One edition (printing) of a card, as an auction names it. */
export type AuctionCard = Schemas["AuctionCard"];
/** One copy of one card, in one edition and one finish, for sale. */
export type AuctionItem = Schemas["AuctionItem"];
export type AuctionPage = Schemas["AuctionPage"];
export type RecentSale = Schemas["RecentSale"];
/** GET /auctions/compare: the same edition and finish's live listings, lowest first. */
export type ComparePrices = Schemas["Comparison"];
/** GET /auctions/targets: Madden's Transfer Targets. */
export type AuctionTargets = Schemas["Targets"];
/** GET /auctions/mine: Madden's Transfer List. */
export type TransferList = Schemas["TransferList"];
/** An edition and finish the viewer may list. */
export type SellableItem = Schemas["SellableItem"];
export type SellablePage = Schemas["SellablePage"];
/** POST /auctions. */
export type NewAuction = Schemas["Listing"];
/** POST /auctions/{id}/relist. */
export type Relisting = Schemas["Relisting"];

/** The library's items' copies by finish and how many may be listed (v0.6.0). */
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
