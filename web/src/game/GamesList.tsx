import { useCallback, useEffect, useRef, useState } from "react";
import { hasTimeline } from "../records/HistoryList";
import { client, type Me } from "../api";
import { useWorkflow } from "../app/rollout";
import { COURT } from "../campaign/campaign";
import { RunningMatches } from "../matches/RunningMatches";
import { seatTitle } from "../tables/kingsTable";
import { SavedGames, useSaves } from "./saves";
import { getSoundEngine } from "./sound/engine";
import {
  ago,
  deckName,
  formatNames,
  outcome,
  plainClick,
  tableFullscreen,
  type GameSummary,
} from "./practice";
import styles from "./game.module.css";

/** The account's games, newest first: asked for again whenever `key` changes; only the latest
 * request's answer is kept (v0.8.6), so a slow older one never replaces it. */
export function useGames(everyone = false): {
  games: GameSummary[] | undefined;
  refresh: () => Promise<void>;
} {
  const [games, setGames] = useState<GameSummary[]>();
  const refreshes = useRef(0);
  const refresh = useCallback(async () => {
    const number = ++refreshes.current;
    const answer = await client
      .GET("/api/v1/games", {
        params: { query: { scope: everyone ? "all" : "mine" } },
      })
      .catch(() => undefined);
    if (number === refreshes.current) setGames(answer?.data ?? []);
  }, [everyone]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { games, refresh };
}

/**
 * The account's games (v1.0.0): the ones saved to be played on later, to resume or discard (where
 * save and resume is open to the account), the ones running, to resume or close, and the last
 * eight that ended. Until v1.0.0 this list sat under the practice table's options on the Play page; the Play
 * wizard took that page, so the list has a page of its own (#play/games), opened from the wizard's
 * first slide (the owner's choice). SysOp may list every player's games.
 */
export function GamesList({ me }: { me: Me }) {
  const sysop = me.permissions.includes("games.view_concealed");
  const [everyone, setEveryone] = useState(false);
  const { games, refresh } = useGames(everyone);
  // Saved games (v1.0.0, saves.tsx): the account's own, whoever's games are listed below.
  const saving = useWorkflow("save_resume");
  const { saves, refresh: refreshSaves } = useSaves(saving);
  // The campaign's court closed by its own player is the court lost (v0.9.8): closing it asks first.
  const [closingCourt, setClosingCourt] = useState<GameSummary | null>(null);
  const courtDialog = useRef<HTMLDialogElement>(null);

  async function close(game: GameSummary) {
    await client.POST("/api/v1/games/{game_id}/close", {
      params: { path: { game_id: game.id } },
    });
    void refresh();
  }

  const active = games?.filter((g) => g.status === "active") ?? [];
  // A saved game is listed above, with its save; without the list (the workflow closed again)
  // it stays among the others, and says that it is saved.
  const recent =
    games
      ?.filter(
        (g) =>
          g.status !== "active" &&
          !(g.status === "saved" && saves && !everyone),
      )
      .slice(0, 8) ?? [];

  return (
    <section
      className={styles.table}
      aria-label={everyone ? "Every player's games" : "Your games"}
    >
      <RunningMatches refreshKey={games} />
      {saves && !everyone && (
        <SavedGames
          saves={saves}
          onChanged={() => {
            void refreshSaves();
            void refresh();
          }}
        />
      )}
      <div className={styles.gamesHead}>
        <h2>{everyone ? "Every player's games" : "Running and recent"}</h2>
        {sysop && (
          <label className={styles.switch}>
            <input
              type="checkbox"
              checked={everyone}
              onChange={(event) => setEveryone(event.target.checked)}
            />
            <span>Show every player's games</span>
          </label>
        )}
      </div>
      {!games ? (
        <p role="status">Loading games…</p>
      ) : active.length + recent.length === 0 ? (
        <p className={styles.hint}>
          {games.length === 0 ? "No games yet." : "No other games yet."}
        </p>
      ) : (
        <ul className={styles.games}>
          {[...active, ...recent].map((game) => {
            const players = game.seats
              .map((seat) =>
                seat.player === "bot" ? "Bot" : (seat.handle ?? "Player"),
              )
              .join(" · ");
            return (
              <li key={game.id} data-status={game.status}>
                <div>
                  <strong>
                    {formatNames[game.format]}
                    {game.kind === "table" ? " table" : ""}
                  </strong>{" "}
                  {game.kings_table && game.your_seat !== null && (
                    <span>{seatTitle(game.your_seat)} · </span>
                  )}
                  <span>{players}</span>
                  <small>
                    {game.match ? `Game ${game.match.game} of a match · ` : ""}
                    {outcome(game)} · started {ago(game.created_at)}
                    {game.your_seat !== null &&
                      ` · ${deckName(game.seats.find((s) => s.seat === game.your_seat)?.deck)}`}
                  </small>
                </div>
                {game.status !== "active" &&
                  game.status !== "saved" &&
                  game.your_seat !== null &&
                  hasTimeline(game.finished_at ?? game.created_at) && (
                    <div className={styles.gameActions}>
                      {/* The game's timeline (v1.0.0), while its events are kept. */}
                      <a
                        className={styles.secondaryButton}
                        href={`#timeline/${game.id}`}
                      >
                        Timeline
                      </a>
                    </div>
                  )}
                {game.status === "active" && (
                  <div className={styles.gameActions}>
                    <a
                      className={styles.primaryButton}
                      href={`#game/${game.id}`}
                      onClick={(event) => {
                        if (plainClick(event.nativeEvent)) {
                          void tableFullscreen();
                          getSoundEngine().unlock();
                        }
                      }}
                    >
                      {game.your_seat === null ? "Observe" : "Resume"}
                    </a>
                    {/* A table's game goes on for the other players: they concede in the game
                        instead (v0.4.0). SysOp may still close it. */}
                    {(game.kind !== "table" || sysop) && (
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => {
                          if (
                            game.campaign?.encounter === COURT &&
                            game.your_seat !== null
                          ) {
                            setClosingCourt(game);
                            courtDialog.current?.showModal();
                          } else void close(game);
                        }}
                      >
                        Close
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <dialog
        ref={courtDialog}
        className={styles.confirm}
        aria-labelledby="close-court-title"
        onClose={() => setClosingCourt(null)}
      >
        <h2 id="close-court-title">Close the court and lose it?</h2>
        <p>
          Closing the court counts as losing it: you go back to ward 14 and must
          make The Sphinx flee again to return. A court nobody plays for an hour
          is lost the same way. To take a break, leave it open and resume it
          here within the hour.
        </p>
        <form method="dialog" className={styles.confirmButtons}>
          <button type="submit" className={styles.secondaryButton} autoFocus>
            Keep the court
          </button>
          <button
            type="submit"
            className={styles.dangerButton}
            onClick={() => closingCourt && void close(closingCourt)}
          >
            Close and lose it
          </button>
        </form>
      </dialog>
    </section>
  );
}
