import type { BoardView, QuestBoards, QuestView } from "../quests/quests";
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
    matches: totals(),
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
    id: "d1-win",
    name: "Win a game",
    tokens: 150,
    target: 1,
    progress: 0,
    completed_at: null,
    step: 1,
    tier: null,
    in_game: true,
    ...fields,
  };
}

export function board(fields: Partial<BoardView> = {}): BoardView {
  return {
    board: "daily",
    period: "2026-11-10",
    resets_at: "2026-11-11T07:00:00Z",
    completed_at: null,
    streak: { current: 0, bonus: 400, next_bonus: 500, best: 0 },
    quests: [1, 2, 3, 4, 5].map((step) =>
      quest({
        slot: step - 1,
        id: `d${step}-win`,
        name: `Win ${step} games`,
        step,
        target: step,
        tokens: [150, 250, 350, 500, 750][step - 1]!,
      }),
    ),
    ...fields,
  };
}

export function questBoards(fields: Partial<QuestBoards> = {}): QuestBoards {
  return {
    daily: board(),
    weekly: board({
      board: "weekly",
      period: "2026-11-08",
      resets_at: "2026-11-15T07:00:00Z",
      streak: { current: 2, bonus: 2_400, next_bonus: 2_600, best: 2 },
      quests: Array.from({ length: 20 }, (_, slot) =>
        quest({
          slot,
          id: `w-goal-${slot}`,
          name: `Goal ${slot + 1}`,
          step: null,
          tier: slot < 6 ? "easy" : slot < 15 ? "medium" : "hard",
          tokens: slot < 6 ? 250 : slot < 15 ? 400 : 650,
          in_game: slot % 3 === 0,
        }),
      ),
    }),
    paid: 0,
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
      {
        seat: 1,
        bot: true,
        player: null,
        bot_skill: 3,
        won: false,
        teammate: false,
      },
      {
        seat: 2,
        bot: true,
        player: null,
        bot_skill: 3,
        won: false,
        teammate: false,
      },
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
