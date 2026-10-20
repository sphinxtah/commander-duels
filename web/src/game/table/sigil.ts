// Generated sigils, the players' portraits until the owner's Planeswalker portraits arrive. A
// sigil grows from a seed (`handle:<h>`, `bot:<seat>` or `seat:<seat>`), so every viewer draws
// the same one for a player, and a player keeps theirs from game to game. The spec is plain
// numbers: the scene draws it on the canvas and SigilSvg draws it for the dom painter.

export interface SigilLayer {
  shape: "ring" | "ray" | "petal" | "polygon" | "dots";
  /** Distance from the centre, as a share of the sigil's radius. */
  radius: number;
  /** Stroke width, as a share of the sigil's radius. */
  width: number;
  /** Rotation, as a share of a full turn. */
  turn: number;
}

export interface SigilSpec {
  hue: number;
  symmetry: 3 | 4 | 5 | 6 | 7 | 8;
  /** Opponents' sigils are drawn grey, as Magic Duels drew their portraits. */
  grey: boolean;
  layers: SigilLayer[];
}

/** FNV-1a: a small, well-spread 32-bit hash of a string. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a seeded generator of numbers in [0, 1), the same sequence for the same seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shapes: SigilLayer["shape"][] = [
  "ring",
  "ray",
  "petal",
  "polygon",
  "dots",
];

export function sigilSpec(seed: string, grey: boolean): SigilSpec {
  const random = mulberry32(fnv1a(seed));
  const hue = Math.floor(random() * 360);
  const symmetry = (3 + Math.floor(random() * 6)) as SigilSpec["symmetry"];
  const count = 3 + Math.floor(random() * 3);
  const layers: SigilLayer[] = [];
  for (let i = 0; i < count; i++)
    layers.push({
      shape: shapes[Math.floor(random() * shapes.length)],
      radius: 0.2 + random() * 0.75,
      width: 0.02 + random() * 0.1,
      turn: random() / symmetry,
    });
  // Outer layers first, so the inner ones are drawn over them.
  layers.sort((a, b) => b.radius - a.radius);
  return { hue, symmetry, grey, layers };
}
