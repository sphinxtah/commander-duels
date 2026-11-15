import { afterEach, describe, expect, it } from "vitest";
import {
  readLastSetup,
  sanitizeLastSetup,
  saveLastSetup,
  type LastSetup,
} from "./lastSetup";

const setup: LastSetup = {
  format: "kings_table",
  best_of: 1,
  rules: { banned: true, not_legal: false, stand_in: true },
  kings: {
    deck_format: "legacy",
    life: "generals_20_kings_40",
    king_attacks_anyone: true,
    guarded_kings: true,
  },
  seat: 4,
  deck: "own:deck-1",
  bots: 5,
  bot_decks: ["", "own:deck-2", "", "", ""],
  skill: 6,
  turn_cap: 90,
};

afterEach(() => localStorage.clear());

describe("the Play wizard's memory (v1.0.0)", () => {
  it("gives back what was saved, to the account that saved it", () => {
    expect(saveLastSetup("account-1", setup)).toBe(true);
    expect(readLastSetup("account-1")).toEqual(setup);
    expect(readLastSetup("account-2")).toBeNull();
  });

  it("drops what is not a setup, and mends what is one in part", () => {
    expect(sanitizeLastSetup(null)).toBeNull();
    expect(sanitizeLastSetup("legacy")).toBeNull();
    expect(sanitizeLastSetup({ format: "pauper" })).toBeNull();
    // A format alone: everything else is the table's default.
    expect(sanitizeLastSetup({ format: "legacy" })).toEqual({
      format: "legacy",
      best_of: 1,
      rules: { banned: false, not_legal: false, stand_in: false },
      kings: null,
      seat: 1,
      deck: "",
      bots: 1,
      bot_decks: [],
      skill: 4,
      turn_cap: null,
    });
    // Values out of range, or of another kind, are not kept.
    expect(
      sanitizeLastSetup({
        ...setup,
        best_of: 5,
        seat: 9,
        bots: 40,
        skill: 0,
        turn_cap: "many",
        deck: 7,
        bot_decks: ["own:deck-2", 3, "a", "b", "c", "d", "e"],
        kings: { ...setup.kings, life: "all_1000" },
      }),
    ).toMatchObject({
      best_of: 1,
      seat: 1,
      bots: 1,
      skill: 4,
      turn_cap: null,
      deck: "",
      bot_decks: ["own:deck-2", "", "a", "b", "c"],
      kings: null,
    });
  });

  it("reads nothing from text that is not JSON", () => {
    localStorage.setItem("cd.play.last.account-1", "{broken");
    expect(readLastSetup("account-1")).toBeNull();
  });
});
