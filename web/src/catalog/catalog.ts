import type { components } from "../generated/api";

export type CardSummary = components["schemas"]["CardSummary"];
export type CardDetail = components["schemas"]["CardDetail"];
export type CardPage = components["schemas"]["CardPage"];
export type PrintingSummary = components["schemas"]["PrintingSummary"];
export type CatalogStatus = components["schemas"]["CatalogStatus"];
export type LibraryView = components["schemas"]["LibraryView"];
export type LibraryCard = components["schemas"]["LibraryCard"];
export type LibraryEdition = components["schemas"]["LibraryEdition"];
export type EditionCopies = components["schemas"]["EditionCopies"];
/** Which of a card's printings its details list (v0.5.0): every one, the editions the player's
 * library holds, or only the one chosen (a card pulled from a pack). */
export type PrintingsShown = "all" | "owned" | "chosen";
export type CustomCard = components["schemas"]["CustomCardInfo"];
export type AllianceCards = components["schemas"]["AllianceCards"];

export type Search = {
  q: string;
  colors: string;
  colorsMode: "including" | "exact" | "within";
  identity: string;
  type: string;
  mvMin: string;
  mvMax: string;
  rarity: string;
  set: string;
  legal: string;
  /** Only the cards in the player's library (basic lands included). The server sets it aside
   * for an account that builds from the whole catalog. */
  owned: boolean;
  sort: "name" | "mana_value" | "released" | "popularity" | "color";
  descending: boolean;
};

export const emptySearch: Search = {
  q: "",
  colors: "",
  colorsMode: "including",
  identity: "",
  type: "",
  mvMin: "",
  mvMax: "",
  rarity: "",
  set: "",
  legal: "",
  owned: false,
  sort: "name",
  descending: false,
};

/** The query string the card search takes; unset filters are left out. Every card it finds is
 * one the game can play (v0.4.5): the others are not in the game. */
export function searchQuery(
  search: Search,
  page: number,
  pageSize: number,
): Record<string, string | number | boolean> {
  const query: Record<string, string | number | boolean> = {
    page,
    page_size: pageSize,
    sort: search.sort,
  };
  if (search.descending) query.descending = true;
  if (search.q.trim()) query.q = search.q.trim();
  if (search.colors) {
    query.colors = search.colors;
    query.colors_mode = search.colorsMode;
  }
  if (search.identity) query.identity = search.identity;
  if (search.type.trim()) query.type = search.type.trim();
  if (search.mvMin !== "") query.mv_min = Number(search.mvMin);
  if (search.mvMax !== "") query.mv_max = Number(search.mvMax);
  if (search.rarity) query.rarity = search.rarity;
  if (search.set.trim()) query.set = search.set.trim().toLowerCase();
  if (search.legal) query.legal = search.legal;
  if (search.owned) query.owned = true;
  return query;
}

/** Basic lands, which every library holds without limit; the server reads the type line the
 * same way. */
export function isBasicLand(card: Pick<CardSummary, "type_line">): boolean {
  return card.type_line.startsWith("Basic ");
}

/**
 * Whether the account builds from a library of its own (v0.3.1), as the cards it was sent say:
 * every card's `owned` is a number of copies for such an account, and null for one that builds
 * from the whole catalog (administrators, SysOp). Basic lands are null for both, so they tell
 * nothing; undefined until a card tells.
 */
export function buildsFromLibrary(
  cards: Iterable<Pick<CardSummary, "type_line" | "owned">>,
): boolean | undefined {
  for (const card of cards) {
    if (isBasicLand(card)) continue;
    return card.owned !== null && card.owned !== undefined;
  }
  return undefined;
}

/** A card's copies in the player's library, in words; null when the library does not limit it
 * (basic lands, and accounts that build from the whole catalog), so nothing is shown. */
export function ownedWords(card: Pick<CardSummary, "owned">): string | null {
  if (card.owned === null || card.owned === undefined) return null;
  return card.owned > 0
    ? `In your library: ${card.owned}`
    : "Not in your library";
}

/** An edition by its set, code and number: "Revised Edition (3ED #150)". */
export function editionName(
  edition: Pick<EditionCopies, "set_name" | "set_code" | "collector_number">,
): string {
  return `${edition.set_name} (${edition.set_code.toUpperCase()} #${edition.collector_number})`;
}

/** The editions of a card a library holds, with their copies, in words; null when the library
 * does not limit the card (v0.5.0). */
export function editionsWords(
  card: Pick<CardSummary, "editions">,
): string | null {
  if (!card.editions) return null;
  if (card.editions.length === 0) return "No edition of it";
  return card.editions
    .map((edition) => `${editionName(edition)} × ${edition.copies}`)
    .join(", ");
}

/** Where a library's copies came from. */
export const sourceLabels: Record<LibraryCard["sources"][number], string> = {
  starter: "Starter decks",
  alliance: "Your alliance",
  grandfathered: "Your earlier decks",
  pack: "Packs you opened",
  // A one-of-a-kind card (v0.5.1): the only copy there is.
  unique: "One of a kind",
};

/** A catalog printing's image, from our own server's cache of Scryfall's. */
export function printingImage(
  printingId: string,
  // The sizes the API serves (png since v0.3.0).
  size: "normal" | "large" | "png" = "normal",
  face?: number,
): string {
  const faced = face === undefined ? "" : `&face=${face}`;
  return `/api/v1/card-images/printings/${printingId}?size=${size}${faced}`;
}

export const colorNames: Record<string, string> = {
  W: "white",
  U: "blue",
  B: "black",
  R: "red",
  G: "green",
};

/** "WUG" in words. */
export function colorWords(colors: string | string[]): string {
  const list = Array.isArray(colors) ? colors : colors.split("");
  if (list.length === 0) return "colorless";
  return list.map((color) => colorNames[color] ?? color).join(", ");
}

export const reasonLabels: Record<string, string> = {
  not_implemented: "Not supported by the game engine yet",
  unknown_layout: "A card layout this version does not know yet",
  not_a_deck_card: "Not a card a deck holds",
  engine_unchecked: "Not checked against the game engine yet",
  engine_load_failed: "The engine's version of this card does not load",
  engine_gate_failed: "The engine's version failed an automatic check",
  characteristics_differ: "The engine's version differs from the Oracle card",
  suspended_by_staff: "Suspended by the site's staff",
  // The Godlike tier's custom cards (v0.4.0).
  not_loaded: "Not loaded by this engine",
  godlike_only: "Only the Godlike tier may play it",
};

/** A short label for why a card cannot be played; the detail explains more. */
export function statusLabel(
  card: Pick<CardSummary, "playable" | "status" | "status_reason">,
): string {
  if (card.playable) return "Playable";
  return (
    reasonLabels[card.status_reason ?? ""] ?? `Not playable (${card.status})`
  );
}

export const legalityLabels: Record<string, string> = {
  legal: "Legal",
  not_legal: "Not legal",
  banned: "Banned",
  restricted: "Restricted",
};

export const formatLabels: Record<string, string> = {
  legacy: "Legacy",
  commander: "Commander",
};

export const steps = [
  "upkeep",
  "draw",
  "main1",
  "before_combat",
  "end_of_combat",
  "main2",
  "end_of_turn",
] as const;
