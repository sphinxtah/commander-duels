import { useEffect, useRef, useState } from "react";
import { client, describe } from "../api";
import {
  duration,
  formatName,
  opponentsWords,
  outcomeWords,
  type HistoryEntry,
  type HistoryPage,
} from "./records";
import styles from "./records.module.css";

// The games one by one (v0.5.0, PROG08): when, the format, the opponents, the player's own deck
// and its revision, the outcome, the turns and the length, newest first, a page at a time. The
// server sends them only to their player and to SysOp; another seat's deck is never among them.

function when(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** How long a game's events are kept after it (api/events.py, EVENT_RETENTION_DAYS). */
export const TIMELINE_DAYS = 90;

/** Whether a game that ended then still has its events: a day short of the 90, so that a link is
 * never offered to a timeline the daily job is about to remove. */
export function hasTimeline(finishedAt: string, now = Date.now()): boolean {
  const age = now - new Date(finishedAt).getTime();
  return age >= 0 && age < (TIMELINE_DAYS - 1) * 24 * 60 * 60 * 1000;
}

function details(item: HistoryEntry): string {
  const parts = [];
  if (item.deck)
    parts.push(
      item.revision ? `${item.deck}, revision ${item.revision}` : item.deck,
    );
  if (item.turns !== null && item.turns !== undefined)
    parts.push(item.turns === 1 ? "1 turn" : `${item.turns} turns`);
  parts.push(duration(item.seconds));
  return parts.join(" · ");
}

async function page(
  playerId: string | undefined,
  cursor: string | undefined,
): Promise<{ data?: HistoryPage; error?: unknown }> {
  const query = cursor ? { cursor } : {};
  return playerId
    ? client.GET("/api/v1/players/{player_id}/history", {
        params: { path: { player_id: playerId }, query },
      })
    : client.GET("/api/v1/me/history", { params: { query } });
}

/** A player's games: the account's own without a player, or one SysOp may read. */
export function HistoryList({ playerId }: { playerId?: string }) {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  // Only the shown player's answers land: another player's page, or none once gone.
  const generation = useRef(0);

  async function load(cursor?: string) {
    const asked = generation.current;
    setState("loading");
    try {
      const { data, error: refused } = await page(playerId, cursor);
      if (asked !== generation.current) return;
      if (!data) {
        setError(describe(refused));
        return setState("error");
      }
      setItems((before) => (cursor ? [...before, ...data.items] : data.items));
      setNext(data.next);
      setState("ready");
    } catch {
      if (asked !== generation.current) return;
      setError(describe(undefined));
      setState("error");
    }
  }

  // Each player's games load afresh.
  useEffect(() => {
    generation.current += 1;
    setItems([]);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [playerId]);

  return (
    <>
      {state === "error" && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {state === "ready" && items.length === 0 && (
        <p className={styles.fine}>No games finished yet.</p>
      )}
      {items.length > 0 && (
        <ol className={styles.history} aria-label="Games, newest first">
          {items.map((item) => (
            <li
              key={`${item.game_id}:${item.seat}`}
              data-outcome={item.outcome}
            >
              <span className={styles.outcome}>
                {outcomeWords[item.outcome]}
              </span>
              <span className={styles.gameWords}>
                <span>
                  {formatName(item.format)} against{" "}
                  {opponentsWords(item.opponents)}
                </span>
                <small>
                  {details(item)}
                  {/* The game's timeline (v1.0.0), for as long as its events are kept: the
                      account's own games only, read through its own seat's eyes. */}
                  {!playerId && hasTimeline(item.finished_at) && (
                    <>
                      {" · "}
                      <a href={`#timeline/${item.game_id}`}>Timeline</a>
                    </>
                  )}
                </small>
              </span>
              <time dateTime={item.finished_at}>{when(item.finished_at)}</time>
            </li>
          ))}
        </ol>
      )}
      {state === "loading" && <p className={styles.fine}>Loading games…</p>}
      {next && state !== "loading" && (
        <button
          type="button"
          className={styles.more}
          onClick={() => void load(next)}
        >
          Show older games
        </button>
      )}
    </>
  );
}
