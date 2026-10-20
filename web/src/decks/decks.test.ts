import { describe, expect, it } from "vitest";
import {
  atLeast,
  combine,
  differences,
  exactly,
  locationsFor,
  merge,
  sampleHand,
  stats,
  typeGroup,
} from "./decks";
import { card, entry } from "./fixtures";

const bolt = card("Lightning Bolt", {
  mana_cost: "{R}",
  type_line: "Instant",
  colors: ["R"],
});
const hybrid = card("Boros Recruit", {
  mana_cost: "{R/W}",
  type_line: "Creature — Goblin Soldier",
  colors: ["R", "W"],
});
const giant = card("Big Giant", {
  mana_cost: "{7}{R}{R}",
  mana_value: 9,
  type_line: "Creature — Giant",
});
const mountain = card("Mountain", {
  mana_cost: null,
  mana_value: 0,
  type_line: "Basic Land — Mountain",
  produced_mana: ["R"],
});
const dryad = card("Dryad Arbor", {
  mana_cost: null,
  mana_value: 0,
  type_line: "Land Creature — Forest Dryad",
  produced_mana: ["G"],
});
const cards = Object.fromEntries(
  [bolt, hybrid, giant, mountain, dryad].map((item) => [item.id, item]),
);

describe("deck statistics", () => {
  it("counts the main deck's curve, types, colored sources and demand", () => {
    const result = stats(
      [
        entry(bolt, 4),
        entry(hybrid, 2),
        entry(giant, 1),
        entry(mountain, 20),
        entry(dryad, 1),
        entry(bolt, 3, "sideboard"),
      ],
      cards,
    );
    expect(result.counts.main).toBe(28);
    expect(result.counts.sideboard).toBe(3);
    // Mana value 9 lands in the last column, "7 or more".
    expect(result.curve).toEqual([0, 6, 0, 0, 0, 0, 0, 1]);
    expect(result.lands).toBe(21);
    // Dryad Arbor is a creature for the type count and a land for the mana count.
    expect(result.types).toEqual({ Instant: 4, Creature: 4, Land: 20 });
    expect(result.sources).toMatchObject({ R: 20, G: 1, W: 0 });
    // A hybrid symbol asks for either color; the giant's two red symbols count twice.
    expect(result.demand).toMatchObject({ R: 8, W: 2 });
    expect(result.averageValue).toBeCloseTo((4 + 2 + 9) / 7);
  });

  it("groups a card by its first matching type, lands last", () => {
    expect(typeGroup(dryad)).toBe("Creature");
    expect(typeGroup(mountain)).toBe("Land");
    expect(
      typeGroup(card("Fire // Ice", { type_line: "Instant // Instant" })),
    ).toBe("Instant");
  });

  it("offers each format's locations", () => {
    expect(locationsFor("commander")).toContain("commander");
    expect(locationsFor("legacy")).not.toContain("commander");
  });
});

describe("opening hand chances", () => {
  it("matches the hypergeometric distribution", () => {
    expect(exactly(60, 24, 7, 0)).toBeCloseTo(0.0216145, 6);
    expect(atLeast(60, 24, 7, 1)).toBeCloseTo(0.9783855, 6);
    expect(atLeast(60, 17, 7, 2)).toBeCloseTo(0.6482097, 6);
    expect(atLeast(60, 17, 7, 0)).toBeCloseTo(1, 10);
    expect(exactly(5, 2, 7, 1)).toBe(0);
  });

  it("deals a hand from the main deck only", () => {
    const hand = sampleHand(
      [entry(bolt, 4), entry(mountain, 3), entry(giant, 5, "sideboard")],
      7,
      () => 0.5,
    );
    expect(hand).toHaveLength(7);
    expect(hand.filter((id) => id === bolt.id)).toHaveLength(4);
    expect(hand).not.toContain(giant.id);
  });
});

describe("merging and conflicts", () => {
  it("adds up the same card in the same place, capped at 250", () => {
    expect(
      merge([entry(mountain, 200), entry(mountain, 100), entry(bolt, 1)]),
    ).toEqual([entry(mountain, 250), entry(bolt, 1)]);
    expect(merge([entry(bolt, 1), entry(bolt, 1, "sideboard")])).toHaveLength(
      2,
    );
  });

  it("lists the differences between two drafts and combines them", () => {
    const mine = [entry(bolt, 4), entry(mountain, 18)];
    const theirs = [entry(bolt, 2), entry(mountain, 18), entry(giant, 1)];
    expect(
      differences(mine, theirs).map(({ entry: item, mine, theirs }) => [
        item.card_id,
        mine,
        theirs,
      ]),
    ).toEqual([
      [bolt.id, 4, 2],
      [giant.id, 0, 1],
    ]);
    expect(combine(mine, theirs)).toEqual([
      entry(bolt, 4),
      entry(mountain, 18),
      entry(giant, 1),
    ]);
  });
});
