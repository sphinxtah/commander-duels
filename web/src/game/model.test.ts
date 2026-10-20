import { describe, expect, it } from "vitest";
import { playerName, resultText } from "./model";
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
