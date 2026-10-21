import type { Graphics } from "./pixi";

// The table's icons as vector paths, ours rather than Magic Duels': crossed swords for combat, a
// shield for blocks, a burst for damage, the attack arrow, the check of a chosen card and the
// rest. Each is drawn into a Graphics centred on (cx, cy) within a square of `size` stage units,
// so it is sharp at every scale.

export type SceneIcon =
  | "swords"
  | "sword"
  | "arrow"
  | "shield"
  | "damage"
  | "check"
  | "offered"
  | "crescent"
  | "turn"
  | "crown"
  | "broken"
  | "draw"
  | "flag";

type Pt = [number, number];

function path(
  g: Graphics,
  cx: number,
  cy: number,
  size: number,
  points: Pt[],
): Graphics {
  return g.poly(points.flatMap(([x, y]) => [cx + x * size, cy + y * size]));
}

/** One sword pointing up-right, in the unit square, turned by `turn` radians. */
function swordPoints(turn: number): Pt[] {
  const blade: Pt[] = [
    [-0.035, 0.12],
    [-0.035, -0.4],
    [0, -0.47],
    [0.035, -0.4],
    [0.035, 0.12],
    [0.13, 0.12],
    [0.13, 0.17],
    [0.03, 0.17],
    [0.03, 0.34],
    [0.06, 0.37],
    [0, 0.43],
    [-0.06, 0.37],
    [-0.03, 0.34],
    [-0.03, 0.17],
    [-0.13, 0.17],
    [-0.13, 0.12],
  ];
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return blade.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
}

export function drawIcon(
  g: Graphics,
  icon: SceneIcon,
  cx: number,
  cy: number,
  size: number,
  colour: number,
): Graphics {
  const s = size;
  switch (icon) {
    case "swords":
      path(g, cx, cy, s, swordPoints(Math.PI / 4)).fill(colour);
      return path(g, cx, cy, s, swordPoints(-Math.PI / 4)).fill(colour);
    case "sword":
      return path(g, cx, cy, s, swordPoints(0)).fill(colour);
    case "arrow":
      // Pointing up, towards the band: the attack mark beside your creature.
      return path(g, cx, cy, s, [
        [0, -0.48],
        [0.36, -0.06],
        [0.13, -0.06],
        [0.13, 0.46],
        [-0.13, 0.46],
        [-0.13, -0.06],
        [-0.36, -0.06],
      ]).fill(colour);
    case "shield":
      return path(g, cx, cy, s, [
        [0, -0.46],
        [0.38, -0.32],
        [0.36, 0.04],
        [0.22, 0.3],
        [0, 0.47],
        [-0.22, 0.3],
        [-0.36, 0.04],
        [-0.38, -0.32],
      ]).fill(colour);
    case "damage": {
      const points: Pt[] = [];
      for (let i = 0; i < 16; i++) {
        const r = i % 2 === 0 ? 0.48 : 0.2;
        const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
        points.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return path(g, cx, cy, s, points).fill(colour);
    }
    case "check":
      return g
        .moveTo(cx - 0.3 * s, cy + 0.02 * s)
        .lineTo(cx - 0.08 * s, cy + 0.24 * s)
        .lineTo(cx + 0.32 * s, cy - 0.24 * s)
        .stroke({
          width: 0.14 * s,
          color: colour,
          cap: "round",
          join: "round",
        });
    case "offered":
      return path(g, cx, cy, s, [
        [0, -0.3],
        [0.3, 0],
        [0, 0.3],
        [-0.3, 0],
      ]).fill(colour);
    case "crescent":
      return g
        .arc(cx, cy, 0.4 * s, Math.PI * 0.35, Math.PI * 1.65)
        .arc(
          cx + 0.14 * s,
          cy - 0.04 * s,
          0.32 * s,
          Math.PI * 1.55,
          Math.PI * 0.45,
          true,
        )
        .fill(colour);
    case "turn": {
      // A sun: the start of a turn.
      g.circle(cx, cy, 0.2 * s).fill(colour);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.moveTo(cx + Math.cos(a) * 0.3 * s, cy + Math.sin(a) * 0.3 * s)
          .lineTo(cx + Math.cos(a) * 0.46 * s, cy + Math.sin(a) * 0.46 * s)
          .stroke({ width: 0.07 * s, color: colour, cap: "round" });
      }
      return g;
    }
    case "crown":
      return path(g, cx, cy, s, [
        [-0.42, 0.3],
        [-0.42, -0.24],
        [-0.2, 0.0],
        [0, -0.36],
        [0.2, 0.0],
        [0.42, -0.24],
        [0.42, 0.3],
      ]).fill(colour);
    case "broken":
      path(g, cx, cy, s, [
        [-0.04, -0.46],
        [-0.38, -0.32],
        [-0.36, 0.04],
        [-0.22, 0.3],
        [-0.04, 0.44],
        [-0.12, 0.12],
        [0.02, -0.08],
        [-0.1, -0.26],
      ]).fill(colour);
      return path(g, cx, cy, s, [
        [0.06, -0.46],
        [0.38, -0.32],
        [0.36, 0.04],
        [0.22, 0.3],
        [0.06, 0.44],
        [0.0, 0.12],
        [0.12, -0.08],
        [0.02, -0.26],
      ]).fill(colour);
    case "draw":
      g.roundRect(
        cx - 0.3 * s,
        cy - 0.36 * s,
        0.42 * s,
        0.6 * s,
        0.05 * s,
      ).fill(colour);
      return g
        .roundRect(cx - 0.1 * s, cy - 0.24 * s, 0.42 * s, 0.6 * s, 0.05 * s)
        .fill(colour);
    case "flag":
      g.rect(cx - 0.3 * s, cy - 0.44 * s, 0.07 * s, 0.9 * s).fill(colour);
      return path(g, cx, cy, s, [
        [-0.23, -0.44],
        [0.36, -0.3],
        [-0.23, -0.06],
      ]).fill(colour);
  }
}

/** A diamond (a square turned 45°) of side `side` centred on (cx, cy). */
export function diamondPath(
  g: Graphics,
  cx: number,
  cy: number,
  side: number,
): Graphics {
  const h = (side * Math.SQRT2) / 2;
  return g.poly([cx, cy - h, cx + h, cy, cx, cy + h, cx - h, cy]);
}
