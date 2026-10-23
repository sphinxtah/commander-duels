import { describe, expect, it } from "vitest";
import {
  clock,
  counts,
  gameLine,
  matchAfterGame,
  matchVerdict,
  moved,
  problems,
  score,
  type GameMatch,
} from "./matches";
import { matchView, sideboardCard as card } from "./fixtures";

const ref: GameMatch = {
  id: "match-1",
  best_of: 3,
  game: 2,
  status: "playing",
  wins: [0, 1],
  winner_seat: null,
  draw: false,
};

describe("a match's score", () => {
  it("reads from the seat's side, its own wins first", () => {
    expect(score([2, 1], 0)).toBe("2–1");
    expect(score([2, 1], 1)).toBe("1–2");
    expect(score([2, 1], null)).toBe("2–1");
    expect(gameLine(ref, 1)).toBe("Game 2 · 1–0");
    expect(gameLine(ref, 0)).toBe("Game 2 · 0–1");
  });

  it("says after a game what comes next, and how the match ended", () => {
    expect(matchAfterGame({ ...ref, status: "sideboarding" }, 1)).toEqual({
      title: "Match 1–0",
      detail: "Game 3 is next: sideboard, then get ready.",
    });
    const won = { ...ref, status: "finished" as const, wins: [1, 2] };
    expect(matchAfterGame({ ...won, winner_seat: 1 }, 1).title).toBe(
      "You won the match, 2–1",
    );
    expect(matchAfterGame({ ...won, winner_seat: 1 }, 0).title).toBe(
      "You lost the match, 1–2",
    );
    expect(matchAfterGame({ ...won, wins: [1, 1], draw: true }, 0).title).toBe(
      "The match is a draw, 1–1",
    );
    expect(matchAfterGame({ ...ref, status: "closed" }, 0).title).toBe(
      "The match ended",
    );
  });

  it("names the winner, and why the match ended", () => {
    const players = matchView().players;
    const finished = {
      status: "finished" as const,
      players: [
        { ...players[0]!, game_wins: 2 },
        { ...players[1]!, game_wins: 1 },
      ],
    };
    expect(
      matchVerdict(
        matchView({ ...finished, winner_seat: 0, end_reason: "games" }),
      ),
    ).toBe("You won the match, 2–1.");
    expect(
      matchVerdict(
        matchView({ ...finished, winner_seat: 0, end_reason: "conceded" }),
      ),
    ).toBe("You won the match, 2–1. bob conceded it.");
    expect(
      matchVerdict(
        matchView({ ...finished, winner_seat: 1, end_reason: "removed" }),
      ),
    ).toBe("bob won the match, 2–1. You were removed while away.");
    expect(
      matchVerdict(
        matchView({
          status: "closed",
          end_reason: "closed",
          winner_seat: null,
        }),
      ),
    ).toMatch(/without a result/);
  });
});

describe("an arrangement", () => {
  const cards = [card("Lightning Bolt", 4, 0), card("Hill Giant", 0, 3)];

  it("moves one copy at a time, never below none", () => {
    const out = moved(cards, 0, "sideboard");
    expect(counts(out)).toEqual({ main: 3, sideboard: 4 });
    expect(moved(out, 1, "main")[1]).toMatchObject({ main: 1, sideboard: 2 });
    expect(moved(cards, 1, "sideboard")).toEqual(cards);
  });

  it("says what keeps it from being a Legacy deck", () => {
    const deck = [card("Mountain", 56, 0), ...cards];
    expect(problems(deck)).toEqual([]);
    expect(problems(moved(deck, 1, "sideboard"))).toEqual([
      "The main deck has 59 cards; Legacy needs at least 60.",
    ]);
    const crowded = [card("Mountain", 60, 0), card("Hill Giant", 0, 16)];
    expect(problems(crowded)).toEqual([
      "The sideboard has 16 cards; Legacy allows 15.",
    ]);
  });

  it("counts down its time as minutes and seconds", () => {
    expect(clock(272.2)).toBe("4:33");
    expect(clock(-3)).toBe("0:00");
  });
});
