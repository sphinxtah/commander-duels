import { describe, expect, it } from "vitest";
import {
  atLeast,
  beyondLibrary,
  collectionLocked,
  combine,
  differences,
  editionFor,
  entryKey,
  exactly,
  locationsFor,
  merge,
  sampleHand,
  stats,
  typeGroup,
  type DeckEntry,
} from "./decks";
import { card, edition, entry, problem, validation } from "./fixtures";
import { needWords, verdict } from "./ProblemList";
import {
  casualRules,
  rulesSentence,
  rulesTag,
  tournamentRules,
} from "../tables/tables";

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

describe("the player's library", () => {
  it("knows a collection-locked validation", () => {
    expect(collectionLocked(validation({ errors: [problem()] }))).toBe(true);
    expect(
      collectionLocked(
        validation({
          errors: [problem({ kind: "not_implemented", code: "card.x" })],
        }),
      ),
    ).toBe(false);
  });

  it("marks the cards the deck holds more copies of than the library", () => {
    const owned = {
      [bolt.id]: { ...bolt, owned: 2 },
      [giant.id]: { ...giant, owned: 0 },
      [hybrid.id]: { ...hybrid, owned: 1 },
      // A basic land, and any card for an account without a library, say null.
      [mountain.id]: mountain,
    };
    expect(
      [
        ...beyondLibrary(
          [
            // Two in the main deck and one in the sideboard: three of two.
            entry(bolt, 2),
            entry(bolt, 1, "sideboard"),
            entry(giant, 1),
            // The maybeboard does not count.
            entry(hybrid, 1),
            entry(hybrid, 3, "maybeboard"),
            entry(mountain, 30),
          ],
          owned,
        ),
      ].sort(),
    ).toEqual(
      [
        [entryKey(entry(bolt, 1)), "card"],
        [entryKey(entry(giant, 1)), "card"],
      ].sort(),
    );
  });

  it("marks the editions the library holds too few of (v0.5.0)", () => {
    const revised = edition("p-revised", "Revised Edition", 2);
    const fourth = edition("p-fourth", "Fourth Edition", 1);
    const king = card("Goblin King", { owned: 3, editions: [revised, fourth] });
    const cards = { [king.id]: king };
    const named = (printing: string, quantity: number): DeckEntry => ({
      ...entry(king, quantity),
      printing_id: printing,
    });
    // Each edition within its copies, and a copy naming none in what they leave: nothing held.
    expect(
      beyondLibrary([named("p-revised", 2), entry(king, 1)], cards).size,
    ).toBe(0);
    // Three of an edition the library holds two of, though three copies in all.
    expect([
      ...beyondLibrary([named("p-revised", 3)], cards).entries(),
    ]).toEqual([["card-goblin-king|p-revised", "edition"]]);
    // More copies in all than the library holds: every row of the card.
    expect([
      ...beyondLibrary(
        [named("p-seventh", 1), named("p-revised", 2), named("p-fourth", 1)],
        cards,
      ).entries(),
    ]).toEqual([
      ["card-goblin-king|p-seventh", "card"],
      ["card-goblin-king|p-revised", "card"],
      ["card-goblin-king|p-fourth", "card"],
    ]);
    // An edition it does not hold, though the copies in all are enough.
    expect([
      ...beyondLibrary(
        [named("p-seventh", 1), named("p-revised", 1), entry(king, 1)],
        cards,
      ).entries(),
    ]).toEqual([["card-goblin-king|p-seventh", "edition"]]);
  });

  it("adds a copy in an edition the library holds and the deck leaves (v0.5.0)", () => {
    const revised = edition("p-revised", "Revised Edition", 2);
    const fourth = edition("p-fourth", "Fourth Edition", 1);
    const king = card("Goblin King", { owned: 3, editions: [revised, fourth] });
    const named = (printing: string, quantity: number): DeckEntry => ({
      ...entry(king, quantity),
      printing_id: printing,
    });
    expect(editionFor(king, [])).toBe("p-revised");
    expect(editionFor(king, [named("p-revised", 2)])).toBe("p-fourth");
    expect(
      editionFor(king, [named("p-revised", 2), named("p-fourth", 1)]),
    ).toBeNull();
    // The maybeboard holds no copies back; a card the library does not limit names none.
    expect(
      editionFor(king, [{ ...named("p-revised", 2), location: "maybeboard" }]),
    ).toBe("p-revised");
    expect(editionFor(bolt, [])).toBeNull();
  });

  it("says what keeps a deck from playing, the library apart from the engine", () => {
    expect(verdict(validation())).toEqual({
      state: "playable",
      words: "Ready to play: legal, and every card is playable here.",
    });
    // A card's legality says which tables take the deck (v0.4.5).
    expect(verdict(validation({ needs: ["banned"] }))).toEqual({
      state: "playable",
      words: "Ready to play at tables that allow banned cards.",
    });
    expect(verdict(validation({ needs: ["not_legal"] })).words).toBe(
      "Ready to play at tables that allow cards not legal in Legacy.",
    );
    // A card the game has no rules for yet plays as a stand-in at casual tables (v0.6.2).
    expect(verdict(validation({ needs: ["stand_in"] })).words).toBe(
      "Ready to play at tables that allow stand-ins. Cards the game has no rules for yet play as stand-ins, with their cost, types, power and toughness.",
    );
    expect(
      verdict(validation({ needs: ["banned", "not_legal", "stand_in"] }))
        .words,
    ).toMatch(
      /^Ready to play at casual tables, which allow banned cards, cards not legal in Legacy and stand-ins\./,
    );
    expect(needWords("stand_in", "legacy")).toBe("Plays stand-ins");
    expect(
      rulesTag({ banned: true, not_legal: false, stand_in: true }, "legacy"),
    ).toBe("Banned cards and stand-ins allowed");
    expect(rulesTag(casualRules, "commander")).toBe("Casual");
    expect(rulesTag(tournamentRules, "commander")).toBe("Tournament rules");
    expect(
      rulesSentence({ banned: true, not_legal: true, stand_in: false }, "legacy"),
    ).toBe(
      "Decks may hold banned cards and cards not legal in Legacy, but no stand-ins.",
    );
    expect(
      verdict(
        validation({ format: "commander", needs: ["banned", "not_legal"] }),
      ).words,
    ).toBe(
      "Ready to play at casual tables, which allow banned cards and cards not legal in Commander.",
    );
    expect(
      verdict(validation({ playable: false, errors: [problem()] })),
    ).toEqual({
      state: "locked",
      words:
        "Legal, but it needs cards you don't own: it cannot start a game until that is fixed.",
    });
    expect(
      verdict(
        validation({
          playable: false,
          errors: [
            problem(),
            problem({ kind: "not_implemented", code: "card.x" }),
          ],
        }),
      ).words,
    ).toBe(
      "Legal, but it needs cards you don't own, and some cards cannot be played here yet: it cannot start a game until that is fixed.",
    );
    expect(
      verdict(
        validation({
          playable: false,
          errors: [problem({ kind: "not_implemented", code: "card.x" })],
        }),
      ).state,
    ).toBe("legal");
    expect(
      verdict(
        validation({
          legal: false,
          playable: false,
          errors: [problem(), problem({ kind: "format_illegal", code: "x" })],
        }),
      ),
    ).toEqual({
      state: "draft",
      words: "2 problems to fix before this deck can play.",
    });
  });
});
