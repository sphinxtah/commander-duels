import { describe, expect, it } from "vitest";
import { playerName, resultText, teammateOf } from "./model";
import type { GameView, PlayerView } from "./types";

function player(seat: number, name: string): PlayerView {
  return {
    seat,
    name,
    life: 20,
    counters: {},
    library_count: 40,
    hand_count: 7,
    graveyard: [],
    exile: [],
    mana_pool: { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 },
    lost: false,
    won: false,
    color_identity: null,
    command_zone: [],
    commanders: [],
  };
}

// The owner's seat view, as SysOp receives it when observing the owner's game.
const view: GameView = {
  seat: 0,
  turn: 12,
  active_seat: 0,
  priority_seat: 0,
  phase: null,
  step: null,
  you: player(0, "Alice"),
  opponents: [player(1, "Bot 2")],
  hand: [],
  battlefield: [],
  stack: [],
  combat: [],
  revealed: [],
  looked_at: [],
  messages: [],
  priority: null,
};
const won = (winner_seat: number) => ({
  kind: "completed",
  winner_seat,
  draw: false,
  turns: 12,
});

describe("the result in words", () => {
  it("speaks to the seat's owner", () => {
    expect(resultText(view, 0, won(0))).toEqual({
      title: "Victory",
      detail: "You won in 12 turns.",
    });
    expect(resultText(view, 0, won(1))).toEqual({
      title: "Defeat",
      detail: "Bot 2 won in 12 turns.",
    });
  });

  it("stays neutral for SysOp observing someone else's game", () => {
    expect(resultText(view, null, won(0))).toEqual({
      title: "Game over",
      detail: "Alice won in 12 turns.",
    });
    expect(resultText(view, null, won(1))).toEqual({
      title: "Game over",
      detail: "Bot 2 won in 12 turns.",
    });
  });

  it("names the owner instead of 'You' when observing", () => {
    expect(playerName(view, 0)).toBe("You");
    expect(playerName(view, 0, true)).toBe("Alice");
    expect(playerName(view, 1, true)).toBe("Bot 2");
  });
});

describe("Two-Headed Giant (v0.5.0)", () => {
  // Seat 0's view: seat 1 is its teammate; seats 2 and 3 the other team.
  const team = (seat: number, name: string): PlayerView => ({
    ...player(seat, name),
    team: Math.floor(seat / 2),
    life: 30,
  });
  const giant: GameView = {
    ...view,
    you: team(0, "Alice"),
    opponents: [team(1, "Bot 2"), team(2, "Bot 3"), team(3, "Bot 4")],
  };
  const teamWon = (winners: number[]) => ({
    ...won(winners[0]),
    winner_seats: winners,
  });

  it("knows the viewer's teammate", () => {
    expect(teammateOf(giant)).toBe(1);
    expect(teammateOf(view)).toBeNull();
    expect(teammateOf({ ...giant, you: null })).toBeNull();
  });

  it("tells a team's win to both teammates", () => {
    expect(resultText(giant, 0, teamWon([0, 1]))).toEqual({
      title: "Victory",
      detail: "Your team won in 12 turns.",
    });
    expect(resultText(giant, 1, teamWon([0, 1]))).toEqual({
      title: "Victory",
      detail: "Your team won in 12 turns.",
    });
    expect(resultText(giant, 0, teamWon([2, 3]))).toEqual({
      title: "Defeat",
      detail: "Bot 3 and Bot 4 won in 12 turns.",
    });
  });
});
