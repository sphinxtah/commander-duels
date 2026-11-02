import type { MotionLevel } from "../game/table/types";
import type { Snapshot } from "../game/types";
import { duration, type Motion } from "../game/scene/timeline";

// The guided game's pace (v0.8.5): how long each frame of a lesson stays before the next, so the
// table's animation for it has time to finish, and how long "Play on its own" leaves a lesson's
// words to be read. Reading time is the words' alone; the frames' time follows the table's own
// animation speed, and with motion reduced the frames step as still pictures.

/** Time to take in a frame once its animation has finished. */
export const LOOK_MS = 650;
/** A frame's hold with motion reduced: nothing moves, so each change is a still picture. */
export const STILL_MS = 900;

/** Reading: a fixed start, then a beginner's pace with a board to look at, within bounds. */
export const READ_BASE_MS = 1_500;
export const READ_WORD_MS = 270;
export const READ_MIN_MS = 5_000;
export const READ_MAX_MS = 22_000;
/** The least "Play on its own" waits once a lesson's frames have settled. */
export const SETTLE_MIN_MS = 1_200;

/** The words a reader reads: a run of mana symbols ("{2}{G}{W}{W}") counts as one. */
export function wordCount(text: string): number {
  const words = text
    .replace(/(\{[^}]+\})+[:;,.]?/g, " mana ")
    .trim()
    .split(/\s+/);
  return words[0] === "" ? 0 : words.length;
}

/** How long "Play on its own" leaves a lesson's words before going on. */
export function readingMs(text: string): number {
  return Math.min(
    READ_MAX_MS,
    Math.max(READ_MIN_MS, READ_BASE_MS + wordCount(text) * READ_WORD_MS),
  );
}

function ids(snapshot: Snapshot, zone: "battlefield" | "stack"): Set<string> {
  return new Set((snapshot.view?.[zone] ?? []).map((item) => item.id));
}

/** The table's animations that a change from one frame to the next starts (the scene's own
 * names, so their lengths are its lengths). */
export function motionsBetween(
  before: Snapshot | null,
  after: Snapshot,
): Motion[] {
  const next = after.view;
  const prev = before?.view;
  if (!next || !prev) return [];
  const motions: Motion[] = ["move"];
  // A new turn, or attackers or blockers declared: the big emblem on the band.
  if (next.turn !== prev.turn || next.active_seat !== prev.active_seat)
    motions.push("emblem");
  const fighting = (step: string, key: "attackers" | "blockers") =>
    next.step === step &&
    next.combat.some((group) => group[key].length > 0) &&
    !(prev.step === step && prev.combat.some((group) => group[key].length > 0));
  if (
    fighting("declare_attackers", "attackers") ||
    fighting("declare_blockers", "blockers")
  )
    motions.push("emblem", "attack");
  const stackBefore = ids(before, "stack");
  const stackAfter = ids(after, "stack");
  if ([...stackAfter].some((id) => !stackBefore.has(id))) motions.push("cast");
  if ([...stackBefore].some((id) => !stackAfter.has(id)))
    motions.push("resolve", "enter");
  const fieldAfter = ids(after, "battlefield");
  // A creature leaving the battlefield: the blade's slash, then its card leaving.
  if ([...ids(before, "battlefield")].some((id) => !fieldAfter.has(id)))
    motions.push("slash", "leave");
  const players = (snapshot: typeof next) => [
    ...(snapshot.you ? [snapshot.you] : []),
    ...snapshot.opponents,
  ];
  const earlier = new Map(players(prev).map((p) => [p.seat, p]));
  for (const player of players(next)) {
    const then = earlier.get(player.seat);
    if (!then) continue;
    if (then.life !== player.life) motions.push("life", "float", "impact");
    if (player.lost && !then.lost) motions.push("shatter", "result");
    if (player.won && !then.won) motions.push("result", "confetti");
  }
  return motions;
}

/** How long a frame stays before the next: its animations' time, plus a moment to look. */
export function frameMs(
  before: Snapshot | null,
  after: Snapshot,
  motion: MotionLevel,
): number {
  if (motion === "none") return STILL_MS;
  const motions = motionsBetween(before, after);
  // The slash holds its card before the card leaves; every other animation runs alongside.
  const slash = motions.includes("slash")
    ? duration("slash", motion) + duration("leave", motion)
    : 0;
  const longest = Math.max(
    slash,
    ...motions.map((name) => duration(name, motion)),
    0,
  );
  return LOOK_MS + longest;
}

/** Each lesson's frame holds: a frame's hold is that of the change that brought it on screen,
 * the first frame's from the lesson before. */
export function frameHolds(
  lessons: readonly { frames: readonly Snapshot[] }[],
  motion: MotionLevel,
): number[][] {
  let before: Snapshot | null = null;
  return lessons.map((lesson) =>
    lesson.frames.map((frame) => {
      const hold = frameMs(before, frame, motion);
      before = frame;
      return hold;
    }),
  );
}

/** How long "Play on its own" waits once a lesson's last frame is on screen: until its
 * animation has finished, and until the words have had their reading time since the lesson
 * opened. */
export function autoWaitMs(
  text: string,
  lastHold: number,
  elapsedSinceLesson: number,
): number {
  return Math.max(
    SETTLE_MIN_MS,
    lastHold,
    readingMs(text) - elapsedSinceLesson,
  );
}
