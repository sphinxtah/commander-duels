// The red X slashed over a creature slain in combat (v0.7.0): two jagged strokes, each cut
// corner to corner in turn, thick in the middle and sharp at the ends. The geometry is here, in
// the card's own space (its centre at 0,0, unrotated); EffectsNode fills it and turns it with the
// card.

export interface StrokePoint {
  x: number;
  y: number;
  /** Half the stroke's width here. */
  half: number;
}

/** The jags along a stroke, as a share of its length sideways, from one end to the other. */
const JAGS = [0, 0.14, -0.1, 0.17, -0.16, 0.08, -0.12, 0.05, 0];
/** How thick the stroke is at each jag, as a share of the card's width. */
const THICK = [0.0, 0.028, 0.044, 0.056, 0.06, 0.054, 0.042, 0.026, 0.0];

/** One stroke from (x0, y0) to (x1, y1) over a card `w` wide. `jag` scales the sideways cuts;
 * the second stroke uses the jags mirrored so the X is not symmetrical. */
export function stroke(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  mirrored: boolean,
): StrokePoint[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  return JAGS.map((jag, i) => {
    const s = i / (JAGS.length - 1);
    const side = (mirrored ? -jag : jag) * w * 0.12;
    return {
      x: x0 + dx * s + nx * side,
      y: y0 + dy * s + ny * side,
      half: THICK[i] * w,
    };
  });
}

/** The two strokes of the X over a card `w` × `h`, the first from the top left, the second from
 * the top right, each a little inside the corners. */
export function slashStrokes(
  w: number,
  h: number,
): [StrokePoint[], StrokePoint[]] {
  const ix = w * 0.44;
  const iy = h * 0.44;
  return [
    stroke(-ix, -iy, ix, iy, w, false),
    stroke(ix, -iy * 0.92, -ix * 0.96, iy, w, true),
  ];
}

function lerp(a: StrokePoint, b: StrokePoint, t: number): StrokePoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    half: a.half + (b.half - a.half) * t,
  };
}

/** The stroke's outline as far as `progress` (0 to 1) of its length has been cut, as a flat
 * polygon [x0, y0, x1, y1, …] running down one side and back up the other, widened by `grow`
 * (an outline draws the same shape a little larger). Empty before anything is cut. */
export function strokePolygon(
  points: StrokePoint[],
  progress: number,
  grow = 0,
): number[] {
  const p = Math.min(1, Math.max(0, progress));
  if (p <= 0 || points.length < 2) return [];
  const last = (points.length - 1) * p;
  const whole = Math.floor(last);
  const cut: StrokePoint[] = points.slice(0, whole + 1);
  if (whole < points.length - 1)
    cut.push(lerp(points[whole], points[whole + 1], last - whole));
  // The tip of a stroke still being cut is a point, as the ends are.
  if (p < 1) cut[cut.length - 1] = { ...cut[cut.length - 1], half: 0 };
  if (cut.length < 2) return [];
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < cut.length; i++) {
    const prev = cut[Math.max(0, i - 1)];
    const next = cut[Math.min(cut.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    // An outline grows the ends too; a narrower core never crosses to the other side.
    const half = Math.max(
      0,
      cut[i].half + (cut[i].half > 0 || grow > 0 ? grow : 0),
    );
    left.push(cut[i].x + nx * half, cut[i].y + ny * half);
    right.unshift(cut[i].x - nx * half, cut[i].y - ny * half);
  }
  return [...left, ...right];
}

/** How far each stroke has been cut at `t` of the slash's life: the first from 0 to 0.22, the
 * second from 0.18 to 0.4, both with a quick start. */
export function strokeProgress(t: number): [number, number] {
  const cut = (from: number, to: number) => {
    const u = Math.min(1, Math.max(0, (t - from) / (to - from)));
    return 1 - (1 - u) ** 2;
  };
  return [cut(0, 0.22), cut(0.18, 0.4)];
}

/** The X's opacity: whole until 0.72 of its life, then gone by the end. */
export function slashAlpha(t: number): number {
  return t < 0.72 ? 1 : Math.max(0, (1 - t) / 0.28);
}

/** The red flash over the card's face: up at once, gone by 0.45. */
export function flashAlpha(t: number): number {
  if (t < 0.06) return (t / 0.06) * 0.38;
  return t < 0.45 ? 0.38 * (1 - (t - 0.06) / 0.39) : 0;
}

/** When the sparks fly: as the second stroke lands. */
export const SPARKS_AT = 0.3;
