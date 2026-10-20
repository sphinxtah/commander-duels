import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TABLE_SETTINGS,
  type TableDiff,
  type TableEvent,
  type TableLayout,
  type TableSettings,
  type TimerView,
} from "../table/types";
import { attackOnce, cuesFor, panAt } from "./cues";
import {
  createSoundEngine,
  getSoundEngine,
  type AudioContextClass,
  type SoundEngine,
} from "./engine";
import { CUES, RECIPES, type Cue } from "./recipes";
import { useTableSound } from "./useTableSound";

/* ---------- a fake Web Audio graph that records what the engine builds ---------- */

class FakeParam {
  events: [string, number, number][] = [];
  constructor(public value = 0) {}
  setValueAtTime(value: number, time: number) {
    this.events.push(["set", value, time]);
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push(["linear", value, time]);
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.events.push(["exponential", value, time]);
    return this;
  }
}

class FakeNode {
  outputs: FakeNode[] = [];
  disconnected = false;
  constructor(readonly context: FakeContext) {
    context.nodes.push(this);
  }
  connect(node: FakeNode) {
    this.outputs.push(node);
    return node;
  }
  disconnect() {
    this.disconnected = true;
    this.outputs = [];
  }
}

class FakeSource extends FakeNode {
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  start(time = 0) {
    this.startedAt = time;
  }
  stop(time = 0) {
    this.stoppedAt = time;
  }
}
class FakeOscillator extends FakeSource {
  type = "sine";
  frequency = new FakeParam(440);
}
class FakeBufferSource extends FakeSource {
  buffer: unknown = null;
  loop = false;
}
class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}
class FakeFilter extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
}
class FakePanner extends FakeNode {
  pan = new FakeParam(0);
}
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24);
  knee = new FakeParam(30);
  ratio = new FakeParam(12);
  attack = new FakeParam(0.003);
  release = new FakeParam(0.25);
}
class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
}

class FakeContext {
  static made: FakeContext[] = [];
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  sampleRate = 8000;
  nodes: FakeNode[] = [];
  destination: FakeNode;
  resumes = 0;
  suspends = 0;
  closed = false;
  constructor(readonly options?: AudioContextOptions) {
    FakeContext.made.push(this);
    this.destination = new FakeNode(this);
  }
  resume() {
    this.resumes += 1;
    this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    this.suspends += 1;
    this.state = "suspended";
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
  createGain() {
    return new FakeGain(this);
  }
  createOscillator() {
    return new FakeOscillator(this);
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createBiquadFilter() {
    return new FakeFilter(this);
  }
  createStereoPanner() {
    return new FakePanner(this);
  }
  createDynamicsCompressor() {
    return new FakeCompressor(this);
  }
  createWaveShaper() {
    return new FakeShaper(this);
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => data,
    };
  }
  all<T extends FakeNode>(type: abstract new (...args: never[]) => T): T[] {
    return this.nodes.filter((node): node is T => node instanceof type);
  }
}

function fakeEngine(Context: unknown = FakeContext): SoundEngine {
  return createSoundEngine({ context: () => Context as AudioContextClass });
}

/** An engine past its first click, with its context. */
async function unlocked() {
  const engine = fakeEngine();
  engine.unlock();
  await Promise.resolve();
  const context = FakeContext.made[FakeContext.made.length - 1];
  return { engine, context };
}

/** The master gain: the one gain that feeds the compressor. */
function masterOf(context: FakeContext): FakeGain {
  const compressor = context.all(FakeCompressor)[0];
  const master = context
    .all(FakeGain)
    .find((gain) => gain.outputs.includes(compressor));
  if (!master) throw new Error("no master gain");
  return master;
}

/** The nodes one call makes. */
function made(context: FakeContext, play: () => void): FakeNode[] {
  const before = context.nodes.length;
  play();
  return context.nodes.slice(before);
}

let engines: SoundEngine[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  FakeContext.made = [];
  engines = [];
});
afterEach(() => {
  engines.forEach((engine) => engine.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the sound engine", () => {
  it("is a silent no-op without Web Audio", () => {
    const engine = createSoundEngine({ context: () => null });
    expect(engine.state).toBe("unavailable");
    expect(() => {
      engine.unlock();
      engine.play("cast", { pan: 0.4, delayMs: 60 });
      engine.setVolume(30);
      engine.setMuted(true);
      engine.dispose();
    }).not.toThrow();
    // jsdom has no AudioContext: the page's engine is the same no-op, made once.
    expect(getSoundEngine().state).toBe("unavailable");
    expect(getSoundEngine()).toBe(getSoundEngine());
  });

  it("makes its context only when unlocked, inside the click", async () => {
    const engine = fakeEngine();
    expect(engine.state).toBe("locked");
    engine.play("cast");
    expect(FakeContext.made).toHaveLength(0);
    engine.unlock();
    expect(FakeContext.made).toHaveLength(1);
    const [context] = FakeContext.made;
    expect(context.options).toEqual({ latencyHint: "interactive" });
    expect(context.resumes).toBe(1);
    // A silent sample started in the gesture, for browsers that unlock only on a sound.
    expect(context.all(FakeBufferSource)[0].startedAt).toBe(0);
    await Promise.resolve();
    expect(engine.state).toBe("running");
    engine.dispose();
  });

  it("routes each voice through its panner, the master gain and a compressor", async () => {
    const { engine, context } = await unlocked();
    engines.push(engine);
    context.currentTime = 2;
    const nodes = made(context, () => engine.play("cast", { pan: 0.3 }));
    const panner = nodes.find((node) => node instanceof FakePanner);
    expect(panner?.pan.value).toBe(0.3);
    const master = masterOf(context);
    expect(panner?.outputs).toHaveLength(1);
    expect(panner?.outputs[0]).toBe(master);
    expect(master.outputs[0].outputs[0]).toBe(context.destination);
    const tones = nodes.filter((node) => node instanceof FakeOscillator);
    expect(tones.map((tone) => tone.frequency.events[0])).toEqual([
      ["set", 392, 2],
      ["set", 587.33, 2],
    ]);
    expect(tones.every((tone) => tone.startedAt === 2)).toBe(true);
  });

  it("sets the master gain to (volume/100)², and to 0 when muted", async () => {
    const engine = fakeEngine();
    engines.push(engine);
    engine.setVolume(40);
    engine.unlock();
    await Promise.resolve();
    const master = masterOf(FakeContext.made[0]);
    expect(master.gain.value).toBeCloseTo(0.16);
    for (const [volume, gain] of [
      [70, 0.49],
      [50, 0.25],
      [100, 1],
      [0, 0],
      [150, 1],
      [-10, 0],
    ]) {
      engine.setVolume(volume);
      expect(master.gain.value).toBeCloseTo(gain);
    }
    engine.setVolume(Number.NaN);
    expect(master.gain.value).toBeCloseTo(0);
    engine.setVolume(50);
    engine.setMuted(true);
    expect(master.gain.value).toBe(0);
    engine.setMuted(false);
    expect(master.gain.value).toBeCloseTo(0.25);
    expect(DEFAULT_TABLE_SETTINGS.effectsVolume).toBe(70);
  });

  it("makes no voices while muted or at volume 0", async () => {
    const { engine, context } = await unlocked();
    engines.push(engine);
    engine.setMuted(true);
    expect(made(context, () => engine.play("cast"))).toEqual([]);
    engine.setMuted(false);
    engine.setVolume(0);
    expect(made(context, () => engine.play("cast"))).toEqual([]);
    engine.setVolume(70);
    expect(made(context, () => engine.play("cast")).length).toBeGreaterThan(0);
  });

  it("pans within ±0.6 and starts a delayed cue later", async () => {
    const { engine, context } = await unlocked();
    engines.push(engine);
    const left = made(context, () => engine.play("tap", { pan: -2 }));
    const right = made(context, () => engine.play("draw", { pan: 5 }));
    const pan = (nodes: FakeNode[]) =>
      nodes.find((node) => node instanceof FakePanner)?.pan.value;
    expect(pan(left)).toBe(-0.6);
    expect(pan(right)).toBe(0.6);
    context.currentTime = 1;
    const later = made(context, () => engine.play("tick", { delayMs: 120 }));
    const tone = later.find((node) => node instanceof FakeOscillator);
    expect(tone?.startedAt).toBeCloseTo(1.12);
  });

  it("drops the same cue within 70 ms of its last start", async () => {
    const { engine, context } = await unlocked();
    engines.push(engine);
    expect(made(context, () => engine.play("tap")).length).toBeGreaterThan(0);
    expect(made(context, () => engine.play("tap"))).toEqual([]);
    // Another cue is not held back.
    expect(made(context, () => engine.play("draw")).length).toBeGreaterThan(0);
    vi.advanceTimersByTime(69);
    expect(made(context, () => engine.play("tap"))).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(made(context, () => engine.play("tap")).length).toBeGreaterThan(0);
  });

  it("keeps six voices at most, cutting the oldest", async () => {
    const { engine, context } = await unlocked();
    engines.push(engine);
    const voices = (
      ["draw", "land", "cast", "resolve", "enter", "die"] as Cue[]
    ).map((cue) => made(context, () => engine.play(cue)));
    expect(voices.flat().some((node) => node.disconnected)).toBe(false);
    made(context, () => engine.play("tap"));
    const [oldest, ...rest] = voices;
    expect(oldest.every((node) => node.disconnected)).toBe(true);
    const cut = oldest.filter((node) => node instanceof FakeSource);
    expect(cut.every((source) => source.stoppedAt === 0)).toBe(true);
    expect(rest.flat().some((node) => node.disconnected)).toBe(false);
  });

  it("lets a voice go when its sounds end", async () => {
    const { engine, context } = await unlocked();
    engines.push(engine);
    const voice = made(context, () => engine.play("land"));
    const sources = voice.filter((node) => node instanceof FakeSource);
    expect(sources).toHaveLength(2);
    sources[0].onended?.();
    expect(voice.some((node) => node.disconnected)).toBe(false);
    sources[1].onended?.();
    expect(voice.every((node) => node.disconnected)).toBe(true);
    // Its place is free again: six more voices cut nothing.
    const six = (
      ["draw", "cast", "resolve", "enter", "die", "tap"] as Cue[]
    ).map((cue) => made(context, () => engine.play(cue)));
    expect(six.flat().some((node) => node.disconnected)).toBe(false);
  });

  it("suspends after 2 s of silence and resumes for the next sound", async () => {
    const { engine, context } = await unlocked();
    engines.push(engine);
    engine.play("tap");
    vi.advanceTimersByTime(2039);
    expect(context.suspends).toBe(0);
    vi.advanceTimersByTime(1);
    expect(context.suspends).toBe(1);
    expect(context.state).toBe("suspended");
    engine.play("cast");
    expect(context.resumes).toBe(2);
    expect(context.state).toBe("running");
  });

  it("suspends while the tab is hidden and plays nothing there", async () => {
    const { engine, context } = await unlocked();
    engines.push(engine);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(context.suspends).toBe(1);
    expect(made(context, () => engine.play("cast"))).toEqual([]);
    visibility.mockReturnValue("visible");
    expect(made(context, () => engine.play("cast")).length).toBeGreaterThan(0);
  });

  it("closes its context when disposed and locks again", async () => {
    const { engine, context } = await unlocked();
    engine.dispose();
    expect(context.closed).toBe(true);
    expect(engine.state).toBe("locked");
    engine.unlock();
    expect(FakeContext.made).toHaveLength(2);
    engine.dispose();
  });

  it("is unavailable when the context cannot be made", () => {
    const engine = fakeEngine(
      class {
        constructor() {
          throw new Error("no audio device");
        }
      },
    );
    expect(engine.state).toBe("locked");
    engine.unlock();
    expect(engine.state).toBe("unavailable");
  });

  it("plays centred where the browser has no stereo panner", async () => {
    class NoPanner extends FakeContext {
      createStereoPanner = undefined as unknown as () => FakePanner;
    }
    const engine = fakeEngine(NoPanner);
    engines.push(engine);
    engine.unlock();
    await Promise.resolve();
    const context = FakeContext.made[0];
    const voice = made(context, () => engine.play("cast", { pan: 0.5 }));
    const gain = voice[0] as FakeGain;
    expect(voice.some((node) => node instanceof FakePanner)).toBe(false);
    expect(gain.outputs).toHaveLength(1);
    expect(gain.outputs[0]).toBe(masterOf(context));
  });
});

describe("the sound recipes", () => {
  // Design §17: cue, length in ms, gain.
  it.each<[Cue, number, number]>([
    ["draw", 140, 0.25],
    ["land", 180, 0.5],
    ["cast", 320, 0.3],
    ["resolve", 500, 0.3],
    ["enter", 200, 0.45],
    ["die", 380, 0.35],
    ["tap", 40, 0.15],
    ["counter", 80, 0.2],
    ["damage", 260, 0.5],
    ["lifeGain", 300, 0.3],
    ["attack", 450, 0.4],
    ["block", 250, 0.3],
    ["phase", 350, 0.25],
    ["yourTurn", 600, 0.3],
    ["tick", 30, 0.15],
    ["victory", 1400, 0.4],
    ["defeat", 1200, 0.35],
    ["drawGame", 800, 0.3],
    ["refused", 220, 0.25],
  ])("%s lasts %s ms at gain %s, every part inside it", (cue, ms, gain) => {
    const recipe = RECIPES[cue];
    expect(recipe).toMatchObject({ ms, gain });
    for (const part of [...recipe.parts, ...(recipe.low ?? [])])
      expect(
        (part.atMs ?? 0) + (part.ms ?? ms - (part.atMs ?? 0)),
      ).toBeLessThanOrEqual(ms);
  });

  it("has nineteen cues, and a falling counter", () => {
    expect(CUES).toHaveLength(19);
    expect(RECIPES.counter.parts).toMatchObject([{ hz: 1320 }]);
    expect(RECIPES.counter.low).toMatchObject([{ hz: 660 }]);
  });

  it("plays the counter's falling variant when asked", async () => {
    const { engine, context } = await unlocked();
    engines.push(engine);
    const voice = made(context, () => engine.play("counter", { low: true }));
    const tone = voice.find((node) => node instanceof FakeOscillator);
    expect(tone?.frequency.events[0][1]).toBe(660);
  });
});

/* ---------- cues ---------- */

function rect(x: number, w = 100) {
  return { x, y: 500, w, h: 140 };
}

/** Enough of a layout to pan by: a card on each side, two portraits and their tiles. */
const layout = {
  nodes: new Map([
    ["battlefield:c1", { kind: "card", footprint: rect(1710) }],
    ["hand:h1", { kind: "card", footprint: rect(350) }],
    ["stack:s1", { kind: "card", footprint: rect(910) }],
    ["more:1", { kind: "more", hit: rect(1890, 20) }],
  ]),
  players: new Map([
    [0, { portrait: { cx: 160 }, counts: { hand: { cx: 260 } } }],
    [1, { portrait: { cx: 1700 }, counts: { hand: { cx: 1600 } } }],
  ]),
  zones: [
    { seat: 0, zone: "library", card: rect(60), topKey: null },
    { seat: 1, zone: "graveyard", card: rect(1810), topKey: "graveyard:c9" },
  ],
} as unknown as TableLayout;

function diff(...events: TableEvent[]): TableDiff {
  return { baseline: false, events };
}

const c1 = "battlefield:c1";
const appear = { kind: "appear" } as const;
const graveyard = { kind: "anchor", anchor: "graveyard", seat: 1 } as const;

/** One of each event the cues are tested with. */
const events = {
  draw: { type: "draw", seat: 0, keys: ["hand:h1"], count: 1 },
  cast: { type: "cast", key: "stack:s1", controllerSeat: 1, from: appear },
  resolve: { type: "resolve", key: "stack:s1", to: { kind: "node", key: c1 } },
  instant: { type: "resolve", key: "stack:s1", to: graveyard },
  land: { type: "enter", key: c1, from: appear, land: true, token: false },
  token: { type: "enter", key: c1, from: appear, land: false, token: true },
  permanent: {
    type: "enter",
    key: "hand:h1",
    from: appear,
    land: false,
    token: false,
  },
  dies: { type: "leave", key: c1, to: graveyard, creature: true },
  dropped: {
    type: "leave",
    key: c1,
    to: { kind: "node", key: "graveyard:c9" },
    creature: true,
  },
  exiled: {
    type: "leave",
    key: c1,
    to: { kind: "anchor", anchor: "exile", seat: 1 },
    creature: true,
  },
  destroyed: { type: "leave", key: c1, to: graveyard, creature: false },
  tap: { type: "tap", key: c1, tapped: true },
  untap: { type: "tap", key: c1, tapped: false },
  counter: { type: "counters", key: c1, seat: null, counter: "p1p1", delta: 1 },
  uncounter: {
    type: "counters",
    key: c1,
    seat: null,
    counter: "p1p1",
    delta: -1,
  },
  damage: { type: "damage", key: c1, amount: 3 },
  lifeLost: { type: "life", seat: 1, delta: -3 },
  lifeGained: { type: "life", seat: 0, delta: 4 },
  commander: { type: "commanderDamage", seat: 0, fromSeat: 1, delta: 5 },
  attack: { type: "attack", keys: [c1] },
  block: { type: "block", keys: [c1] },
  yourTurn: { type: "turn", turn: 4, activeSeat: 0 },
  theirTurn: { type: "turn", turn: 5, activeSeat: 1 },
  emblem: {
    type: "step",
    phase: "combat",
    step: "declare_attackers",
    emblem: "attack",
  },
  turnEmblem: {
    type: "step",
    phase: "beginning",
    step: "upkeep",
    emblem: "turn",
  },
  damageStep: {
    type: "step",
    phase: "combat",
    step: "combat_damage",
    emblem: null,
  },
  blockStep: {
    type: "step",
    phase: "combat",
    step: "declare_blockers",
    emblem: "block",
  },
  mainStep: {
    type: "step",
    phase: "postcombat_main",
    step: "postcombat_main",
    emblem: null,
  },
  eliminated: { type: "eliminated", seat: 1 },
  victory: { type: "result", outcome: "victory" },
  defeat: { type: "result", outcome: "defeat" },
  drawn: { type: "result", outcome: "draw" },
  over: { type: "result", outcome: "over" },
} satisfies Record<string, TableEvent>;

describe("the cues for a diff", () => {
  it.each<[string, TableEvent, Cue | null, boolean?]>([
    ["a draw", events.draw, "draw"],
    ["a cast", events.cast, "cast"],
    ["a permanent resolving", events.resolve, "resolve"],
    ["an instant resolving", events.instant, null],
    ["a land entering", events.land, "land"],
    ["a token entering", events.token, "enter"],
    ["a creature dying", events.dies, "die"],
    ["a creature put in a graveyard", events.dropped, "die"],
    ["a creature exiled", events.exiled, null],
    ["an artifact destroyed", events.destroyed, null],
    ["a tap", events.tap, "tap"],
    ["an untap", events.untap, "tap"],
    ["a counter added", events.counter, "counter"],
    ["a counter removed", events.uncounter, "counter", true],
    ["damage", events.damage, "damage"],
    ["life lost", events.lifeLost, "damage"],
    ["life gained", events.lifeGained, "lifeGain"],
    ["commander damage", events.commander, "damage"],
    ["an attack", events.attack, "attack"],
    ["a block", events.block, "block"],
    ["the viewer's turn", events.yourTurn, "yourTurn"],
    ["another player's turn", events.theirTurn, null],
    ["a step emblem", events.emblem, "phase"],
    ["a step without an emblem", events.damageStep, null],
    ["an elimination", events.eliminated, null],
    ["a victory", events.victory, "victory"],
    ["a defeat", events.defeat, "defeat"],
    ["a drawn game", events.drawn, "drawGame"],
    ["a game over for an observer", events.over, "drawGame"],
  ])("%s", (_, event, cue, low) => {
    const cues = cuesFor(diff(event), layout, 0);
    expect(cues.map((call) => call.cue)).toEqual(cue ? [cue] : []);
    if (cue) expect(Boolean(cues[0].low)).toBe(Boolean(low));
  });

  it("makes nothing for a baseline", () => {
    expect(
      cuesFor({ baseline: true, events: [events.tap] }, layout, 0),
    ).toEqual([]);
  });

  it("sounds each cue once per diff, in event order, 60 ms apart", () => {
    const cues = cuesFor(
      diff(
        events.tap,
        { ...events.tap, key: "hand:h1" },
        events.cast,
        events.draw,
      ),
      layout,
      0,
    );
    expect(cues.map(({ cue, delayMs }) => [cue, delayMs])).toEqual([
      ["tap", 0],
      ["cast", 60],
      ["draw", 120],
    ]);
  });

  it("pans to where the event is on the stage", () => {
    const pan = (event: TableEvent) => cuesFor(diff(event), layout, 0)[0].pan;
    expect(pan(events.tap)).toBeCloseTo(0.5);
    expect(pan(events.cast)).toBe(0);
    expect(pan(events.lifeLost)).toBeCloseTo(0.4625);
    // A draw comes off the library's tile.
    expect(pan(events.draw)).toBeCloseTo(-0.53125);
    // A card gone to a graveyard is shown on that tile.
    expect(pan(events.dropped)).toBeCloseTo(0.5625);
    // Several attackers sound from between them.
    expect(pan({ type: "attack", keys: [c1, "hand:h1"] })).toBeCloseTo(0.075);
    expect(pan(events.victory)).toBe(0);
    expect(panAt(1920)).toBe(0.6);
    expect(panAt(0)).toBe(-0.6);
    // Without a layout everything is centred.
    expect(cuesFor(diff(events.tap), null, 0)[0].pan).toBe(0);
  });

  it("lets Your Turn stand in for the turn's step emblem", () => {
    const cues = cuesFor(diff(events.yourTurn, events.turnEmblem), layout, 0);
    expect(cues.map((call) => call.cue)).toEqual(["yourTurn"]);
  });

  it("keeps the most telling six when a diff would make more", () => {
    const cues = cuesFor(
      diff(
        events.tap,
        events.counter,
        events.draw,
        events.turnEmblem,
        events.land,
        events.permanent,
        events.dies,
        events.victory,
      ),
      layout,
      0,
    );
    expect(cues.map((call) => call.cue)).toEqual([
      "draw",
      "phase",
      "land",
      "enter",
      "die",
      "victory",
    ]);
    expect(cues.map((call) => call.delayMs)).toEqual([
      0, 60, 120, 180, 240, 300,
    ]);
  });

  it("sounds the attack once per combat", () => {
    const both = cuesFor(diff(events.attack, events.tap), layout, 0);
    const first = attackOnce(both, diff(events.attack), false);
    expect(first.cues.map((call) => call.cue)).toEqual(["attack", "tap"]);
    expect(first.sounded).toBe(true);
    const again = attackOnce(both, diff(events.attack), true);
    expect(again.cues.map(({ cue, delayMs }) => [cue, delayMs])).toEqual([
      ["tap", 0],
    ]);
    // The next turn, or a step out of combat, is a new combat; another combat step is not.
    const attack = cuesFor(diff(events.attack), layout, 0);
    expect(
      attackOnce(attack, diff(events.theirTurn, events.attack), true).cues,
    ).toHaveLength(1);
    expect(attackOnce([], diff(events.mainStep), true).sounded).toBe(false);
    expect(attackOnce([], diff(events.blockStep), true).sounded).toBe(true);
  });
});

/* ---------- the hook ---------- */

interface SoundProps {
  diff: TableDiff | null;
  settings: TableSettings;
  refusal: string | null;
  timer: TimerView | null;
}

/** The hook over the page's engine, whose calls are watched (jsdom has no Web Audio). */
function mountSound(first: Partial<SoundProps> = {}) {
  const engine = getSoundEngine();
  const play = vi.spyOn(engine, "play").mockImplementation(() => {});
  const setVolume = vi.spyOn(engine, "setVolume");
  const setMuted = vi.spyOn(engine, "setMuted");
  const unlock = vi.spyOn(engine, "unlock");
  let props: SoundProps = {
    diff: null,
    settings: DEFAULT_TABLE_SETTINGS,
    refusal: null,
    timer: null,
    ...first,
  };
  const hook = renderHook(
    (current: SoundProps) => useTableSound({ ...current, layout, viewSeat: 0 }),
    { initialProps: props },
  );
  return {
    play,
    setVolume,
    setMuted,
    unlock,
    played: () => play.mock.calls.map(([cue]) => cue),
    update(next: Partial<SoundProps>) {
      props = { ...props, ...next };
      hook.rerender(props);
    },
  };
}

function running(remainingMs: number): TimerView {
  return {
    key: "p1|s1",
    phase: "running",
    remainingMs,
    totalMs: 8000,
    subject: null,
  };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("the table's sound hook", () => {
  it("applies the volume and mute settings", () => {
    const sound = mountSound();
    expect(sound.setVolume).toHaveBeenLastCalledWith(70);
    expect(sound.setMuted).toHaveBeenLastCalledWith(false);
    sound.update({
      settings: { ...DEFAULT_TABLE_SETTINGS, effectsVolume: 30, muted: true },
    });
    expect(sound.setVolume).toHaveBeenLastCalledWith(30);
    expect(sound.setMuted).toHaveBeenLastCalledWith(true);
  });

  it("plays each committed diff once, and nothing for a baseline", () => {
    const sound = mountSound({
      diff: { baseline: true, events: [events.tap] },
    });
    expect(sound.play).not.toHaveBeenCalled();
    const change = diff(events.cast, events.tap);
    sound.update({ diff: change });
    expect(sound.play.mock.calls).toEqual([
      ["cast", { pan: 0, delayMs: 0 }],
      ["tap", { pan: 0.5, delayMs: 60 }],
    ]);
    // A re-render with the same diff, for another reason, plays nothing again.
    sound.update({ refusal: null });
    sound.update({ diff: change });
    expect(sound.play).toHaveBeenCalledTimes(2);
  });

  it("sounds the attack once per combat across diffs", () => {
    const sound = mountSound({ diff: diff(events.attack) });
    sound.update({ diff: diff(events.attack) });
    expect(sound.played()).toEqual(["attack"]);
    sound.update({ diff: diff(events.theirTurn, events.attack) });
    expect(sound.played()).toEqual(["attack", "attack"]);
  });

  it("buzzes for a new refusal, not the one already shown", () => {
    const sound = mountSound({ refusal: "That prompt has changed." });
    expect(sound.play).not.toHaveBeenCalled();
    sound.update({ refusal: "Not your priority." });
    sound.update({ refusal: null });
    expect(sound.played()).toEqual(["refused"]);
  });

  it("ticks once a second in the timer's last three seconds", () => {
    const sound = mountSound({ timer: running(8000) });
    advance(4999);
    expect(sound.play).not.toHaveBeenCalled();
    advance(1);
    expect(sound.played()).toEqual(["tick"]);
    advance(1000);
    expect(sound.played()).toEqual(["tick", "tick"]);
    // Stopped: the last tick never comes.
    sound.update({ timer: { ...running(0), phase: "stopped" } });
    advance(5000);
    expect(sound.played()).toEqual(["tick", "tick"]);
    // Resumed with 2 s left: two ticks, the first at once.
    sound.update({ timer: running(2000) });
    advance(1000);
    expect(sound.played()).toEqual(["tick", "tick", "tick", "tick"]);
  });

  it("unlocks on the first press in the game while sound is locked", () => {
    const engine = getSoundEngine();
    const state = vi.spyOn(engine, "state", "get").mockReturnValue("locked");
    const sound = mountSound();
    window.dispatchEvent(new Event("keydown"));
    expect(sound.unlock).toHaveBeenCalledTimes(1);
    state.mockReturnValue("running");
    window.dispatchEvent(new Event("pointerdown"));
    expect(sound.unlock).toHaveBeenCalledTimes(1);
  });

  it("listens for nothing when there is no Web Audio", () => {
    const sound = mountSound();
    window.dispatchEvent(new Event("pointerdown"));
    expect(sound.unlock).not.toHaveBeenCalled();
  });
});
