import type { components } from "../generated/api";

// Statistics, match history and achievements (v0.5.0). The server judges every one of them from
// its own record of each game that ended (api/stats.py, api/achievements.py); docs/quests.md
// describes them. A profile's totals and badges are for whoever may open it; the games one by
// one are for their player and SysOp alone.

export type Totals = components["schemas"]["Totals"];
export type Stats = components["schemas"]["Stats"];
export type HistoryEntry = components["schemas"]["HistoryEntry"];
export type HistoryPage = components["schemas"]["HistoryPage"];
export type Opponent = components["schemas"]["Opponent"];
export type Achievements = components["schemas"]["Achievements"];
export type AchievementView = components["schemas"]["AchievementView"];
export type PlayerBadges = components["schemas"]["PlayerBadges"];
export type EarnedBadge = components["schemas"]["EarnedBadge"];
export type BadgeGroup = AchievementView["group"];

/** The badges a player may pin to their profile. */
export const PINS = 3;

const formatNames: Record<string, string> = {
  commander: "Commander",
  legacy: "Legacy",
  two_headed_giant: "Two-Headed Giant",
};

/** "Commander"; a format added later shows by its own name. */
export function formatName(format: string): string {
  return formatNames[format] ?? format.replace(/_/g, " ");
}

export const outcomeWords: Record<HistoryEntry["outcome"], string> = {
  win: "Won",
  loss: "Lost",
  draw: "Draw",
  no_result: "No result",
};

export const groupNames: Record<BadgeGroup, string> = {
  victories: "Victories",
  commander: "Commander",
  legacy: "Legacy",
  colours: "Colours",
  bots: "Bots",
  players: "Players",
  quests: "Quests",
  shop: "Leng's card shop",
  friends: "Friends",
};

/** "a skill-3 bot", "bob", "a player who has left". */
export function opponentName(opponent: Opponent): string {
  if (opponent.bot) return `a skill-${opponent.bot_skill ?? "?"} bot`;
  return opponent.player?.handle ?? "a player who has left";
}

/** "bob and two skill-3 bots": the other seats, the bots counted together. A Two-Headed Giant
 * teammate (v0.5.1) played beside the player: "bob and dan, with cara". */
export function opponentsWords(opponents: Opponent[]): string {
  const mates = opponents.filter((opponent) => opponent.teammate);
  const against = sideWords(opponents.filter((opponent) => !opponent.teammate));
  return mates.length
    ? `${against}, with ${mates.map(opponentName).join(" and ")}`
    : against;
}

function sideWords(opponents: Opponent[]): string {
  const players = opponents
    .filter((opponent) => !opponent.bot)
    .map(opponentName);
  const bots = opponents.filter((opponent) => opponent.bot);
  const parts = [...players];
  if (bots.length === 1) parts.push(opponentName(bots[0]!));
  else if (bots.length > 1)
    parts.push(
      `${numberWords[bots.length] ?? bots.length} skill-${bots[0]!.bot_skill ?? "?"} bots`,
    );
  if (parts.length <= 1) return parts[0] ?? "nobody";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const numberWords: Record<number, string> = { 2: "two", 3: "three" };

/** "24 min", "1 h 05 min", "under a minute". */
export function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h ${String(rest).padStart(2, "0")} min`;
}

/** The share of games won, rounded: "62%"; a dash with no games. */
export function winRate(totals: Totals): string {
  if (totals.games === 0) return "–";
  return `${Math.round((totals.wins / totals.games) * 100)}%`;
}
