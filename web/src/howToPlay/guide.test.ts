import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OVERVIEW } from "../tutorial/Overview";
import { buildDemo } from "../tutorial/demoScript";
import {
  CARDS,
  GUIDE,
  PROMPT_TOPICS,
  searchGuide,
  TOPICS,
  topicById,
  topicText,
  TUTORIAL_TOPICS,
} from "./guide";
import { parseRules, pieces } from "./rules";

/** Every rule number a topic names: its list, and the references in its words. */
function numbersOf(topicId: string): string[] {
  const topic = topicById(topicId)!;
  const named = pieces(topicText(topic)).flatMap((piece) =>
    "rule" in piece ? [piece.rule] : [],
  );
  const tables = topic.blocks.flatMap((block) =>
    block.kind === "table"
      ? block.rows
          .map((row) => row[row.length - 1]!)
          .filter((cell) => /^\d{3}(\.\d+[a-z]*)?$/.test(cell))
      : [],
  );
  return [...topic.rules, ...named, ...tables];
}

describe("the guide", () => {
  it("has unique topic ids, each with words", () => {
    const ids = TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const topic of TOPICS) {
      expect(topic.blocks.length).toBeGreaterThan(0);
      expect(topic.summary.length).toBeGreaterThan(10);
    }
    expect(GUIDE.length).toBeGreaterThanOrEqual(8);
  });

  it("names rules in their official shape", () => {
    for (const topic of TOPICS)
      for (const number of numbersOf(topic.id))
        expect(number, `${topic.id}: ${number}`).toMatch(
          /^\d{3}(\.\d+[a-z]*)?$/,
        );
  });

  it("links every prompt kind and tutorial lesson to a topic", () => {
    for (const [kind, id] of Object.entries(PROMPT_TOPICS))
      expect(topicById(id), kind).toBeTruthy();
    for (const [title, id] of Object.entries(TUTORIAL_TOPICS))
      expect(topicById(id), title).toBeTruthy();
    // Every refresher page and every lesson has its link.
    for (const page of OVERVIEW.filter((p) => p.part === "A Magic refresher"))
      expect(TUTORIAL_TOPICS[page.title], page.title).toBeTruthy();
    for (const beat of buildDemo())
      expect(TUTORIAL_TOPICS[beat.title], beat.title).toBeTruthy();
  });

  it("gives every example card its name, type and text", () => {
    for (const card of Object.values(CARDS)) {
      expect(card.name).toBeTruthy();
      expect(card.type).toBeTruthy();
      expect(Array.isArray(card.rules)).toBe(true);
    }
  });

  it("finds topics by their words, titles first", () => {
    expect(searchGuide("trample")[0]!.id).toBe("combat-damage");
    expect(searchGuide("commander tax").map((t) => t.id)).toContain(
      "commander-tax",
    );
    expect(searchGuide("x")).toEqual([]);
  });
});

// Against the official text, when the gitignored rules/ folder beside compose.yaml has it: every
// rule the guide names exists there.
const official = resolve(
  process.cwd(),
  "..",
  "rules",
  "comprehensive-rules.txt",
);
describe.skipIf(!existsSync(official))(
  "the guide against the official text",
  () => {
    it("names only rules that exist", () => {
      const rules = parseRules(readFileSync(official, "utf8"));
      const missing = TOPICS.flatMap((topic) =>
        numbersOf(topic.id)
          .filter((number) => !rules.index.has(number))
          .map((number) => `${topic.id}: ${number}`),
      );
      expect(missing).toEqual([]);
    });
  },
);
