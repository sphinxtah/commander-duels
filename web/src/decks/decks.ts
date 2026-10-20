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
