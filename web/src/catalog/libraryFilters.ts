import type { LibraryCard } from "./catalog";

// My library's filters (v0.6.2, the owner's request): as fine as the auction house's search, by
// name, set, rarity, finish, colour, type and mana value, with where the copies came from and a
// sort. The library arrives whole (GET /library), so they apply here, at once, as they change.

export type LibrarySource = LibraryCard["sources"][number];
type FinishCounts = LibraryCard["finishes"];
export type LibraryFinish = keyof FinishCounts;
export type LibrarySort =
  "name" | "mana_value" | "newest" | "rarity" | "copies";
/** How the colour pips match: any of them, every one, or exactly those (C: colourless). */
export type ColourMatch = "any" | "all" | "exactly";

export interface LibraryFilters {
  /** Words in the card's name or type, or the set's name; a set code alone finds that set. */
  find: string;
  source: LibrarySource | "";
  /** A set code the library holds; "" for any. */
  set: string;
  rarity: string[];
  finish: LibraryFinish[];
  colours: string[];
  colourMatch: ColourMatch;
  /** Words the type line holds, all of them: "legendary creature". */
  type: string;
  mvMin: string;
  mvMax: string;
  sort: LibrarySort;
}

export const noLibraryFilters: LibraryFilters = {
  find: "",
  source: "",
  set: "",
  rarity: [],
  finish: [],
  colours: [],
  colourMatch: "any",
  type: "",
  mvMin: "",
  mvMax: "",
  sort: "name",
};

export const LIBRARY_RARITIES = [
  "common",
  "uncommon",
  "rare",
  "mythic",
  "special",
  "bonus",
] as const;
export const LIBRARY_FINISHES: LibraryFinish[] = ["nonfoil", "foil", "etched"];
export const LIBRARY_COLOURS = ["W", "U", "B", "R", "G", "C"] as const;

export const librarySortNames: Record<LibrarySort, string> = {
  name: "Name",
  mana_value: "Mana value",
  newest: "Newest edition",
  rarity: "Rarity, rarest first",
  copies: "Most copies",
};

/** How many filters are set beyond the plain ones (find and source), for the Filters button. */
export function filtersSet(filters: LibraryFilters): number {
  return [
    filters.set !== "",
    filters.rarity.length > 0,
    filters.finish.length > 0,
    filters.colours.length > 0,
    filters.type.trim() !== "",
    filters.mvMin !== "" || filters.mvMax !== "",
  ].filter(Boolean).length;
}

type Item = LibraryCard;

/** The copies of each finish an item holds; an item from before finishes, all nonfoil. */
function finishesOf(item: Item): FinishCounts {
  const known = item.finishes as Partial<FinishCounts> | undefined;
  if (!known || (!known.nonfoil && !known.foil && !known.etched))
    return { nonfoil: item.copies ?? 0, foil: 0, etched: 0 };
  return {
    nonfoil: known.nonfoil ?? 0,
    foil: known.foil ?? 0,
    etched: known.etched ?? 0,
  };
}

function colourMatches(
  colours: string[],
  wanted: string[],
  match: ColourMatch,
): boolean {
  if (wanted.length === 0) return true;
  const colourless = colours.length === 0;
  const pips = wanted.filter((colour) => colour !== "C");
  if (match === "any")
    return (
      (wanted.includes("C") && colourless) ||
      pips.some((colour) => colours.includes(colour))
    );
  if (wanted.includes("C"))
    // Colourless with colours asked for together matches nothing but colourless cards.
    return colourless && pips.length === 0;
  if (match === "all") return pips.every((colour) => colours.includes(colour));
  return (
    colours.length === pips.length &&
    pips.every((colour) => colours.includes(colour))
  );
}

function number(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const rarityRank: Record<string, number> = {
  bonus: 0,
  special: 1,
  mythic: 2,
  rare: 3,
  uncommon: 4,
  common: 5,
};

/** The library's items the filters keep, in the order asked for. */
export function filterLibrary<T extends Item>(
  items: T[],
  filters: LibraryFilters,
): T[] {
  const words = filters.find.trim().toLowerCase();
  const typeWords = filters.type
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const set = filters.set.toLowerCase();
  const low = number(filters.mvMin);
  const high = number(filters.mvMax);
  const kept = items.filter((item) => {
    const card = item.card;
    const type = card.type_line.toLowerCase();
    if (filters.source && !item.sources.includes(filters.source)) return false;
    if (
      words &&
      !card.name.toLowerCase().includes(words) &&
      !type.includes(words) &&
      !item.edition.set_name.toLowerCase().includes(words) &&
      item.edition.set_code.toLowerCase() !== words
    )
      return false;
    if (set && item.edition.set_code.toLowerCase() !== set) return false;
    if (filters.rarity.length && !filters.rarity.includes(item.edition.rarity))
      return false;
    if (filters.finish.length) {
      const held = finishesOf(item);
      if (!filters.finish.some((finish) => held[finish] > 0)) return false;
    }
    if (!colourMatches(card.colors, filters.colours, filters.colourMatch))
      return false;
    if (typeWords.length && !typeWords.every((word) => type.includes(word)))
      return false;
    if (low !== null && card.mana_value < low) return false;
    if (high !== null && card.mana_value > high) return false;
    return true;
  });
  if (filters.sort === "name") return kept;
  const byName = (a: T, b: T) =>
    a.card.name.localeCompare(b.card.name, undefined, { sensitivity: "base" });
  const released = (item: T) => item.edition.released_at ?? "";
  const order: Record<Exclude<LibrarySort, "name">, (a: T, b: T) => number> = {
    mana_value: (a, b) => a.card.mana_value - b.card.mana_value || byName(a, b),
    newest: (a, b) => released(b).localeCompare(released(a)) || byName(a, b),
    rarity: (a, b) =>
      (rarityRank[a.edition.rarity] ?? 9) -
        (rarityRank[b.edition.rarity] ?? 9) || byName(a, b),
    copies: (a, b) => (b.copies ?? 0) - (a.copies ?? 0) || byName(a, b),
  };
  return kept.slice().sort(order[filters.sort]);
}

/** The sets the library holds, by name, for the set filter. */
export function librarySets(
  items: Pick<LibraryCard, "edition">[],
): { code: string; name: string }[] {
  const found = new Map<string, string>();
  for (const item of items)
    found.set(item.edition.set_code.toLowerCase(), item.edition.set_name);
  return [...found.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
