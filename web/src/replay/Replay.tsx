import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { client } from "../api";
import type { components } from "../generated/api";
import {
  describe,
  largeChanges,
  plainText,
  stepWords,
  turnOwners,
  type Line,
} from "../timeline/events";
import { TimelineLines, type TimelineSeat } from "../timeline/Timeline";
import timeline from "../timeline/timeline.module.css";
import {
  dayOf,
  delayOf,
  deleteMark,
  indexAt,
  matches,
  putMark,
  scoreboard,
  shareReplay,
  SPEEDS,
  turnStarts,
  turnStep,
  unshareReplay,
  useReplayEvents,
  type Replay,
  type ReplayMark,
  type Speed,
} from "./replay";
import styles from "./replay.module.css";

// A replay's player (v1.0.0, docs/replays.md): the game's timeline played step by step over a
// scoreboard, with pause, speed, turns to step and jump by, a search, and the reader's own
// bookmarks and notes. It lists the lines up to where it stands, the newest at the foot, so
// what comes next is not told before it is played.

type FriendList = components["schemas"]["FriendList"];
type PlayerSummary = components["schemas"]["PlayerSummary"];

/** How many lines the list shows at most: the ones leading up to where the replay stands. */
export const WINDOW = 80;

const LABEL_MAX = 80;
const NOTE_MAX = 2000;

const NONE: readonly number[] = [];
/** The seats the game's result names as its winners. */
function winnersOf(replay: Replay): readonly number[] {
  const result = replay.game.result;
  if (!result || result.draw) return NONE;
  if (result.winner_seats?.length) return result.winner_seats;
  return typeof result.winner_seat === "number" ? [result.winner_seat] : NONE;
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function Scoreboard({
  seats,
  scores,
  counted,
  active,
  through,
  winners,
}: {
  seats: readonly TimelineSeat[];
  scores: ReturnType<ReturnType<typeof scoreboard>["at"]>;
  counted: boolean;
  /** Whose turn it is where the replay stands. */
  active: number | undefined;
  through: number;
  /** The seats that won, once the replay stands at the game's end: a duel's events tell who
   * lost, and the game's result who won. */
  winners: readonly number[];
}) {
  const count = (value: number | null) => (value === null ? "–" : value);
  return (
    <div className={styles.scores}>
      <table>
        <caption className={styles.hidden}>
          Each player’s counts where the replay stands
        </caption>
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Life</th>
            <th scope="col">Hand</th>
            <th scope="col">Library</th>
            <th scope="col">
              <abbr title="Permanents on the battlefield">Board</abbr>
            </th>
            <th scope="col">
              <abbr title="Cards in the graveyard">Yard</abbr>
            </th>
          </tr>
        </thead>
        <tbody>
          {scores.map((score) => {
            const seat = seats.find((entry) => entry.seat === score.seat);
            return (
              <tr
                key={score.seat}
                data-active={score.seat === active || undefined}
                data-out={score.out || undefined}
              >
                <th scope="row">
                  <span
                    className={timeline.player}
                    data-you={score.seat === through || undefined}
                  >
                    {seat?.name ?? `Player ${score.seat + 1}`}
                  </span>
                  {score.seat === active && (
                    <span className={styles.tag}>their turn</span>
                  )}
                  {(score.won || winners.includes(score.seat)) && (
                    <span className={styles.tag}>won</span>
                  )}
                  {score.out && !score.won && !winners.includes(score.seat) && (
                    <span className={styles.tag}>out</span>
                  )}
                </th>
                <td className={styles.life}>{score.life}</td>
                <td>{count(score.hand)}</td>
                <td>{count(score.library)}</td>
                <td>{count(score.battlefield)}</td>
                <td>{count(score.graveyard)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!counted && (
        <p className={styles.small}>
          This game was recorded before replays: it tells each player’s life,
          and not the other counts.
        </p>
      )}
    </div>
  );
}

function Sharing({
  replay,
  onReplay,
}: {
  replay: Replay;
  onReplay(next: Replay): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [friends, setFriends] = useState<PlayerSummary[]>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const title = useId();

  async function open() {
    setError("");
    dialog.current?.showModal();
    const { data } = await client.GET("/api/v1/friends");
    setFriends((data as FriendList | undefined)?.friends ?? []);
  }
  async function share(player: PlayerSummary) {
    setBusy(player.id);
    const { replay: next, error: failed } = await shareReplay(
      replay.game.id,
      player.id,
    );
    setBusy("");
    setError(failed ?? "");
    if (next) onReplay(next);
  }
  async function takeBack(grantId: string) {
    setBusy(grantId);
    const { error: failed } = await unshareReplay(replay.game.id, grantId);
    setBusy("");
    setError(failed ?? "");
    if (!failed)
      onReplay({
        ...replay,
        shares: replay.shares.filter((share) => share.id !== grantId),
      });
  }

  const sharedWith = new Map(
    replay.shares.map((share) => [share.player.id, share]),
  );
  return (
    <section className={styles.panel} aria-label="Sharing">
      <h2>Sharing</h2>
      {replay.shares.length === 0 ? (
        <p className={styles.small}>Only you can open this replay.</p>
      ) : (
        <ul className={styles.shares}>
          {replay.shares.map((share) => (
            <li key={share.id}>
              <span>
                Shared with <strong>{share.player.handle}</strong>
              </span>
              <button
                type="button"
                disabled={busy === share.id}
                onClick={() => void takeBack(share.id)}
              >
                Take back
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={styles.action}
        onClick={() => void open()}
      >
        Share with a friend
      </button>
      <dialog ref={dialog} className={styles.dialog} aria-labelledby={title}>
        <h2 id={title}>Share this replay</h2>
        <p>
          A friend you share it with sees the game through your seat: your hand
          as you saw it, and nothing that was hidden from you. Your bookmarks
          and notes stay yours. It stays shared until you take it back, or until
          the replay goes on {dayOf(replay.kept_until)}.
        </p>
        {error && <p role="alert">{error}</p>}
        {!friends ? (
          <p role="status">Reading your friends…</p>
        ) : friends.length === 0 ? (
          <p>
            You have no friends here yet. <a href="#friends">Find players</a>
          </p>
        ) : (
          <ul className={styles.shares}>
            {friends.map((friend) => {
              const given = sharedWith.get(friend.id);
              return (
                <li key={friend.id}>
                  <span>
                    <strong>{friend.handle}</strong>
                    {given ? " · shared" : ""}
                  </span>
                  {given ? (
                    <button
                      type="button"
                      disabled={busy === given.id}
                      onClick={() => void takeBack(given.id)}
                    >
                      Take back
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === friend.id}
                      onClick={() => void share(friend)}
                    >
                      Share
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <form method="dialog">
          <button type="submit" className={styles.action}>
            Done
          </button>
        </form>
      </dialog>
    </section>
  );
}

export function ReplayPlayer({
  replay,
  seats,
  onReplay,
}: {
  replay: Replay;
  seats: readonly TimelineSeat[];
  /** The header changed: a bookmark, the note, a share. */
  onReplay(next: Replay): void;
}) {
  const gameId = replay.game.id;
  const sharedBy = replay.through.shared_by?.id ?? null;
  const loading = useReplayEvents(gameId, sharedBy);
  const { events } = loading;
  const id = useId();

  const seatName = useCallback(
    (number: number) =>
      seats.find((entry) => entry.seat === number)?.name ??
      `Player ${number + 1}`,
    [seats],
  );
  const lines = useMemo(
    () => describe(events).filter((line) => !line.quiet),
    [events],
  );
  const owners = useMemo(() => {
    const found = new Map<number, number>(
      Object.entries(loading.turns).map(([turn, seat]) => [Number(turn), seat]),
    );
    for (const [turn, seat] of turnOwners(events)) found.set(turn, seat);
    return found;
  }, [events, loading.turns]);
  const large = useMemo(() => largeChanges(events), [events]);
  const board = useMemo(
    () => scoreboard(events, replay.starting),
    [events, replay.starting],
  );
  const starts = useMemo(() => turnStarts(lines), [lines]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [said, setSaid] = useState("");
  const last = lines.length - 1;
  const at = Math.min(index, Math.max(0, last));
  const line: Line | undefined = lines[at];
  const seq = line?.seq ?? 0;
  const ended = loading.done && at >= last;

  const say = useCallback(
    (target: Line | undefined) => {
      if (!target) return;
      const owner = owners.get(target.turn);
      setSaid(
        [
          target.turn < 1
            ? "Before the first turn"
            : `Turn ${target.turn}${owner !== undefined ? `, ${seatName(owner)}` : ""}`,
          stepWords(target.step),
          plainText(target.text, seatName),
        ]
          .filter(Boolean)
          .join(". "),
      );
    },
    [owners, seatName],
  );
  /** Goes to a line at the reader's own word: playback stops, and the line is said. */
  const seek = useCallback(
    (next: number) => {
      const bounded = Math.max(0, Math.min(last, next));
      setPlaying(false);
      setIndex(bounded);
      say(lines[bounded]);
    },
    [last, lines, say],
  );

  // Playback: the next line after the current one has stood its time. At the end of what has
  // been read so far it waits for the rest; at the end of the game it stops.
  useEffect(() => {
    if (!playing) return;
    if (at >= last) {
      if (loading.done) {
        setPlaying(false);
        setSaid("The end of the game.");
      }
      return;
    }
    const wait = window.setTimeout(
      () => setIndex(at + 1),
      delayOf(lines[at], speed),
    );
    return () => window.clearTimeout(wait);
  }, [playing, at, last, lines, speed, loading.done]);

  // The list keeps its foot, where the current line is, in view.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [at, lines.length]);

  function toggle() {
    if (ended) {
      // Played to its end: Play starts it again.
      setIndex(0);
      setPlaying(true);
      setSaid("Playing from the start.");
      return;
    }
    setPlaying((before) => {
      setSaid(before ? "Paused." : "Playing.");
      return !before;
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (typing(event.target) || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const onButton =
      event.target instanceof HTMLElement &&
      ["BUTTON", "A", "SUMMARY"].includes(event.target.tagName);
    let handled = true;
    if (event.key === "k" || (event.key === " " && !onButton)) toggle();
    else if (event.key === "ArrowRight")
      seek(event.shiftKey ? turnStep(lines, at, 1) : at + 1);
    else if (event.key === "ArrowLeft")
      seek(event.shiftKey ? turnStep(lines, at, -1) : at - 1);
    else if (event.key === "Home") seek(0);
    else if (event.key === "End") seek(last);
    else handled = false;
    if (handled) event.preventDefault();
  }

  // The search: among the lines' own words, which are only what this seat saw.
  const [typed, setTyped] = useState("");
  const found = useMemo(
    () => matches(lines, typed, seatName),
    [lines, typed, seatName],
  );
  const foundAt = found.indexOf(at);
  function findNext(direction: -1 | 1) {
    if (!found.length) return;
    const next =
      direction === 1
        ? (found.find((entry) => entry > at) ?? found[0]!)
        : ([...found].reverse().find((entry) => entry < at) ?? found.at(-1)!);
    seek(next);
  }

  // Bookmarks and the note: the reader's own.
  const marks = replay.marks;
  const marked = useMemo(() => new Set(marks.map((mark) => mark.seq)), [marks]);
  const [editing, setEditing] = useState<{
    seq: number;
    label: string;
    note: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState("");
  const [note, setNote] = useState(replay.note);
  const [noteSaved, setNoteSaved] = useState(false);

  async function saveMark() {
    if (!editing) return;
    setSaving(true);
    const { replay: next, error } = await putMark(
      gameId,
      editing.seq,
      { label: editing.label, note: editing.note },
      sharedBy,
    );
    setSaving(false);
    setFailed(error ?? "");
    if (next) {
      onReplay(next);
      setEditing(null);
    }
  }
  async function removeMark(mark: ReplayMark) {
    const { replay: next, error } = await deleteMark(
      gameId,
      mark.seq,
      sharedBy,
    );
    setFailed(error ?? "");
    if (next) onReplay(next);
  }
  async function saveNote() {
    setSaving(true);
    const { replay: next, error } = await putMark(
      gameId,
      0,
      { note },
      sharedBy,
    );
    setSaving(false);
    setFailed(error ?? "");
    if (next) {
      onReplay(next);
      setNoteSaved(true);
    }
  }

  const from = Math.max(0, at - WINDOW + 1);
  const shown = lines.slice(from, at + 1);
  const turn = line?.turn ?? 0;
  const active = owners.get(turn);
  const readSoFar = events.at(-1)?.seq ?? 0;

  if (loading.error && !lines.length)
    return (
      <p role="alert">
        The replay could not be read. {loading.error}{" "}
        <button type="button" onClick={loading.retry}>
          Try again
        </button>
      </p>
    );
  if (loading.done && !lines.length)
    return (
      <p>
        This game has no events to play back: they are kept for 90 days after a
        game, and games played before events were recorded have none.
      </p>
    );

  return (
    <div className={styles.player} onKeyDown={onKeyDown}>
      <Scoreboard
        seats={seats}
        scores={board.at(seq)}
        counted={board.counted}
        active={active}
        through={replay.through.seat}
        winners={ended ? winnersOf(replay) : NONE}
      />

      <div className={styles.transport} role="group" aria-label="Playback">
        <div className={styles.buttons}>
          <button
            type="button"
            aria-label="Previous turn"
            title="Previous turn (Shift+Left)"
            disabled={at <= 0}
            onClick={() => seek(turnStep(lines, at, -1))}
          >
            <span aria-hidden="true">⏮</span>
          </button>
          <button
            type="button"
            aria-label="One step back"
            title="One step back (Left)"
            disabled={at <= 0}
            onClick={() => seek(at - 1)}
          >
            <span aria-hidden="true">◀</span>
          </button>
          <button
            type="button"
            className={styles.play}
            aria-pressed={playing}
            title="Play or pause (K)"
            disabled={!lines.length}
            onClick={toggle}
          >
            {playing ? "Pause" : ended ? "Play again" : "Play"}
          </button>
          <button
            type="button"
            aria-label="One step on"
            title="One step on (Right)"
            disabled={at >= last}
            onClick={() => seek(at + 1)}
          >
            <span aria-hidden="true">▶</span>
          </button>
          <button
            type="button"
            aria-label="Next turn"
            title="Next turn (Shift+Right)"
            disabled={at >= last}
            onClick={() => seek(turnStep(lines, at, 1))}
          >
            <span aria-hidden="true">⏭</span>
          </button>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-speed`}>Speed</label>
          <select
            id={`${id}-speed`}
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value) as Speed)}
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-turn`}>Turn</label>
          <select
            id={`${id}-turn`}
            value={turn}
            onChange={(event) => {
              const wanted = Number(event.target.value);
              const start = starts.find((entry) => entry.turn === wanted);
              if (start) seek(start.index);
            }}
          >
            {starts.map((start) => {
              const owner = owners.get(start.turn);
              return (
                <option key={start.turn} value={start.turn}>
                  {start.turn < 1
                    ? "Before turn 1"
                    : `Turn ${start.turn}${owner !== undefined ? ` · ${seatName(owner)}` : ""}`}
                </option>
              );
            })}
          </select>
        </div>
        <div className={styles.place}>
          <input
            type="range"
            min={0}
            max={Math.max(0, last)}
            value={at}
            aria-label="Place in the game"
            aria-valuetext={`Step ${at + 1} of ${lines.length}, turn ${turn}`}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span>
            Step {lines.length ? at + 1 : 0} of {lines.length}
            {turn > 0 ? ` · turn ${turn} of ${replay.turns}` : ""}
            {!loading.done &&
              ` · reading the game, ${readSoFar.toLocaleString("en-US")} of ${replay.events.toLocaleString("en-US")} events`}
          </span>
        </div>
      </div>
      {loading.error && (
        <p role="alert">
          The rest of the replay could not be read. {loading.error}{" "}
          <button type="button" onClick={loading.retry}>
            Try again
          </button>
        </p>
      )}
      <p className={styles.hidden} role="status">
        {said}
      </p>

      <div className={styles.columns}>
        <div className={styles.main}>
          <form
            className={styles.find}
            role="search"
            aria-label="Find in the replay"
            onSubmit={(event) => {
              event.preventDefault();
              findNext(1);
            }}
          >
            <label htmlFor={`${id}-find`}>Find a step</label>
            <input
              id={`${id}-find`}
              type="search"
              value={typed}
              maxLength={80}
              placeholder="A card, a player, a word"
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
            <button
              type="button"
              disabled={!found.length}
              onClick={() => findNext(-1)}
            >
              Previous
            </button>
            <button type="submit" disabled={!found.length}>
              Next
            </button>
            <span role="status">
              {typed.trim()
                ? found.length
                  ? `${foundAt >= 0 ? `${foundAt + 1} of ` : ""}${found.length} found`
                  : loading.done
                    ? "Nothing found. A card you were not shown is found by no name."
                    : "Nothing found so far."
                : ""}
            </span>
          </form>

          <div
            ref={list}
            className={`${timeline.list} ${styles.list}`}
            tabIndex={0}
            role="region"
            aria-label="The game so far"
          >
            {!lines.length && <p role="status">Reading the game’s events…</p>}
            {from > 0 && (
              <p className={styles.small}>
                Earlier steps are behind this one: step back, or pick a turn.
              </p>
            )}
            <TimelineLines
              lines={shown}
              owners={owners}
              large={large}
              seatName={seatName}
              you={replay.through.seat}
              current={seq}
              extra={(shownLine) =>
                marked.has(shownLine.seq) ? (
                  <span className={styles.star}> ★ bookmarked</span>
                ) : null
              }
            />
          </div>
        </div>

        <div className={styles.side}>
          <section className={styles.panel} aria-label="Bookmarks">
            <h2>Bookmarks</h2>
            {failed && <p role="alert">{failed}</p>}
            {editing ? (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveMark();
                }}
              >
                <label htmlFor={`${id}-label`}>Name</label>
                <input
                  id={`${id}-label`}
                  value={editing.label}
                  maxLength={LABEL_MAX}
                  autoComplete="off"
                  onChange={(event) =>
                    setEditing({ ...editing, label: event.target.value })
                  }
                />
                <label htmlFor={`${id}-mark-note`}>Note</label>
                <textarea
                  id={`${id}-mark-note`}
                  rows={3}
                  value={editing.note}
                  maxLength={NOTE_MAX}
                  onChange={(event) =>
                    setEditing({ ...editing, note: event.target.value })
                  }
                />
                <div className={styles.row}>
                  <button
                    type="submit"
                    className={styles.action}
                    disabled={saving}
                  >
                    Save bookmark
                  </button>
                  <button type="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className={styles.action}
                disabled={!line}
                onClick={() => {
                  setPlaying(false);
                  const kept = marks.find((mark) => mark.seq === seq);
                  setEditing({
                    seq,
                    label: kept?.label ?? "",
                    note: kept?.note ?? "",
                  });
                }}
              >
                {marked.has(seq)
                  ? "Edit this step’s bookmark"
                  : "Bookmark this step"}
              </button>
            )}
            {marks.length === 0 ? (
              <p className={styles.small}>
                None yet. A bookmark keeps a place in the game, with a name and
                a note. Only you see them.
              </p>
            ) : (
              <ul className={styles.marks}>
                {marks.map((mark) => (
                  <li key={mark.seq} data-here={mark.seq === seq || undefined}>
                    <button
                      type="button"
                      className={styles.go}
                      disabled={mark.seq > readSoFar}
                      onClick={() =>
                        seek(Math.max(0, indexAt(lines, mark.seq)))
                      }
                    >
                      {mark.turn ? `Turn ${mark.turn}` : "Before turn 1"}
                      {mark.label ? ` · ${mark.label}` : ""}
                    </button>
                    {mark.note && <p>{mark.note}</p>}
                    <div className={styles.row}>
                      <button
                        type="button"
                        aria-label={`Edit the bookmark ${mark.label || `at turn ${mark.turn}`}`}
                        onClick={() =>
                          setEditing({
                            seq: mark.seq,
                            label: mark.label,
                            note: mark.note,
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove the bookmark ${mark.label || `at turn ${mark.turn}`}`}
                        onClick={() => void removeMark(mark)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.panel} aria-label="Your note">
            <h2>
              <label htmlFor={`${id}-note`}>Your note on this game</label>
            </h2>
            <textarea
              id={`${id}-note`}
              rows={4}
              value={note}
              maxLength={NOTE_MAX}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteSaved(false);
              }}
            />
            <div className={styles.row}>
              <button
                type="button"
                className={styles.action}
                disabled={saving || note.trim() === replay.note}
                onClick={() => void saveNote()}
              >
                Save note
              </button>
              <span role="status" className={styles.small}>
                {noteSaved ? "Saved. Only you see it." : ""}
              </span>
            </div>
          </section>

          {replay.through.yours && (
            <Sharing replay={replay} onReplay={onReplay} />
          )}
        </div>
      </div>
    </div>
  );
}
