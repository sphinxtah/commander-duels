import { DEFAULT_TABLE_SETTINGS } from "../table/types";
import { RECIPES, type Cue, type Part, type Recipe } from "./recipes";

// The table's sound (design §17), generated with Web Audio from the recipes in recipes.ts. One
// AudioContext, made lazily inside the player's first click (browsers start audio only after a
// gesture), feeds: each voice → its stereo panner → the master gain, (volume/100)² or 0 when muted
// → a compressor → the speakers. The context is suspended after 2 s of silence and while the tab is
// hidden, and resumed by the next sound. Without Web Audio (jsdom, very old browsers) every call is
// a no-op and the state says "unavailable".

export type SoundState = "locked" | "running" | "unavailable";

export interface PlayOptions {
  /** −1 (left) to 1 (right); clamped to ±PAN_LIMIT. */
  pan?: number;
  /** From now; one diff's cues are staggered with it. */
  delayMs?: number;
  /** The cue's falling variant, where it has one (a counter removed). */
  low?: boolean;
}

export interface SoundEngine {
  readonly state: SoundState;
  /** Makes or resumes the context; call it inside a click or key press. */
  unlock(): void;
  play(cue: Cue, o?: PlayOptions): void;
  /** 0–100. */
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  dispose(): void;
}

/** More voices than this and the oldest is cut. */
export const MAX_VOICES = 6;
/** The same cue closer than this to its last start is dropped. */
export const CUE_GAP_MS = 70;
/** Silence this long suspends the context. */
export const QUIET_MS = 2000;
export const PAN_LIMIT = 0.6;
/** Exponential ramps cannot reach 0; this is silence. */
const FLOOR = 0.0001;

export type AudioContextClass = new (
  options?: AudioContextOptions,
) => AudioContext;

export interface SoundEngineOptions {
  /** Finds the AudioContext class; null when there is none. Defaults to the window's. */
  context?: () => AudioContextClass | null;
  /** The clock for the rate limit and silence, in ms. */
  now?: () => number;
}

interface Voice {
  cue: Cue;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  /** When it has finished, on the engine's clock. */
  endsAt: number;
  done: boolean;
}

/** The page's AudioContext class, looked up when needed (older Safari prefixes it). */
function windowContext(): AudioContextClass | null {
  const scope = globalThis as {
    AudioContext?: AudioContextClass;
    webkitAudioContext?: AudioContextClass;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function hidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

export function createSoundEngine(
  options: SoundEngineOptions = {},
): SoundEngine {
  const lookup = options.context ?? windowContext;
  const now = options.now ?? (() => Date.now());
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let clipCurve: Float32Array<ArrayBuffer> | null = null;
  let unlocked = false;
  let broken = false;
  let volume = DEFAULT_TABLE_SETTINGS.effectsVolume;
  let muted = DEFAULT_TABLE_SETTINGS.muted;
  let voices: Voice[] = [];
  const lastStart = new Map<Cue, number>();
  let quietUntil = 0;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;

  const level = () => (muted ? 0 : (volume / 100) ** 2);
  const applyLevel = () => {
    if (master) master.gain.value = level();
  };

  const onVisibility = () => {
    if (hidden() && ctx?.state === "running") void ctx.suspend().catch(ignore);
  };

  function build(context: AudioContext) {
    master = context.createGain();
    master.gain.value = level();
    // The compressor keeps several voices at once from clipping.
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    master.connect(compressor);
    compressor.connect(context.destination);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", onVisibility);
  }

  /** A silent sample started inside the gesture: some browsers (iOS Safari) unlock only on a
   * sound actually started there. */
  function prime(context: AudioContext) {
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 1, context.sampleRate);
    source.connect(context.destination);
    source.onended = () => source.disconnect();
    source.start(0);
  }

  function whiteNoise(context: AudioContext): AudioBuffer {
    if (noise) return noise;
    const buffer = context.createBuffer(
      1,
      context.sampleRate,
      context.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return (noise = buffer);
  }

  function softClip(): Float32Array<ArrayBuffer> {
    if (clipCurve) return clipCurve;
    const curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i += 1) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(3 * x) / Math.tanh(3);
    }
    return (clipCurve = curve);
  }

  /** Suspends the context once nothing has sounded for QUIET_MS. */
  function scheduleQuiet() {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(
      () => {
        quietTimer = null;
        if (now() < quietUntil + QUIET_MS) return scheduleQuiet();
        prune();
        if (ctx?.state === "running") void ctx.suspend().catch(ignore);
      },
      Math.max(0, quietUntil + QUIET_MS - now()),
    );
  }

  function end(voice: Voice, cut: boolean) {
    if (voice.done) return;
    voice.done = true;
    if (cut)
      for (const source of voice.sources)
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
    for (const node of voice.nodes) node.disconnect();
    voices = voices.filter((other) => other !== voice);
  }

  /** Voices whose ended event never came (a context suspended mid-sound) are let go by the clock. */
  function prune() {
    const t = now();
    for (const voice of [...voices])
      if (voice.endsAt + 250 < t) end(voice, true);
  }

  function voice(
    context: AudioContext,
    out: AudioNode,
    cue: Cue,
    recipe: Recipe,
    delayMs: number,
    o: PlayOptions,
  ): Voice {
    const start = context.currentTime + delayMs / 1000;
    const gain = context.createGain();
    gain.gain.value = recipe.gain;
    const made: Voice = {
      cue,
      sources: [],
      nodes: [gain],
      endsAt: now() + delayMs + recipe.ms,
      done: false,
    };
    // StereoPannerNode is missing from some older Safari versions; those play centred.
    if (typeof context.createStereoPanner === "function") {
      const panner = context.createStereoPanner();
      panner.pan.value = clampPan(o.pan ?? 0);
      gain.connect(panner);
      panner.connect(out);
      made.nodes.push(panner);
    } else gain.connect(out);
    const parts = (o.low && recipe.low) || recipe.parts;
    let playing = parts.length;
    for (const part of parts) {
      const source = renderPart(context, part, start, recipe.ms, gain, made);
      source.onended = () => {
        playing -= 1;
        if (playing === 0) end(made, false);
      };
    }
    return made;
  }

  /** source → filter → soft clip → envelope → the voice's gain. */
  function renderPart(
    context: AudioContext,
    part: Part,
    start: number,
    cueMs: number,
    out: AudioNode,
    made: Voice,
  ): AudioScheduledSourceNode {
    const atMs = part.atMs ?? 0;
    const at = start + atMs / 1000;
    const length = (part.ms ?? cueMs - atMs) / 1000;
    const envelope = context.createGain();
    shape(
      envelope.gain,
      at,
      length,
      part.level ?? 1,
      part.kind === "noise" && part.swell === true,
    );
    envelope.connect(out);
    made.nodes.push(envelope);
    let head: AudioNode = envelope;
    if (part.kind === "noise" && part.clip) {
      const shaper = context.createWaveShaper();
      shaper.curve = softClip();
      shaper.connect(head);
      made.nodes.push(shaper);
      head = shaper;
    }
    const filter = filterOf(part);
    if (filter) {
      const node = context.createBiquadFilter();
      node.type = filter.type;
      glide(node.frequency, filter.hz, filter.toHz, at, length);
      node.Q.value = filter.q ?? 0.7;
      node.connect(head);
      made.nodes.push(node);
      head = node;
    }
    let source: AudioScheduledSourceNode;
    if (part.kind === "tone") {
      const oscillator = context.createOscillator();
      oscillator.type = part.wave;
      glide(oscillator.frequency, part.hz, part.toHz, at, length);
      source = oscillator;
    } else {
      const buffer = context.createBufferSource();
      buffer.buffer = whiteNoise(context);
      buffer.loop = true;
      source = buffer;
    }
    source.connect(head);
    made.nodes.push(source);
    made.sources.push(source);
    source.start(at);
    source.stop(at + length + 0.02);
    return source;
  }

  return {
    get state(): SoundState {
      if (broken || (!ctx && !lookup())) return "unavailable";
      return unlocked ? "running" : "locked";
    },

    unlock() {
      if (broken) return;
      if (!ctx) {
        const Context = lookup();
        if (!Context) return;
        try {
          ctx = new Context({ latencyHint: "interactive" });
        } catch {
          broken = true;
          return;
        }
        build(ctx);
      }
      const context = ctx;
      if (!unlocked) prime(context);
      if (context.state === "running") unlocked = true;
      else
        void context.resume().then(() => {
          if (ctx === context && context.state === "running") unlocked = true;
        }, ignore);
      quietUntil = Math.max(quietUntil, now());
      scheduleQuiet();
    },

    play(cue, o = {}) {
      const context = ctx;
      if (!context || !master || !unlocked || muted || volume <= 0) return;
      if (hidden()) return;
      const recipe = RECIPES[cue];
      const delayMs = Math.max(0, o.delayMs ?? 0);
      const at = now() + delayMs;
      const last = lastStart.get(cue);
      if (last !== undefined && Math.abs(at - last) < CUE_GAP_MS) return;
      lastStart.set(cue, at);
      prune();
      while (voices.length >= MAX_VOICES) end(voices[0], true);
      if (context.state !== "running") void context.resume().catch(ignore);
      voices.push(voice(context, master, cue, recipe, delayMs, o));
      quietUntil = Math.max(quietUntil, at + recipe.ms);
      scheduleQuiet();
    },

    setVolume(v) {
      if (!Number.isFinite(v)) return;
      volume = Math.min(100, Math.max(0, v));
      applyLevel();
    },

    setMuted(m) {
      muted = m;
      applyLevel();
    },

    dispose() {
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = null;
      for (const playing of [...voices]) end(playing, true);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", onVisibility);
      if (ctx) void ctx.close().catch(ignore);
      ctx = null;
      master = null;
      noise = null;
      unlocked = false;
      broken = false;
      lastStart.clear();
      quietUntil = 0;
    },
  };
}

/** Sound is a nicety: a context that refuses to resume or suspend is left as it is. */
function ignore() {}

export function clampPan(pan: number): number {
  if (!Number.isFinite(pan)) return 0;
  return Math.min(PAN_LIMIT, Math.max(-PAN_LIMIT, pan));
}

/** A quick attack (or a slow swell) and an exponential fall to silence at the part's end. */
function shape(
  param: AudioParam,
  at: number,
  length: number,
  peak: number,
  swell: boolean,
) {
  const attack = swell ? length * 0.6 : Math.min(0.005, length / 4);
  param.setValueAtTime(FLOOR, at);
  param.exponentialRampToValueAtTime(Math.max(FLOOR, peak), at + attack);
  param.exponentialRampToValueAtTime(FLOOR, at + length);
}

/** Noise always has its filter; a tone may be low-passed. */
function filterOf(
  part: Part,
): { type: BiquadFilterType; hz: number; toHz?: number; q?: number } | null {
  if (part.kind === "noise")
    return { type: part.filter, hz: part.hz, toHz: part.toHz, q: part.q };
  return part.lowpass ? { type: "lowpass", hz: part.lowpass } : null;
}

function glide(
  param: AudioParam,
  hz: number,
  toHz: number | undefined,
  at: number,
  length: number,
) {
  param.setValueAtTime(hz, at);
  if (toHz !== undefined && toHz !== hz)
    param.exponentialRampToValueAtTime(toHz, at + length);
}

let engine: SoundEngine | null = null;

/** The page's one engine. Asking for it makes no AudioContext; unlock() does. */
export function getSoundEngine(): SoundEngine {
  return (engine ??= createSoundEngine());
}
