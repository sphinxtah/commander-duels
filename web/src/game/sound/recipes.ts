// The table's sound effects as recipes (design §17): each cue is a few oscillators and bursts of
// filtered noise with a short envelope, generated in the browser. No recorded audio. The engine
// (engine.ts) renders any recipe; the numbers here are the whole of each sound.

export type Cue =
  | "draw"
  | "land"
  | "cast"
  | "resolve"
  | "enter"
  | "die"
  | "tap"
  | "counter"
  | "damage"
  | "lifeGain"
  | "attack"
  | "block"
  | "phase"
  | "yourTurn"
  | "tick"
  | "victory"
  | "defeat"
  | "drawGame"
  | "refused"
  // Leng's card shop (v0.4.0): opening a pack.
  | "packTear"
  | "cardDeal"
  | "cardFlip"
  | "rareReveal"
  | "mythicReveal"
  | "foilShimmer"
  // The menus (v0.4.5): a tile or link under the pointer, a choice made, and back to the menu.
  | "menuHover"
  | "menuSelect"
  | "menuBack";

interface Timing {
  /** When the part starts, from the cue's start (default 0). */
  atMs?: number;
  /** How long it lasts (default: to the cue's end). */
  ms?: number;
  /** Its peak, relative to the cue's gain (default 1). */
  level?: number;
}

/** An oscillator, optionally gliding to a second pitch and low-passed. */
export interface Tone extends Timing {
  kind: "tone";
  wave: OscillatorType;
  hz: number;
  toHz?: number;
  lowpass?: number;
}

/** White noise through one filter, optionally sweeping, soft-clipped or swelling in. */
export interface Noise extends Timing {
  kind: "noise";
  filter: BiquadFilterType;
  hz: number;
  toHz?: number;
  q?: number;
  clip?: boolean;
  swell?: boolean;
}

export type Part = Tone | Noise;

export interface Recipe {
  ms: number;
  gain: number;
  parts: Part[];
  /** The falling variant: a counter removed rather than added. */
  low?: Part[];
}

/** One note of a phrase: a triangle wave, so the chimes sound like bells. */
function note(hz: number, atMs: number, ms: number, level = 1): Tone {
  return { kind: "tone", wave: "triangle", hz, atMs, ms, level };
}

const C5 = 523.25;
const D4 = 293.66;
const E5 = 659.25;
const F4 = 349.23;
const G5 = 783.99;
const A4 = 440;
const C6 = 1046.5;
const B5 = 987.77;
const E6 = 1318.51;

export const RECIPES: Record<Cue, Recipe> = {
  // A card slid off the library: a breath of noise rising through a band-pass.
  draw: {
    ms: 140,
    gain: 0.25,
    parts: [
      { kind: "noise", filter: "bandpass", hz: 2000, toHz: 6000, q: 1.2 },
    ],
  },
  land: {
    ms: 180,
    gain: 0.5,
    parts: [
      { kind: "tone", wave: "sine", hz: 140, toHz: 70 },
      { kind: "noise", filter: "lowpass", hz: 900, ms: 30, level: 0.6 },
    ],
  },
  // Two sines a fifth apart, each gliding up a fifth.
  cast: {
    ms: 320,
    gain: 0.3,
    parts: [
      { kind: "tone", wave: "sine", hz: 392, toHz: 588 },
      { kind: "tone", wave: "sine", hz: 587.33, toHz: 881, level: 0.8 },
    ],
  },
  resolve: {
    ms: 500,
    gain: 0.3,
    parts: [note(C5, 0, 500), note(G5, 0, 500, 0.7)],
  },
  enter: {
    ms: 200,
    gain: 0.45,
    parts: [
      { kind: "tone", wave: "sine", hz: 110, toHz: 55 },
      { kind: "noise", filter: "lowpass", hz: 600, ms: 60, level: 0.5 },
    ],
  },
  die: {
    ms: 380,
    gain: 0.35,
    parts: [{ kind: "noise", filter: "lowpass", hz: 1200, toHz: 200 }],
  },
  tap: {
    ms: 40,
    gain: 0.15,
    parts: [{ kind: "noise", filter: "bandpass", hz: 3000, q: 2 }],
  },
  counter: {
    ms: 80,
    gain: 0.2,
    parts: [{ kind: "tone", wave: "sine", hz: 1320 }],
    low: [{ kind: "tone", wave: "sine", hz: 660 }],
  },
  // A low thud under a burst of soft-clipped noise; also life lost and commander damage.
  damage: {
    ms: 260,
    gain: 0.5,
    parts: [
      { kind: "tone", wave: "sine", hz: 80, toHz: 60 },
      {
        kind: "noise",
        filter: "lowpass",
        hz: 2400,
        ms: 160,
        level: 0.6,
        clip: true,
      },
    ],
  },
  lifeGain: {
    ms: 300,
    gain: 0.3,
    parts: [{ kind: "tone", wave: "sine", hz: E5, toHz: 987.77 }],
  },
  attack: {
    ms: 450,
    gain: 0.4,
    parts: [
      { kind: "tone", wave: "sawtooth", hz: 98, lowpass: 600 },
      {
        kind: "noise",
        filter: "lowpass",
        hz: 1500,
        level: 0.5,
        swell: true,
      },
    ],
  },
  block: {
    ms: 250,
    gain: 0.3,
    parts: [{ kind: "tone", wave: "square", hz: 196, lowpass: 900 }],
  },
  // The step emblem: noise sweeping up through a band-pass.
  phase: {
    ms: 350,
    gain: 0.25,
    parts: [{ kind: "noise", filter: "bandpass", hz: 400, toHz: 2000, q: 1.5 }],
  },
  yourTurn: {
    ms: 600,
    gain: 0.3,
    parts: [
      { kind: "tone", wave: "sine", hz: G5 },
      { kind: "tone", wave: "sine", hz: 1174.66, level: 0.7 },
    ],
  },
  // The response timer's last three seconds.
  tick: {
    ms: 30,
    gain: 0.15,
    parts: [{ kind: "tone", wave: "sine", hz: 1000 }],
  },
  victory: {
    ms: 1400,
    gain: 0.4,
    parts: [
      note(C5, 0, 350),
      note(E5, 150, 350),
      note(G5, 300, 350),
      note(C6, 450, 950),
    ],
  },
  defeat: {
    ms: 1200,
    gain: 0.35,
    parts: [note(A4, 0, 400), note(F4, 250, 400), note(D4, 500, 700)],
  },
  // A draw, or a game that ended without the viewer in it: an open fifth, neither up nor down.
  drawGame: {
    ms: 800,
    gain: 0.3,
    parts: [note(A4, 0, 400), note(E5, 300, 500)],
  },
  // A refusal: two short low pulses, softened a little.
  refused: {
    ms: 220,
    gain: 0.25,
    parts: [
      { kind: "tone", wave: "square", hz: 140, ms: 90, lowpass: 1800 },
      {
        kind: "tone",
        wave: "square",
        hz: 140,
        atMs: 130,
        ms: 90,
        lowpass: 1800,
      },
    ],
  },
  // Leng's card shop (v0.4.0). The wrapper tearing: noise ripping upward through a band-pass,
  // soft-clipped, over a low thump.
  packTear: {
    ms: 420,
    gain: 0.4,
    parts: [
      {
        kind: "noise",
        filter: "bandpass",
        hz: 1200,
        toHz: 5200,
        q: 0.9,
        ms: 360,
        clip: true,
      },
      { kind: "tone", wave: "sine", hz: 120, toHz: 70, ms: 160, level: 0.6 },
    ],
  },
  // A card dealt face down: a short swish.
  cardDeal: {
    ms: 90,
    gain: 0.18,
    parts: [{ kind: "noise", filter: "highpass", hz: 2600, toHz: 4200 }],
  },
  // A card turned over: a flick of noise and a soft tick.
  cardFlip: {
    ms: 110,
    gain: 0.22,
    parts: [
      { kind: "noise", filter: "bandpass", hz: 2400, toHz: 1600, q: 1.4 },
      { kind: "tone", wave: "sine", hz: 880, ms: 40, level: 0.4 },
    ],
  },
  // A rare: two bells a fifth apart.
  rareReveal: {
    ms: 800,
    gain: 0.3,
    parts: [note(E5, 0, 500), note(B5, 140, 660, 0.8)],
  },
  // A mythic rare: a rising chord that rings.
  mythicReveal: {
    ms: 1200,
    gain: 0.32,
    parts: [
      note(C5, 0, 700),
      note(G5, 120, 760, 0.8),
      note(C6, 240, 820, 0.7),
      note(E6, 360, 840, 0.6),
    ],
  },
  // A foil: quiet high sparkles.
  foilShimmer: {
    ms: 700,
    gain: 0.16,
    parts: [
      { kind: "tone", wave: "sine", hz: 2093, ms: 260 },
      { kind: "tone", wave: "sine", hz: 2637, atMs: 140, ms: 280, level: 0.8 },
      { kind: "tone", wave: "sine", hz: 3136, atMs: 300, ms: 400, level: 0.6 },
    ],
  },
  // The menus (v0.4.5). Under the pointer: a soft, high tick.
  menuHover: {
    ms: 60,
    gain: 0.08,
    parts: [
      { kind: "tone", wave: "sine", hz: 1760, toHz: 1980, lowpass: 3000 },
    ],
  },
  // A choice made: a whoosh rising into a bell a fifth above.
  menuSelect: {
    ms: 420,
    gain: 0.22,
    parts: [
      {
        kind: "noise",
        filter: "bandpass",
        hz: 900,
        toHz: 3600,
        q: 0.8,
        ms: 220,
        swell: true,
      },
      note(E5, 120, 300, 0.7),
      note(B5, 160, 260, 0.5),
    ],
  },
  // Back to the menu: the whoosh falling, with a low bell.
  menuBack: {
    ms: 360,
    gain: 0.2,
    parts: [
      {
        kind: "noise",
        filter: "bandpass",
        hz: 3200,
        toHz: 800,
        q: 0.8,
        ms: 220,
      },
      note(A4, 100, 260, 0.6),
    ],
  },
};

export const CUES = Object.keys(RECIPES) as Cue[];
