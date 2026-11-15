import { useEffect, useState, type RefObject } from "react";
import shell from "../App.module.css";
import { deckName, formatNames, type GameSummary } from "../game/practice";
import { seatsOf } from "../timeline/TimelinePage";
import type { TimelineSeat } from "../timeline/Timeline";
import timeline from "../timeline/timeline.module.css";
import { ReplayPlayer } from "./Replay";
import {
  dayOf,
  readReplay,
  readReplays,
  replayHref,
  unshareReplay,
  type Replay,
  type ReplayEntry,
  type ReplayList,
} from "./replay";
import styles from "./replay.module.css";

// A replay on a page of its own (v1.0.0, docs/replays.md): #replay/<game> for a game the reader
// played, #replay/<game>/<player> for the one that player shared with them; and #replays, the
// list of both. Opened from Your games, the match history, a game's result, the timeline's page
// and the bell.

/** How the game ended, said for the seat the replay is read through. */
export function resultWords(
  game: GameSummary,
  seat: number,
  yours: boolean,
  seatName: (seat: number) => string,
): string {
  if (game.status === "interrupted") return "Interrupted before it ended";
  const result = game.result;
  if (!result) return "Finished";
  const turns = `${result.turns} turn${result.turns === 1 ? "" : "s"}`;
  if (result.draw) return `A draw after ${turns}`;
  const winners = result.winner_seats?.length
    ? result.winner_seats
    : result.winner_seat !== null
      ? [result.winner_seat]
      : [];
  if (winners.length) {
    if (winners.includes(seat))
      return yours
        ? `You won in ${turns}`
        : `${seatName(seat)} won in ${turns}`;
    const names = winners.map(seatName).join(" and ");
    return yours ? `You lost in ${turns}` : `${names} won in ${turns}`;
  }
  const kinds: Record<string, string> = {
    turn_limit: "The turn limit",
    closed: "Closed",
    idle_timeout: "Timed out",
    humans_eliminated: "Lost",
    error: "An engine error",
  };
  return `${kinds[result.kind] ?? "Finished"} after ${turns}`;
}

/** The seats by name, the one the replay is read through marked as the reader's own eyes. */
function seatsThrough(game: GameSummary, seat: number): TimelineSeat[] {
  return seatsOf(game).map((entry) => ({ ...entry, you: entry.seat === seat }));
}

export function ReplayPage({
  gameId,
  sharedBy,
  heading,
}: {
  gameId: string;
  sharedBy: string | null;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const key = `${gameId}/${sharedBy ?? ""}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    replay?: Replay;
    error?: string;
  }>({ key: "" });
  useEffect(() => {
    let cancelled = false;
    void readReplay(gameId, sharedBy).then(({ replay, error, status }) => {
      if (cancelled) return;
      setLoaded(
        replay
          ? { key, replay }
          : {
              key,
              error:
                status === 404
                  ? "No such replay. It may have been taken back, its 90 days may be over, or replays may not be open to your account yet."
                  : error,
            },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [gameId, sharedBy, key]);
  useEffect(() => {
    document.title = "Commander Duels · Replay";
    return () => {
      document.title = "Commander Duels";
    };
  }, []);

  const replay = loaded.key === key ? loaded.replay : undefined;
  const error = loaded.key === key ? loaded.error : undefined;
  const game = replay?.game;
  const seats = replay ? seatsThrough(replay.game, replay.through.seat) : [];
  const seatName = (seat: number) =>
    seats.find((entry) => entry.seat === seat)?.name ?? `Player ${seat + 1}`;
  const sharer = replay?.through.shared_by;

  async function giveUp() {
    if (!replay?.through.grant_id) return;
    const { error: failed } = await unshareReplay(
      replay.game.id,
      replay.through.grant_id,
    );
    if (!failed) window.location.hash = "#replays";
  }

  return (
    <div className={`${timeline.page} ${styles.page}`}>
      <header>
        <span className={shell.eyebrow}>
          {game ? formatNames[game.format].toUpperCase() : "A GAME"} · REPLAY
        </span>
        <h1 ref={heading} tabIndex={-1}>
          The game, played back
        </h1>
        {replay && game && (
          <>
            <p>
              {seats.map((entry) => entry.name).join(", ")} ·{" "}
              {dayOf(game.finished_at ?? game.created_at)} ·{" "}
              {resultWords(
                game,
                replay.through.seat,
                replay.through.yours,
                seatName,
              )}
              .
            </p>
            <p>
              {replay.through.yours ? (
                <>
                  You see what your own seat saw, and nothing that was hidden
                  from it.
                </>
              ) : (
                <>
                  <strong>{sharer?.handle ?? "A friend"}</strong> shared this
                  with you: you see what their seat,{" "}
                  {seatName(replay.through.seat)}’s, saw.
                </>
              )}
              {replay.deck && (
                <>
                  {" "}
                  {replay.through.yours ? "Your deck" : "Their deck"}:{" "}
                  {replay.deck.deck_id ? (
                    <a href={`#deck/${replay.deck.deck_id}`}>
                      {replay.deck.title}
                    </a>
                  ) : replay.deck.version === null ? (
                    // A deck with no saved version is named as the table names it.
                    deckName(replay.deck.title)
                  ) : (
                    replay.deck.title
                  )}
                  {replay.deck.version !== null &&
                    `, version ${replay.deck.version}`}
                  .
                </>
              )}{" "}
              Kept until {dayOf(replay.kept_until)}.
            </p>
            <p>
              <a href="#replays">Replays</a>
              {replay.through.yours && (
                <>
                  {" · "}
                  <a href={`#timeline/${game.id}`}>
                    The whole timeline, to read and narrow
                  </a>
                </>
              )}
              {!replay.through.yours && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => void giveUp()}
                  >
                    Remove it from my replays
                  </button>
                </>
              )}
            </p>
          </>
        )}
      </header>
      {error && <p role="alert">{error}</p>}
      {!replay && !error && <p role="status">Reading the replay…</p>}
      {replay && (
        <div className={timeline.pagePanel}>
          <ReplayPlayer
            key={key}
            replay={replay}
            seats={seats}
            onReplay={(next) => setLoaded({ key, replay: next })}
          />
        </div>
      )}
    </div>
  );
}

function Entry({ entry }: { entry: ReplayEntry }) {
  const game = entry.game;
  const sharer = entry.through.shared_by;
  const seats = seatsThrough(game, entry.through.seat);
  const seatName = (seat: number) =>
    seats.find((found) => found.seat === seat)?.name ?? `Player ${seat + 1}`;
  const kept = [
    entry.marks ? `${entry.marks} bookmark${entry.marks === 1 ? "" : "s"}` : "",
    entry.noted ? "a note" : "",
    entry.shares
      ? `shared with ${entry.shares} friend${entry.shares === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);
  return (
    <li>
      <div>
        <strong>
          {formatNames[game.format]}
          {game.kind === "table" ? " table" : ""}
        </strong>{" "}
        <span>{seats.map((seat) => seat.name).join(" · ")}</span>
        <small>
          {dayOf(game.finished_at ?? game.created_at)} ·{" "}
          {resultWords(game, entry.through.seat, entry.through.yours, seatName)}
          {entry.turns ? ` · ${entry.turns} turns` : ""}
          {sharer ? ` · shared by ${sharer.handle}` : ""}
          {kept.length ? ` · ${kept.join(", ")}` : ""} · kept until{" "}
          {dayOf(entry.kept_until)}
        </small>
      </div>
      <a className={styles.action} href={replayHref(game.id, sharer?.id)}>
        Watch
      </a>
    </li>
  );
}

export function ReplaysPage({
  heading,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [list, setList] = useState<ReplayList | null>();
  useEffect(() => {
    let cancelled = false;
    void readReplays().then((found) => {
      if (!cancelled) setList(found ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className={`${timeline.page} ${styles.page}`}>
      <header>
        <span className={shell.eyebrow}>PLAY · REPLAYS</span>
        <h1 ref={heading} tabIndex={-1}>
          Replays
        </h1>
        <p>
          Every game you finish can be played back for 90 days: step by step,
          through your own seat’s eyes, with your own bookmarks and notes.{" "}
          <a href="#play/games">Your games</a>
        </p>
      </header>
      {list === undefined && <p role="status">Reading your replays…</p>}
      {list === null && (
        <p role="alert">
          The replays could not be read. They may not be open to your account
          yet.
        </p>
      )}
      {list && (
        <>
          <section className={timeline.pagePanel} aria-label="Your games">
            <h2>Your games</h2>
            {list.own.length === 0 ? (
              <p className={styles.small}>
                No game of yours has a replay yet. Finish one, and it is here.
              </p>
            ) : (
              <ul className={styles.entries}>
                {list.own.map((entry) => (
                  <Entry key={entry.game.id} entry={entry} />
                ))}
              </ul>
            )}
            {list.more && (
              <p className={styles.small}>
                Older games are in your match history, each with its replay
                while it is kept.
              </p>
            )}
          </section>
          <section className={timeline.pagePanel} aria-label="Shared with you">
            <h2>Shared with you</h2>
            {list.shared.length === 0 ? (
              <p className={styles.small}>
                Nothing yet. A friend can share a replay of a game they played;
                you then see it through their seat.
              </p>
            ) : (
              <ul className={styles.entries}>
                {list.shared.map((entry) => (
                  <Entry
                    key={`${entry.game.id}/${entry.through.grant_id}`}
                    entry={entry}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
