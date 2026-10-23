import { useCallback, useEffect, useRef, useState } from "react";
import { client, describe } from "../api";
import game from "../game/game.module.css";
import { getSoundEngine } from "../game/sound/engine";
import type { components } from "../generated/api";
import { waited } from "./queue";
import styles from "./queues.module.css";

// Rematch (v0.5.0, docs/queues.md) on a game's result screen. A practice game starts again at
// once with the same settings. At a table, Rematch offers the players still there the same seats
// and decks; the others see the offer here (and through the bell), and it starts once every one
// of them accepts. A player who declines, or leaves the result screen while it is offered, ends
// it, and the others go back to the queue or the lobby. The page follows into the new game.

export type RematchView = components["schemas"]["RematchView"];
type Summary = components["schemas"]["GameSummary"];

/** How often an offer is asked for while it waits for answers. */
export const REMATCH_POLL_MS = 2000;

export interface Rematch {
  view: RematchView | null;
  busy: boolean;
  error: string;
  /** Rematch: start it (practice), offer it, or accept it. */
  ask: () => void;
  decline: () => void;
  /** The game's own address, so a link elsewhere can tell it is leaving. */
  gameId: string;
}

function open(gameId: string) {
  window.location.hash = `#game/${gameId}`;
}

/**
 * The finished game's rematch, for a player of it: asked for once the game's end is recorded,
 * and again every REMATCH_POLL_MS while a table's offer is open. The page opens the new game when
 * it starts, if this page saw it offered or asked for it.
 */
export function useRematch(
  gameId: string,
  summary: Summary | undefined,
  over: boolean,
): Rematch {
  const ready =
    over &&
    summary !== undefined &&
    summary.your_seat !== null &&
    summary.status !== "active";
  const [view, setView] = useState<RematchView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  // Whether this page saw the offer open, or asked: only then does a start open the new game.
  const waitedHere = useRef(false);
  const latest = useRef<RematchView | null>(null);

  const show = useCallback((next: RematchView) => {
    latest.current = next;
    setView(next);
    if (next.status === "open") waitedHere.current = true;
    if (next.status === "started" && next.game_id && waitedHere.current) {
      waitedHere.current = false;
      open(next.game_id);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    void client
      .GET("/api/v1/games/{game_id}/rematch", {
        params: { path: { game_id: gameId } },
      })
      .then(({ data }) => {
        if (active && data) show(data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [ready, gameId, tick, show]);

  // A table's offer is asked for again while it may still change: every REMATCH_POLL_MS from
  // the last asking.
  const waiting =
    view !== null &&
    view.kind === "table" &&
    (view.status === "open" || (view.status === "none" && view.can_offer));
  useEffect(() => {
    if (!ready || !waiting) return;
    const timer = setTimeout(() => setTick((n) => n + 1), REMATCH_POLL_MS);
    return () => clearTimeout(timer);
  }, [ready, waiting, tick]);

  // Leaving the result screen while an offer stands declines it, so the others need not wait.
  useEffect(() => {
    const leaving = () => {
      const current = latest.current;
      const hash = window.location.hash;
      if (
        current?.status !== "open" ||
        current.your_answer === "no" ||
        hash === `#game/${gameId}` ||
        (current.game_id !== null && hash === `#game/${current.game_id}`)
      )
        return;
      latest.current = { ...current, status: "declined" };
      void client
        .POST("/api/v1/games/{game_id}/rematch/decline", {
          params: { path: { game_id: gameId } },
        })
        .catch(() => undefined);
    };
    window.addEventListener("hashchange", leaving);
    return () => window.removeEventListener("hashchange", leaving);
  }, [gameId]);

  const path = { params: { path: { game_id: gameId } } };
  async function act(
    request: () => Promise<{ data?: RematchView; error?: unknown }>,
  ) {
    setError("");
    setBusy(true);
    const { data, error: failure } = await request().catch(() => ({
      data: undefined,
      error: undefined,
    }));
    setBusy(false);
    if (data) show(data);
    else {
      setError(describe(failure));
      setTick((n) => n + 1);
    }
  }
  return {
    view,
    busy,
    error,
    gameId,
    ask: () => {
      // Sound starts only from a click: this may be the last one before the game opens.
      getSoundEngine().unlock();
      waitedHere.current = true;
      void act(() => client.POST("/api/v1/games/{game_id}/rematch", path));
    },
    decline: () =>
      void act(() =>
        client.POST("/api/v1/games/{game_id}/rematch/decline", path),
      ),
  };
}

/** The time an offer has left, counted down in the page from the last answer. */
function useLeft(view: RematchView | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  const [since, setSince] = useState(() => Date.now());
  const seconds = view?.expires_in ?? null;
  useEffect(() => setSince(Date.now()), [view]);
  useEffect(() => {
    if (seconds === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [seconds]);
  // Up to the whole second, as a countdown reads.
  return seconds === null
    ? null
    : Math.max(0, Math.ceil(seconds - Math.max(0, (now - since) / 1000)));
}

/** The rematch's part of the result screen. */
export function RematchPanel({ rematch }: { rematch: Rematch }) {
  const { view, busy, error } = rematch;
  const left = useLeft(view);
  if (!view) return null;
  const others = view.players.filter((player) => !player.you);
  const pending = view.players
    .filter((player) => player.answer === null)
    .map((player) => (player.you ? "you" : (player.handle ?? "a player")));
  return (
    <div className={styles.rematch} data-rematch={view.status}>
      {view.status === "none" && view.can_offer && (
        <>
          <p>
            {view.kind === "practice"
              ? "Play again with the same deck, bots and rules."
              : `Offer ${others.map((p) => p.handle ?? "a player").join(" and ")} the same game again.`}
          </p>
          <div className={styles.buttons}>
            <button
              type="button"
              className={game.primaryButton}
              disabled={busy}
              onClick={rematch.ask}
            >
              {busy ? "Starting…" : "Rematch"}
            </button>
          </div>
        </>
      )}
      {view.status === "open" && (
        <>
          <p role="status">
            {view.your_answer === null
              ? `${view.offered_by ?? "A player"} offers a rematch: the same seats and decks.`
              : pending.length > 0
                ? `Rematch offered. Waiting for ${pending.join(" and ")}…`
                : "Everyone accepted. Starting the rematch…"}
            {left !== null && ` ${waited(left)} left.`}
          </p>
          <ul className={styles.answers} aria-label="Answers">
            {view.players.map((player) => (
              <li key={player.seat}>
                {player.handle ?? "A player"}
                {player.you ? " (you)" : ""}
                <span className={styles.answer} data-answer={player.answer}>
                  {player.answer === "yes"
                    ? "Ready"
                    : player.answer === "no"
                      ? "Declined"
                      : "Waiting"}
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.buttons}>
            {view.your_answer === null && (
              <button
                type="button"
                className={game.primaryButton}
                disabled={busy}
                onClick={rematch.ask}
              >
                Accept rematch
              </button>
            )}
            <button
              type="button"
              className={game.secondaryButton}
              disabled={busy}
              onClick={rematch.decline}
            >
              {view.your_answer === null ? "Decline" : "Withdraw"}
            </button>
          </div>
        </>
      )}
      {view.status === "started" && view.game_id && (
        <p>
          The rematch has started.{" "}
          <a href={`#game/${view.game_id}`} className={styles.link}>
            Open the rematch
          </a>
        </p>
      )}
      {/* The way back, to the queue or the lobby, is the result screen's own link below. */}
      {(view.status === "declined" ||
        view.status === "lapsed" ||
        view.status === "failed") && (
        <p role="status">
          {view.status === "declined"
            ? `${view.declined_by ?? "A player"} declined the rematch.`
            : view.status === "lapsed"
              ? "The rematch offer ran out of time."
              : `The rematch could not start: ${view.message ?? "a player cannot play now."}`}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.refusal}>
          {error}
        </p>
      )}
    </div>
  );
}
