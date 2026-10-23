import type { components } from "../generated/api";

// Daily quests (v0.5.0, PROG04): three a day, drawn the first time the account asks for them,
// judged by the server from the games it recorded, each paid once. docs/quests.md describes
// them.

export type DailyQuests = components["schemas"]["DailyQuests"];
export type QuestView = components["schemas"]["QuestView"];

/** "in 5 h", "in 40 min", "in a minute": until the next day's quests, at midnight in Arizona. */
export function resetsIn(iso: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(iso) - now) / 60000));
  if (minutes < 2) return "in a minute";
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.round(minutes / 60)} h`;
}
