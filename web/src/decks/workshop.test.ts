import { describe, expect, it } from "vitest";
import type { DeckEntry, DeckSummary } from "./decks";
import {
  NO_CHANGE,
  NO_FILTERS,
  UNFILED,
  diffWords,
  filtering,
  foldersOf,
  lineChange,
  oppositionWords,
  organizeRequest,
  organizeWords,
  recordWords,
  shownDecks,
  sideWords,
  swapped,
  tagsOf,
  typedTags,
  winRate,
  type DeckRecord,
  type Split,
} from "./workshop";

// The deck workshop (v1.0.0): what its screens share.

function deck(fields: Partial<DeckSummary>): DeckSummary {
  return {
    id: "d1",
    title: "A deck",
    format: "commander",
    commanders: [],
    folder: null,
    tags: [],
    ...fields,
  } as DeckSummary;
}

const decks = [
  deck({
    id: "d1",
    title: "Zombie Horde",
    commanders: ["Gisa and Geralf"],
    folder: "Tribal",
    tags: ["budget", "graveyard"],
  }),
  deck({
    id: "d2",
    title: "Burn",
    format: "legacy",
    folder: "Tournament",
    tags: ["budget"],
  }),
  deck({ id: "d3", title: "Elves", folder: "Tribal" }),
  deck({ id: "d4", title: "Azorius Fliers" }),
];

describe("the Decks page's shelves", () => {
  it("counts the folders and the tags by name", () => {
    expect(foldersOf(decks)).toEqual([
      { name: "Tournament", decks: 1 },
      { name: "Tribal", decks: 2 },
    ]);
    expect(tagsOf(decks)).toEqual([
      { name: "budget", decks: 2 },
      { name: "graveyard", decks: 1 },
    ]);
  });

  it("narrows by folder, by every tag ticked, and by a search of names, commanders, folders and tags", () => {
    const titles = (filters: Partial<typeof NO_FILTERS>) =>
      shownDecks(decks, { ...NO_FILTERS, ...filters }).map((d) => d.title);
    expect(titles({})).toEqual([
      "Zombie Horde",
      "Burn",
      "Elves",
      "Azorius Fliers",
    ]);
    expect(titles({ folder: "Tribal" })).toEqual(["Zombie Horde", "Elves"]);
    expect(titles({ folder: UNFILED })).toEqual(["Azorius Fliers"]);
    expect(titles({ tags: ["budget"] })).toEqual(["Zombie Horde", "Burn"]);
    expect(titles({ tags: ["budget", "graveyard"] })).toEqual(["Zombie Horde"]);
    expect(titles({ search: "gisa" })).toEqual(["Zombie Horde"]);
    expect(titles({ search: "TRIBAL el" })).toEqual(["Elves"]);
    expect(titles({ search: "tournament" })).toEqual(["Burn"]);
    expect(titles({ search: "nothing" })).toEqual([]);
  });

  it("keeps the server's order unless another is asked", () => {
    const titles = (sort: (typeof NO_FILTERS)["sort"]) =>
      shownDecks(decks, { ...NO_FILTERS, sort }).map((d) => d.title);
    expect(titles("name")).toEqual([
      "Azorius Fliers",
      "Burn",
      "Elves",
      "Zombie Horde",
    ]);
    expect(titles("format")).toEqual([
      "Azorius Fliers",
      "Elves",
      "Zombie Horde",
      "Burn",
    ]);
  });

  it("knows whether a filter narrows the list; an order does not", () => {
    expect(filtering(NO_FILTERS)).toBe(false);
    expect(filtering({ ...NO_FILTERS, sort: "name" })).toBe(false);
    expect(filtering({ ...NO_FILTERS, search: " x " })).toBe(true);
    expect(filtering({ ...NO_FILTERS, folder: UNFILED })).toBe(true);
  });
});

describe("the organizer", () => {
  it("reads typed tags: trimmed, none empty, none twice whatever its case", () => {
    expect(
      typedTags(" budget, Tribal ,, budget , BUDGET,  two  words "),
    ).toEqual(["budget", "Tribal", "two words"]);
    expect(typedTags("x".repeat(40))).toEqual(["x".repeat(32)]);
  });

  it("asks for nothing until something would change", () => {
    expect(organizeRequest(["d1"], NO_CHANGE)).toBeNull();
    expect(organizeRequest([], { ...NO_CHANGE, folder: "Tribal" })).toBeNull();
    expect(organizeRequest(["d1"], { ...NO_CHANGE, add: " , " })).toBeNull();
  });

  it("makes one request for the decks chosen, and says what it will change", () => {
    const request = organizeRequest(["d1", "d2"], {
      folder: " Tribal ",
      unfile: false,
      add: "budget, fun",
      remove: ["old"],
    })!;
    expect(request).toEqual({
      deck_ids: ["d1", "d2"],
      folder: "Tribal",
      unfile: false,
      add_tags: ["budget", "fun"],
      remove_tags: ["old"],
    });
    expect(organizeWords(request)).toEqual([
      "Move them into the folder “Tribal”.",
      "Add the tags “budget” and “fun” to each.",
      "Remove the tag “old” from each that has it.",
    ]);
  });

  it("takes decks out of their folders instead of moving them", () => {
    const request = organizeRequest(["d1"], {
      ...NO_CHANGE,
      folder: "Ignored",
      unfile: true,
    })!;
    expect(request).toEqual({
      deck_ids: ["d1"],
      unfile: true,
      add_tags: [],
      remove_tags: [],
    });
    expect(organizeWords(request)).toEqual(["Take them out of their folders."]);
  });
});

describe("a comparison", () => {
  it("names its sides and says what differs in copies", () => {
    expect(sideWords("draft")).toBe("The draft");
    expect(sideWords(3)).toBe("Version 3");
    expect(sideWords("3")).toBe("Version 3");
    expect(diffWords({ added: 3, removed: 1, same: false })).toBe(
      "3 copies added, 1 copy removed",
    );
    expect(diffWords({ added: 0, removed: 2, same: false })).toBe(
      "2 copies removed",
    );
    expect(diffWords({ added: 0, removed: 0, same: true })).toBe(
      "The two hold the same cards in the same places.",
    );
    expect(
      lineChange({
        card_id: "c",
        name: "Bolt",
        location: "main",
        before: 4,
        after: 1,
      }),
    ).toBe(-3);
  });
});

describe("a record", () => {
  const record = (fields: Partial<DeckRecord>): DeckRecord => ({
    games: 12,
    wins: 7,
    losses: 4,
    draws: 1,
    win_rate: 7 / 12,
    small_sample: false,
    ...fields,
  });

  it("is said in games won, lost and drawn, with its rate in whole percent", () => {
    expect(recordWords(record({}))).toBe("7 won, 4 lost, 1 drawn");
    expect(recordWords(record({ draws: 0 }))).toBe("7 won, 4 lost");
    expect(winRate(record({}))).toBe("58%");
    expect(winRate(record({ games: 0, win_rate: null }))).toBe("–");
  });

  it("says who a split's games were against", () => {
    const split = (fields: Partial<Split>): Split =>
      ({
        ...record({}),
        format: "commander",
        mode: "practice",
        opposition: "bots",
        bot_skill: 4,
        ...fields,
      }) as Split;
    expect(oppositionWords(split({}))).toBe("Bots at skill 4");
    expect(
      oppositionWords(split({ opposition: "players", bot_skill: null })),
    ).toBe("Players");
    expect(oppositionWords(split({ opposition: "mixed", bot_skill: 2 }))).toBe(
      "Players and bots at skill 2",
    );
  });
});

describe("a substitute swapped into the draft", () => {
  const entries: DeckEntry[] = [
    { card_id: "bolt", location: "main", quantity: 4, printing_id: "p1" },
    { card_id: "bolt", location: "sideboard", quantity: 2 },
    { card_id: "bolt", location: "maybeboard", quantity: 1 },
    { card_id: "shock", location: "main", quantity: 1 },
    { card_id: "mountain", location: "main", quantity: 20 },
  ];

  it("takes the missing copies' places where they are played, and joins copies it already has", () => {
    expect(swapped(entries, "bolt", "shock", 5)).toEqual({
      swapped: 5,
      entries: [
        // Four from the main deck and one from the sideboard gave way.
        { card_id: "bolt", location: "sideboard", quantity: 1 },
        // The maybeboard is not played: it is left as it is.
        { card_id: "bolt", location: "maybeboard", quantity: 1 },
        { card_id: "shock", location: "main", quantity: 5 },
        { card_id: "mountain", location: "main", quantity: 20 },
        { card_id: "shock", location: "sideboard", quantity: 1 },
      ],
    });
  });

  it("swaps no more copies than the deck plays", () => {
    const result = swapped(entries, "bolt", "incinerate", 9);
    expect(result.swapped).toBe(6);
    expect(
      result.entries.filter((entry) => entry.card_id === "incinerate"),
    ).toEqual([
      { card_id: "incinerate", location: "main", quantity: 4 },
      { card_id: "incinerate", location: "sideboard", quantity: 2 },
    ]);
    expect(result.entries.filter((entry) => entry.card_id === "bolt")).toEqual([
      { card_id: "bolt", location: "maybeboard", quantity: 1 },
    ]);
  });

  it("changes nothing for a card the deck does not play", () => {
    expect(swapped(entries, "absent", "shock", 2)).toEqual({
      swapped: 0,
      entries,
    });
  });
});
