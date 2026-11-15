import { useCallback, useEffect, useRef, useState } from "react";
import { client, describe as describeError } from "../api";
import type { components } from "../generated/api";
import { plainText, type GameEvent, type Line } from "../timeline/events";

// Replays and review (v1.0.0, docs/replays.md): a game that is over, played back from its
// structured events through one seat's eyes. Nothing here runs a game again: the events say what
// happened, the timeline's words (../timeline/events.ts) say it in sentences, and this module
// keeps the place, the pace and the scoreboard. The server filters every event it gives, so no
// way of seeking shows more than the replay's seat saw.

export type Replay = components["schemas"]["Replay"];
export type ReplayEntry = components["schemas"]["ReplayEntry"];
export type ReplayList = components["schemas"]["ReplayList"];
export type ReplayMark = components["schemas"]["ReplayMarkView"];
export type ReplayStart = components["schemas"]["ReplayStart"];
export type ReplayShare = components["schemas"]["ReplayShare"];

/** #replay/<game>, and #replay/<game>/<player> for the replay that player shared. */
export const REPLAY_ROUTE = /^#replay\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?$/i;
export const REPLAYS_ROUTE = /^#replays$/i;

export function replayHref(gameId: string, sharedBy?: string | null): string {
  return sharedBy ? `#replay/${gameId}/${sharedBy}` : `#replay/${gameId}`;
}

/** How many events one request asks for (the API's most). */
export const PAGE = 500;

// The scoreboard.

/** A seat's public counts at a moment of the game. A count the events do not tell is null. */
export interface Score {
  seat: number;
  life: number;
  hand: number | null;
  library: number | null;
  graveyard: number | null;
  battlefield: number | null;
  /** The player lost or left the game by this moment. */
  out: boolean;
  won: boolean;
}

export interface Scoreboard {
  /** The counts as they stood once the event with this number had happened. */
  at(seq: number): Score[];
  /** Whether the events tell the counts at all: a game recorded before v1.0.0 tells only life,
   * which is then counted from each seat's starting life and the life it gained and lost. */
  counted: boolean;
}

/**
 * Every seat's counts through the game. Since v1.0.0 the engine's events carry them (`tally`:
 * life, hand, library, graveyard and permanents of each seat, told whenever they change), since
 * the opening hands are dealt before the first event and no count of the moves would find a
 * hand's size. Where the events carry none, life is counted from where each seat started; in a
 * team that shares its life (Two-Headed Giant) a change of either player is the team's.
 */
export function scoreboard(
  events: readonly GameEvent[],
  starting: readonly ReplayStart[],
): Scoreboard {
  let now: Score[] = starting.map((start) => ({
    seat: start.seat,
    life: start.life,
    hand: null,
    library: null,
    graveyard: null,
    battlefield: null,
    out: false,
    won: false,
  }));
  const index = new Map(now.map((score, at) => [score.seat, at]));
  const mates = (seat: number): number[] => {
    const start = starting.find((entry) => entry.seat === seat);
    if (!start?.shared_life || start.team === null) return [seat];
    return starting
      .filter((entry) => entry.team === start.team)
      .map((entry) => entry.seat);
  };
  const points: { seq: number; scores: Score[] }[] = [{ seq: 0, scores: now }];
  let counted = false;
  for (const event of events) {
    let next: Score[] | null = null;
    const change = (seat: number, patch: Partial<Score>) => {
      const at = index.get(seat);
      if (at === undefined) return;
      next ??= now.slice();
      next[at] = { ...next[at]!, ...patch };
    };
    if (event.tally) {
      counted = true;
      // In the seats' order, as the engine tells them.
      event.tally.forEach((counts, at) => {
        const score = now[at];
        if (!score || counts.length < 5) return;
        change(score.seat, {
          life: counts[0]!,
          hand: counts[1]!,
          library: counts[2]!,
          graveyard: counts[3]!,
          battlefield: counts[4]!,
        });
      });
    } else if (
      !counted &&
      (event.type === "life_lost" || event.type === "life_gained") &&
      typeof event.player === "number" &&
      typeof event.amount === "number"
    ) {
      const delta = event.type === "life_gained" ? event.amount : -event.amount;
      for (const seat of mates(event.player)) {
        const at = index.get(seat);
        if (at !== undefined)
          change(seat, { life: (next ?? now)[at]!.life + delta });
      }
    }
    if (event.type === "eliminated" && typeof event.player === "number")
      change(event.player, { out: true });
    if (event.type === "won" && typeof event.player === "number")
      change(event.player, { won: true });
    if (next) {
      now = next;
      points.push({ seq: event.seq, scores: now });
    }
  }
  return {
    counted,
    at(seq: number) {
      let low = 0;
      let high = points.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (points[middle]!.seq <= seq) low = middle;
        else high = middle - 1;
      }
      return points[low]!.scores;
    },
  };
}

// The place and the pace.

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
/** How long a line stands at normal speed, in ms; one with explanations under it stands longer. */
export const LINE_MS = 1400;
export const NOTE_MS = 900;

export function delayOf(line: Line | undefined, speed: Speed): number {
  if (!line) return LINE_MS / speed;
  return (LINE_MS + Math.min(2, line.notes.length) * NOTE_MS) / speed;
}

/** The index of the last line at or before an event's number; -1 before the first. */
export function indexAt(lines: readonly Line[], seq: number): number {
  let low = -1;
  let high = lines.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lines[middle]!.seq <= seq) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Where each turn begins: the turn and the index of its first line. */
export function turnStarts(
  lines: readonly Line[],
): { turn: number; index: number }[] {
  const starts: { turn: number; index: number }[] = [];
  lines.forEach((line, index) => {
    if (starts.at(-1)?.turn !== line.turn)
      starts.push({ turn: line.turn, index });
  });
  return starts;
}

/** The line to stand at after stepping a turn back or on from a line. Back from within a turn
 * goes to that turn's first line, and from a first line to the turn before. */
export function turnStep(
  lines: readonly Line[],
  index: number,
  direction: -1 | 1,
): number {
  const starts = turnStarts(lines);
  if (!starts.length) return index;
  if (direction === 1) {
    return starts.find((start) => start.index > index)?.index ?? index;
  }
  const before = starts.filter((start) => start.index < index);
  return before.at(-1)?.index ?? starts[0]!.index;
}

/** The lines whose words hold the text, by index: a card's name, a player's, any word of the
 * sentence or of what explains it. */
export function matches(
  lines: readonly Line[],
  text: string,
  seatName: (seat: number) => string,
): number[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  const found: number[] = [];
  lines.forEach((line, index) => {
    const words = [line.text, ...line.notes.map((note) => note.text)]
      .map((pieces) => plainText(pieces, seatName))
      .join(" ")
      .toLowerCase();
    if (words.includes(needle)) found.push(index);
  });
  return found;
}

// Asking the server.

type Shared = { shared_by?: string };
const shared = (sharedBy: string | null | undefined): Shared =>
  sharedBy ? { shared_by: sharedBy } : {};

export async function readReplay(
  gameId: string,
  sharedBy?: string | null,
): Promise<{ replay?: Replay; error?: string; status?: number }> {
  const { data, error, response } = await client.GET(
    "/api/v1/games/{game_id}/replay",
    { params: { path: { game_id: gameId }, query: shared(sharedBy) } },
  );
  if (data) return { replay: data };
  return { error: describeError(error), status: response.status };
}

export async function readReplays(): Promise<ReplayList | undefined> {
  const { data } = await client.GET("/api/v1/replays", {
    params: { query: { limit: 50 } },
  });
  return data;
}

export async function putMark(
  gameId: string,
  seq: number,
  body: { label?: string; note?: string },
  sharedBy?: string | null,
): Promise<{ replay?: Replay; error?: string }> {
  const { data, error } = await client.PUT(
    "/api/v1/games/{game_id}/replay/marks/{seq}",
    {
      params: { path: { game_id: gameId, seq }, query: shared(sharedBy) },
      body: { label: body.label ?? "", note: body.note ?? "" },
    },
  );
  return data ? { replay: data } : { error: describeError(error) };
}

export async function deleteMark(
  gameId: string,
  seq: number,
  sharedBy?: string | null,
): Promise<{ replay?: Replay; error?: string }> {
  const { data, error } = await client.DELETE(
    "/api/v1/games/{game_id}/replay/marks/{seq}",
    { params: { path: { game_id: gameId, seq }, query: shared(sharedBy) } },
  );
  return data ? { replay: data } : { error: describeError(error) };
}

export async function shareReplay(
  gameId: string,
  playerId: string,
): Promise<{ replay?: Replay; error?: string }> {
  const { data, error } = await client.POST(
    "/api/v1/games/{game_id}/replay/shares",
    { params: { path: { game_id: gameId } }, body: { player_id: playerId } },
  );
  return data ? { replay: data } : { error: describeError(error) };
}

export async function unshareReplay(
  gameId: string,
  grantId: string,
): Promise<{ error?: string }> {
  const { error, response } = await client.DELETE(
    "/api/v1/games/{game_id}/replay/shares/{grant_id}",
    { params: { path: { game_id: gameId, grant_id: grantId } } },
  );
  return response.ok ? {} : { error: describeError(error) };
}

/**
 * The whole replay's events, read from the first on, a page at a time, so that playback begins
 * with the first page and the rest arrives behind it. `turns` is whose turn each turn was, as
 * the pages said it.
 */
export function useReplayEvents(gameId: string, sharedBy?: string | null) {
  const [loaded, setLoaded] = useState<{
    key: string;
    events: GameEvent[];
    turns: Record<string, number>;
    done: boolean;
    error: string;
  }>({ key: "", events: [], turns: {}, done: false, error: "" });
  const [attempt, setAttempt] = useState(0);
  const key = `${gameId}/${sharedBy ?? ""}`;
  const current = useRef(key);
  current.current = key;

  useEffect(() => {
    let cancelled = false;
    setLoaded({ key, events: [], turns: {}, done: false, error: "" });
    void (async () => {
      let since = 0;
      for (;;) {
        const { data, error } = await client.GET(
          "/api/v1/games/{game_id}/replay/events",
          {
            params: {
              path: { game_id: gameId },
              query: { since, limit: PAGE, ...shared(sharedBy) },
            },
          },
        );
        if (cancelled) return;
        if (!data) {
          setLoaded((before) =>
            before.key === key
              ? { ...before, error: describeError(error) }
              : before,
          );
          return;
        }
        const page = data.events as unknown as GameEvent[];
        const more = data.more ?? false;
        setLoaded((before) =>
          before.key === key
            ? {
                ...before,
                events: [...before.events, ...page],
                turns: { ...before.turns, ...(data.turns ?? {}) },
                done: !more,
              }
            : before,
        );
        if (!more) return;
        since = Math.max(since, data.next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, sharedBy, key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const fresh = loaded.key === key;
  return {
    events: fresh ? loaded.events : [],
    turns: fresh ? loaded.turns : {},
    done: fresh && loaded.done,
    error: fresh ? loaded.error : "",
    retry,
  };
}

/** A day and a month, with the year: when a game was played, until when a replay is kept. */
export function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
