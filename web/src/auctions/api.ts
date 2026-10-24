import {
  answered,
  BACKGROUND_HEADER,
  currentCsrfToken,
  type ApiError,
} from "../api";
import type {
  AuctionItem,
  AuctionPage,
  AuctionStatus,
  AuctionTargets,
  ComparePrices,
  Finish,
  NewAuction,
  Relisting,
  SellablePage,
  TransferList,
} from "./types";

// The auction house's requests (v0.6.0). Until the API's contract is generated into
// src/generated/api.d.ts these go through the same fetch as the typed client (`answered`: a network
// failure is the service's own "unavailable" answer) with the session's CSRF token, and answer in
// the client's shape, { data } or { error }. At the merge each becomes a client.GET/POST call.

export type Answer<T> =
  { data: T; error?: undefined } | { data?: undefined; error: ApiError };

type Query = Record<
  string,
  string | number | boolean | (string | number)[] | null | undefined
>;

function address(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value))
      for (const item of value) params.append(key, String(item));
    else params.append(key, String(value));
  }
  const search = params.toString();
  return `/api/v1${path}${search ? `?${search}` : ""}`;
}

async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  {
    query,
    body,
    background = false,
  }: { query?: Query; body?: unknown; background?: boolean } = {},
): Promise<Answer<T>> {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const token = currentCsrfToken();
  if (token && method !== "GET") headers.set("X-CSRF-Token", token);
  // A poll the page makes on its own does not count as the player's activity.
  if (background && method === "GET") headers.set(BACKGROUND_HEADER, "1");
  const response = await answered(
    new Request(new URL(address(path, query), window.location.origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    }),
  );
  const text = await response.text().catch(() => "");
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (response.ok) return { data: parsed as T };
  const error =
    parsed && typeof parsed === "object" && "message" in parsed
      ? (parsed as ApiError)
      : {
          code: "service_unavailable",
          message: "The application service is unavailable. Try again.",
        };
  return { error };
}

/** The transfer market's filters, as GET /auctions takes them. */
export interface MarketQuery {
  q?: string;
  set?: string;
  rarity?: string[];
  finish?: Finish[];
  color?: string[];
  type?: string;
  min_bid?: number;
  max_bid?: number;
  min_buy_now?: number;
  max_buy_now?: number;
  buy_now_only?: boolean;
  max_time_left?: number;
  sort?: string;
  cursor?: string;
  limit?: number;
  include_mine?: boolean;
}

/** Every request the auction house makes; tests answer them one by one. */
export const auctionApi = {
  search: (query: MarketQuery, background = false) =>
    call<AuctionPage>("GET", "/auctions", {
      query: query as Query,
      background,
    }),
  item: (id: string, background = false) =>
    call<AuctionItem>("GET", `/auctions/${id}`, { background }),
  compare: (printingId: string, finish: Finish) =>
    call<ComparePrices>("GET", "/auctions/compare", {
      query: { printing_id: printingId, finish },
    }),
  create: (body: NewAuction) =>
    call<{ items: AuctionItem[] }>("POST", "/auctions", { body }),
  bid: (id: string, amount: number, key: string) =>
    call<AuctionItem>("POST", `/auctions/${id}/bids`, {
      body: { amount, key },
    }),
  buyNow: (id: string, key: string) =>
    call<AuctionItem>("POST", `/auctions/${id}/buy-now`, { body: { key } }),
  withdraw: (id: string) => call<AuctionItem>("DELETE", `/auctions/${id}`),
  watch: (id: string, on: boolean) =>
    call<void>(on ? "PUT" : "DELETE", `/auctions/${id}/watch`),
  targets: (background = false) =>
    call<AuctionTargets>("GET", "/auctions/targets", { background }),
  clearTargets: (which: "won" | "lost") =>
    call<void>("POST", "/auctions/targets/clear", { body: { which } }),
  mine: (background = false) =>
    call<TransferList>("GET", "/auctions/mine", { background }),
  relist: (id: string, body: Relisting) =>
    call<AuctionItem>("POST", `/auctions/${id}/relist`, { body }),
  clearMine: (which: "sold" | "unsold") =>
    call<void>("POST", "/auctions/mine/clear", { body: { which } }),
  sellable: (q: string, cursor?: string | null) =>
    call<SellablePage>("GET", "/auctions/sellable", {
      query: { q: q.trim(), cursor, limit: 30 },
    }),
  adminList: (status: AuctionStatus | "", cursor?: string | null) =>
    call<AuctionPage>("GET", "/admin/auctions", {
      query: { status, cursor },
    }),
  adminCancel: (id: string, reason: string) =>
    call<AuctionItem>("POST", `/admin/auctions/${id}/cancel`, {
      body: { reason },
    }),
};
