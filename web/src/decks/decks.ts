import type { components } from "../generated/api";
import type { CardSummary } from "../catalog/catalog";

export type DeckSummary = components["schemas"]["DeckSummary"];
export type DeckDetail = components["schemas"]["DeckDetail"];
export type DeckEntry = components["schemas"]["DeckEntry"];
export type Validation = components["schemas"]["Validation"];
export type Problem = components["schemas"]["Problem"];
export type ImportPreview = components["schemas"]["ImportPreview"];
export type ImportLine = components["schemas"]["ImportLine"];
export type GuidedResult = components["schemas"]["GuidedResult"];
export type GuidedRequest = components["schemas"]["GuidedRequest"];
export type StarterDeck = components["schemas"]["StarterDeck"];
export type SharedDeck = components["schemas"]["SharedDeck"];
export type RevisionSummary = components["schemas"]["RevisionSummary"];
export type Location = DeckEntry["location"];
export type DeckFormat = DeckSummary["format"];
/** A table option a deck may need by its cards' legality (v0.4.5). */
export type TableOption = Validation["needs"][number];

export const locationNames: Record<Location, string> = {
  commander: "Commander",
  companion: "Companion",
  main: "Main deck",
  sideboard: "Sideboard",
  maybeboard: "Maybeboard",
};

export function locationsFor(format: DeckFormat): Location[] {
  return format === "commander"
    ? ["commander", "companion", "main", "maybeboard"]
    : ["main", "sideboard", "companion", "maybeboard"];
}

/** Card types in the order a list shows them; a card goes under the first it has. */
export const typeOrder = [
  "Creature",
  "Planeswalker",
  "Battle",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Land",
] as const;

export function frontTypes(card: CardSummary): string[] {
  const front = card.type_line.split(" // ")[0] ?? "";
  const left = front.split(/ [—-] /)[0] ?? "";
  return left.split(" ");
}

export function typeGroup(card: CardSummary): string {
  const types = frontTypes(card);
  return typeOrder.find((type) => types.includes(type)) ?? "Other";
}

export function isLand(card: CardSummary): boolean {
  return frontTypes(card).includes("Land");
}

/** Whether the deck holds more copies of a card than the player's library does (DECK08, since
 * v0.3.1): saved, and perhaps legal, but kept from games until fixed. */
export function collectionLocked(
  validation: Pick<Validation, "errors">,
): boolean {
  return validation.errors.some(
    (problem) => problem.kind === "collection_locked",
  );
}

/** A deck entry's card and edition, as the editor tells its rows apart. */
export function entryKey(
  entry: Pick<DeckEntry, "card_id" | "printing_id">,
): string {
  return `${entry.card_id}|${entry.printing_id ?? ""}`;
}

/** Why the player's library holds an entry back (v0.5.0): too few copies of the card, or of the
 * edition it names. */
export type Shortage = "card" | "edition";

/**
 * The entries the player's library holds back, counted as the server counts them: every location
 * but the maybeboard. A card the library does not limit (a basic land, or any card for an account
 * that builds from the whole catalog) is never among them. Since v0.5.0 the library holds cards by
 * edition: with enough copies of the card, an entry naming an edition is held back when the deck
 * holds more of that edition than the library does, and one naming none when the editions the
 * deck leaves over are too few. Keyed by entryKey. The server's validation stays the authority;
 * this only marks the deck's rows.
 */
export function beyondLibrary(
  entries: DeckEntry[],
  cards: Record<string, CardSummary>,
): Map<string, Shortage> {
  const playing = entries.filter((entry) => entry.location !== "maybeboard");
  const held = new Map<string, number>();
  const named = new Map<string, number>();
  const unnamed = new Map<string, number>();
  for (const entry of playing) {
    held.set(entry.card_id, (held.get(entry.card_id) ?? 0) + entry.quantity);
    if (entry.printing_id)
      named.set(
        entryKey(entry),
        (named.get(entryKey(entry)) ?? 0) + entry.quantity,
      );
    else
      unnamed.set(
        entry.card_id,
        (unnamed.get(entry.card_id) ?? 0) + entry.quantity,
      );
  }
  const found = new Map<string, Shortage>();
  for (const entry of playing) {
    const card = cards[entry.card_id];
    const owned = card?.owned;
    if (!card || owned === null || owned === undefined) continue;
    if ((held.get(entry.card_id) ?? 0) > owned) {
      found.set(entryKey(entry), "card");
      continue;
    }
    if (!card.editions) continue;
    const copies = (printing: string) =>
      card.editions?.find((edition) => edition.printing_id === printing)
        ?.copies ?? 0;
    if (entry.printing_id) {
      if ((named.get(entryKey(entry)) ?? 0) > copies(entry.printing_id))
        found.set(entryKey(entry), "edition");
      continue;
    }
    const spare = card.editions.reduce(
      (sum, edition) =>
        sum +
        Math.max(
          0,
          edition.copies -
            (named.get(
              entryKey({
                card_id: entry.card_id,
                printing_id: edition.printing_id,
              }),
            ) ?? 0),
        ),
      0,
    );
    if ((unnamed.get(entry.card_id) ?? 0) > spare)
      found.set(entryKey(entry), "edition");
  }
  return found;
}

/**
 * The edition a copy added to the deck takes (v0.5.0): of the editions the player's library holds,
 * the first (the most copies) the deck leaves a copy of, outside the maybeboard. Null when the
 * library does not limit the card, or the deck holds every copy already: the server's save gives
 * it one if it can, and says so if it cannot.
 */
export function editionFor(
  card: Pick<CardSummary, "id" | "editions">,
  entries: DeckEntry[],
): string | null {
  if (!card.editions) return null;
  const used = new Map<string, number>();
  for (const entry of entries)
    if (
      entry.card_id === card.id &&
      entry.printing_id &&
      entry.location !== "maybeboard"
    )
      used.set(
        entry.printing_id,
        (used.get(entry.printing_id) ?? 0) + entry.quantity,
      );
  return (
    card.editions.find(
      (edition) => edition.copies > (used.get(edition.printing_id) ?? 0),
    )?.printing_id ?? null
  );
}

/** One entry per card, printing and location; quantities added. */
export function merge(entries: DeckEntry[]): DeckEntry[] {
  const totals = new Map<string, DeckEntry>();
  for (const entry of entries) {
    const key = `${entry.card_id}|${entry.printing_id ?? ""}|${entry.location}`;
    const found = totals.get(key);
    totals.set(
      key,
      found
        ? { ...found, quantity: Math.min(250, found.quantity + entry.quantity) }
        : { ...entry },
    );
  }
  return [...totals.values()];
}

export type Stats = {
  counts: Record<Location, number>;
  curve: number[];
  lands: number;
  types: Record<string, number>;
  sources: Record<string, number>;
  demand: Record<string, number>;
  averageValue: number;
};

const COLORS = ["W", "U", "B", "R", "G"] as const;

/** Statistics of the cards that start in the library: the main deck, and the commanders. */
export function stats(
  entries: DeckEntry[],
  cards: Record<string, CardSummary>,
): Stats {
  const counts: Record<Location, number> = {
    commander: 0,
    companion: 0,
    main: 0,
    sideboard: 0,
    maybeboard: 0,
  };
  const curve = Array.from({ length: 8 }, () => 0);
  const types: Record<string, number> = {};
  const sources: Record<string, number> = {
    W: 0,
    U: 0,
    B: 0,
    R: 0,
    G: 0,
    C: 0,
  };
  const demand: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let lands = 0;
  let spells = 0;
  let values = 0;
  for (const entry of entries) {
    counts[entry.location] += entry.quantity;
    const card = cards[entry.card_id];
    if (!card || (entry.location !== "main" && entry.location !== "commander"))
      continue;
    const group = typeGroup(card);
    types[group] = (types[group] ?? 0) + entry.quantity;
    if (isLand(card)) {
      lands += entry.quantity;
      for (const color of card.produced_mana) {
        if (color in sources)
          sources[color] = (sources[color] ?? 0) + entry.quantity;
      }
      continue;
    }
    spells += entry.quantity;
    values += card.mana_value * entry.quantity;
    curve[Math.min(7, Math.floor(card.mana_value))]! += entry.quantity;
    const cost = (card.mana_cost ?? "").toUpperCase();
    for (const color of COLORS) {
      const symbols = cost.match(new RegExp(`\\{[^}]*${color}[^}]*\\}`, "g"));
      if (symbols)
        demand[color] = (demand[color] ?? 0) + symbols.length * entry.quantity;
    }
  }
  return {
    counts,
    curve,
    lands,
    types,
    sources,
    demand,
    averageValue: spells ? values / spells : 0,
  };
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/** The chance of exactly k successes in a hand drawn from a deck (hypergeometric). */
export function exactly(
  deck: number,
  successes: number,
  hand: number,
  k: number,
): number {
  const total = choose(deck, hand);
  return total === 0
    ? 0
    : (choose(successes, k) * choose(deck - successes, hand - k)) / total;
}

export function atLeast(
  deck: number,
  successes: number,
  hand: number,
  k: number,
): number {
  let sum = 0;
  for (let i = k; i <= Math.min(hand, successes); i++)
    sum += exactly(deck, successes, hand, i);
  return sum;
}

/** A sample opening hand from the library, shuffled with the given random source. */
export function sampleHand(
  entries: DeckEntry[],
  size = 7,
  random: () => number = Math.random,
): string[] {
  const library: string[] = [];
  for (const entry of entries)
    if (entry.location === "main")
      for (let i = 0; i < entry.quantity; i++) library.push(entry.card_id);
  for (let i = library.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [library[i], library[j]] = [library[j]!, library[i]!];
  }
  return library.slice(0, size);
}

/** Entries that differ between two drafts, by card, printing and location. */
export function differences(
  mine: DeckEntry[],
  theirs: DeckEntry[],
): { key: string; entry: DeckEntry; mine: number; theirs: number }[] {
  const keyed = (list: DeckEntry[]) =>
    new Map(
      merge(list).map((entry) => [
        `${entry.card_id}|${entry.printing_id ?? ""}|${entry.location}`,
        entry,
      ]),
    );
  const a = keyed(mine);
  const b = keyed(theirs);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const found = [];
  for (const key of keys) {
    const left = a.get(key)?.quantity ?? 0;
    const right = b.get(key)?.quantity ?? 0;
    if (left !== right)
      found.push({
        key,
        entry: (a.get(key) ?? b.get(key))!,
        mine: left,
        theirs: right,
      });
  }
  return found;
}

/** Each card at the larger of the two drafts' counts. */
export function combine(mine: DeckEntry[], theirs: DeckEntry[]): DeckEntry[] {
  const keyed = new Map<string, DeckEntry>();
  for (const entry of [...merge(mine), ...merge(theirs)]) {
    const key = `${entry.card_id}|${entry.printing_id ?? ""}|${entry.location}`;
    const found = keyed.get(key);
    if (!found || found.quantity < entry.quantity) keyed.set(key, entry);
  }
  return [...keyed.values()];
}
