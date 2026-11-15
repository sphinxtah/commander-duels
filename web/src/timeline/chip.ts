import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import type { GameView } from "../game/types";
import { LARGE, largeChanges, plainText, type GameEvent } from "./events";

// "What changed?" at the table (v1.0.0, the owner's decision 21): after a large resolution a chip
// offers its summary for a few seconds; nothing opens by itself. The table's own view says when
// to look (the board changed much at once), and the game's events say what to offer: the chip is
// shown only for a resolution the events sum to LARGE changes or more, and only while that
// resolution is the latest thing that happened.

/** How long the chip stays, in ms. */
export const CHIP_SHOWN_MS = 12_000;
/** How long after the board changed the events are asked for, and once more after that, in ms. */
export const LOOK_MS = 900;
export const LOOK_AGAIN_MS = 2500;
/** How many of the newest events a look reads. */
const TAIL = 150;
/** How many events may follow a resolution's last change for it still to be the latest. */
const RECENT = 12;
const END = 2147483647;

/** What of the table a large resolution moves: the permanents by their ids, each player's life. */
export function boardOf(view: GameView | null): Set<string> | null {
  if (!view) return null;
  const marks = new Set<string>(view.battlefield.map((entry) => entry.id));
  for (const player of [view.you, ...view.opponents])
    if (player) marks.add(`life:${player.seat}:${player.life}`);
  return marks;
}

/** How much two boards differ: the marks in one and not in the other. A life total that changed
 * counts once. */
export function boardDelta(before: Set<string>, after: Set<string>): number {
  let gone = 0;
  let lives = 0;
  for (const mark of before)
    if (!after.has(mark)) {
      if (mark.startsWith("life:")) lives++;
      else gone++;
    }
  let come = 0;
  for (const mark of after)
    if (!before.has(mark) && !mark.startsWith("life:")) come++;
  return gone + come + lives;
}

export interface Offer {
  /** The resolution's event, which the timeline opens at. */
  seq: number;
  /** What resolved, in words. */
  source: string;
}

/** The latest large resolution among the events, if nothing much has happened since. */
export function latestLarge(
  events: readonly GameEvent[],
  after: number,
): Offer | null {
  const summaries = [...largeChanges(events).values()];
  const latest = summaries.at(-1);
  if (!latest || latest.seq <= after) return null;
  const since = events.filter((event) => event.seq > latest.until).length;
  if (since > RECENT) return null;
  return {
    seq: latest.seq,
    source: plainText([latest.source], (seat) => `Player ${seat + 1}`),
  };
}

export function useWhatChanged(
  gameId: string,
  view: GameView | null,
  enabled: boolean,
): { offer: Offer | null; dismiss(): void } {
  const [offer, setOffer] = useState<Offer | null>(null);
  const board = useRef<Set<string> | null>(null);
  const offered = useRef(0);
  const timer = useRef<number | null>(null);
  const alive = useRef(true);
  const on = useRef(enabled);
  on.current = enabled;

  const look = useCallback(
    async (again: boolean) => {
      timer.current = null;
      if (!on.current) return;
      try {
        const { data } = await client.GET("/api/v1/games/{game_id}/timeline", {
          params: {
            path: { game_id: gameId },
            query: { before: END, limit: TAIL },
          },
        });
        if (!alive.current || !data) return;
        const found = latestLarge(
          data.events as unknown as GameEvent[],
          offered.current,
        );
        if (found) {
          offered.current = found.seq;
          setOffer(found);
        } else if (again && timer.current === null) {
          // The engine's events may trail the table by a moment.
          timer.current = window.setTimeout(
            () => void look(false),
            LOOK_AGAIN_MS,
          );
        }
      } catch {
        // No chip: the timeline says what happened when it is opened.
      }
    },
    [gameId],
  );

  useEffect(() => {
    const now = boardOf(view);
    const was = board.current;
    board.current = now;
    if (!enabled || !was || !now) return;
    if (boardDelta(was, now) < LARGE - 1) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void look(true), LOOK_MS);
  }, [view, enabled, look]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [gameId]);

  useEffect(() => {
    if (!offer) return;
    const gone = window.setTimeout(() => setOffer(null), CHIP_SHOWN_MS);
    return () => window.clearTimeout(gone);
  }, [offer]);

  const dismiss = useCallback(() => setOffer(null), []);
  return { offer: enabled ? offer : null, dismiss };
}
