// The official Comprehensive Rules (v0.8.6, docs/how-to-play.md): Wizards of the Coast's plain-text
// release, as it is published, parsed in the browser. The file itself is not in this repository: the
// owner's private web image serves it at RULES_URL, and locally the gitignored rules/ folder beside
// compose.yaml does. Without it How to play shows its own guide and a link to Wizards' rules page.
//
// The format, as Wizards publishes it: a title, "These rules are effective as of <date>.", an
// introduction, the contents, then the rules themselves, numbered by section ("1. Game Concepts"),
// chapter ("100. General"), rule ("100.1.") and subrule ("100.1a"), each on one line with blank
// lines between, and "Example:" lines after the rule they illustrate; then the glossary (a term,
// then its definition) and the credits. Blank lines are a no-break space. The test fixture,
// rules.fixture.txt, is a few made-up rules in the same shape.

/** Where the private images, and the local rules/ folder, serve the official text. */
export const RULES_URL = "/rules/comprehensive-rules.txt";
/** Wizards' own page of the rules, linked when the text is not in the build. */
export const WIZARDS_RULES_PAGE = "https://magic.wizards.com/en/rules";

export interface Rule {
  /** "100.1" or "100.1a". */
  number: string;
  /** The rule's own text, without its number. */
  text: string;
  /** Its examples, each without the "Example:" label. */
  examples: string[];
  /** Further paragraphs that follow it before the next number (lists in a few rules). */
  more: string[];
  /** True for a lettered subrule. */
  sub: boolean;
}

export interface Chapter {
  /** "100". */
  number: string;
  title: string;
  rules: Rule[];
}

export interface Section {
  /** "1". */
  number: string;
  title: string;
  chapters: Chapter[];
}

export interface GlossaryEntry {
  term: string;
  definition: string[];
}

export interface ComprehensiveRules {
  title: string;
  /** As the text states it: "September 25, 2026". */
  effective: string | null;
  /** The same date as YYYY-MM-DD, when it reads as a date. */
  effectiveDate: string | null;
  introduction: string[];
  sections: Section[];
  glossary: GlossaryEntry[];
  /** Every rule and chapter by its number, for links. */
  index: Map<string, Rule | Chapter>;
}

const SECTION = /^(\d)\.\s+(.+)$/;
const CHAPTER = /^(\d{3})\.\s+(.+)$/;
// A trailing period after a subrule's letter (one rule has it) and two letters ("704.5aa") occur.
const RULE = /^(\d{3}\.\d+)([a-z]*)\.?\s+(.+)$/;
const EXAMPLE = /^Example:\s*(.*)$/;
const EFFECTIVE = /effective as of ([A-Z][a-z]+ \d{1,2}, \d{4})/;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** A line's text, trimmed of ordinary and no-break spaces; empty for a blank line. */
function clean(line: string): string {
  // A few rules hold a line separator (U+2028) where their text breaks into a second paragraph,
  // padded with no-break spaces: it reads as a space, so the rule stays one line.
  return line
    .replace(/\u2028[\s\u00a0]*/g, " ")
    .replace(/^[\s\u00a0\ufeff]+|[\s\u00a0]+$/g, "");
}

/** "September 25, 2026" as "2026-09-25", or null. */
export function isoDate(text: string | null): string | null {
  if (!text) return null;
  const match = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]!) + 1;
  if (month === 0) return null;
  return `${match[3]}-${String(month).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

export class RulesFormatError extends Error {}

/**
 * The rules from the text Wizards publishes. Throws RulesFormatError when the text does not have
 * the shape (no sections, or no rules), so a wrong file is never shown as rules.
 */
export function parseRules(text: string): ComprehensiveRules {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(clean)
    .filter((line) => line !== "");
  const title = lines[0] ?? "";
  const effective = EFFECTIVE.exec(lines.slice(0, 6).join(" "))?.[1] ?? null;

  // The contents list the sections, then their chapters; the rules start where the first
  // section's heading comes again. The glossary and credits follow the last rule.
  const firstSection = lines.findIndex((line) => SECTION.test(line));
  if (firstSection < 0) throw new RulesFormatError("No sections in the text");
  const start = lines.indexOf(lines[firstSection]!, firstSection + 1);
  if (start < 0) throw new RulesFormatError("No rules after the contents");
  const contentsAt = lines.indexOf("Contents");
  const introduction = lines
    .slice(1, contentsAt > 0 ? contentsAt : firstSection)
    .filter((line) => !EFFECTIVE.test(line) && line !== "Introduction");
  const glossaryAt = lines.lastIndexOf("Glossary");
  const creditsAt = lines.lastIndexOf("Credits");
  const end =
    glossaryAt > start
      ? glossaryAt
      : creditsAt > start
        ? creditsAt
        : lines.length;

  const sections: Section[] = [];
  const index = new Map<string, Rule | Chapter>();
  let section: Section | undefined;
  let chapter: Chapter | undefined;
  let rule: Rule | undefined;
  for (const line of lines.slice(start, end)) {
    const ruled = RULE.exec(line);
    if (ruled && chapter) {
      const number = ruled[1]! + ruled[2]!;
      rule = {
        number,
        text: ruled[3]!,
        examples: [],
        more: [],
        sub: ruled[2]!.length > 0,
      };
      chapter.rules.push(rule);
      if (!index.has(number)) index.set(number, rule);
      continue;
    }
    const chaptered = CHAPTER.exec(line);
    if (chaptered && section) {
      chapter = { number: chaptered[1]!, title: chaptered[2]!, rules: [] };
      section.chapters.push(chapter);
      index.set(chapter.number, chapter);
      rule = undefined;
      continue;
    }
    const sectioned = SECTION.exec(line);
    if (sectioned) {
      section = { number: sectioned[1]!, title: sectioned[2]!, chapters: [] };
      sections.push(section);
      chapter = undefined;
      rule = undefined;
      continue;
    }
    const example = EXAMPLE.exec(line);
    if (rule && example) rule.examples.push(example[1]!);
    else if (rule) rule.more.push(line);
  }
  if (sections.length === 0 || index.size === 0)
    throw new RulesFormatError("No numbered rules in the text");

  const glossary: GlossaryEntry[] = [];
  if (glossaryAt > start) {
    // Each entry is a term, then one or more lines of definition; the next term follows a blank
    // line in the original. Blank lines are gone by now, so a term is told apart by being short,
    // with no full stop of its own, and followed by a definition.
    const body = text.replace(/\r\n?/g, "\n").split("\n").map(clean);
    const from = body.lastIndexOf("Glossary");
    const to = body.lastIndexOf("Credits");
    let entry: GlossaryEntry | undefined;
    for (const line of body.slice(from + 1, to > from ? to : body.length)) {
      if (line === "") {
        entry = undefined;
        continue;
      }
      if (!entry) {
        entry = { term: line, definition: [] };
        glossary.push(entry);
      } else entry.definition.push(line);
    }
  }
  return {
    title,
    effective,
    effectiveDate: isoDate(effective),
    introduction,
    sections,
    glossary: glossary.filter((item) => item.definition.length > 0),
    index,
  };
}

/** The chapter a rule number belongs to: "702" for "702.19b". */
export function chapterOf(number: string): string {
  return number.slice(0, 3);
}

/** A rule number as the address part of How to play's official rules: "702.19b". */
export const RULE_NUMBER = /^\d{3}(?:\.\d+[a-z]*)?$/;

/** A piece of rules text: words, or a reference to another rule that becomes a link. */
export type Piece = { text: string } | { rule: string; text: string };

/**
 * The text cut where it names other rules, "See rule 702.19" or "704.5k", so each reference can
 * link to its rule. A bare three-digit number counts only after "rule" or "rules".
 */
export function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  const pattern = /\b(\d{3}\.\d+[a-z]*)\b|\b(rules?\s+)(\d{3})\b(?!\.\d)/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[1]) {
      if (match.index > last) out.push({ text: text.slice(last, match.index) });
      out.push({ rule: match[1], text: match[1] });
      last = match.index + match[1].length;
    } else {
      const at = match.index + match[2]!.length;
      if (at > last) out.push({ text: text.slice(last, at) });
      out.push({ rule: match[3]!, text: match[3]! });
      last = at + match[3]!.length;
    }
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export interface RuleHit {
  number: string;
  /** The chapter's title, for context. */
  chapter: string;
  text: string;
}

export interface GlossaryHit {
  term: string;
  definition: string;
}

/**
 * Rules and glossary entries matching a search: a rule number finds that rule (and its subrules);
 * words find every rule and entry containing all of them, glossary terms first. At most `limit`
 * of each.
 */
export function searchRules(
  rules: ComprehensiveRules,
  query: string,
  limit = 40,
): { rules: RuleHit[]; glossary: GlossaryHit[] } {
  const wanted = query.trim().toLowerCase();
  if (wanted.length < 2) return { rules: [], glossary: [] };
  const ruleHits: RuleHit[] = [];
  const glossaryHits: GlossaryHit[] = [];
  const numbered = /^\d{3}(\.\d+[a-z]*)?\.?$/.test(wanted);
  const words = wanted.split(/\s+/).filter(Boolean);
  const has = (text: string) => {
    const lower = text.toLowerCase();
    return words.every((word) => lower.includes(word));
  };
  if (!numbered) {
    for (const entry of rules.glossary) {
      if (glossaryHits.length >= limit) break;
      if (has(entry.term) || has(entry.definition.join(" ")))
        glossaryHits.push({
          term: entry.term,
          definition: entry.definition.join(" "),
        });
    }
    // Terms that match by name first.
    glossaryHits.sort((a, b) => Number(has(b.term)) - Number(has(a.term)));
  }
  const number = wanted.replace(/\.$/, "");
  for (const section of rules.sections)
    for (const chapter of section.chapters)
      for (const rule of chapter.rules) {
        if (ruleHits.length >= limit) break;
        const matches = numbered
          ? rule.number === number ||
            rule.number.startsWith(number.includes(".") ? number : `${number}.`)
          : has(rule.text) || rule.examples.some(has);
        if (matches)
          ruleHits.push({
            number: rule.number,
            chapter: `${chapter.number}. ${chapter.title}`,
            text: rule.text,
          });
      }
  return { rules: ruleHits, glossary: glossaryHits.slice(0, limit) };
}
