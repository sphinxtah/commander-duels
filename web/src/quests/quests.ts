import type { components } from "../generated/api";

// The quest boards (v0.9.5, PROG04): a daily board of five quests, easiest to hardest, and a
// weekly board of twenty goals, each drawn at its period's first look and judged by the server
// from what it recorded, each paid once, with a bonus for a full board that grows with the streak.
// docs/quests.md describes them.

export type QuestBoards = components["schemas"]["QuestBoards"];
export type BoardView = components["schemas"]["BoardView"];
export type QuestView = components["schemas"]["QuestView"];

/** The quests page's address. */
export const QUESTS_ROUTE = "#quests";

/** "in 3 days", "in 5 h", "in 40 min", "in a minute": until the next board, at midnight in
 * Arizona. */
export function resetsIn(iso: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(iso) - now) / 60000));
  if (minutes < 2) return "in a minute";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/** How many of a board's quests are complete. */
export function doneOf(board: BoardView): number {
  return board.quests.filter((quest) => quest.completed_at).length;
}

/** What a daily step or a weekly tier is called. */
export function levelOf(quest: QuestView): string {
  if (quest.step) return `Step ${quest.step}`;
  if (quest.tier) return quest.tier[0]!.toUpperCase() + quest.tier.slice(1);
  return "";
}

/** The streak's words: "3 days in a row", "First week", "No streak yet". */
export function streakWords(board: BoardView): string {
  const unit = board.board === "daily" ? "day" : "week";
  const count = board.streak.current;
  if (count === 0) return "No streak yet";
  return `${count} ${unit}${count === 1 ? "" : "s"} in a row`;
}
