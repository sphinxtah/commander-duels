import type { MotionLevel } from "../table/types";

// The scene's tweens (UI09, design §14). The DOM never animates: every commit lands at once, and
// the canvas then moves its pictures from where they are drawn now to where the layout says.
// A new commit retargets each picture from its current sampled pose, so nothing is queued and
// nothing waits on an animation. The clock is injected, so tests run without real time.

/** Milliseconds at the normal speed, from the design's animation table. */
export const DURATIONS = {
  draw: 350,
  opponentDraw: 300,
  cast: 420,
  resolve: 380,
  enter: 380,
  leave: 450,
  fade: 200,
  tap: 180,
  counters: 250,
  damage: 300,
  life: 400,
  attack: 300,
  emblem: 1100,
  eliminated: 900,
  result: 1200,
  /** A card moving because the row around it changed. */
  move: 260,
  /** A card already moving when the next commit gives it somewhere else to be. */
  retarget: 80,
  /** A hand card rising under the pointer, or settling back. */
  rise: 120,
  /** A card image fading in over its text frame. */
  imageFade: 150,
  /** A floating number rising off a card or a portrait. */
  float: 800,
  /** Between the cards of one draw, and the most a draw's stagger may add up to. */
  stagger: 60,
  staggerMax: 600,
  // The special effects (v0.7.0). None of these run with motion "none": the layer is off.
  /** The red X slashed over a creature slain in combat; its card waits for the strokes. */
  slash: 760,
  /** Ash rising off a creature that died another way. */
  ash: 650,
  /** The arcane burst of a commander cast or a big spell taking effect. */
  burst: 650,
  /** The dust ring under a big creature landing. */
  stomp: 520,
  /** Embers off the attackers, and the steel shimmer on the blockers. */
  embers: 520,
  shield: 420,
  /** The shock ring of a heavy blow to a player, with the screen's edges flaring for your own. */
  impact: 520,
  /** Green glitter rising for a big life gain. */
  glitter: 700,
  /** A portrait shattering as its player is eliminated. */
  shatter: 900,
  /** Confetti for a victory, ash falling for a defeat. */
  confetti: 2200,
  /** A gold shine sweeping the band as your turn begins. */
  shine: 700,
} as const;

export type Motion = keyof typeof DURATIONS;

const SPEED: Record<MotionLevel, number> = {
  none: 0,
  normal: 1,
  fast: 0.6,
  faster: 0.35,
};

/** Fades still happen with reduced motion, only shorter; nothing moves. */
const FADES = new Set<Motion>(["fade", "imageFade", "float"]);

/** How long a motion takes at a motion level. With motion "none" nothing moves: fades last at
 * most 120 ms and an emblem stands still for 600 ms; everything else lands at once. */
export function duration(name: Motion, motion: MotionLevel): number {
  const ms = DURATIONS[name];
  if (motion !== "none") return Math.round(ms * SPEED[motion]);
  if (name === "emblem" || name === "result") return 600;
  if (FADES.has(name)) return Math.min(ms, 120);
  return 0;
}

export type Ease = (t: number) => number;
export const linear: Ease = (t) => t;
export const easeOut: Ease = (t) => 1 - (1 - t) ** 3;
export const easeInOut: Ease = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** What a tween moves: a picture's pose, or any other named numbers (a glow, a progress). */
export type Values = Record<string, number>;

/** A picture's pose on the stage: its pivot, turn in degrees, uniform scale and opacity. */
export interface Pose extends Values {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  alpha: number;
}

interface Track {
  from: Values;
  to: Values;
  start: number;
  ms: number;
  ease: Ease;
}

export interface TweenOptions {
  delay?: number;
  ease?: Ease;
}

export class Timeline {
  private readonly tracks = new Map<string, Track>();
  private readonly clock: () => number;

  constructor(clock: () => number = () => performance.now()) {
    this.clock = clock;
  }

  now(): number {
    return this.clock();
  }

  /** Starts, or replaces, a key's tween. A zero duration with no delay lands at once and leaves
   * no tween behind. */
  to(
    key: string,
    from: Values,
    to: Values,
    ms: number,
    o: TweenOptions = {},
  ): void {
    const delay = Math.max(0, o.delay ?? 0);
    if (ms <= 0 && delay === 0) {
      this.tracks.delete(key);
      return;
    }
    this.tracks.set(key, {
      from: { ...from },
      to: { ...to },
      start: this.clock() + delay,
      ms: Math.max(0, ms),
      ease: o.ease ?? easeOut,
    });
  }

  /** A tween from wherever the key is drawn now (its sample, or `rest` when it is still) to
   * `to`: a new commit never makes a picture jump. */
  retarget(
    key: string,
    rest: Values,
    to: Values,
    ms: number,
    o: TweenOptions = {},
  ): void {
    this.to(key, this.sample(key) ?? rest, to, ms, o);
  }

  /** The key's values now, or null when it has no tween. Before a delayed start it holds its
   * starting values; after the end, its target. */
  sample(key: string, now = this.clock()): Values | null {
    const track = this.tracks.get(key);
    if (!track) return null;
    const p =
      track.ms <= 0
        ? now >= track.start
          ? 1
          : 0
        : Math.min(1, Math.max(0, (now - track.start) / track.ms));
    const e = track.ease(p);
    const out: Values = {};
    for (const name of Object.keys(track.to)) {
      const a = track.from[name] ?? track.to[name];
      out[name] = a + (track.to[name] - a) * e;
    }
    return out;
  }

  /** How far through its tween the key is, 0 to 1, or null when it has none. */
  progress(key: string, now = this.clock()): number | null {
    const track = this.tracks.get(key);
    if (!track) return null;
    if (track.ms <= 0) return now >= track.start ? 1 : 0;
    return Math.min(1, Math.max(0, (now - track.start) / track.ms));
  }

  target(key: string): Values | null {
    return this.tracks.get(key)?.to ?? null;
  }

  has(key: string): boolean {
    return this.tracks.has(key);
  }

  /** Whether the key's tween is still running (or yet to start). */
  active(key: string, now = this.clock()): boolean {
    const track = this.tracks.get(key);
    return track !== undefined && now < track.start + track.ms;
  }

  /** Whether any tween is still running: the scene keeps drawing frames while this holds. Keys
   * in `except` are left out (an idle glow is not something the table waits on). */
  busy(now = this.clock(), except?: ReadonlySet<string>): boolean {
    for (const [key, track] of this.tracks)
      if (now < track.start + track.ms && !except?.has(key)) return true;
    return false;
  }

  /** Forgets the tweens that have ended, and says whose they were. */
  prune(now = this.clock()): string[] {
    const ended: string[] = [];
    for (const [key, track] of this.tracks)
      if (now >= track.start + track.ms) {
        ended.push(key);
        this.tracks.delete(key);
      }
    return ended;
  }

  cancel(key: string): void {
    this.tracks.delete(key);
  }

  clear(): void {
    this.tracks.clear();
  }

  get size(): number {
    return this.tracks.size;
  }
}
