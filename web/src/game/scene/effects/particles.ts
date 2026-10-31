// The particles of the special effects (v0.7.0): small sprites of two shared textures, each
// with a path fixed when it is born, so a frame at time t needs no history. Nothing here draws;
// EffectsNode owns the sprites and asks each particle where it is.

/** A small deterministic generator (a 32-bit LCG), so an effect's spray is the same in a test
 * as on screen. Returns 0 ≤ r < 1. */
export function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface ParticleSpec {
  /** Where it is born, in stage units. */
  x: number;
  y: number;
  /** Its velocity at birth, in stage units per second, and the pull on it per second squared. */
  vx: number;
  vy: number;
  gravity: number;
  /** Air: the share of the velocity left after one second (1 = none lost). */
  drag: number;
  /** Its spin, turns per second, and its tilt at birth, in radians. */
  spin: number;
  tilt: number;
  /** Its size at birth and at its end, as a scale of the texture, each axis. */
  scaleFrom: number;
  scaleTo: number;
  /** Width over height: a confetti strip is wider than it is tall. */
  stretch: number;
  /** When in the effect's life it is born and dies, 0 to 1. */
  from: number;
  to: number;
  /** Its colour, and whether it is drawn as light (additive) or as matter. */
  tint: number;
  additive: boolean;
  /** Its opacity at its peak; it fades in over the first tenth and out over the last third.
   * `flicker` makes it twinkle. */
  alpha: number;
  flicker: boolean;
  /** Sideways sway: how far, in stage units, and how many swings over its life. */
  swayAmp: number;
  swayTurns: number;
}

export interface ParticlePose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
  /** False before it is born or after it died. */
  shown: boolean;
}

export const defaultParticle: ParticleSpec = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  gravity: 0,
  drag: 1,
  spin: 0,
  tilt: 0,
  scaleFrom: 1,
  scaleTo: 1,
  stretch: 1,
  from: 0,
  to: 1,
  tint: 0xffffff,
  additive: true,
  alpha: 1,
  flicker: false,
  swayAmp: 0,
  swayTurns: 0,
};

/** Where a particle is at `t` (0 to 1) of its effect's life of `ms` milliseconds. */
export function particleAt(
  p: ParticleSpec,
  t: number,
  ms: number,
): ParticlePose {
  const life = Math.max(1e-6, p.to - p.from);
  const u = (t - p.from) / life;
  if (u < 0 || u > 1)
    return {
      x: p.x,
      y: p.y,
      rotation: 0,
      scaleX: 0,
      scaleY: 0,
      alpha: 0,
      shown: false,
    };
  const seconds = (u * life * ms) / 1000;
  // Velocity decays by drag; the distance is its integral. Drag of 1 is plain motion.
  const k = -Math.log(Math.max(1e-6, Math.min(1, p.drag)));
  const travel = k < 1e-6 ? seconds : (1 - Math.exp(-k * seconds)) / k;
  const sway =
    p.swayAmp === 0 ? 0 : Math.sin(u * Math.PI * 2 * p.swayTurns) * p.swayAmp;
  const x = p.x + p.vx * travel + sway;
  const y = p.y + p.vy * travel + 0.5 * p.gravity * seconds * seconds;
  const scale = p.scaleFrom + (p.scaleTo - p.scaleFrom) * u;
  const fadeIn = Math.min(1, u / 0.1);
  const fadeOut = u < 0.66 ? 1 : Math.max(0, (1 - u) / 0.34);
  const flicker = p.flicker
    ? 0.7 + 0.3 * Math.sin(u * Math.PI * 9 + p.tilt)
    : 1;
  return {
    x,
    y,
    rotation: p.tilt + p.spin * seconds * Math.PI * 2,
    scaleX: Math.max(0, scale * p.stretch),
    scaleY: Math.max(0, scale),
    alpha: p.alpha * fadeIn * fadeOut * flicker,
    shown: true,
  };
}

/** `count` particles sprayed from a point in every direction, at speeds between `speed` and
 * twice it, each a little different. */
export function spray(
  seed: number,
  count: number,
  base: Partial<ParticleSpec> & { x: number; y: number },
  speed: number,
  tints: number[],
): ParticleSpec[] {
  const random = rng(seed);
  const out: ParticleSpec[] = [];
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    const v = speed * (1 + random());
    out.push({
      ...defaultParticle,
      ...base,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v,
      tilt: random() * Math.PI * 2,
      tint: tints[i % tints.length],
      scaleFrom: (base.scaleFrom ?? 1) * (0.7 + random() * 0.6),
      from: (base.from ?? 0) + random() * 0.08,
    });
  }
  return out;
}

/** `count` particles drifting up (or down, with a positive `rise`) from within a box, each on
 * its own slight course. */
export function drift(
  seed: number,
  count: number,
  box: { x: number; y: number; w: number; h: number },
  rise: number,
  base: Partial<ParticleSpec>,
  tints: number[],
): ParticleSpec[] {
  const random = rng(seed);
  const out: ParticleSpec[] = [];
  for (let i = 0; i < count; i++)
    out.push({
      ...defaultParticle,
      ...base,
      x: box.x + random() * box.w,
      y: box.y + random() * box.h,
      vx: (random() - 0.5) * Math.abs(rise) * 0.5,
      vy: rise * (0.7 + random() * 0.6),
      tilt: random() * Math.PI * 2,
      tint: tints[i % tints.length],
      scaleFrom: (base.scaleFrom ?? 1) * (0.7 + random() * 0.6),
      from: (base.from ?? 0) + random() * 0.4,
      swayAmp: (base.swayAmp ?? 0) * (0.5 + random()),
    });
  return out;
}
