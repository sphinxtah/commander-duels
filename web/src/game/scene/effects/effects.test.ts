import { afterEach, describe, expect, it, vi } from "vitest";
import { Container, Sprite, Texture } from "../pixi";
import { DURATIONS } from "../timeline";
import {
  burstHue,
  EffectsNode,
  GOLD,
  MANA_HUES,
  placeOf,
  SLASH_HOLD,
  type EffectsKit,
} from "./EffectsNode";
import { defaultParticle, drift, particleAt, rng, spray } from "./particles";
import {
  flashAlpha,
  slashAlpha,
  slashStrokes,
  strokePolygon,
  strokeProgress,
} from "./slash";

// The special effects (v0.7.0) on PixiJS's real scene graph with no renderer: the node is asked
// for its frames on a test clock. Canvas drawing is stubbed, as the scene's own test does.

vi.hoisted(() => {
  const context2d: unknown = new Proxy(function () {}, {
    get: (_target, name) => (name === Symbol.toPrimitive ? () => 0 : context2d),
    apply: () => context2d,
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = (() => context2d) as never;
});

describe("particles", () => {
  it("are born, travel and die on their own share of the effect's life", () => {
    const p = {
      ...defaultParticle,
      x: 100,
      y: 50,
      vx: 200,
      vy: -100,
      gravity: 1000,
      from: 0.2,
      to: 0.7,
    };
    expect(particleAt(p, 0.1, 1000).shown).toBe(false);
    expect(particleAt(p, 0.8, 1000).shown).toBe(false);
    const start = particleAt(p, 0.2, 1000);
    expect(start.shown).toBe(true);
    expect(start.x).toBeCloseTo(100);
    expect(start.y).toBeCloseTo(50);
    // Half way: 0.25 s on, so 50 su right, 25 up and 31.25 down from gravity.
    const mid = particleAt(p, 0.45, 1000);
    expect(mid.x).toBeCloseTo(150);
    expect(mid.y).toBeCloseTo(50 - 25 + 31.25);
    expect(mid.alpha).toBe(1);
    // Fading out over the last third.
    expect(particleAt(p, 0.69, 1000).alpha).toBeLessThan(0.1);
  });

  it("slow down with drag and never travel further than the drag allows", () => {
    const p = { ...defaultParticle, vx: 100, drag: 0.1 };
    const far = particleAt(p, 1, 10_000).x;
    // With 10% of the speed left each second, the whole flight is under 100 / ln(10) ≈ 43 su.
    expect(far).toBeLessThan(44);
    expect(far).toBeGreaterThan(40);
  });

  it("spray and drift are the same for the same seed", () => {
    const a = spray(7, 5, { x: 0, y: 0 }, 100, [1, 2]);
    const b = spray(7, 5, { x: 0, y: 0 }, 100, [1, 2]);
    expect(a).toEqual(b);
    expect(spray(8, 5, { x: 0, y: 0 }, 100, [1, 2])).not.toEqual(a);
    expect(a.map((p) => p.tint)).toEqual([1, 2, 1, 2, 1]);
    for (const p of a)
      expect(Math.hypot(p.vx, p.vy)).toBeGreaterThanOrEqual(100);
    const d = drift(3, 4, { x: 10, y: 20, w: 100, h: 50 }, -80, {}, [9]);
    for (const p of d) {
      expect(p.x).toBeGreaterThanOrEqual(10);
      expect(p.x).toBeLessThanOrEqual(110);
      expect(p.vy).toBeLessThan(0);
    }
    const random = rng(1);
    const values = [random(), random(), random()];
    for (const v of values) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of values) expect(v).toBeLessThan(1);
    expect(new Set(values).size).toBe(3);
  });
});

describe("the slash", () => {
  it("cuts two strokes across the card, the first before the second", () => {
    const [a, b] = slashStrokes(100, 140);
    expect(a[0].x).toBeLessThan(0);
    expect(a[0].y).toBeLessThan(0);
    expect(a[a.length - 1].x).toBeGreaterThan(0);
    expect(b[0].x).toBeGreaterThan(0);
    expect(b[b.length - 1].x).toBeLessThan(0);
    // Sharp at the ends, thick in the middle.
    expect(a[0].half).toBe(0);
    expect(a[4].half).toBeGreaterThan(5);
    expect(strokeProgress(0)).toEqual([0, 0]);
    const [p1, p2] = strokeProgress(0.2);
    expect(p1).toBeGreaterThan(0.9);
    expect(p2).toBeGreaterThan(0);
    expect(p2).toBeLessThan(0.3);
    expect(strokeProgress(0.4)).toEqual([1, 1]);
  });

  it("outlines what has been cut so far as one closed polygon", () => {
    const [a] = slashStrokes(100, 140);
    expect(strokePolygon(a, 0)).toEqual([]);
    const half = strokePolygon(a, 0.5);
    const whole = strokePolygon(a, 1);
    expect(half.length % 2).toBe(0);
    expect(whole.length).toBe(a.length * 4);
    expect(half.length).toBeLessThan(whole.length);
    // The outline is the same shape a little larger; the core never crosses over.
    const outline = strokePolygon(a, 1, 2);
    expect(Math.max(...outline)).toBeGreaterThan(Math.max(...whole));
    const core = strokePolygon(a, 1, -100);
    expect(core.length).toBe(whole.length);
  });

  it("flashes red at once and fades the X out at the end", () => {
    expect(flashAlpha(0.06)).toBeCloseTo(0.38);
    expect(flashAlpha(0.5)).toBe(0);
    expect(slashAlpha(0.5)).toBe(1);
    expect(slashAlpha(1)).toBe(0);
  });
});

describe("the effects node", () => {
  let now = 1000;
  const made: EffectsNode[] = [];
  function node(motion = 1): EffectsNode {
    const kit: EffectsKit = {
      clock: () => now,
      texture: () => new Texture(),
      duration: (name) => Math.round(DURATIONS[name] * motion),
    };
    const fx = new EffectsNode(kit);
    made.push(fx);
    return fx;
  }
  const card = placeOf({ cx: 400, cy: 600, height: 140, rotation: 0 });
  const seat = { cx: 1700, cy: 300, side: 90 };
  const edges = { left: 0, right: 1920, top: 0, bottom: 1080 };
  function sprites(root: Container): Sprite[] {
    const out: Sprite[] = [];
    const walk = (c: Container) => {
      if (c instanceof Sprite) out.push(c);
      for (const child of c.children) walk(child);
    };
    walk(root);
    return out;
  }
  afterEach(() => {
    for (const fx of made) fx.destroy();
    made.length = 0;
    now = 1000;
  });

  it("holds a slain card under its X for part of the slash, then lets it all go", () => {
    const fx = node();
    expect(fx.slash(card, true)).toBe(Math.round(DURATIONS.slash * SLASH_HOLD));
    expect(fx.active).toBe(true);
    expect(sprites(fx.root)).toHaveLength(12);
    fx.update(now);
    // Before the second stroke lands no spark is shown.
    expect(sprites(fx.root).filter((s) => s.visible)).toHaveLength(0);
    now += DURATIONS.slash * 0.5;
    fx.update(now);
    expect(sprites(fx.root).filter((s) => s.visible).length).toBeGreaterThan(0);
    now += DURATIONS.slash;
    fx.update(now);
    expect(fx.active).toBe(false);
    expect(fx.root.children).toHaveLength(0);
  });

  it("plays no slash and holds nothing with no time to play in", () => {
    const fx = node(0);
    expect(fx.slash(card, true)).toBe(0);
    expect(fx.active).toBe(false);
  });

  it("leaves the particles out when asked, and keeps the marks", () => {
    const fx = node();
    fx.slash(card, false);
    fx.burst(card, ["R"], false, false);
    fx.stomp(card, false);
    fx.impact(seat, true, false, null);
    fx.shatter(seat, false);
    expect(sprites(fx.root)).toHaveLength(0);
    expect(fx.count).toBe(5);
  });

  it("waits for a flight before a burst, then plays it", () => {
    const fx = node();
    fx.burst(card, ["U", "R"], false, true, 300);
    fx.update(now);
    expect(fx.root.children[0].visible).toBe(false);
    now += 350;
    fx.update(now);
    expect(fx.root.children[0].visible).toBe(true);
    expect(sprites(fx.root)).toHaveLength(14);
    now += DURATIONS.burst;
    fx.update(now);
    expect(fx.active).toBe(false);
  });

  it("flares the four edges only for the viewer's own heavy blow", () => {
    const fx = node();
    fx.impact(seat, false, true, edges);
    expect(sprites(fx.root)).toHaveLength(10 + 4);
    fx.clear();
    fx.impact(seat, true, true, null);
    expect(sprites(fx.root)).toHaveLength(16);
  });

  it("drops confetti and ash across the whole view, and sweeps the band", () => {
    const fx = node();
    fx.confetti(edges);
    expect(sprites(fx.root)).toHaveLength(56);
    fx.ashfall(edges);
    expect(sprites(fx.root)).toHaveLength(56 + 36);
    fx.shine({ x: 0, y: 0, w: 1920, h: 88 }, { left: 0, right: 1920 });
    fx.glitter(seat);
    fx.embers(card);
    fx.shield(card);
    fx.ash(card);
    expect(fx.count).toBe(7);
    now += 100;
    fx.update(now);
    for (const sprite of sprites(fx.root))
      expect(Number.isFinite(sprite.x) && Number.isFinite(sprite.y)).toBe(true);
    now += DURATIONS.confetti;
    fx.update(now);
    expect(fx.active).toBe(false);
  });

  it("clears everything at once, and destroys cleanly", () => {
    const fx = node();
    fx.slash(card, true);
    fx.confetti(edges);
    fx.clear();
    expect(fx.active).toBe(false);
    expect(fx.root.children).toHaveLength(0);
    fx.destroy();
    expect(fx.active).toBe(false);
    expect(() => fx.clear()).not.toThrow();
  });

  it("colours a burst by the spell's colours", () => {
    expect(burstHue(["R"], false)).toBe(MANA_HUES.R);
    expect(burstHue(["U", "R"], false)).toBe(GOLD);
    expect(burstHue([], true)).toBe(GOLD);
    expect(burstHue([], false)).not.toBe(GOLD);
  });
});
