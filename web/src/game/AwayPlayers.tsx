import { useEffect, useState } from "react";
import type { GameState } from "./connection";
import type { PresenceSeat, Seat } from "./types";
import styles from "./away.module.css";

// Away players at a human table (v0.4.0, docs/tables.md). There are no turn timers: a player
// with no tab open for 2 minutes is away, and the other players still in the game may vote to
// remove them. A majority of them removes the seat, which concedes; the game goes on.

/** "3 min", "45 s": how long a player has been away. */
export function awayFor(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Re-renders every so often, so away times count on between the server's messages. */
function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
}

const gone: Record<NonNullable<PresenceSeat["left"]>, string> = {
  conceded: "conceded",
  removed: "was removed while away",
  eliminated: "is out of the game",
};

export function AwayPlayers({
  state,
  name,
  onVote,
}: {
  state: GameState;
  /** A seat's player, by handle. */
  name: (seat: Seat) => string;
  onVote: (seat: Seat, remove: boolean) => void;
}) {
  const now = useNow(5000);
  const presence = state.presence;
  if (!presence) return null;
  const mine = presence.seats.find((entry) => entry.seat === state.seat);
  const voter = mine !== undefined && mine.left === null;
  const others = presence.seats.filter(
    (entry) =>
      entry.seat !== state.seat &&
      (entry.left === "conceded" ||
        entry.left === "removed" ||
        (entry.left === null && !entry.connected)),
  );
  if (mine?.left !== "removed" && others.length === 0) return null;
  const elapsed = (now - presence.received) / 1000;
  return (
    <section className={styles.away} aria-labelledby="away-title">
      <h2 id="away-title">Players</h2>
      {mine?.left === "removed" && (
        <p role="alert" className={styles.removed}>
          The other players removed you from this game while you were away. It
          goes on without you.
        </p>
      )}
      <ul>
        {others.map((entry) => {
          const who = name(entry.seat);
          if (entry.left)
            return (
              <li key={entry.seat}>
                {who} {gone[entry.left]}.
              </li>
            );
          const away = (entry.away_seconds ?? 0) + elapsed;
          const yours =
            state.seat !== null
              ? entry.yes.includes(state.seat)
                ? true
                : entry.no.includes(state.seat)
                  ? false
                  : null
              : null;
          return (
            <li key={entry.seat} data-removable={entry.removable}>
              <span role="status">
                {who} is away · {awayFor(away)}
              </span>
              {entry.removable && (
                <>
                  <small>
                    {entry.yes.length} of {entry.needed}{" "}
                    {entry.needed === 1 ? "vote" : "votes"} to remove
                    {yours === true
                      ? " · you voted to remove"
                      : yours === false
                        ? " · you voted to wait"
                        : ""}
                  </small>
                  {voter && (
                    <span className={styles.buttons}>
                      <button
                        type="button"
                        className={styles.remove}
                        aria-pressed={yours === true}
                        onClick={() => onVote(entry.seat, true)}
                      >
                        Vote to remove {who}
                      </button>
                      <button
                        type="button"
                        className={styles.wait}
                        aria-pressed={yours === false}
                        onClick={() => onVote(entry.seat, false)}
                      >
                        Keep waiting
                      </button>
                    </span>
                  )}
                </>
              )}
              {!entry.removable && voter && (
                <small>
                  After {awayFor(presence.away_after)} away, you may vote to
                  remove {who}.
                </small>
              )}
            </li>
          );
        })}
      </ul>
      {state.voteRefusal && (
        <p role="alert" className={styles.refusal}>
          {state.voteRefusal}
        </p>
      )}
    </section>
  );
}
