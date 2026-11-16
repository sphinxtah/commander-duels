import type { components } from "../generated/api";
import type { DeckEntry, DeckSummary } from "./decks";

// The deck workshop (v1.0.0, docs/decks.md): what its screens share. The services are v0.9.12's
// (api/workshop.py): folders and tags with a batch organizer, a diff of two versions and a
// restore into the draft, results by deck and by version, the wishlist, what a deck lacks, and
// explained substitutes from the cards the library holds. Nothing here rates a deck.

export type Organize = components["schemas"]["Organize"];
export type DeckDiff = components["schemas"]["DeckDiff"];
export type DiffLine = components["schemas"]["DiffLine"];
export type Performance = components["schemas"]["Performance"];
export type DeckRecord = components["schemas"]["Record"];
export type Split = components["schemas"]["Split"];
export type VersionRecord = components["schemas"]["VersionRecord"];
export type Wishlist = components["schemas"]["Wishlist"];
export type Wish = components["schemas"]["Wish"];
export type Missing = components["schemas"]["Missing"];
export type MissingCard = components["schemas"]["MissingCard"];
export type Substitutions = components["schemas"]["Substitutions"];
export type Substitute = components["schemas"]["Substitute"];

/** The most tags a deck carries, and the longest folder's and tag's names (api/workshop.py). */
export const MAX_TAGS = 12;
export const FOLDER_LENGTH = 64;
export const TAG_LENGTH = 32;

// The Decks page's filters.

export type DeckSort = "changed" | "name" | "format";
export const SORTS: [DeckSort, string][] = [
  ["changed", "Last changed"],
  ["name", "Name"],
  ["format", "Format, then name"],
];

/** The folder choice that means the decks in no folder. */
export const UNFILED = "\u0000unfiled";

export type DeckFilters = {
  search: string;
  /** "" for every deck, UNFILED for those in no folder, else a folder's name. */
  folder: string;
  /** Every tag ticked must be on a deck. */
  tags: string[];
  sort: DeckSort;
};
export const NO_FILTERS: DeckFilters = {
  search: "",
  folder: "",
  tags: [],
  sort: "changed",
};

export type Shelf = { name: string; decks: number };

function counted(names: string[]): Shelf[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .map(([name, decks]) => ({ name, decks }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The folders the decks are kept in, by name, with how many each holds. */
export function foldersOf(decks: DeckSummary[]): Shelf[] {
  return counted(decks.flatMap((deck) => (deck.folder ? [deck.folder] : [])));
}

/** The tags on the decks, by name, with how many carry each. */
export function tagsOf(decks: DeckSummary[]): Shelf[] {
  return counted(decks.flatMap((deck) => deck.tags ?? []));
}

/** The decks the filters leave, in the order asked. A search looks in a deck's name, its
 * commanders, its folder and its tags. */
export function shownDecks(
  decks: DeckSummary[],
  filters: DeckFilters,
): DeckSummary[] {
  const words = filters.search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const found = decks.filter((deck) => {
    if (filters.folder === UNFILED && deck.folder) return false;
    if (
      filters.folder &&
      filters.folder !== UNFILED &&
      deck.folder !== filters.folder
    )
      return false;
    const tags = deck.tags ?? [];
    if (!filters.tags.every((tag) => tags.includes(tag))) return false;
    if (words.length === 0) return true;
    const text = [deck.title, ...deck.commanders, deck.folder ?? "", ...tags]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
  if (filters.sort === "changed") return found;
  return [...found].sort((a, b) =>
    filters.sort === "format" && a.format !== b.format
      ? a.format.localeCompare(b.format)
      : a.title.localeCompare(b.title),
  );
}

/** Whether any filter narrows the list. */
export function filtering(filters: DeckFilters): boolean {
  return (
    filters.search.trim() !== "" ||
    filters.folder !== "" ||
    filters.tags.length > 0
  );
}

// The batch organizer.

/** What the organizer's form holds before it is sent. */
export type OrganizeDraft = {
  /** The folder to move the decks into; "" leaves them where they are. */
  folder: string;
  unfile: boolean;
  /** Tags to add, as typed: separated by commas. */
  add: string;
  remove: string[];
};
export const NO_CHANGE: OrganizeDraft = {
  folder: "",
  unfile: false,
  add: "",
  remove: [],
};

/** The tags a line of typing names: trimmed, none twice whatever its case, none empty. */
export function typedTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim().replace(/\s+/g, " ").slice(0, TAG_LENGTH);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}

/** The request the organizer sends for the decks chosen; null while it would change nothing. */
export function organizeRequest(
  deckIds: string[],
  draft: OrganizeDraft,
): Organize | null {
  const folder = draft.unfile ? "" : draft.folder.trim();
  const add = typedTags(draft.add);
  if (
    deckIds.length === 0 ||
    (!folder && !draft.unfile && add.length === 0 && draft.remove.length === 0)
  )
    return null;
  return {
    deck_ids: deckIds,
    ...(folder ? { folder } : {}),
    unfile: draft.unfile,
    add_tags: add,
    remove_tags: draft.remove,
  };
}

function quoted(names: string[]): string {
  const said = names.map((name) => `“${name}”`);
  return said.length < 2
    ? (said[0] ?? "")
    : `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
}

/** What a request will change, a sentence each: said before it is sent. */
export function organizeWords(request: Organize): string[] {
  const words: string[] = [];
  if (request.unfile) words.push("Take them out of their folders.");
  else if (request.folder)
    words.push(`Move them into the folder “${request.folder}”.`);
  const add = request.add_tags ?? [];
  const remove = request.remove_tags ?? [];
  if (add.length)
    words.push(
      `Add the ${add.length === 1 ? "tag" : "tags"} ${quoted(add)} to each.`,
    );
  if (remove.length)
    words.push(
      `Remove the ${remove.length === 1 ? "tag" : "tags"} ${quoted(remove)} from each that has ${remove.length === 1 ? "it" : "them"}.`,
    );
  return words;
}

// Versions.

/** A side of a comparison: a saved version's number, or the draft. */
export type Side = "draft" | number;

export function sideWords(side: Side | string): string {
  return side === "draft" ? "The draft" : `Version ${side}`;
}

/** A diff's line as a change: copies added (positive) or removed (negative). */
export function lineChange(line: DiffLine): number {
  return line.after - line.before;
}

/** "3 copies added, 2 removed", or that the two are the same. */
export function diffWords(diff: Pick<DeckDiff, "added" | "removed" | "same">) {
  if (diff.same) return "The two hold the same cards in the same places.";
  const copies = (count: number) =>
    `${count} ${count === 1 ? "copy" : "copies"}`;
  return [
    diff.added ? `${copies(diff.added)} added` : "",
    diff.removed ? `${copies(diff.removed)} removed` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

// Performance.

/** The least games a record needs before it says much (SMALL_SAMPLE in api/workshop.py). */
export const SMALL_SAMPLE = 10;

/** "7 won, 4 lost, 1 drawn". */
export function recordWords(record: DeckRecord): string {
  return [
    `${record.wins} won`,
    `${record.losses} lost`,
    ...(record.draws ? [`${record.draws} drawn`] : []),
  ].join(", ");
}

/** A win rate in whole percent; a dash with no game. */
export function winRate(record: DeckRecord): string {
  return record.win_rate === null || record.win_rate === undefined
    ? "–"
    : `${Math.round(record.win_rate * 100)}%`;
}

/** The games' modes (api/modes.py), as a table says them. */
export const MODE_NAMES: Record<string, string> = {
  practice: "Practice",
  table: "Table",
  queue: "Quick match",
  campaign: "Campaign",
  sandbox: "Sandbox",
  borrowed: "Borrowed deck",
  league_practice: "League practice",
  league_match: "League match",
};

const FORMAT_NAMES: Record<string, string> = {
  legacy: "Legacy",
  commander: "Commander",
  two_headed_giant: "Two-Headed Giant",
  kings_table: "King's Table",
};

/** Who a split's games were played against, in words. */
export function oppositionWords(split: Split): string {
  const skill = split.bot_skill ? ` at skill ${split.bot_skill}` : "";
  return split.opposition === "bots"
    ? `Bots${skill}`
    : split.opposition === "players"
      ? "Players"
      : `Players and bots${skill}`;
}

export function splitFormat(split: Split): string {
  return FORMAT_NAMES[split.format] ?? split.format;
}

export function splitMode(split: Split): string {
  return MODE_NAMES[split.mode] ?? split.mode;
}

// Substitutes.

/**
 * A draft with a substitute swapped in: up to `copies` copies of the card the deck lacks give
 * way, where they are played, to the card the library holds. The maybeboard is not played and
 * is left alone. Answers the new entries and how many copies changed.
 */
export function swapped(
  entries: DeckEntry[],
  lacking: string,
  substitute: string,
  copies: number,
): { entries: DeckEntry[]; swapped: number } {
  let left = copies;
  const moved = new Map<DeckEntry["location"], number>();
  const kept: DeckEntry[] = [];
  for (const entry of entries) {
    if (
      entry.card_id !== lacking ||
      entry.location === "maybeboard" ||
      left === 0
    ) {
      kept.push(entry);
      continue;
    }
    const taken = Math.min(left, entry.quantity);
    left -= taken;
    moved.set(entry.location, (moved.get(entry.location) ?? 0) + taken);
    if (entry.quantity > taken)
      kept.push({ ...entry, quantity: entry.quantity - taken });
  }
  for (const [location, quantity] of moved) {
    // Copies naming no edition: the server gives them one the library holds.
    const own = kept.findIndex(
      (entry) =>
        entry.card_id === substitute &&
        entry.location === location &&
        !entry.printing_id &&
        !entry.choice,
    );
    if (own >= 0)
      kept[own] = { ...kept[own]!, quantity: kept[own]!.quantity + quantity };
    else kept.push({ card_id: substitute, location, quantity });
  }
  return { entries: kept, swapped: copies - left };
}
