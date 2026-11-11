import { describe, expect, it } from "vitest";
import {
  DEFAULT_KINGS_TABLE,
  PRACTICE_KINGS_TABLE,
  kingsAttackWords,
  kingsGuarded,
  settingsLine,
  settingsSentence,
  settingsTags,
} from "./kingsTable";
import { MAX_TURN_LIMIT, defaultTurnLimit } from "./tables";

// The house rule and its guard as the lobby, a table and the game's menu say them (v0.9.7), and
// the turn limit a table shows before the API names it.

describe("King's Table's house rule and its guard (v0.9.7)", () => {
  const guarded = {
    ...DEFAULT_KINGS_TABLE,
    king_attacks_anyone: true,
    guarded_kings: true,
  };

  it("holds the guard only with the house rule it belongs to", () => {
    expect(kingsGuarded(DEFAULT_KINGS_TABLE)).toBe(false);
    expect(kingsGuarded(PRACTICE_KINGS_TABLE)).toBe(false);
    expect(kingsGuarded(guarded)).toBe(true);
    expect(kingsGuarded({ ...guarded, king_attacks_anyone: false })).toBe(
      false,
    );
    // An engine before v0.9.7 names no guard in a game's settings: the guard is off.
    expect(kingsGuarded({ king_attacks_anyone: true })).toBe(false);
  });

  it("says whom a King may attack", () => {
    expect(kingsAttackWords(DEFAULT_KINGS_TABLE)).toBe(
      "A King attacks only an opponent beside them and in range, as a General does",
    );
    expect(kingsAttackWords(PRACTICE_KINGS_TABLE)).toBe(
      "A King's creatures may attack any opponent, the other King included",
    );
    expect(kingsAttackWords(guarded)).toBe(
      "A King's creatures may attack any opposing General, and the other King once one of that King's Generals is defeated",
    );
  });

  it("tags the guard beside the house rule, in the lobby and in the game's menu", () => {
    expect(settingsTags(DEFAULT_KINGS_TABLE)).toEqual([
      "Commander decks",
      "Everyone 40",
      "King can attack anyone: off",
    ]);
    expect(settingsTags(guarded)).toEqual([
      "Commander decks",
      "Everyone 40",
      "King can attack anyone: on",
      "Generals guard their King",
    ]);
    expect(settingsLine(guarded)).toBe(
      "Commander decks · Everyone 40 · King can attack anyone: on · Generals guard their King",
    );
    // The engine's echo of a game from before v0.9.7 reads as it always did.
    expect(
      settingsLine({
        deck_format: "legacy",
        life: "all_20",
        king_attacks_anyone: true,
      }),
    ).toBe("Legacy decks · Everyone 20 · King can attack anyone: on");
  });

  it("says the settings in sentences", () => {
    expect(settingsSentence(DEFAULT_KINGS_TABLE)).toBe(
      "Commander decks for all six players (100 cards with a commander, singleton; every player has a commander, Generals too). Every player starts at 40 life. House rule off: a King attacks only an opponent beside them and in range, as a General does.",
    );
    expect(settingsSentence(PRACTICE_KINGS_TABLE)).toMatch(
      /House rule on: a King's creatures may attack any opponent, the other King included; spells and abilities still keep to range\.$/,
    );
    expect(settingsSentence(guarded)).toMatch(
      /House rule on, Generals guarding their King: a King's creatures may attack any opposing General, and the other King once one of that King's Generals is defeated; spells and abilities still keep to range\.$/,
    );
  });
});

describe("a game's turn limit (v0.9.7)", () => {
  it("is 40 turns for each player unless someone names one", () => {
    expect(defaultTurnLimit("legacy", 1)).toBe(80);
    expect(defaultTurnLimit("commander", 1)).toBe(80);
    expect(defaultTurnLimit("commander", 2)).toBe(120);
    expect(defaultTurnLimit("commander", 3)).toBe(160);
    expect(defaultTurnLimit("kings_table", 5)).toBe(240);
    // Two-Headed Giant's teams take their turns together: 80 turns are 40 for each player.
    expect(defaultTurnLimit("two_headed_giant", 3)).toBe(80);
    expect(MAX_TURN_LIMIT).toBeGreaterThanOrEqual(240);
  });
});
