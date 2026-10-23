import { useCallback, useEffect, useState } from "react";
import { client } from "../api";
import game from "../game/game.module.css";
import { opponentOf, running, score, type MatchView } from "./matches";

// The account's running best-of-three matches on the Play page (v0.5.0): a match holds its
// player's running game between its games too, so the page leads back to it.

export function RunningMatches({ refreshKey }: { refreshKey?: unknown }) {
  const [matches, setMatches] = useState<MatchView[]>([]);
  const load = useCallback(async () => {
    const answer = await client.GET("/api/v1/matches").catch(() => undefined);
    setMatches(answer?.data ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  const shown = matches.filter((match) => {
    const mine = match.players.find((player) => player.you);
    return running(match.status) && mine && !mine.left;
  });
  if (shown.length === 0) return null;
  return (
    <>
      <div className={game.gamesHead}>
        <h3>Your matches</h3>
      </div>
      <ul className={game.games} aria-label="Your matches">
        {shown.map((match) => {
          const other = opponentOf(match, match.your_seat);
          const wins = match.players.map((player) => player.game_wins);
          return (
            <li key={match.id} data-status="active">
              <div>
                <strong>
                  Legacy match{match.kind === "table" ? " at a table" : ""}
                </strong>{" "}
                <span>
                  against{" "}
                  {other?.player === "bot"
                    ? "the bot"
                    : (other?.handle ?? "a player")}
                </span>
                <small>
                  Best of three · {score(wins, match.your_seat)} ·{" "}
                  {match.status === "sideboarding"
                    ? `Sideboarding for game ${match.game_number}`
                    : `Game ${match.game_number} in play`}
                </small>
              </div>
              <div className={game.gameActions}>
                <a className={game.primaryButton} href={`#match/${match.id}`}>
                  Resume
                </a>
                <button
                  type="button"
                  className={game.secondaryButton}
                  onClick={() =>
                    void client
                      .POST("/api/v1/matches/{match_id}/concede", {
                        params: { path: { match_id: match.id } },
                      })
                      .then(() => load())
                  }
                >
                  Concede the match
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
