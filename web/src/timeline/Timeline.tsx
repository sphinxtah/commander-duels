import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { client, describe as describeError } from "../api";
import { ManaCost } from "../game/Card";
import { cardImageUrl } from "../game/images";
import { RetryingImage } from "../game/RetryingImage";
import { ruleHref } from "../howToPlay/guide";
import {
  describe,
  GROUPS,
  largeChanges,
  plainText,
  stepWords,
  turnOwners,
  typesFor,
  type Card,
  type GameEvent,
  type GroupId,
  type Line,
  type Piece,
  type Summary,
} from "./events";
import styles from "./timeline.module.css";

// The explainable game timeline (v1.0.0, docs/timeline.md): a game's events as sentences, by turn
// and step, with what explains each (a cost that changed, why a creature died, a spell that did
// not resolve) and the rule that says so, linked into How to play. It can be narrowed to kinds of
// events, to one player, and to a card by name; "What changed?" sums up what a large resolution
// did. It shows what this reader's seat saw and nothing else: the server filters every event, and
// narrows by name only among the names the reader may see. The table's text log stays as it is.

/** How many events one request asks for. */
export const PAGE = 300;
/** How long after the table changed the game's new events are asked for, in ms. */
export const SETTLE_MS = 800;
/** How often a running game's events are asked for while its timeline is open, in ms. */
export const POLL_MS = 5000;
const END = 2147483647;

export interface TimelineSeat {
  seat: number;
  name: string;
  you?: boolean;
}

export interface Filters {
  groups: ReadonlySet<GroupId>;
  seat: number | null;
  text: string;
}

type Query = {
  since?: number;
  before?: number;
  limit: number;
  type?: string;
  seat?: number;
  q?: string;
};

async function page(gameId: string, query: Query) {
  const { data, error } = await client.GET("/api/v1/games/{game_id}/timeline", {
    params: { path: { game_id: gameId }, query },
  });
  if (!data) return { error: describeError(error) };
  return {
    events: data.events as unknown as GameEvent[],
    turns: (data.turns ?? {}) as Record<string, number>,
    next: data.next,
    first: data.first ?? 0,
    more: data.more ?? false,
  };
}

function narrowed(filters: Filters): Pick<Query, "type" | "seat" | "q"> {
  const types = typesFor(filters.groups);
  return {
    ...(types.length ? { type: types.join(",") } : {}),
    ...(filters.seat !== null ? { seat: filters.seat } : {}),
    ...(filters.text.trim() ? { q: filters.text.trim() } : {}),
  };
}

/**
 * A game's events as this reader may see them: the newest page first, earlier ones on demand, and
 * while the game runs (`live`) the new ones, asked for shortly after each change of `pulse` (the
 * table's revision) and every few seconds besides. A game the engine took up again made its later
 * events anew, under a higher epoch: the page is read again from its end.
 */
export function useTimeline(
  gameId: string,
  filters: Filters,
  live: boolean,
  pulse: number,
) {
  const key = JSON.stringify([
    gameId,
    [...filters.groups].sort(),
    filters.seat,
    filters.text.trim().toLowerCase(),
  ]);
  const [loaded, setLoaded] = useState<{
    key: string;
    events: GameEvent[];
    /** Whose turn each turn was, as the pages said it. */
    turns: Record<string, number>;
    earlier: boolean;
    error: string;
    state: "loading" | "ready" | "error";
  }>({
    key,
    events: [],
    turns: {},
    earlier: false,
    error: "",
    state: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const current = useRef(key);
  current.current = key;
  // Where the reading stands: the last number looked at, and the engine's epoch.
  const cursor = useRef({ next: 0, epoch: 0, busy: false });
  const query = useRef(narrowed(filters));
  query.current = narrowed(filters);

  useEffect(() => {
    let cancelled = false;
    cursor.current = { next: 0, epoch: 0, busy: true };
    void page(gameId, { before: END, limit: PAGE, ...query.current }).then(
      (found) => {
        if (cancelled) return;
        cursor.current.busy = false;
        if ("error" in found) {
          setLoaded({
            key,
            events: [],
            turns: {},
            earlier: false,
            error: found.error ?? "",
            state: "error",
          });
          return;
        }
        cursor.current.next = found.events.at(-1)?.seq ?? 0;
        cursor.current.epoch = Math.max(
          0,
          ...found.events.map((event) => event.epoch),
        );
        setLoaded({
          key,
          events: found.events,
          turns: found.turns,
          earlier: found.more,
          error: "",
          state: "ready",
        });
      },
    );
    return () => {
      cancelled = true;
    };
    // The filters are in the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, key, attempt]);

  const refresh = useCallback(async () => {
    const asked = current.current;
    const at = cursor.current;
    if (at.busy) return;
    at.busy = true;
    try {
      const fresh: GameEvent[] = [];
      let turns: Record<string, number> = {};
      let since = at.next;
      for (let pages = 0; pages < 6; pages++) {
        const found = await page(gameId, {
          since,
          limit: PAGE,
          ...query.current,
        });
        if (asked !== current.current || "error" in found) return;
        fresh.push(...found.events);
        turns = { ...turns, ...found.turns };
        since = Math.max(since, found.next);
        if (!found.more) break;
      }
      if (fresh.some((event) => event.epoch > at.epoch)) {
        // The game was taken up again: what was read after its checkpoint is no longer its log.
        setAttempt((n) => n + 1);
        return;
      }
      at.next = since;
      if (fresh.length)
        setLoaded((before) =>
          before.key === asked
            ? {
                ...before,
                turns: { ...before.turns, ...turns },
                events: [
                  ...before.events,
                  ...fresh.filter(
                    (event) => event.seq > (before.events.at(-1)?.seq ?? 0),
                  ),
                ],
              }
            : before,
        );
    } finally {
      at.busy = false;
    }
  }, [gameId]);

  useEffect(() => {
    if (!live || loaded.state !== "ready" || loaded.key !== key) return;
    const soon = window.setTimeout(() => void refresh(), SETTLE_MS);
    const often = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      window.clearTimeout(soon);
      window.clearInterval(often);
    };
  }, [live, pulse, refresh, loaded.state, loaded.key, key]);

  const loadEarlier = useCallback(async () => {
    const asked = current.current;
    const first = loaded.events[0]?.seq;
    if (!first || loadingEarlier) return;
    setLoadingEarlier(true);
    const found = await page(gameId, {
      before: first,
      limit: PAGE,
      ...query.current,
    });
    setLoadingEarlier(false);
    if (asked !== current.current || "error" in found) return;
    setLoaded((before) =>
      before.key === asked
        ? {
            ...before,
            turns: { ...found.turns, ...before.turns },
            events: [...found.events, ...before.events],
            earlier: found.more,
          }
        : before,
    );
  }, [gameId, loaded.events, loadingEarlier]);

  const fresh = loaded.key === key;
  return {
    events: fresh ? loaded.events : [],
    turns: fresh ? loaded.turns : {},
    state: fresh ? loaded.state : ("loading" as const),
    error: fresh ? loaded.error : "",
    earlier: fresh && loaded.earlier,
    loadEarlier,
    loadingEarlier,
    retry: () => setAttempt((n) => n + 1),
  };
}

function Pieces({
  pieces,
  seatName,
  you,
  shown,
  onCard,
  newTab,
  owner,
}: {
  pieces: readonly Piece[];
  seatName(seat: number): string;
  you: number | null;
  /** The card whose picture is open under this line, by its id. */
  shown: string | null;
  onCard(card: Card): void;
  newTab: boolean;
  /** The preview's id, for the buttons that open it. */
  owner: string;
}) {
  return (
    <>
      {pieces.map((part, index) => {
        if (typeof part === "string")
          return <Fragment key={index}>{part}</Fragment>;
        if ("card" in part)
          return part.card.name ? (
            <button
              key={index}
              type="button"
              className={styles.card}
              aria-expanded={shown === part.card.ref}
              aria-controls={owner}
              onClick={() => onCard(part.card)}
            >
              {part.card.name}
            </button>
          ) : (
            <span key={index} className={styles.unseen}>
              {index ? "a card" : "A card"}
            </span>
          );
        if ("hidden" in part)
          return (
            <span key={index} className={styles.unseen}>
              {index ? "a hidden card" : "A hidden card"}
            </span>
          );
        if ("seat" in part)
          return (
            <span
              key={index}
              className={styles.player}
              data-you={part.seat === you || undefined}
            >
              {seatName(part.seat)}
            </span>
          );
        if ("cost" in part) return <ManaCost key={index} cost={part.cost} />;
        return (
          <a
            key={index}
            className={styles.rule}
            href={newTab ? `/${ruleHref(part.rule)}` : ruleHref(part.rule)}
            {...(newTab ? { target: "_blank", rel: "noopener" } : {})}
            aria-label={`Rule ${part.rule}, in How to play${newTab ? " (opens a new tab)" : ""}`}
          >
            rule {part.rule}
          </a>
        );
      })}
    </>
  );
}

function WhatChanged({
  summary,
  open,
  children,
}: {
  summary: Summary;
  open: boolean;
  children(pieces: readonly Piece[]): ReactNode;
}) {
  const box = useRef<HTMLDetailsElement>(null);
  // Asked for from the table's chip: opened, and brought into view.
  useEffect(() => {
    if (!open || !box.current) return;
    box.current.open = true;
    box.current.scrollIntoView?.({ block: "nearest" });
    box.current.querySelector("summary")?.focus({ preventScroll: true });
  }, [open]);
  return (
    <details ref={box} className={styles.changed} data-changed={summary.seq}>
      <summary>What changed?</summary>
      <ul>
        {summary.changes.map((change, index) => (
          <li key={index}>{children(change.text)}</li>
        ))}
      </ul>
    </details>
  );
}

export function Timeline({
  gameId,
  seats,
  live,
  pulse = 0,
  focus = null,
  newTab = false,
  fill = false,
}: {
  gameId: string;
  seats: readonly TimelineSeat[];
  /** The game is running: its new events are read as it goes on. */
  live: boolean;
  /** Changes whenever the table does (its revision). */
  pulse?: number;
  /** A resolution whose "What changed?" is asked for, by its event's number. */
  focus?: number | null;
  /** Rules open in a tab of their own, so that a game goes on where it is. */
  newTab?: boolean;
  /** The list scrolls within the timeline, which fills its box (a table's drawer). */
  fill?: boolean;
}) {
  const [groups, setGroups] = useState<ReadonlySet<GroupId>>(new Set());
  const [seat, setSeat] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [text, setText] = useState("");
  const [everything, setEverything] = useState(false);
  const [shown, setShown] = useState<{ seq: number; card: Card } | null>(null);
  const id = useId();
  // The search waits for the typing to pause.
  useEffect(() => {
    const wait = window.setTimeout(() => setText(typed), 350);
    return () => window.clearTimeout(wait);
  }, [typed]);
  const filters = useMemo<Filters>(
    () => ({ groups, seat, text }),
    [groups, seat, text],
  );
  const timeline = useTimeline(gameId, filters, live, pulse);
  const { events } = timeline;
  const you = seats.find((entry) => entry.you)?.seat ?? null;
  const seatName = useCallback(
    (number: number) =>
      seats.find((entry) => entry.seat === number)?.name ??
      `Player ${number + 1}`,
    [seats],
  );
  const lines = useMemo(() => describe(events), [events]);
  // Whose turn each turn was: as the pages said it, and as the steps among the events say it.
  const owners = useMemo(() => {
    const found = new Map<number, number>(
      Object.entries(timeline.turns).map(([turn, seat]) => [
        Number(turn),
        seat,
      ]),
    );
    for (const [turn, seat] of turnOwners(events)) found.set(turn, seat);
    return found;
  }, [events, timeline.turns]);
  const large = useMemo(() => largeChanges(events), [events]);
  const visible = useMemo(
    () => (everything ? lines : lines.filter((line) => !line.quiet)),
    [lines, everything],
  );
  const narrowedDown = groups.size > 0 || seat !== null || text.trim() !== "";
  const old = events.some((event) => event.v < 2);

  // The list follows the game while its reader is at its end.
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = events.at(-1)?.seq ?? 0;
  const first = events[0]?.seq ?? 0;
  const firstBefore = useRef(first);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    // Earlier events put before the list leave its end where it was: no jump.
    const earlier = first < firstBefore.current;
    firstBefore.current = first;
    if (stick.current && !earlier && focus === null)
      element.scrollTop = element.scrollHeight;
  }, [last, first, focus]);

  const turns: { turn: number; lines: Line[] }[] = [];
  for (const line of visible) {
    const open = turns.at(-1);
    if (open && open.turn === line.turn) open.lines.push(line);
    else turns.push({ turn: line.turn, lines: [line] });
  }

  const render = (seq: number) => (pieces: readonly Piece[]) => (
    <Pieces
      pieces={pieces}
      seatName={seatName}
      you={you}
      shown={shown?.seq === seq ? shown.card.ref : null}
      onCard={(card) =>
        setShown((before) =>
          before?.seq === seq && before.card.ref === card.ref
            ? null
            : { seq, card },
        )
      }
      newTab={newTab}
      owner={`${id}-card-${seq}`}
    />
  );

  return (
    <div className={styles.timeline} data-fill={fill || undefined}>
      <form
        className={styles.controls}
        role="search"
        aria-label="Narrow the timeline"
        onSubmit={(event) => {
          event.preventDefault();
          setText(typed);
        }}
      >
        <div className={styles.find}>
          <label htmlFor={`${id}-find`}>Find a card</label>
          <input
            id={`${id}-find`}
            type="search"
            value={typed}
            maxLength={80}
            placeholder="A card’s name"
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <div className={styles.find}>
          <label htmlFor={`${id}-seat`}>Player</label>
          <select
            id={`${id}-seat`}
            value={seat ?? ""}
            onChange={(event) =>
              setSeat(
                event.target.value === "" ? null : Number(event.target.value),
              )
            }
          >
            <option value="">Everyone</option>
            {seats.map((entry) => (
              <option key={entry.seat} value={entry.seat}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        <fieldset className={styles.kinds}>
          <legend>Show only</legend>
          {GROUPS.map((group) => (
            <button
              key={group.id}
              type="button"
              aria-pressed={groups.has(group.id)}
              onClick={() =>
                setGroups((before) => {
                  const next = new Set(before);
                  if (!next.delete(group.id)) next.add(group.id);
                  return next;
                })
              }
            >
              {group.label}
            </button>
          ))}
        </fieldset>
        <label className={styles.every}>
          <input
            type="checkbox"
            checked={everything}
            onChange={(event) => setEverything(event.target.checked)}
          />
          Every event, bookkeeping too
        </label>
      </form>

      <div
        ref={list}
        className={styles.list}
        tabIndex={0}
        role="region"
        aria-label="The game, event by event"
        aria-busy={timeline.state === "loading"}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            32;
        }}
      >
        {timeline.state === "loading" && (
          <p className={styles.status} role="status">
            Reading the game’s events…
          </p>
        )}
        {timeline.state === "error" && (
          <p className={styles.status} role="alert">
            The timeline could not be read. {timeline.error}{" "}
            <button type="button" onClick={timeline.retry}>
              Try again
            </button>
          </p>
        )}
        {timeline.state === "ready" && visible.length === 0 && (
          <p className={styles.status}>
            {narrowedDown
              ? "Nothing in this game matches. A card you were not shown is found by no name."
              : live
                ? "Nothing has happened yet."
                : "This game has no events to show: they are kept for 90 days after a game, and games played before events were recorded have none."}
          </p>
        )}
        {timeline.earlier && (
          <p className={styles.earlier}>
            <button
              type="button"
              disabled={timeline.loadingEarlier}
              onClick={() => void timeline.loadEarlier()}
            >
              {timeline.loadingEarlier ? "Reading…" : "Show earlier events"}
            </button>
          </p>
        )}
        {turns.map(({ turn, lines: turnLines }, index) => {
          const owner = owners.get(turn);
          const title =
            turn < 1
              ? "Before the first turn"
              : `Turn ${turn}${owner !== undefined ? ` · ${seatName(owner)}` : ""}`;
          let step: string | null | undefined;
          return (
            <section
              key={`${turn}-${index}`}
              className={styles.turn}
              aria-label={title}
            >
              <h3>{title}</h3>
              <ol>
                {turnLines.map((line) => {
                  const heading =
                    line.step !== step ? stepWords(line.step) : "";
                  step = line.step;
                  const summary = line.resolution
                    ? large.get(line.seq)
                    : undefined;
                  const picture = shown?.seq === line.seq ? shown.card : null;
                  return (
                    <Fragment key={line.seq}>
                      {heading && (
                        <li className={styles.step} role="presentation">
                          <h4>{heading}</h4>
                        </li>
                      )}
                      <li
                        className={styles.line}
                        data-seq={line.seq}
                        data-group={line.group}
                        data-quiet={line.quiet || undefined}
                      >
                        <p>{render(line.seq)(line.text)}</p>
                        {line.notes.map((note, at) => (
                          <p
                            key={at}
                            className={styles.note}
                            data-unknown={note.unknown || undefined}
                          >
                            {render(line.seq)(note.text)}
                          </p>
                        ))}
                        {summary && (
                          <WhatChanged
                            summary={summary}
                            open={focus === line.seq}
                          >
                            {render(line.seq)}
                          </WhatChanged>
                        )}
                        <div id={`${id}-card-${line.seq}`}>
                          {picture?.name && (
                            <figure className={styles.picture}>
                              <RetryingImage
                                src={cardImageUrl(picture.name, "normal")}
                                width={244}
                                height={340}
                                fallback={
                                  <span className={styles.noPicture}>
                                    No picture of this card is at hand.
                                  </span>
                                }
                              />
                              <figcaption>
                                {picture.name}{" "}
                                <button
                                  type="button"
                                  onClick={() => setShown(null)}
                                >
                                  Close
                                </button>
                              </figcaption>
                            </figure>
                          )}
                        </div>
                      </li>
                    </Fragment>
                  );
                })}
              </ol>
            </section>
          );
        })}
        {old && timeline.state === "ready" && (
          <p className={styles.status}>
            Part of this game was recorded before the timeline could ask the
            game why: there it says what happened, and that the game recorded no
            reason.
          </p>
        )}
      </div>
    </div>
  );
}

/** A line as plain words: for tests, and for whoever needs the sentence without its links. */
export function lineText(line: Line, seatName: (seat: number) => string) {
  return plainText(line.text, seatName);
}
