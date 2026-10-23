import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOLLOW_MS,
  MatchChip,
  MatchOutcome,
  matchLink,
  useFollowMatch,
} from "./GameMatch";
import type { GameMatch } from "./matches";

const MATCH = "00000000-0000-4000-8000-00000000aaaa";

function match(fields: Partial<GameMatch> = {}): GameMatch {
  return {
    id: MATCH,
    best_of: 3,
    game: 2,
    status: "playing",
    wins: [1, 0],
    winner_seat: null,
    draw: false,
    ...fields,
  };
}

afterEach(() => {
  vi.useRealTimers();
  window.location.hash = "";
});

describe("a match's game on the game screen", () => {
  it("shows the game's number and the score from the player's side", () => {
    render(<MatchChip match={match()} seat={1} />);
    expect(screen.getByText("Game 2 · 0–1")).toBeInTheDocument();
  });

  it("leads to sideboarding, or to the match once it is over", () => {
    expect(matchLink(match({ status: "sideboarding" }))).toEqual({
      href: `#match/${MATCH}`,
      text: "Sideboard for game 3",
    });
    expect(matchLink(match({ status: "finished" })).text).toBe("To the match");
  });

  it("says where the match stands after the game", () => {
    render(
      <MatchOutcome
        match={match({ status: "finished", wins: [2, 0], winner_seat: 0 })}
        seat={0}
        following={null}
      />,
    );
    expect(screen.getByText("You won the match, 2–0.")).toBeInTheDocument();
  });

  it("goes on to sideboarding by itself, unless the player reviews the board", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useFollowMatch(match({ status: "sideboarding" }), true, enabled),
      { initialProps: { enabled: true } },
    );
    expect(result.current).toBe(FOLLOW_MS / 1000);
    act(() => vi.advanceTimersByTime(FOLLOW_MS - 1000));
    expect(result.current).toBe(1);
    expect(window.location.hash).toBe("");
    act(() => vi.advanceTimersByTime(1500));
    expect(window.location.hash).toBe(`#match/${MATCH}`);

    window.location.hash = "";
    rerender({ enabled: false });
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(FOLLOW_MS * 2));
    expect(window.location.hash).toBe("");
  });

  it("stays on a game whose match is over", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useFollowMatch(match({ status: "finished" }), true, true),
    );
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(FOLLOW_MS * 2));
    expect(window.location.hash).toBe("");
  });
});
