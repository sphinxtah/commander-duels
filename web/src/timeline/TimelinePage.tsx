import { useEffect, useState, type RefObject } from "react";
import { client, describe } from "../api";
import { useWorkflow } from "../app/rollout";
import type { components } from "../generated/api";
import shell from "../App.module.css";
import { Timeline, type TimelineSeat } from "./Timeline";
import styles from "./timeline.module.css";

// A game's timeline on a page of its own (v1.0.0, docs/timeline.md): #timeline/<game>, opened from
// Your games and from the match history once a game is over, for as long as its events are kept
// (90 days). It reads the same events through the same eyes as the table's drawer did: its
// reader's own seat's. A game that is still running is read as it goes on.

type GameSummary = components["schemas"]["GameSummary"];

export const TIMELINE_ROUTE = /^#timeline\/([0-9a-f-]{36})$/i;

const FORMATS: Record<GameSummary["format"], string> = {
  legacy: "Legacy",
  commander: "Commander",
  two_headed_giant: "Two-Headed Giant",
  kings_table: "King’s Table",
};

/** The seats of a game by the names its players go by: a handle, or a bot by its seat. */
export function seatsOf(game: GameSummary): TimelineSeat[] {
  return game.seats.map((entry) => ({
    seat: entry.seat,
    name:
      entry.handle ??
      (entry.player === "bot"
        ? `Bot ${entry.seat + 1}`
        : `Player ${entry.seat + 1}`),
    you: entry.seat === game.your_seat,
  }));
}

function when(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function TimelinePage({
  gameId,
  heading,
}: {
  gameId: string;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [loaded, setLoaded] = useState<{
    id: string;
    game?: GameSummary;
    error?: string;
  }>({ id: "" });
  useEffect(() => {
    let cancelled = false;
    void client
      .GET("/api/v1/games/{game_id}", {
        params: { path: { game_id: gameId } },
      })
      .then(({ data, error, response }) => {
        if (cancelled) return;
        setLoaded(
          data
            ? { id: gameId, game: data.game }
            : {
                id: gameId,
                error:
                  response.status === 404
                    ? "No such game, or it is not one of yours."
                    : describe(error),
              },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [gameId]);
  useEffect(() => {
    document.title = "Commander Duels · Timeline";
    return () => {
      document.title = "Commander Duels";
    };
  }, []);

  // The game played back (v1.0.0, ../replay), where replays are open to the account.
  const replays = useWorkflow("replays");
  const game = loaded.id === gameId ? loaded.game : undefined;
  const error = loaded.id === gameId ? loaded.error : undefined;
  const running = game?.status === "active";
  return (
    <div className={styles.page}>
      <header>
        <span className={shell.eyebrow}>
          {game ? FORMATS[game.format].toUpperCase() : "A GAME"} · TIMELINE
        </span>
        <h1 ref={heading} tabIndex={-1}>
          The game, event by event
        </h1>
        {game && (
          <p>
            {seatsOf(game)
              .map((entry) => entry.name)
              .join(", ")}{" "}
            · {when(game.finished_at ?? game.created_at)}
            {running
              ? " · still being played"
              : game.status === "saved"
                ? " · saved, to be played on"
                : ""}
            . You see what your own seat saw, and nothing that was hidden from
            it. <a href="#play/games">Your games</a>
            {replays && game.status !== "active" && game.status !== "saved" && (
              <>
                {" · "}
                <a href={`#replay/${game.id}`}>Play it back as a replay</a>
              </>
            )}
            {running && (
              <>
                {" · "}
                <a href={`#game/${game.id}`}>Back to the table</a>
              </>
            )}
          </p>
        )}
      </header>
      {error && <p role="alert">{error}</p>}
      {!game && !error && <p role="status">Reading the game…</p>}
      {game && (
        <div className={styles.pagePanel}>
          <Timeline
            key={game.id}
            gameId={game.id}
            seats={seatsOf(game)}
            live={running}
          />
        </div>
      )}
    </div>
  );
}
