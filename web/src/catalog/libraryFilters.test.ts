import { describe, expect, it } from "vitest";
import { card } from "../decks/fixtures";
import type { LibraryCard } from "./catalog";
import {
  filterLibrary,
  filtersSet,
  librarySets,
  noLibraryFilters,
  type LibraryFilters,
} from "./libraryFilters";

// My library's filters (v0.6.2): each one alone, then together, and the sorts.

function item(
  name: string,
  fields: {
    set?: [string, string];
    rarity?: string;
    colors?: string[];
    type?: string;
    mv?: number;
    copies?: number;
    finishes?: Partial<LibraryCard["finishes"]>;
    released?: string;
    sources?: LibraryCard["sources"];
  } = {},
): LibraryCard {
  const [code, setName] = fields.set ?? ["m10", "Magic 2010"];
  const copies = fields.copies ?? 1;
  return {
    card: card(name, {
      colors: fields.colors ?? [],
      type_line: fields.type ?? "Artifact",
      mana_value: fields.mv ?? 1,
    }),
    edition: {
      printing_id: `${name}-${code}`,
      set_code: code,
      set_name: setName,
      collector_number: "1",
      released_at: fields.released ?? "2009-07-17",
      rarity: fields.rarity ?? "common",
    },
    copies,
    sources: fields.sources ?? ["pack"],
    finishes: { nonfoil: copies, foil: 0, etched: 0, ...fields.finishes },
    sellable: 0,
  };
}

const bolt = item("Lightning Bolt", {
  set: ["lea", "Limited Edition Alpha"],
  rarity: "common",
  colors: ["R"],
  type: "Instant",
  mv: 1,
  copies: 4,
  released: "1993-08-05",
});
const signet = item("Arcane Signet", {
  rarity: "uncommon",
  mv: 2,
  finishes: { nonfoil: 0, foil: 1 },
  copies: 1,
  sources: ["starter"],
});
const teferi = item("Teferi, Temporal Archmage", {
  set: ["c16", "Commander 2016"],
  rarity: "mythic",
  colors: ["U"],
  type: "Legendary Planeswalker — Teferi",
  mv: 6,
  copies: 4,
  released: "2016-11-11",
  sources: ["alliance"],
});
const knight = item("Knight of the Reliquary", {
  rarity: "rare",
  colors: ["G", "W"],
  type: "Creature — Human Knight",
  mv: 3,
  finishes: { etched: 1 },
  copies: 2,
});
const all = [signet, knight, bolt, teferi];

function names(filters: Partial<LibraryFilters>): string[] {
  return filterLibrary(all, { ...noLibraryFilters, ...filters }).map(
    (found) => found.card.name,
  );
}

describe("My library's filters", () => {
  it("keeps everything, in the library's order, with none set", () => {
    expect(names({})).toEqual([
      "Arcane Signet",
      "Knight of the Reliquary",
      "Lightning Bolt",
      "Teferi, Temporal Archmage",
    ]);
    expect(filtersSet(noLibraryFilters)).toBe(0);
  });

  it("finds words in the name, the type or the set's name, and a set's code", () => {
    expect(names({ find: "bolt" })).toEqual(["Lightning Bolt"]);
    expect(names({ find: "planeswalker" })).toEqual([
      "Teferi, Temporal Archmage",
    ]);
    expect(names({ find: "alpha" })).toEqual(["Lightning Bolt"]);
    expect(names({ find: "C16" })).toEqual(["Teferi, Temporal Archmage"]);
  });

  it("filters by source, set, rarity, finish, type and mana value", () => {
    expect(names({ source: "alliance" })).toEqual([
      "Teferi, Temporal Archmage",
    ]);
    expect(names({ set: "m10" })).toEqual([
      "Arcane Signet",
      "Knight of the Reliquary",
    ]);
    expect(names({ rarity: ["rare", "mythic"] })).toEqual([
      "Knight of the Reliquary",
      "Teferi, Temporal Archmage",
    ]);
    expect(names({ finish: ["foil"] })).toEqual(["Arcane Signet"]);
    expect(names({ finish: ["foil", "etched"] })).toEqual([
      "Arcane Signet",
      "Knight of the Reliquary",
    ]);
    // Nonfoil: the editions with a nonfoil copy, not those held only in foil.
    expect(names({ finish: ["nonfoil"] })).not.toContain("Arcane Signet");
    // Every word of the type, in any order.
    expect(names({ type: "knight creature" })).toEqual([
      "Knight of the Reliquary",
    ]);
    expect(names({ mvMin: "2", mvMax: "3" })).toEqual([
      "Arcane Signet",
      "Knight of the Reliquary",
    ]);
    expect(names({ mvMin: "6" })).toEqual(["Teferi, Temporal Archmage"]);
    expect(
      filtersSet({
        ...noLibraryFilters,
        find: "x",
        source: "pack",
        rarity: ["rare"],
        mvMin: "1",
        mvMax: "2",
      }),
    ).toBe(2);
  });

  it("matches colours as any of them, all of them, or exactly them", () => {
    expect(names({ colours: ["W", "R"] })).toEqual([
      "Knight of the Reliquary",
      "Lightning Bolt",
    ]);
    expect(names({ colours: ["C"] })).toEqual(["Arcane Signet"]);
    expect(names({ colours: ["C", "U"] })).toEqual([
      "Arcane Signet",
      "Teferi, Temporal Archmage",
    ]);
    expect(names({ colours: ["W"], colourMatch: "all" })).toEqual([
      "Knight of the Reliquary",
    ]);
    expect(names({ colours: ["W"], colourMatch: "exactly" })).toEqual([]);
    expect(names({ colours: ["W", "G"], colourMatch: "exactly" })).toEqual([
      "Knight of the Reliquary",
    ]);
    expect(names({ colours: ["C"], colourMatch: "exactly" })).toEqual([
      "Arcane Signet",
    ]);
  });

  it("sorts by mana value, newest edition, rarity and copies", () => {
    expect(names({ sort: "mana_value" })).toEqual([
      "Lightning Bolt",
      "Arcane Signet",
      "Knight of the Reliquary",
      "Teferi, Temporal Archmage",
    ]);
    expect(names({ sort: "newest" })[0]).toBe("Teferi, Temporal Archmage");
    expect(names({ sort: "newest" })[3]).toBe("Lightning Bolt");
    expect(names({ sort: "rarity" })).toEqual([
      "Teferi, Temporal Archmage",
      "Knight of the Reliquary",
      "Arcane Signet",
      "Lightning Bolt",
    ]);
    expect(names({ sort: "copies" })).toEqual([
      "Lightning Bolt",
      "Teferi, Temporal Archmage",
      "Knight of the Reliquary",
      "Arcane Signet",
    ]);
  });

  it("lists the sets the library holds, by name", () => {
    expect(librarySets(all)).toEqual([
      { code: "c16", name: "Commander 2016" },
      { code: "lea", name: "Limited Edition Alpha" },
      { code: "m10", name: "Magic 2010" },
    ]);
  });
});
