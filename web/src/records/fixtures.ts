import type { DailyQuests, QuestView } from "../quests/quests";
import type {
  AchievementView,
  Achievements,
  HistoryEntry,
  HistoryPage,
  PlayerBadges,
  Stats,
  Totals,
} from "./records";

// Test data for statistics, quests and achievements (v0.5.0).

export function totals(fields: Partial<Totals> = {}): Totals {
  return { games: 0, wins: 0, losses: 0, draws: 0, no_result: 0, ...fields };
}

/** A record of no games, unless told otherwise. */
export function stats(fields: Partial<Stats> = {}): Stats {
  return {
    totals: totals(),
    formats: [],
    against_bots: totals(),
    against_players: totals(),
    history: false,
    ...fields,
  };
}

export function achievement(
  fields: Partial<AchievementView> = {},
): AchievementView {
  return {
    id: "first-win",
    name: "First Victory",
    description: "Win a game.",
    group: "victories",
    addition: false,
    tokens: 100,
    target: 1,
    progress: 0,
    earned_at: null,
    pin: null,
    ...fields,
  };
}

export function achievements(
  items: AchievementView[] = [achievement()],
  paid = 0,
): Achievements {
  return {
    achievements: items,
    earned: items.filter((item) => item.earned_at).length,
    paid,
  };
}

export function badges(fields: Partial<PlayerBadges> = {}): PlayerBadges {
  return { pinned: [], earned: [], total: 29, ...fields };
}

export function quest(fields: Partial<QuestView> = {}): QuestView {
  return {
    slot: 0,
    id: "win",
    name: "Win a game",
    tokens: 100,
    target: 1,
    progress: 0,
    completed_at: null,
    swapped: false,
    ...fields,
  };
}

export function dailyQuests(fields: Partial<DailyQuests> = {}): DailyQuests {
  return {
    day: "2026-10-22",
    resets_at: "2026-10-23T07:00:00Z",
    can_swap: true,
    paid: 0,
    quests: [
      quest(),
      quest({
        slot: 1,
        id: "win-red",
        name: "Win with a red deck",
        tokens: 150,
      }),
      quest({
        slot: 2,
        id: "win-3",
        name: "Win three games",
        tokens: 200,
        target: 3,
      }),
    ],
    ...fields,
  };
}

export function game(fields: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    game_id: "00000000-0000-4000-8000-0000000000a1",
    format: "commander",
    kind: "practice",
    outcome: "win",
    seat: 0,
    started_at: "2026-10-22T18:00:00Z",
    finished_at: "2026-10-22T18:24:00Z",
    seconds: 24 * 60,
    turns: 9,
    deck: "Red Test",
    revision: 2,
    colors: "R",
    opponents: [
      { seat: 1, bot: true, player: null, bot_skill: 3, won: false },
      { seat: 2, bot: true, player: null, bot_skill: 3, won: false },
    ],
    ...fields,
  };
}

export function history(
  items: HistoryEntry[] = [],
  next: string | null = null,
): HistoryPage {
  return { items, next };
}
