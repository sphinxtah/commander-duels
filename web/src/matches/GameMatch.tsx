import { useEffect, useState, type RefObject } from "react";
import { client, describe } from "../api";
import { markIntendedLeave } from "../app/liveGame";
import game from "../game/game.module.css";
import screen from "../game/table/screen.module.css";
import { gameLine, matchAfterGame, type GameMatch } from "./matches";

// A match's game on the game screen (v0.5.0, docs/matches.md): the score on the table, the
// match's state in the game's result, the way to sideboarding, which the screen follows into
// by itself a moment after the game, and conceding the whole match.

/** How long the game's result stays before the screen goes on to sideboarding. */
export const FOLLOW_MS = 6000;

/** The game's number and the score, on the table: "Game 2 · 1–0". */
export function MatchChip({
  match,
  seat,
}: {
  match: GameMatch;
  seat: number | null;
}) {
  return (
    <span className={screen.chip} data-match>
      {gameLine(match, seat)}
    </span>
  );
}

/** Where the game's result leads in a match: its sideboarding, or the match's own page. */
export function matchLink(match: GameMatch): { href: string; text: string } {
  return {
    href: `#match/${match.id}`,
    text:
      match.status === "sideboarding"
        ? `Sideboard for game ${match.game + 1}`
        : match.status === "playing"
          ? "To the next game"
          : "To the match",
  };
}

/**
 * Once a game of a match is over and the match goes on, the screen goes on to sideboarding after
 * FOLLOW_MS, unless the player chose to review the board. Returns the seconds left, or null.
 */
export function useFollowMatch(
  match: GameMatch | null,
  over: boolean,
  enabled: boolean,
): number | null {
  const going =
    enabled &&
    over &&
    match !== null &&
    (match.status === "sideboarding" || match.status === "playing");
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!going || !match) {
      setLeft(null);
      return;
    }
    const until = Date.now() + FOLLOW_MS;
    setLeft(Math.ceil(FOLLOW_MS / 1000));
    const timer = window.setInterval(() => {
      const remaining = until - Date.now();
      if (remaining <= 0) {
        window.clearInterval(timer);
        markIntendedLeave();
        window.location.hash = `#match/${match.id}`;
        return;
      }
      setLeft(Math.ceil(remaining / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [going, match?.id]);
  return left;
}

/** The match in the game's result: the score after it, and what comes next. */
export function MatchOutcome({
  match,
  seat,
  following,
}: {
  match: GameMatch;
  seat: number | null;
  /** Seconds before the screen goes on to sideboarding, or null. */
  following: number | null;
}) {
  const outcome = matchAfterGame(match, seat);
  return (
    <div data-match-result>
      <p>
        <strong>{outcome.title}.</strong> {outcome.detail}
      </p>
      {following !== null && (
        <p className={game.hint} role="status">
          Sideboarding opens in {following} s.
        </p>
      )}
    </div>
  );
}

/** "Concede the match?": the game in play, and the match with it. */
export function ConcedeMatchDialog({
  match,
  dialog,
}: {
  match: GameMatch;
  dialog: RefObject<HTMLDialogElement | null>;
}) {
  const [error, setError] = useState("");
  async function concede() {
    setError("");
    const { data, error: failure } = await client
      .POST("/api/v1/matches/{match_id}/concede", {
        params: { path: { match_id: match.id } },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    if (!data) {
      setError(describe(failure));
      dialog.current?.showModal();
    }
  }
  return (
    <dialog
      ref={dialog}
      className={game.confirm}
      aria-labelledby="concede-match-title"
    >
      <h2 id="concede-match-title">Concede the match?</h2>
      <p>
        You lose this game and the match at once. The games you won still count.
      </p>
      {error && (
        <p role="alert" className={game.refusal}>
          {error}
        </p>
      )}
      <form method="dialog" className={game.confirmButtons}>
        <button type="submit" className={game.secondaryButton} autoFocus>
          Keep playing
        </button>
        <button
          type="submit"
          className={game.dangerButton}
          onClick={() => void concede()}
        >
          Concede the match
        </button>
      </form>
    </dialog>
  );
}
