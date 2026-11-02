import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "./rules.fixture.txt?raw";
import {
  isoDate,
  parseRules,
  pieces,
  RulesFormatError,
  searchRules,
  type Rule,
} from "./rules";

describe("the Comprehensive Rules' format", () => {
  const rules = parseRules(fixture);

  it("reads the title, the effective date and the introduction", () => {
    expect(rules.title).toBe("Example Game: Test Rules");
    expect(rules.effective).toBe("March 4, 2031");
    expect(rules.effectiveDate).toBe("2031-03-04");
    expect(rules.introduction).toEqual([
      "This is a made-up rules text in the shape of the official one, for tests only. None of it is a real rule.",
    ]);
  });

  it("skips the contents and reads sections, chapters and rules", () => {
    expect(rules.sections.map((section) => section.title)).toEqual([
      "First Things",
      "Second Things",
    ]);
    const [beginnings, middles] = rules.sections[0]!.chapters;
    expect(beginnings!.number).toBe("100");
    expect(beginnings!.rules.map((rule) => rule.number)).toEqual([
      "100.1",
      "100.1a",
      "100.1b",
      "100.2",
    ]);
    expect(middles!.rules.map((rule) => rule.number)).toEqual([
      "101.1",
      "101.2",
      "101.2aa",
    ]);
  });

  it("keeps examples and further lines with their rule, and marks subrules", () => {
    const rule = (number: string) => rules.index.get(number) as Rule;
    expect(rule("100.1a").examples).toEqual([
      "A teapot joins the game. It is a pretend player.",
    ]);
    expect(rule("100.1a").sub).toBe(true);
    expect(rule("100.1").sub).toBe(false);
    // A stray period after the letter, as one official subrule has.
    expect(rule("100.1b").text).toBe("A teapot can't be the starting player.");
    expect(rule("100.2").more).toEqual(["Red marbles", "Blue marbles"]);
    expect(rule("200.1").examples).toHaveLength(2);
  });

  it("reads the glossary up to the credits", () => {
    expect(rules.glossary).toEqual([
      { term: "Marble", definition: ["A small glass ball. See rule 100.2."] },
      {
        term: "Teapot",
        definition: [
          "1. A pretend player that whistles. 2. A thing for tea. See rule 100.1a.",
        ],
      },
    ]);
  });

  it("refuses a text that is not the rules", () => {
    expect(() => parseRules("<html><body>Not found</body></html>")).toThrow(
      RulesFormatError,
    );
    expect(() => parseRules("")).toThrow(RulesFormatError);
  });

  it("reads Windows line endings the same", () => {
    const crlf = parseRules(fixture.replace(/\n/g, "\r\n"));
    expect(crlf.index.size).toBe(rules.index.size);
  });

  it("finds rules by number and by words, and glossary terms", () => {
    expect(searchRules(rules, "100.1").rules.map((hit) => hit.number)).toEqual([
      "100.1",
      "100.1a",
      "100.1b",
    ]);
    expect(searchRules(rules, "101").rules.map((hit) => hit.number)).toEqual([
      "101.1",
      "101.2",
      "101.2aa",
    ]);
    const found = searchRules(rules, "teapot");
    expect(found.glossary[0]!.term).toBe("Teapot");
    expect(found.rules.map((hit) => hit.number)).toEqual([
      "100.1a",
      "100.1b",
      "101.2",
      // By its example.
      "200.1",
    ]);
    expect(searchRules(rules, "a").rules).toEqual([]);
  });
});

describe("rule references", () => {
  it("become links: dotted numbers anywhere, chapters after 'rule'", () => {
    expect(pieces("See rules 200 and 704.5aa.")).toEqual([
      { text: "See rules " },
      { rule: "200", text: "200" },
      { text: " and " },
      { rule: "704.5aa", text: "704.5aa" },
      { text: "." },
    ]);
    expect(pieces("Each player starts with 9 marbles.")).toEqual([
      { text: "Each player starts with 9 marbles." },
    ]);
  });

  it("reads dates", () => {
    expect(isoDate("September 25, 2026")).toBe("2026-09-25");
    expect(isoDate("Smarch 1, 2026")).toBeNull();
    expect(isoDate(null)).toBeNull();
  });
});

// The official text, when the gitignored rules/ folder beside compose.yaml has it.
const official = resolve(
  process.cwd(),
  "..",
  "rules",
  "comprehensive-rules.txt",
);
describe.skipIf(!existsSync(official))(
  "the official text, when present",
  () => {
    it("parses whole", () => {
      const rules = parseRules(readFileSync(official, "utf8"));
      expect(rules.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rules.sections.length).toBeGreaterThanOrEqual(9);
      expect(rules.index.get("702.19")).toBeTruthy();
      expect(rules.index.get("903")).toBeTruthy();
      expect(rules.glossary.length).toBeGreaterThan(500);
    });
  },
);
