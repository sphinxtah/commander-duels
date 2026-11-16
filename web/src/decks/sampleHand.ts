import type { CardSummary } from "../catalog/catalog";
import type { DeckEntry } from "./decks";

// Sample hands (v1.0.0, the owner's decision of 2026-11-16): a deck's opening hands drawn on
// its Workshop page, with no game. The library is shuffled here, in the browser; nothing is
// asked of the server and nothing is kept. Mulligans are the game's own: a new seven each
// time, then one card to the bottom for each mulligan taken, the first one free in a game of
// three or more players (engine/GameFormat.java).

export interface HandCard {
  /** One copy: the card and which copy of it. */
  key: string;
  cardId: string;
  name: string;
  typeLine: string;
}

export interface Sample {
  hand: HandCard[];
  library: HandCard[];
  /** Mulligans taken so far. */
  mulligans: number;
  /** Cards still to put on the bottom for them. */
  owed: number;
  /** Cards drawn after the opening hand. */
  drawn: number;
}

export const HAND_SIZE = 7;

/** The cards a game would shuffle: every copy in the main deck. A commander starts in the
 * command zone, and the sideboard, the companion and the maybeboard stay out. */
export function libraryOf(
  entries: DeckEntry[],
  cards: Record<string, CardSummary | undefined>,
): HandCard[] {
  return entries
    .filter((entry) => entry.location === "main")
    .flatMap((entry) =>
      Array.from({ length: entry.quantity }, (_, copy) => ({
        key: `${entry.card_id}:${entry.printing_id ?? ""}:${copy}`,
        cardId: entry.card_id,
        name: cards[entry.card_id]?.name ?? "A card",
        typeLine: cards[entry.card_id]?.type_line ?? "",
      })),
    );
}

/** A shuffled copy (Fisher-Yates). */
export function shuffled<T>(
  items: T[],
  random: () => number = Math.random,
): T[] {
  const deck = [...items];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** A new opening hand from the whole library. */
export function deal(
  library: HandCard[],
  random: () => number = Math.random,
  mulligans = 0,
  free = 0,
): Sample {
  const deck = shuffled(library, random);
  return {
    hand: deck.slice(0, HAND_SIZE),
    library: deck.slice(HAND_SIZE),
    mulligans,
    owed: Math.min(HAND_SIZE, Math.max(0, mulligans - free)),
    drawn: 0,
  };
}

/** A mulligan: the whole library shuffled again, seven drawn, and one more card owed to the
 * bottom than the last time (the first is free where `free` is 1). */
export function mulligan(
  sample: Sample,
  library: HandCard[],
  free: number,
  random: () => number = Math.random,
): Sample {
  return deal(library, random, sample.mulligans + 1, free);
}

/** Puts a card of the hand on the bottom of the library, while one is owed. */
export function bottom(sample: Sample, key: string): Sample {
  const card = sample.hand.find((found) => found.key === key);
  if (!card || sample.owed === 0) return sample;
  return {
    ...sample,
    hand: sample.hand.filter((found) => found.key !== key),
    library: [...sample.library, card],
    owed: sample.owed - 1,
  };
}

/** Draws the library's top card, once nothing is owed to the bottom. */
export function draw(sample: Sample): Sample {
  if (sample.owed > 0 || sample.library.length === 0) return sample;
  const [top, ...rest] = sample.library;
  return {
    ...sample,
    hand: [...sample.hand, top],
    library: rest,
    drawn: sample.drawn + 1,
  };
}

/** How many lands a hand holds, said under it. */
export function lands(hand: HandCard[]): number {
  return hand.filter((card) => /\bLand\b/.test(card.typeLine)).length;
}

/** The hand's state in a sentence. */
export function sampleWords(sample: Sample): string {
  const held = `${sample.hand.length} ${sample.hand.length === 1 ? "card" : "cards"}, ${lands(sample.hand)} of them lands`;
  if (sample.owed > 0)
    return `${held}. Choose ${sample.owed} to put on the bottom of your library.`;
  const taken =
    sample.mulligans === 0
      ? "No mulligan taken"
      : `${sample.mulligans} ${sample.mulligans === 1 ? "mulligan" : "mulligans"} taken`;
  const drawn =
    sample.drawn === 0
      ? ""
      : `, ${sample.drawn} ${sample.drawn === 1 ? "card" : "cards"} drawn since`;
  return `${held}. ${taken}${drawn}.`;
}
