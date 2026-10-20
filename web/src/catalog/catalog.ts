import type { components } from "../generated/api";

export type CardSummary = components["schemas"]["CardSummary"];
export type CardDetail = components["schemas"]["CardDetail"];
export type CardPage = components["schemas"]["CardPage"];
export type PrintingSummary = components["schemas"]["PrintingSummary"];
export type CatalogStatus = components["schemas"]["CatalogStatus"];

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
  playable: "" | "true" | "false";
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
  playable: "",
  sort: "name",
  descending: false,
};

/** The query string the card search takes; unset filters are left out. */
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
  if (search.playable) query.playable = search.playable === "true";
  return query;
}

/** A catalog printing's image, from our own server's cache of Scryfall's. */
export function printingImage(
  printingId: string,
  size: "normal" | "large" | "small" = "normal",
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
