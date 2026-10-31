import type { ManaColour, Rect } from "../../table/types";
import { canvas } from "../art";
import { Container, Graphics, Sprite, type Texture } from "../pixi";
import { drift, particleAt, spray, type ParticleSpec } from "./particles";
import {
  flashAlpha,
  slashAlpha,
  slashStrokes,
  SPARKS_AT,
  strokePolygon,
  strokeProgress,
} from "./slash";

// The special effects layer (v0.7.0): what the table draws over itself when something notable
// happens. Each effect lives for a fixed time on the scene's clock and is drawn from `t` alone,
// so a dropped frame costs nothing and a test can step straight to any moment. Everything is
// Graphics and sprites of three small textures made once; there are no filters, so a weak GPU
// pays for a few hundred quads at most. Nothing here knows the game: the scene resolves each
// planned effect (plan.ts) to a place on the stage and calls one of the methods below.

/** A card's place on the stage: its centre, size and turn, in stage units and degrees. */
export interface Place {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

/** A portrait's place: its centre and the side of its diamond. */
export interface Spot {
  cx: number;
  cy: number;
  side: number;
}

/** The view's edges in stage units: wider than the stage on an ultrawide screen. */
export interface Edges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface EffectsKit {
  clock(): number;
  /** A texture from a canvas, at the scene's resolution. */
  texture(c: HTMLCanvasElement): Texture;
  /** How long an effect lasts at the current motion level. */
  duration(
    name:
      | "slash"
      | "ash"
      | "burst"
      | "stomp"
      | "embers"
      | "shield"
      | "impact"
      | "glitter"
      | "shatter"
      | "confetti"
      | "shine",
  ): number;
}

/** The hues of a spell's burst, by the colours of its cost. */
export const MANA_HUES: Record<ManaColour, number> = {
  W: 0xf7f0c4,
  U: 0x4aa3ff,
  B: 0xa066ff,
  R: 0xff6a3d,
  G: 0x5fd36a,
};
export const GOLD = 0xe8c35a;
export const COLOURLESS = 0xc9d2e3;

/** One hue for a burst: the colour of a one-colour spell, gold for several (and a commander),
 * steel for none. */
export function burstHue(colours: ManaColour[], commander: boolean): number {
  if (commander || colours.length > 1) return GOLD;
  return colours.length === 1 ? MANA_HUES[colours[0]] : COLOURLESS;
}

const CARD_RATIO = 150 / 209.52;
/** How long the shine's beam is along the band, in stage units. */
const BEAM_LENGTH = 260;

/** The share of the slash's life its card waits before leaving: the second stroke has landed and
 * the X has been seen. */
export const SLASH_HOLD = 0.45;

interface Particle {
  spec: ParticleSpec;
  sprite: Sprite;
}

interface Effect {
  root: Container;
  start: number;
  ms: number;
  particles: Particle[];
  draw(t: number): void;
}

export class EffectsNode {
  readonly root = new Container();
  private readonly kit: EffectsKit;
  private readonly effects: Effect[] = [];
  private textures: { dot: Texture; shard: Texture; beam: Texture } | null =
    null;
  private seed = 1;
  private destroyed = false;

  constructor(kit: EffectsKit) {
    this.kit = kit;
  }

  /** Whether anything is still playing (or waiting to start). */
  get active(): boolean {
    return this.effects.length > 0;
  }

  get count(): number {
    return this.effects.length;
  }

  /** One frame: every effect drawn at its moment; the ones over are let go. */
  update(now: number): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      const t = effect.ms <= 0 ? 1 : (now - effect.start) / effect.ms;
      if (t < 0) {
        effect.root.visible = false;
        continue;
      }
      if (t >= 1) {
        this.effects.splice(i, 1);
        effect.root.destroy({ children: true });
        continue;
      }
      effect.root.visible = true;
      for (const { spec, sprite } of effect.particles) {
        const pose = particleAt(spec, t, effect.ms);
        sprite.visible = pose.shown;
        if (!pose.shown) continue;
        sprite.position.set(pose.x, pose.y);
        sprite.rotation = pose.rotation;
        sprite.scale.set(pose.scaleX, pose.scaleY);
        sprite.alpha = pose.alpha;
      }
      effect.draw(t);
    }
  }

  clear(): void {
    for (const effect of this.effects) effect.root.destroy({ children: true });
    this.effects.length = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
    this.root.destroy({ children: true });
    if (this.textures) {
      for (const texture of Object.values(this.textures)) texture.destroy(true);
      this.textures = null;
    }
  }

  /* ---------- the effects ---------- */

  /** The X slashed over a creature slain in combat: two strokes, a red flash, sparks as the
   * second lands. Returns how long its card should wait before it leaves. */
  slash(at: Place, sparks: boolean): number {
    const ms = this.kit.duration("slash");
    if (ms <= 0) return 0;
    const { w, h } = at;
    const strokes = slashStrokes(w, h);
    const body = new Container();
    body.position.set(at.cx, at.cy);
    body.rotation = (at.rotation * Math.PI) / 180;
    const flash = new Graphics();
    flash.roundRect(-w / 2, -h / 2, w, h, w * 0.045).fill(0xff2a2a);
    const outline = new Graphics();
    const red = new Graphics();
    const core = new Graphics();
    body.addChild(flash, outline, red, core);
    const particles = sparks
      ? this.sprites(
          body,
          spray(
            this.nextSeed(),
            12,
            {
              x: 0,
              y: 0,
              gravity: 900,
              drag: 0.35,
              scaleFrom: 0.5,
              scaleTo: 0,
              from: SPARKS_AT,
              to: SPARKS_AT + 0.42,
              alpha: 1,
            },
            260,
            [0xffb347, 0xff5a3c, 0xffe08a],
          ),
          "dot",
        )
      : [];
    let cut = -1;
    this.add(body, ms, particles, (t) => {
      flash.alpha = flashAlpha(t);
      const [a, b] = strokeProgress(t);
      // The strokes are redrawn only while they are being cut.
      if (cut < 1) {
        outline.clear();
        red.clear();
        core.clear();
        const draw = (points: (typeof strokes)[0], p: number) => {
          if (p <= 0) return;
          outline.poly(strokePolygon(points, p, w * 0.012)).fill({
            color: 0x3a0505,
            alpha: 0.95,
          });
          red.poly(strokePolygon(points, p)).fill(0xe8262c);
          core.poly(strokePolygon(points, p, -w * 0.02)).fill({
            color: 0xffb3b3,
            alpha: 0.9,
          });
        };
        draw(strokes[0], a);
        draw(strokes[1], b);
        cut = Math.min(a, b);
      }
      const alpha = slashAlpha(t);
      outline.alpha = alpha;
      red.alpha = alpha;
      core.alpha = alpha;
    });
    return Math.round(ms * SLASH_HOLD);
  }

  /** Ash rising off a creature that died another way. */
  ash(at: Place): void {
    const ms = this.kit.duration("ash");
    if (ms <= 0) return;
    const root = new Container();
    const particles = this.sprites(
      root,
      drift(
        this.nextSeed(),
        9,
        {
          x: at.cx - at.w * 0.4,
          y: at.cy - at.h * 0.3,
          w: at.w * 0.8,
          h: at.h * 0.6,
        },
        -70,
        {
          scaleFrom: 0.45,
          scaleTo: 0.1,
          additive: false,
          alpha: 0.85,
          to: 1,
          swayAmp: 6,
          swayTurns: 1.5,
        },
        [0x8a8a8a, 0x5c5c5c, 0x3b3b3b],
      ),
      "dot",
    );
    this.add(root, ms, particles, () => undefined);
  }

  /** The arcane burst of a commander cast or a big spell: a ring in the spell's colour, a second
   * for a commander, and motes thrown outward. */
  burst(
    at: Place,
    colours: ManaColour[],
    commander: boolean,
    motes: boolean,
    delayMs = 0,
  ): void {
    const ms = this.kit.duration("burst");
    if (ms <= 0) return;
    const hue = burstHue(colours, commander);
    const root = new Container();
    root.position.set(at.cx, at.cy);
    const ring = new Graphics();
    root.addChild(ring);
    const particles = motes
      ? this.sprites(
          root,
          spray(
            this.nextSeed(),
            commander ? 18 : 14,
            {
              x: 0,
              y: 0,
              drag: 0.2,
              scaleFrom: 0.6,
              scaleTo: 0.05,
              to: 0.9,
              alpha: 0.95,
              flicker: true,
            },
            at.h * 1.4,
            commander ? [GOLD, 0xfff2c4, 0xffffff] : [hue, 0xffffff],
          ),
          "dot",
        )
      : [];
    const r0 = at.h * 0.12;
    const r1 = at.h * 0.95;
    this.add(
      root,
      ms,
      particles,
      (t) => {
        const e = 1 - (1 - t) ** 3;
        ring.clear();
        const r = r0 + (r1 - r0) * e;
        ring.circle(0, 0, r).stroke({
          width: 7 * (1 - e) + 1,
          color: hue,
          alpha: (1 - t) * 0.95,
        });
        ring.circle(0, 0, r * 0.6).stroke({
          width: 3 * (1 - e) + 0.5,
          color: 0xffffff,
          alpha: (1 - t) * 0.5,
        });
        if (commander) {
          const u = Math.max(0, Math.min(1, (t - 0.12) / 0.88));
          const e2 = 1 - (1 - u) ** 3;
          ring.circle(0, 0, r0 + (r1 * 1.25 - r0) * e2).stroke({
            width: 4 * (1 - e2) + 1,
            color: 0xfff2c4,
            alpha: (1 - u) * 0.8,
          });
        }
      },
      delayMs,
    );
  }

  /** The dust ring under a big creature landing, with puffs rolling out. */
  stomp(at: Place, puffs: boolean, delayMs = 0): void {
    const ms = this.kit.duration("stomp");
    if (ms <= 0) return;
    const root = new Container();
    const footY = at.cy + at.h * 0.36;
    root.position.set(at.cx, footY);
    const ring = new Graphics();
    root.addChild(ring);
    const particles = puffs
      ? this.sprites(
          root,
          spray(
            this.nextSeed(),
            8,
            {
              x: 0,
              y: 0,
              drag: 0.15,
              gravity: -40,
              scaleFrom: 0.9,
              scaleTo: 1.3,
              additive: false,
              alpha: 0.45,
              to: 1,
            },
            at.w * 0.9,
            [0x9b8c74, 0x7d7060, 0xb5a78e],
          ),
          "dot",
        )
      : [];
    for (const { spec } of particles) spec.vy = -Math.abs(spec.vy) * 0.4;
    this.add(
      root,
      ms,
      particles,
      (t) => {
        const e = 1 - (1 - t) ** 3;
        const rx = at.w * (0.2 + 0.95 * e);
        ring.clear();
        ring.ellipse(0, 0, rx, rx * 0.32).stroke({
          width: 6 * (1 - e) + 1,
          color: 0xa8977a,
          alpha: (1 - t) * 0.7,
        });
      },
      delayMs,
    );
  }

  /** Embers rising off an attacker. */
  embers(at: Place): void {
    const ms = this.kit.duration("embers");
    if (ms <= 0) return;
    const root = new Container();
    const particles = this.sprites(
      root,
      drift(
        this.nextSeed(),
        6,
        {
          x: at.cx - at.w * 0.4,
          y: at.cy - at.h * 0.1,
          w: at.w * 0.8,
          h: at.h * 0.5,
        },
        -160,
        {
          scaleFrom: 0.4,
          scaleTo: 0.05,
          alpha: 1,
          flicker: true,
          swayAmp: 5,
          swayTurns: 2,
        },
        [0xff7a2a, 0xffc14d, 0xff4d1f],
      ),
      "dot",
    );
    this.add(root, ms, particles, () => undefined);
  }

  /** The steel shimmer on a blocker: a pale frame closing on the card. */
  shield(at: Place): void {
    const ms = this.kit.duration("shield");
    if (ms <= 0) return;
    const root = new Container();
    root.position.set(at.cx, at.cy);
    root.rotation = (at.rotation * Math.PI) / 180;
    const frame = new Graphics();
    root.addChild(frame);
    this.add(root, ms, [], (t) => {
      const e = 1 - (1 - t) ** 2;
      const s = 1.28 - 0.28 * e;
      const w = at.w * s;
      const h = at.h * s;
      frame.clear();
      frame.roundRect(-w / 2, -h / 2, w, h, w * 0.06).stroke({
        width: 4,
        color: 0x9fd3ff,
        alpha: Math.sin(Math.PI * t) * 0.9,
      });
      frame.roundRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10, w * 0.05).stroke({
        width: 1.5,
        color: 0xffffff,
        alpha: Math.sin(Math.PI * t) * 0.6,
      });
    });
  }

  /** A heavy blow to a player: a shock ring off the portrait, sparks, and, for your own life,
   * the screen's edges flaring red once. `edges` spans the stage as the viewer sees it. */
  impact(at: Spot, heavy: boolean, sparks: boolean, edges: Edges | null): void {
    const ms = this.kit.duration("impact");
    if (ms <= 0) return;
    const root = new Container();
    const ring = new Graphics();
    ring.position.set(at.cx, at.cy);
    root.addChild(ring);
    const particles = sparks
      ? this.sprites(
          root,
          spray(
            this.nextSeed(),
            heavy ? 16 : 10,
            {
              x: at.cx,
              y: at.cy,
              gravity: 700,
              drag: 0.4,
              scaleFrom: 0.55,
              scaleTo: 0,
              to: 0.85,
              alpha: 1,
            },
            at.side * (heavy ? 3.2 : 2.4),
            [0xff5a5a, 0xffb347, 0xff2a2a],
          ),
          "dot",
        )
      : [];
    const beams: Sprite[] = [];
    if (edges) {
      const beam = this.sheet().beam;
      const thick = heavy ? 260 : 180;
      const w = edges.right - edges.left;
      const h = edges.bottom - edges.top;
      // Four strips of one gradient, each fading away from its edge.
      const strips: [number, number, number, number, number][] = [
        [edges.left, edges.top, w, thick, 0], // top
        [edges.right, edges.top, h, thick, Math.PI / 2], // right
        [edges.right, edges.bottom, w, thick, Math.PI], // bottom
        [edges.left, edges.bottom, h, thick, -Math.PI / 2], // left
      ];
      for (const [x, y, length, depth, rotation] of strips) {
        const sprite = new Sprite(beam);
        sprite.tint = 0xff1e1e;
        sprite.position.set(x, y);
        sprite.rotation = rotation;
        sprite.width = length;
        sprite.height = depth;
        root.addChild(sprite);
        beams.push(sprite);
      }
    }
    const r0 = at.side * 0.3;
    const r1 = at.side * (heavy ? 1.9 : 1.4);
    this.add(root, ms, particles, (t) => {
      const e = 1 - (1 - t) ** 3;
      ring.clear();
      ring.circle(0, 0, r0 + (r1 - r0) * e).stroke({
        width: 9 * (1 - e) + 1,
        color: 0xff3b3b,
        alpha: (1 - t) * 0.95,
      });
      if (heavy)
        ring.circle(0, 0, (r0 + (r1 - r0) * e) * 0.7).stroke({
          width: 4 * (1 - e) + 1,
          color: 0xffffff,
          alpha: (1 - t) * 0.6,
        });
      // One pulse, peaking early, never a strobe.
      const vignette = t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.8);
      for (const sprite of beams)
        sprite.alpha = vignette * (heavy ? 0.55 : 0.4);
    });
  }

  /** Green glitter rising for a big life gain. */
  glitter(at: Spot): void {
    const ms = this.kit.duration("glitter");
    if (ms <= 0) return;
    const root = new Container();
    const particles = this.sprites(
      root,
      drift(
        this.nextSeed(),
        12,
        {
          x: at.cx - at.side * 0.6,
          y: at.cy,
          w: at.side * 1.2,
          h: at.side * 0.6,
        },
        -120,
        {
          scaleFrom: 0.5,
          scaleTo: 0.1,
          alpha: 1,
          flicker: true,
          swayAmp: 8,
          swayTurns: 1.5,
        },
        [0x8fe88f, 0xd9ffd0, 0x5fd36a],
      ),
      "dot",
    );
    this.add(root, ms, particles, () => undefined);
  }

  /** A portrait shattering as its player is eliminated: dark shards flung out and a dark ring. */
  shatter(at: Spot, shards: boolean): void {
    const ms = this.kit.duration("shatter");
    if (ms <= 0) return;
    const root = new Container();
    const ring = new Graphics();
    ring.position.set(at.cx, at.cy);
    root.addChild(ring);
    const particles = shards
      ? this.sprites(
          root,
          spray(
            this.nextSeed(),
            14,
            {
              x: at.cx,
              y: at.cy,
              gravity: 1100,
              drag: 0.6,
              spin: 1.5,
              scaleFrom: 1.2,
              scaleTo: 0.6,
              additive: false,
              alpha: 0.95,
              to: 1,
            },
            at.side * 2.2,
            [0x1b1b22, 0x3a3a46, 0x55555f],
          ),
          "shard",
        )
      : [];
    const r1 = at.side * 1.6;
    this.add(root, ms, particles, (t) => {
      const e = 1 - (1 - t) ** 3;
      ring.clear();
      ring.circle(0, 0, at.side * 0.4 + (r1 - at.side * 0.4) * e).stroke({
        width: 10 * (1 - e) + 1,
        color: 0x000000,
        alpha: (1 - t) * 0.7,
      });
    });
  }

  /** Confetti falling over the table for a victory, across the whole view. */
  confetti(edges: Edges): void {
    const ms = this.kit.duration("confetti");
    if (ms <= 0) return;
    const root = new Container();
    const width = edges.right - edges.left;
    const drop = edges.bottom - edges.top + 60;
    const particles = this.sprites(
      root,
      drift(
        this.nextSeed(),
        56,
        { x: edges.left, y: edges.top - 60, w: width, h: 40 },
        drop / (ms / 1000) / 1.1,
        {
          scaleFrom: 0.42,
          scaleTo: 0.42,
          stretch: 1.9,
          spin: 0.9,
          additive: false,
          alpha: 0.95,
          to: 1,
          swayAmp: 26,
          swayTurns: 2.5,
        },
        [GOLD, 0xfff6dc, 0xd84a3b, 0x59c8c8, 0xf0dd9a],
      ),
      "dot",
    );
    this.add(root, ms, particles, () => undefined);
  }

  /** Ash drifting down over the table for a defeat. */
  ashfall(edges: Edges): void {
    const ms = this.kit.duration("confetti");
    if (ms <= 0) return;
    const root = new Container();
    const width = edges.right - edges.left;
    const drop = edges.bottom - edges.top + 40;
    const particles = this.sprites(
      root,
      drift(
        this.nextSeed(),
        36,
        { x: edges.left, y: edges.top - 40, w: width, h: 60 },
        drop / (ms / 1000) / 1.3,
        {
          scaleFrom: 0.35,
          scaleTo: 0.25,
          additive: false,
          alpha: 0.6,
          to: 1,
          swayAmp: 18,
          swayTurns: 1.5,
        },
        [0x7a7a7a, 0x4e4e4e, 0x9a9a9a],
      ),
      "dot",
    );
    this.add(root, ms, particles, () => undefined);
  }

  /** A gold shine sweeping the band from left to right as your turn begins. The beam fades in
   * and out at the ends and travels inside the view, so it needs no clipping. */
  shine(band: Rect, span: { left: number; right: number }): void {
    const ms = this.kit.duration("shine");
    if (ms <= 0) return;
    const root = new Container();
    const beam = new Sprite(this.sheet().beam);
    beam.tint = GOLD;
    beam.blendMode = "add";
    beam.alpha = 0;
    beam.anchor.set(0.5, 0);
    // The gradient fades along its height; turned on its side it fades along the band.
    beam.rotation = -Math.PI / 2;
    beam.width = band.h;
    beam.height = BEAM_LENGTH;
    root.addChild(beam);
    const from = span.left;
    const to = span.right - BEAM_LENGTH;
    this.add(root, ms, [], (t) => {
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      beam.position.set(from + (to - from) * e, band.y + band.h / 2);
      beam.alpha = 0.5 * Math.sin(Math.PI * t);
    });
  }

  /* ---------- parts ---------- */

  private add(
    root: Container,
    ms: number,
    particles: Particle[],
    draw: (t: number) => void,
    delayMs = 0,
  ): void {
    root.visible = delayMs <= 0;
    this.root.addChild(root);
    this.effects.push({
      root,
      start: this.kit.clock() + Math.max(0, delayMs),
      ms,
      particles,
      draw,
    });
    if (delayMs <= 0) {
      for (const { spec, sprite } of particles) {
        const pose = particleAt(spec, 0, ms);
        sprite.visible = pose.shown;
      }
      draw(0);
    }
  }

  private sprites(
    parent: Container,
    specs: ParticleSpec[],
    texture: "dot" | "shard",
  ): Particle[] {
    const sheet = this.sheet();
    return specs.map((spec) => {
      const sprite = new Sprite(sheet[texture]);
      sprite.anchor.set(0.5);
      sprite.tint = spec.tint;
      if (spec.additive) sprite.blendMode = "add";
      sprite.visible = false;
      parent.addChild(sprite);
      return { spec, sprite };
    });
  }

  private nextSeed(): number {
    this.seed = (this.seed * 7919 + 17) >>> 0;
    return this.seed;
  }

  /** The three textures, made the first time anything needs them. */
  private sheet(): { dot: Texture; shard: Texture; beam: Texture } {
    if (this.textures) return this.textures;
    this.textures = {
      dot: this.kit.texture(dotCanvas(32)),
      shard: this.kit.texture(shardCanvas(24)),
      beam: this.kit.texture(beamCanvas(256)),
    };
    return this.textures;
  }
}

/** A soft white dot: bright in the middle, clear at the edge. */
export function dotCanvas(size: number): HTMLCanvasElement {
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.85)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/** A white shard: a long, sharp triangle. */
export function shardCanvas(size: number): HTMLCanvasElement {
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(size * 0.5, 0);
  ctx.lineTo(size, size * 0.78);
  ctx.lineTo(size * 0.18, size);
  ctx.closePath();
  ctx.fill();
  return c;
}

/** A white gradient, solid at the top and clear at the bottom, one pixel wide. */
export function beamCanvas(length: number): HTMLCanvasElement {
  const c = canvas(2, length);
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const gradient = ctx.createLinearGradient(0, 0, 0, length);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.35)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 2, length);
  return c;
}

/** A card's place from its drawn centre, height and turn. */
export function placeOf(v: {
  cx: number;
  cy: number;
  height: number;
  rotation: number;
}): Place {
  return {
    cx: v.cx,
    cy: v.cy,
    w: v.height * CARD_RATIO,
    h: v.height,
    rotation: v.rotation,
  };
}
