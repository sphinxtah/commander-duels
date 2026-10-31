import { describe, expect, it } from "vitest";
import type { CardView } from "../types";
import {
  isBigCreature,
  isBigSpell,
  manaColours,
  manaValue,
  powerOf,
} from "./notable";

const card = (face: Partial<CardView>): CardView => ({
  id: "c1",
  hidden: false,
  name: "A card",
  mana_cost: null,
  type_line: null,
  power: null,
  toughness: null,
  rules: [],
  ...face,
});

describe("what makes a moment notable (v0.7.0)", () => {
  it("counts a mana value from the cost's symbols", () => {
    expect(manaValue("{3}{R}{R}")).toBe(5);
    expect(manaValue("{4}{R}{R}")).toBe(6);
    expect(manaValue("{X}{G}{G}")).toBe(2);
    expect(manaValue("{2/W}{2/W}")).toBe(4);
    expect(manaValue("{W/U}{B/P}")).toBe(2);
    expect(manaValue("{0}")).toBe(0);
    expect(manaValue(null)).toBe(0);
    expect(manaValue("")).toBe(0);
  });

  it("calls a spell of six or more mana big", () => {
    expect(isBigSpell(card({ mana_cost: "{4}{R}{R}" }))).toBe(true);
    expect(isBigSpell(card({ mana_cost: "{5}{G}" }))).toBe(true);
    expect(isBigSpell(card({ mana_cost: "{3}{R}{R}" }))).toBe(false);
    expect(isBigSpell(card({ mana_cost: null }))).toBe(false);
  });

  it("calls a creature of power five or more big, and never one with a * for power", () => {
    expect(powerOf(card({ power: "5" }))).toBe(5);
    expect(powerOf(card({ power: "*" }))).toBeNull();
    expect(powerOf(card({ power: null }))).toBeNull();
    expect(isBigCreature(card({ power: "5", toughness: "5" }))).toBe(true);
    expect(isBigCreature(card({ power: "4", toughness: "9" }))).toBe(false);
    expect(isBigCreature(card({ power: "*", toughness: "*" }))).toBe(false);
  });

  it("reads a cost's colours in WUBRG order, once each, hybrid included", () => {
    expect(manaColours("{4}{R}{R}")).toEqual(["R"]);
    expect(manaColours("{G}{W}{U}")).toEqual(["W", "U", "G"]);
    expect(manaColours("{2}{W/B}")).toEqual(["W", "B"]);
    expect(manaColours("{7}")).toEqual([]);
    expect(manaColours(null)).toEqual([]);
  });
});
