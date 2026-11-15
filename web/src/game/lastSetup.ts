import { KINGS_SEATS, type KingsTableSettings } from "../tables/kingsTable";
import type { TableRules } from "../tables/tables";
import type { BestOf, PracticeFormatId } from "./practice";

// The Play wizard's memory (v1.0.0, the owner's choice): what the account last started a game
// with, so every slide opens on that choice and the first slide offers to play it again. Kept in
// this browser alone, by account: it is a convenience, not a record, and the server checks every
// start as it always did. A deck since deleted or a format since gone is dropped where it is read.

export type LastSetup = {
  format: PracticeFormatId;
  best_of: BestOf;
  rules: TableRules;
  kings: KingsTableSettings | null;
  seat: number;
  /** "own:<id>", a fixture deck's name, or "" for the table's choice. */
  deck: string;
  bots: number;
  bot_decks: string[];
  skill: number;
  /** The turn limit the player typed; null for the table's own. */
  turn_cap: number | null;
};

const FORMATS: readonly string[] = [
  "legacy",
  "commander",
  "two_headed_giant",
  "kings_table",
];
const KINGS_LIFE: readonly unknown[] = [
  "all_20",
  "all_40",
  "generals_20_kings_40",
];

function keyOf(account: string): string {
  return `cd.play.last.${account}`;
}

function flag(value: unknown): boolean {
  return value === true;
}

function whole(value: unknown, low: number, high: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= low &&
    value <= high
    ? value
    : null;
}

/** What was stored, as a setup, or null where it is not one: another version's, or tampered. */
export function sanitizeLastSetup(raw: unknown): LastSetup | null {
  if (typeof raw !== "object" || raw === null) return null;
  const held = raw as Record<string, unknown>;
  if (typeof held.format !== "string" || !FORMATS.includes(held.format))
    return null;
  const rules = (held.rules ?? {}) as Record<string, unknown>;
  const kings = held.kings as Record<string, unknown> | null | undefined;
  const seat = whole(held.seat, 0, KINGS_SEATS.length - 1);
  return {
    format: held.format as PracticeFormatId,
    best_of: held.best_of === 3 ? 3 : 1,
    rules: {
      banned: flag(rules.banned),
      not_legal: flag(rules.not_legal),
      stand_in: flag(rules.stand_in),
    },
    kings:
      kings &&
      (kings.deck_format === "commander" || kings.deck_format === "legacy") &&
      KINGS_LIFE.includes(kings.life)
        ? ({
            deck_format: kings.deck_format,
            life: kings.life,
            king_attacks_anyone: flag(kings.king_attacks_anyone),
            guarded_kings: flag(kings.guarded_kings),
          } as KingsTableSettings)
        : null,
    seat: seat ?? 1,
    deck: typeof held.deck === "string" ? held.deck : "",
    bots: whole(held.bots, 1, 5) ?? 1,
    bot_decks: Array.isArray(held.bot_decks)
      ? held.bot_decks
          .slice(0, 5)
          .map((deck) => (typeof deck === "string" ? deck : ""))
      : [],
    skill: whole(held.skill, 1, 6) ?? 4,
    turn_cap: whole(held.turn_cap, 1, 100000),
  };
}

export function readLastSetup(account: string): LastSetup | null {
  try {
    const raw = localStorage.getItem(keyOf(account));
    return raw === null ? null : sanitizeLastSetup(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** False when the browser would not store it: the wizard then simply remembers nothing. */
export function saveLastSetup(account: string, setup: LastSetup): boolean {
  try {
    localStorage.setItem(keyOf(account), JSON.stringify(setup));
    return true;
  } catch {
    return false;
  }
}
