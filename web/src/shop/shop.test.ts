import { describe, expect, it } from "vitest";
import { card, eras, product, products } from "./fixtures";
import {
  byEra,
  describeCard,
  filtered,
  glowOf,
  kindsOf,
  matches,
  noFilters,
  purchaseKey,
  tokens,
  yearsOf,
} from "./shop";

describe("the shop's helpers", () => {
  it("says prices in tokens", () => {
    expect(tokens(150_000)).toBe("150,000 tokens");
    expect(tokens(1)).toBe("1 token");
  });

  it("searches by set name, set code or product name", () => {
    expect(matches(product(), "zen")).toBe(true);
    expect(matches(product(), "ZNR")).toBe(true);
    expect(matches(product(), "rising draft")).toBe(true);
    expect(matches(product(), "revised")).toBe(false);
    expect(matches(product(), "  ")).toBe(true);
  });

  it("filters by year and type, and sorts by date or price", () => {
    const names = (sort: typeof noFilters.sort, extra = {}) =>
      filtered(products, { ...noFilters, sort, ...extra }).map(
        (item) => item.set_code,
      );
    expect(names("newest")).toEqual(["FRA", "ZNR", "3ED"]);
    expect(names("oldest")).toEqual(["3ED", "ZNR", "FRA"]);
    expect(names("cheapest")).toEqual(["ZNR", "FRA", "3ED"]);
    expect(names("dearest")).toEqual(["3ED", "FRA", "ZNR"]);
    expect(names("newest", { year: "2020" })).toEqual(["ZNR"]);
    expect(names("newest", { kind: "booster" })).toEqual(["3ED"]);
    expect(yearsOf(products)).toEqual([2026, 2020, 1994]);
    expect(kindsOf(products)).toEqual(["booster", "draft", "play"]);
  });

  it("groups by era in the eras' order, or not at all when sorted by price", () => {
    const groups = byEra(products, eras, "newest");
    expect(groups.map((group) => group.era?.id)).toEqual([
      "play",
      "collector",
      "first",
    ]);
    expect(
      byEra(products, eras, "oldest").map((group) => group.era?.id),
    ).toEqual(["first", "collector", "play"]);
    const flat = byEra(products, eras, "cheapest");
    expect(flat).toHaveLength(1);
    expect(flat[0].era).toBeNull();
    expect(byEra([], eras, "dearest")).toEqual([]);
  });

  it("announces cards and picks their glow", () => {
    expect(
      describeCard(card(1, { name: "Gisela", rarity: "mythic", new: true })),
    ).toBe("Mythic rare, Gisela, new to your library");
    expect(describeCard(card(2, { finish: "etched" }))).toBe(
      "Common, Common Card 2, etched foil",
    );
    expect(glowOf(card(1, { rarity: "rare" }))).toBe("rare");
    expect(glowOf(card(1, { rarity: "mythic" }))).toBe("mythic");
    expect(glowOf(card(1))).toBeNull();
  });

  it("makes a fresh purchase key each time", () => {
    const first = purchaseKey();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(purchaseKey()).not.toBe(first);
  });
});
