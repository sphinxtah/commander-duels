import type { components } from "../generated/api";

// King's Table (v0.8.7, docs/kings-table.md): the owner's six-player Emperor variant, as the
// practice table, the tables and the game screen say it. Six seats in a fixed circle: 0 is team
// A's Left General, 1 its King, 2 its Right General, 3 team B's Right General, 4 its King, 5 its
// Left General. A seat's team is seat // 3. Seat 5 sits beside seat 0, so the circle drawn as two
// rows facing each other is team B's 5, 4, 3 across from team A's 0, 1, 2.

export type KingsTableSettings = components["schemas"]["KingsTableSettings"];
/** The settings as anything that shows them takes them: the API's, or the engine's echo in a
 * game's snapshot, where an engine before v0.9.7 names no guard (the guard off). */
export type KingsRules = Omit<KingsTableSettings, "guarded_kings"> & {
  guarded_kings?: boolean;
};
export type KingsLife = KingsTableSettings["life"];
export type KingsDeckFormat = KingsTableSettings["deck_format"];
export type KingsRole = "king" | "general";

export const KINGS_TABLE = "kings_table";
export const KINGS_SEATS = [0, 1, 2, 3, 4, 5] as const;
/** The seats as the circle draws them: team B's row across the table, then team A's. */
export const CIRCLE_ROWS = [
  [5, 4, 3],
  [0, 1, 2],
] as const;

/** The API's defaults, for before the practice options arrive and for a new table. */
export const DEFAULT_KINGS_TABLE: KingsTableSettings = {
  deck_format: "commander",
  life: "all_40",
  king_attacks_anyone: false,
  guarded_kings: false,
};

/** Practice games' defaults (v0.9.1): the house rule on, so a table of bots doesn't stall. The
 * API sends the same with the practice options. */
export const PRACTICE_KINGS_TABLE: KingsTableSettings = {
  ...DEFAULT_KINGS_TABLE,
  king_attacks_anyone: true,
};

export function kingsTeam(seat: number): 0 | 1 {
  return seat < 3 ? 0 : 1;
}

export function kingsRole(seat: number): KingsRole {
  return seat === 1 || seat === 4 ? "king" : "general";
}

/** "Team A" or "Team B", as the mode's rules name them. */
export function kingsTeamName(team: number): string {
  return team === 0 ? "Team A" : "Team B";
}

const POSITIONS = [
  "Left General",
  "King",
  "Right General",
  "Right General",
  "King",
  "Left General",
] as const;

/** A seat's place in its team: "King", "Left General", "Right General". */
export function seatPosition(seat: number): string {
  return POSITIONS[seat] ?? "General";
}

/** A seat by its team and place: "Team A's King", "Team B's Left General". */
export function seatTitle(seat: number): string {
  return `${kingsTeamName(kingsTeam(seat))}'s ${seatPosition(seat)}`;
}

/** A role as a plate or a seat shows it: a crown for a King. */
export function roleWords(role: KingsRole | null | undefined): string {
  return role === "king" ? "♔ King" : "General";
}

export const LIFE_WORDS: Record<KingsLife, string> = {
  all_20: "Everyone 20",
  all_40: "Everyone 40",
  generals_20_kings_40: "Generals 20, Kings 40",
};

/** What each life preset gives, in a line. */
export const LIFE_DETAIL: Record<KingsLife, string> = {
  all_20: "Every player starts at 20 life",
  all_40: "Every player starts at 40 life",
  generals_20_kings_40: "Each General starts at 20 life, each King at 40",
};

export const DECK_FORMAT_WORDS: Record<KingsDeckFormat, string> = {
  legacy: "Legacy decks",
  commander: "Commander decks",
};

export const DECK_FORMAT_DETAIL: Record<KingsDeckFormat, string> = {
  legacy:
    "60 cards or more, four copies at most, Legacy's banned list; no commanders",
  commander:
    "100 cards with a commander, singleton; every player has a commander, Generals too",
};

export const HOUSE_RULE = "King can attack anyone";
export const HOUSE_RULE_DETAIL =
  "A King's creatures may attack any opponent, the other King included; spells and abilities still keep to range";
/** The house rule's guard (v0.9.7, the owner's rule for the campaign's court): with it a King
 * attacks the opposing Generals from the start, and the other King only once one of that King's
 * own Generals is defeated. It needs the house rule: without it no King attacks across the table. */
export const GUARD_RULE = "Generals guard their King";
export const GUARD_RULE_DETAIL =
  "Except the other King, whom a King's creatures may attack only once one of that King's Generals is defeated";
/** What a King may attack under the house rule with its guard, as a sentence's start. */
export const GUARDED_ATTACKS =
  "A King's creatures may attack any opposing General, and the other King once one of that King's Generals is defeated";

/** The house rule as a tag or a line: "King can attack anyone: on". */
export function houseRuleWords(on: boolean): string {
  return `${HOUSE_RULE}: ${on ? "on" : "off"}`;
}

/** Whether the guard holds: it is chosen, and the house rule it belongs to is on. */
export function kingsGuarded(
  settings: Pick<KingsRules, "king_attacks_anyone" | "guarded_kings">,
): boolean {
  return settings.king_attacks_anyone && settings.guarded_kings === true;
}

/** Whom a King may attack under the settings, in a sentence without its full stop. */
export function kingsAttackWords(
  settings: Pick<KingsRules, "king_attacks_anyone" | "guarded_kings">,
): string {
  if (!settings.king_attacks_anyone)
    return "A King attacks only an opponent beside them and in range, as a General does";
  return kingsGuarded(settings)
    ? GUARDED_ATTACKS
    : "A King's creatures may attack any opponent, the other King included";
}

export function startingLife(
  settings: Pick<KingsTableSettings, "life">,
  seat: number,
): number {
  if (settings.life === "all_20") return 20;
  if (settings.life === "all_40") return 40;
  return kingsRole(seat) === "king" ? 40 : 20;
}

/** The settings as the lobby's tags: the decks, the life, the house rule and, when it holds, the
 * rule's guard. */
export function settingsTags(settings: KingsRules): string[] {
  return [
    DECK_FORMAT_WORDS[settings.deck_format],
    LIFE_WORDS[settings.life],
    houseRuleWords(settings.king_attacks_anyone),
    ...(kingsGuarded(settings) ? [GUARD_RULE] : []),
  ];
}

/** The settings in one line, for the game's menu: "Commander decks · Generals 20, Kings 40 · King
 * can attack anyone: off". */
export function settingsLine(settings: KingsRules): string {
  return settingsTags(settings).join(" · ");
}

/** A sentence's start in the middle of another: its first letter small. */
function inSentence(words: string): string {
  return `${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

/** The settings in sentences, as a table shows them before anyone readies. */
export function settingsSentence(settings: KingsRules): string {
  return `${DECK_FORMAT_WORDS[settings.deck_format]} for all six players (${DECK_FORMAT_DETAIL[settings.deck_format]}). ${LIFE_DETAIL[settings.life]}. ${
    settings.king_attacks_anyone
      ? `House rule on${kingsGuarded(settings) ? ", Generals guarding their King" : ""}: ${inSentence(kingsAttackWords(settings))}; spells and abilities still keep to range.`
      : `House rule off: ${inSentence(kingsAttackWords(settings))}.`
  }`;
}

/** A list in words: "a, b and c". */
export function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
