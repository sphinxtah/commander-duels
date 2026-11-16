import { describe, expect, it } from "vitest";
import {
  bottom,
  deal,
  draw,
  lands,
  libraryOf,
  mulligan,
  sampleWords,
  shuffled,
} from "./sampleHand";

// Sample hands (v1.0.0): the library a game would shuffle, an opening seven, and the game's own
// mulligan: a new seven, then one card to the bottom for each mulligan taken.

const cards = {
  bolt: { name: "Lightning Bolt", type_line: "Instant" },
  mountain: { name: "Mountain", type_line: "Basic Land — Mountain" },
  chief: { name: "Krenko, Mob Boss", type_line: "Legendary Creature — Goblin" },
} as never;
const entries = [
  { card_id: "bolt", quantity: 4, location: "main" },
  { card_id: "mountain", quantity: 16, location: "main" },
  { card_id: "chief", quantity: 1, location: "commander" },
  { card_id: "bolt", quantity: 2, location: "sideboard" },
  { card_id: "mountain", quantity: 3, location: "maybeboard" },
] as never;

/** A chance that always takes the last card: a shuffle that changes nothing. */
const still = () => 0.999999;

describe("the library of a sample hand", () => {
  it("is every copy of the main deck, and nothing of the other places", () => {
    const library = libraryOf(entries, cards);
    expect(library).toHaveLength(20);
    expect(
      library.filter((card) => card.name === "Lightning Bolt"),
    ).toHaveLength(4);
    expect(library.some((card) => card.name === "Krenko, Mob Boss")).toBe(
      false,
    );
    expect(new Set(library.map((card) => card.key)).size).toBe(20);
  });

  it("is shuffled whole: the same cards in another order", () => {
    const library = libraryOf(entries, cards);
    let seed = 7;
    const chance = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const mixed = shuffled(library, chance);
    expect(mixed.map((card) => card.key)).not.toEqual(
      library.map((card) => card.key),
    );
    expect([...mixed].sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      [...library].sort((a, b) => a.key.localeCompare(b.key)),
    );
  });
});

describe("a sample hand", () => {
  const library = libraryOf(entries, cards);

  it("is seven cards, the rest the library, and is drawn from", () => {
    const sample = deal(library, still);
    expect(sample.hand).toHaveLength(7);
    expect(sample.library).toHaveLength(13);
    expect([sample.mulligans, sample.owed]).toEqual([0, 0]);
    expect(sampleWords(sample)).toBe(
      "7 cards, 3 of them lands. No mulligan taken.",
    );
    const drawn = draw(draw(sample));
    expect(drawn.hand).toHaveLength(9);
    expect(drawn.library).toHaveLength(11);
    expect(sampleWords(drawn)).toMatch(
      /No mulligan taken, 2 cards drawn since\.$/,
    );
  });

  it("owes a card to the bottom for each mulligan, the first free where three or more play", () => {
    const once = mulligan(deal(library, still), library, 0, still);
    expect([once.hand.length, once.mulligans, once.owed]).toEqual([7, 1, 1]);
    expect(sampleWords(once)).toBe(
      "7 cards, 3 of them lands. Choose 1 to put on the bottom of your library.",
    );
    // Nothing is drawn while a card is owed.
    expect(draw(once)).toBe(once);
    const kept = bottom(once, once.hand[0].key);
    expect(kept.hand).toHaveLength(6);
    expect(kept.library.at(-1)).toEqual(once.hand[0]);
    expect(kept.owed).toBe(0);
    expect(bottom(kept, kept.hand[0].key)).toBe(kept);
    expect(sampleWords(kept)).toMatch(
      /^6 cards, \d of them lands\. 1 mulligan taken\.$/,
    );

    const free = mulligan(deal(library, still), library, 1, still);
    expect([free.mulligans, free.owed]).toEqual([1, 0]);
    expect(mulligan(free, library, 1, still).owed).toBe(1);
  });

  it("counts the lands by their type", () => {
    expect(
      lands([
        {
          key: "a",
          cardId: "a",
          name: "Dryad Arbor",
          typeLine: "Land Creature — Forest Dryad",
        },
        {
          key: "b",
          cardId: "b",
          name: "Landfall Hawk",
          typeLine: "Creature — Bird",
        },
      ]),
    ).toBe(1);
  });
});
