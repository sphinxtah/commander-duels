import type { CSSProperties, JSX, ReactNode } from "react";
import styles from "./scenery.module.css";

// The Final Concordance's cut-scene backdrops (v0.8.0): seventeen painted scenes, one per place in
// the story, drawn as inline SVG layers (sky, far, mid, near) that drift slowly and independently,
// with a few CSS particles. The cut-scene player lays portraits and speech over them, so every
// scene keeps its centre and lower middle quiet and darkens toward the bottom edge. A scene's
// phase (data-phase) changes it mid-scene through CSS transitions in scenery.module.css; the
// account's Reduce motion setting stops every animation there.

export type SceneryId =
  | "refuge"
  | "village"
  | "fairground"
  | "foundry"
  | "streets"
  | "tribunal"
  | "garden"
  | "revel"
  | "transit"
  | "prism"
  | "nightmare"
  | "amphitheater"
  | "gallery"
  | "citadel"
  | "names"
  | "throne"
  | "dawn";

export const SCENERY_IDS: readonly SceneryId[] = [
  "refuge",
  "village",
  "fairground",
  "foundry",
  "streets",
  "tribunal",
  "garden",
  "revel",
  "transit",
  "prism",
  "nightmare",
  "amphitheater",
  "gallery",
  "citadel",
  "names",
  "throne",
  "dawn",
];

/** A short human name per scene, e.g. "The refuge", "The abandoned fairground". */
export const SCENERY_NAMES: Record<SceneryId, string> = {
  refuge: "The refuge",
  village: "The village at dusk",
  fairground: "The abandoned fairground",
  foundry: "The salvage foundry",
  streets: "The rooted streets",
  tribunal: "The tribunal of petitions",
  garden: "The mirror garden",
  revel: "The captured revel",
  transit: "The transit works",
  prism: "The prism observatory",
  nightmare: "The nightmare archive",
  amphitheater: "The conquest amphitheater",
  gallery: "The gallery of bound champions",
  citadel: "The counterfeit citadel",
  names: "The chamber of living names",
  throne: "The Sphinx's throne",
  dawn: "Dawn across the worlds",
};

/** Each scene's accent colour (a CSS colour string) for the cut scene's UI to tint with. */
export const SCENERY_ACCENTS: Record<SceneryId, string> = {
  refuge: "#b9d3f0",
  village: "#f0b35e",
  fairground: "#d0583f",
  foundry: "#e9893a",
  streets: "#c9a36b",
  tribunal: "#8fc3ea",
  garden: "#b7e0c6",
  revel: "#f2c66d",
  transit: "#5cc8ff",
  prism: "#d9e3ff",
  nightmare: "#a678e8",
  amphitheater: "#c8443a",
  gallery: "#d8dde6",
  citadel: "#e8c26a",
  names: "#b48cff",
  throne: "#f4dca6",
  dawn: "#ffc98a",
};

export interface SceneryProps {
  id: SceneryId;
  phase?: string;
  className?: string;
}

/* ------------------------------------------------------------------ helpers */

type Box = readonly [number, number, number, number];
type Range = readonly [number, number];
type Stop = readonly [number, string, number?];

/** A tiny seeded PRNG (mulberry32): the same scene lays out the same on server and client. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n1 = (value: number): number => Math.round(value * 10) / 10;
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function vars(values: Record<`--${string}`, string | number>): CSSProperties {
  return values as CSSProperties;
}

function cx(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
}

type Depth = "sky" | "far" | "mid" | "near";

/** One full-bleed painted layer; its depth sets how slowly it drifts. */
function Layer(props: {
  depth: Depth;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <svg
      className={cx(styles.layer, styles[props.depth], props.className)}
      viewBox="0 0 1920 1080"
      preserveAspectRatio="xMidYMid slice"
    >
      {props.children}
    </svg>
  );
}

/** A scene's gradients and shared shapes; ids carry the scene's prefix. */
function Defs({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg className={styles.defs} width="0" height="0">
      <defs>{children}</defs>
    </svg>
  );
}

function stops(list: readonly Stop[]): JSX.Element[] {
  return list.map(([offset, color, opacity], i) => (
    <stop
      key={i}
      offset={offset}
      stopColor={color}
      stopOpacity={opacity ?? 1}
    />
  ));
}

/** A linear gradient, top to bottom unless told otherwise. */
function Lin(props: {
  id: string;
  s: readonly Stop[];
  x2?: number;
  y2?: number;
}): JSX.Element {
  return (
    <linearGradient
      id={props.id}
      x1="0"
      y1="0"
      x2={props.x2 ?? 0}
      y2={props.y2 ?? 1}
    >
      {stops(props.s)}
    </linearGradient>
  );
}

function Rad(props: {
  id: string;
  s: readonly Stop[];
  cx?: number;
  cy?: number;
}): JSX.Element {
  return (
    <radialGradient
      id={props.id}
      cx={props.cx ?? 0.5}
      cy={props.cy ?? 0.5}
      r="0.5"
    >
      {stops(props.s)}
    </radialGradient>
  );
}

/** Many small discs in one path: static stars, flowers, sparks of paint. */
function dots(
  count: number,
  seed: number,
  box: Box,
  r: Range,
  keep?: (x: number, y: number) => boolean,
): string {
  const rand = prng(seed);
  let d = "";
  for (let i = 0, tries = 0; i < count && tries < count * 6; tries++) {
    const x = mix(box[0], box[2], rand());
    const y = mix(box[1], box[3], rand());
    const rad = mix(r[0], r[1], rand() ** 2);
    if (keep && !keep(x, y)) continue;
    i++;
    d += `M${n1(x - rad)} ${n1(y)}a${n1(rad)} ${n1(rad)} 0 1 0 ${n1(rad * 2)} 0a${n1(rad)} ${n1(rad)} 0 1 0 ${n1(-rad * 2)} 0`;
  }
  return d;
}

interface FieldOptions {
  x?: Range;
  y?: Range;
  size?: Range;
  dur?: Range;
  dx?: Range;
  dy?: Range;
  op?: Range;
}

/**
 * A field of small animated particles (embers, motes, soot, petals). Positions, sizes and delays
 * come from a seeded PRNG; the CSS class picks the look and the motion.
 */
function particles(
  count: number,
  seed: number,
  className: string,
  o: FieldOptions = {},
): JSX.Element {
  const rand = prng(seed);
  const pick = (range: Range | undefined, fallback: Range): number =>
    mix((range ?? fallback)[0], (range ?? fallback)[1], rand());
  const items: JSX.Element[] = [];
  for (let i = 0; i < count; i++) {
    const t = n1(pick(o.dur, [10, 20]));
    items.push(
      <i
        key={i}
        className={className}
        style={vars({
          "--x": `${n1(pick(o.x, [0, 100]))}%`,
          "--y": `${n1(pick(o.y, [0, 100]))}%`,
          "--s": `${n1(pick(o.size, [2, 4]))}px`,
          "--t": `${t}s`,
          "--d": `${-n1(rand() * t)}s`,
          "--dx": `${n1(pick(o.dx, [-30, 30]))}px`,
          "--dy": `${n1(pick(o.dy, [-160, -80]))}px`,
          "--o": Math.round(pick(o.op, [0.4, 0.8]) * 100) / 100,
        })}
      />,
    );
  }
  return <div className={styles.field}>{items}</div>;
}

type P = readonly [number, number];

/** Points along a cubic Bézier. */
function bez(p0: P, p1: P, p2: P, p3: P, n: number): P[] {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] +
        3 * u * u * t * p1[0] +
        3 * u * t * t * p2[0] +
        t * t * t * p3[0],
      u * u * u * p0[1] +
        3 * u * u * t * p1[1] +
        3 * u * t * t * p2[1] +
        t * t * t * p3[1],
    ]);
  }
  return out;
}

/** A filled shape along a line of points, w0 wide at its start and w1 at its end: roots, horns. */
function taper(pts: readonly P[], w0: number, w1: number): string {
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const w = mix(w0, w1, i / (pts.length - 1)) / 2;
    left.push(`${n1(pts[i][0] + nx * w)} ${n1(pts[i][1] + ny * w)}`);
    right.push(`${n1(pts[i][0] - nx * w)} ${n1(pts[i][1] - ny * w)}`);
  }
  return `M${left.join("L")}L${right.reverse().join("L")}Z`;
}

/** A jagged bolt along a quadratic curve, for arcs of energy. */
function bolt(
  seed: number,
  x0: number,
  y0: number,
  cxp: number,
  cyp: number,
  x1: number,
  y1: number,
  n: number,
  jag: number,
): string {
  const rand = prng(seed);
  let d = `M${x0} ${y0}`;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * x0 + 2 * u * t * cxp + t * t * x1;
    const y = u * u * y0 + 2 * u * t * cyp + t * t * y1;
    const j = i === n ? 0 : (rand() - 0.5) * jag;
    d += `L${n1(x + j)} ${n1(y + j * 0.6)}`;
  }
  return d;
}

/** A jagged crack that wanders from a point and sometimes forks. */
function crack(
  seed: number,
  x: number,
  y: number,
  angle: number,
  len: number,
  steps: number,
): string {
  const rand = prng(seed);
  let d = "";
  const walk = (
    x0: number,
    y0: number,
    a0: number,
    l: number,
    n: number,
    depth: number,
  ): void => {
    let px = x0;
    let py = y0;
    let a = a0;
    d += `M${n1(px)} ${n1(py)}`;
    for (let i = 0; i < n; i++) {
      a += (rand() - 0.5) * 0.9;
      const step = (l / n) * (0.6 + rand() * 0.8);
      px += Math.cos(a) * step;
      py += Math.sin(a) * step;
      d += `L${n1(px)} ${n1(py)}`;
      if (depth < 2 && rand() < 0.3) {
        walk(
          px,
          py,
          a + (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.6),
          l * 0.4,
          Math.max(2, n >> 1),
          depth + 1,
        );
        d += `M${n1(px)} ${n1(py)}`;
      }
    }
  };
  walk(x, y, angle, len, steps, 0);
  return d;
}

/** Petitions: upright paper slips, a share of them stamped, as three paths. */
function petitions(
  count: number,
  seed: number,
  box: Box,
  size: Range,
  stampRate: number,
): { sheets: string; lines: string; stamps: string } {
  const rand = prng(seed);
  let sheets = "";
  let lines = "";
  let stamps = "";
  const quad = (
    cxp: number,
    cyp: number,
    w: number,
    h: number,
    a: number,
  ): string => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const pts = [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ].map(
      ([px, py]) => `${n1(cxp + px * c - py * s)} ${n1(cyp + px * s + py * c)}`,
    );
    return `M${pts.join("L")}Z`;
  };
  for (let i = 0, tries = 0; i < count && tries < count * 8; tries++) {
    const x = mix(box[0], box[2], rand());
    const y = mix(box[1], box[3], rand());
    // Keep the middle of the hall clear for the portraits and speech.
    const ex = (x - 960) / 430;
    const ey = (y - 600) / 300;
    if (ex * ex + ey * ey < 1 && rand() < 0.9) continue;
    i++;
    const h = mix(size[0], size[1], rand());
    const w = h * 0.72;
    const a = (rand() - 0.5) * 0.14;
    sheets += quad(x, y, w, h, a);
    if (h > 14) {
      for (let k = 0; k < 3; k++) {
        const ly = -h * 0.28 + k * h * 0.13;
        lines += quad(
          x - Math.sin(a) * ly,
          y + Math.cos(a) * ly,
          w * 0.66,
          Math.max(0.8, h * 0.035),
          a,
        );
      }
    }
    if (rand() < stampRate) {
      stamps += quad(
        x - Math.sin(a) * h * 0.2,
        y + Math.cos(a) * h * 0.2,
        w * 0.74,
        h * 0.2,
        a - 0.22,
      );
    }
  }
  return { sheets, lines, stamps };
}

/** A made-up script: a small alphabet of stroke glyphs laid along rows in perspective. */
function glyphAlphabet(seed: number, count: number): number[][][] {
  const rand = prng(seed);
  const glyphs: number[][][] = [];
  for (let g = 0; g < count; g++) {
    const strokes: number[][] = [];
    const n = 2 + Math.floor(rand() * 2);
    for (let s = 0; s < n; s++) {
      const pts: number[] = [];
      const m = 2 + Math.floor(rand() * 2);
      for (let p = 0; p < m; p++)
        pts.push(Math.floor(rand() * 3) * 4, Math.floor(rand() * 4) * 4 - 6);
      strokes.push(pts);
    }
    glyphs.push(strokes);
  }
  return glyphs;
}

const GLYPHS = glyphAlphabet(77, 18);

/**
 * Rows of script on a wall whose near edge (x0, top0..bottom0, glyph scale s0) recedes to a far
 * edge (x1, top1..bottom1, scale s1). Returns one path per group of rows, for flickering.
 */
function scriptWall(
  seed: number,
  x0: number,
  top0: number,
  bottom0: number,
  s0: number,
  x1: number,
  top1: number,
  bottom1: number,
  s1: number,
  rows: number,
  groups: number,
  skip?: (x: number, y: number) => boolean,
): string[] {
  const rand = prng(seed);
  const out: string[] = Array.from({ length: groups }, () => "");
  for (let r = 0; r < rows; r++) {
    const v = 0.06 + (0.88 * r) / Math.max(1, rows - 1);
    let u = rand() * 0.02;
    let d = "";
    while (u < 0.98) {
      const s = mix(s0, s1, u);
      const x = mix(x0, x1, u);
      const y = mix(mix(top0, bottom0, v), mix(top1, bottom1, v), u);
      if (rand() < 0.16) {
        u += (14 * s) / Math.abs(x1 - x0);
        continue;
      }
      if (!skip || !skip(x, y)) {
        const glyph = GLYPHS[Math.floor(rand() * GLYPHS.length)];
        const dir = x1 > x0 ? 1 : -1;
        for (const stroke of glyph) {
          d += "M";
          for (let p = 0; p < stroke.length; p += 2) {
            d += `${p ? "L" : ""}${n1(x + dir * stroke[p] * s * 0.8)} ${n1(y + stroke[p + 1] * s)}`;
          }
        }
      }
      u += (12 * s) / Math.abs(x1 - x0);
    }
    out[r % groups] += d;
  }
  return out;
}

/* ------------------------------------------------------------------ scenes */

const RF_OPENING =
  "M640 0L676 64L640 118L712 184L704 246L800 296L884 284L962 338L1046 296L1136 312L1206 248L1262 206L1238 148L1318 88L1290 38L1336 0Z";
const RF_DOME = `M-40 -40H1960V700Q960 590 -40 700Z${RF_OPENING}`;
const RF_DOOR = "M1048 836V476A102 102 0 0 1 1252 476V836Z";
const RF_FRAME = "M1020 850V476A130 130 0 0 1 1280 476V850";

/** 1. The refuge: a broken observatory open to the stars, a silver passage, a desk and candle. */
function Refuge(): JSX.Element {
  const ribs = [-260, 60, 360, 640, 1280, 1560, 1860, 2180];
  const rib = (x: number): string =>
    `M${x} 730Q${n1(960 + (x - 960) * 0.6)} 150 960 -420`;
  return (
    <>
      <Defs>
        <Lin
          id="rf-sky"
          s={[
            [0, "#02040a"],
            [0.55, "#091426"],
            [1, "#152238"],
          ]}
        />
        <Rad
          id="rf-neb"
          s={[
            [0, "#7593c9", 0.34],
            [1, "#7593c9", 0],
          ]}
        />
        <Lin
          id="rf-dome"
          s={[
            [0, "#0c1422"],
            [1, "#16243a"],
          ]}
        />
        <Rad
          id="rf-glow"
          s={[
            [0, "#eef5ff", 0.55],
            [0.32, "#b9d3f0", 0.22],
            [1, "#6d8fb8", 0],
          ]}
        />
        <Lin
          id="rf-door"
          s={[
            [0, "#c8d8ee"],
            [0.45, "#7f9cc4"],
            [1, "#2e4668"],
          ]}
        />
        <Lin
          id="rf-beam"
          s={[
            [0, "#d4e3ff", 0.13],
            [1, "#d4e3ff", 0],
          ]}
        />
        <Rad
          id="rf-candle"
          s={[
            [0, "#ffd99a", 0.55],
            [0.3, "#ffb35a", 0.16],
            [1, "#ff9a40", 0],
          ]}
        />
        <clipPath id="rf-domeclip">
          <path d={RF_DOME} clipRule="evenodd" />
        </clipPath>
        <clipPath id="rf-doorclip">
          <path d={RF_DOOR} />
        </clipPath>
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#rf-sky)" />
        <ellipse
          cx="990"
          cy="150"
          rx="560"
          ry="110"
          fill="url(#rf-neb)"
          transform="rotate(-14 990 150)"
        />
        <path
          d={dots(170, 11, [560, 0, 1400, 360], [0.6, 1.5])}
          fill="#d6e4ff"
          opacity="0.55"
        />
        <path
          d={dots(28, 12, [600, 0, 1360, 320], [1.4, 2.4])}
          fill="#f2f6ff"
          opacity="0.85"
        />
      </Layer>
      {particles(9, 22, styles.twinkle, {
        x: [36, 66],
        y: [1, 22],
        size: [2, 3.5],
        dur: [3, 6],
        op: [0.6, 1],
      })}
      <Layer depth="far">
        <path d={RF_DOME} fillRule="evenodd" fill="url(#rf-dome)" />
        <g clipPath="url(#rf-domeclip)" fill="none">
          {ribs.map((x) => (
            <path key={x} d={rib(x)} stroke="#1b293e" strokeWidth="18" />
          ))}
          {ribs.map((x) => (
            <path
              key={`l${x}`}
              d={rib(x - 8)}
              stroke="#3b5274"
              strokeWidth="2"
              opacity="0.5"
            />
          ))}
          <path
            d="M-60 520Q960 330 1980 520"
            stroke="#1b293e"
            strokeWidth="14"
          />
          <path
            d="M-60 512Q960 322 1980 512"
            stroke="#3b5274"
            strokeWidth="2"
            opacity="0.4"
          />
          <path
            d="M-60 300Q960 120 1980 300"
            stroke="#1b293e"
            strokeWidth="10"
          />
        </g>
        <path
          d={RF_OPENING}
          fill="none"
          stroke="#a6bfe0"
          strokeWidth="3"
          opacity="0.4"
          strokeLinejoin="round"
        />
        <path
          d="M884 284L870 330L890 372L872 410"
          fill="none"
          stroke="#1b293e"
          strokeWidth="9"
          strokeLinecap="round"
        />
        <path d="M-40 700Q960 590 1960 700V1120H-40Z" fill="#0a1019" />
        <path
          d="M-40 700Q960 590 1960 700V726Q960 618 -40 726Z"
          fill="#24364d"
        />
        {[140, 400, 1520, 1780].map((x) => (
          <path
            key={x}
            d={`M${x - 52} 900V790A52 52 0 0 1 ${x + 52} 790V900Z`}
            fill="#060a11"
            stroke="#22344b"
            strokeWidth="3"
          />
        ))}
        <path d="M700 250L880 300L1080 1080L520 1080Z" fill="url(#rf-beam)" />
        <path
          d="M980 330L1120 300L1520 1080L1100 1080Z"
          fill="url(#rf-beam)"
          opacity="0.7"
        />
      </Layer>
      <Layer depth="mid">
        <ellipse
          cx="1150"
          cy="610"
          rx="420"
          ry="470"
          fill="url(#rf-glow)"
          className={styles.rfAura}
        />
        <ellipse
          cx="1150"
          cy="884"
          rx="470"
          ry="54"
          fill="url(#rf-glow)"
          opacity="0.55"
        />
        <path d={RF_FRAME} fill="none" stroke="#18253a" strokeWidth="34" />
        <path
          d={RF_FRAME}
          fill="none"
          stroke="#a9c1e0"
          strokeWidth="2"
          opacity="0.55"
        />
        <path d={RF_DOOR} fill="url(#rf-door)" opacity="0.72" />
        <g clipPath="url(#rf-doorclip)">
          <g className={styles.rfShimmer}>
            {[300, 500, 700, 900, 1100].map((y) => (
              <ellipse
                key={y}
                cx="1150"
                cy={y}
                rx="140"
                ry="30"
                fill="#ffffff"
                opacity="0.12"
              />
            ))}
          </g>
        </g>
        <rect x="992" y="850" width="316" height="16" fill="#1b2638" />
        <rect x="960" y="866" width="380" height="20" fill="#121b29" />
        <rect
          x="992"
          y="850"
          width="316"
          height="2"
          fill="#9db6d8"
          opacity="0.35"
        />
      </Layer>
      {particles(10, 21, styles.mote, {
        x: [53, 67],
        y: [36, 82],
        size: [2, 4],
        dur: [14, 24],
        dy: [-140, -70],
        op: [0.3, 0.7],
      })}
      <Layer depth="near">
        <circle
          cx="562"
          cy="728"
          r="230"
          fill="url(#rf-candle)"
          className={styles.rfCandleGlow}
        />
        <g fill="#05080d">
          <path d="M96 796H676L686 812H86Z" />
          <rect x="118" y="812" width="20" height="270" />
          <rect x="626" y="812" width="20" height="270" />
          <rect x="150" y="812" width="230" height="64" />
          <path d="M700 1080V690Q702 676 716 676H776Q790 676 790 690V800H774V694H716V800H700Z M690 800H800V816H690Z M700 816H714V1080H700Z M776 816H790V1080H776Z" />
          <rect x="166" y="744" width="118" height="22" rx="2" />
          <rect x="176" y="722" width="98" height="22" rx="2" />
          <rect x="160" y="766" width="130" height="30" rx="2" />
          <rect x="548" y="780" width="28" height="16" rx="3" />
        </g>
        <rect
          x="176"
          y="722"
          width="98"
          height="2"
          fill="#ffcf8a"
          opacity="0.25"
        />
        <path
          d="M320 794Q394 772 468 788Q542 772 616 794L606 800Q542 784 468 798Q394 784 330 800Z"
          fill="#d9c49a"
          opacity="0.5"
        />
        <path
          d="M340 790L452 780M484 780L598 790"
          stroke="#3a3022"
          strokeWidth="1.5"
          opacity="0.4"
          strokeDasharray="10 5"
        />
        <rect
          x="555"
          y="738"
          width="14"
          height="44"
          rx="2"
          fill="#d8ccb0"
          opacity="0.7"
        />
        <ellipse
          cx="562"
          cy="726"
          rx="6.5"
          ry="13"
          fill="#ffd27a"
          className={styles.rfFlame}
        />
        <ellipse
          cx="562"
          cy="730"
          rx="3"
          ry="6"
          fill="#fff6dc"
          className={styles.rfFlame}
        />
        <g
          transform="rotate(-34 1720 640)"
          fill="#070b12"
          stroke="#5f789b"
          strokeWidth="2"
          strokeOpacity="0.5"
        >
          <rect x="1540" y="618" width="320" height="42" rx="8" />
          <rect x="1506" y="610" width="48" height="58" rx="6" />
          <rect x="1640" y="606" width="40" height="66" rx="4" />
        </g>
        <path
          d="M1720 640L1630 1080M1720 640L1810 1080M1720 640L1736 1080"
          stroke="#070b12"
          strokeWidth="12"
        />
        <path
          d="M0 1080V986L90 960L170 990L260 972L300 1080ZM1460 1080L1500 1000L1580 1016L1640 990L1760 1006L1920 980V1080Z"
          fill="#04070b"
        />
      </Layer>
    </>
  );
}

/** A lamp that fails in the village's dark phase; `i` is its turn. */
function VillageLamp(props: {
  x: number;
  y: number;
  r: number;
  i: number;
  children?: ReactNode;
}): JSX.Element {
  return (
    <g className={styles.vgLamp} style={vars({ "--i": props.i })}>
      <circle
        cx={props.x}
        cy={props.y}
        r={props.r}
        fill="url(#vg-lamp)"
        className={styles.vgFlicker}
      />
      {props.children}
    </g>
  );
}

function House(props: {
  x: number;
  w: number;
  top: number;
  apex: number;
  chimney?: number;
}): JSX.Element {
  const { x, w, top, apex } = props;
  const roof = `M${x - 16} ${top + 6}L${x + w / 2} ${apex}L${x + w + 16} ${top + 6}`;
  return (
    <g>
      {props.chimney !== undefined && (
        <rect
          x={x + w * props.chimney}
          y={apex + (top - apex) * 0.2}
          width="20"
          height={(top - apex) * 0.7}
          fill="#120b12"
        />
      )}
      <rect x={x} y={top} width={w} height={900 - top} fill="#130c13" />
      <path d={`${roof}Z`} fill="#170e16" />
      <path
        d={roof}
        fill="none"
        stroke="#6a3c44"
        strokeWidth="2.5"
        opacity="0.65"
      />
    </g>
  );
}

/** 2. The village at dusk: lamps on posts and in windows, five suns low in the sky. */
function Village(): JSX.Element {
  return (
    <>
      <Defs>
        <Lin
          id="vg-sky"
          s={[
            [0, "#0b0a1a"],
            [0.38, "#221932"],
            [0.58, "#46283a"],
            [0.68, "#77393b"],
            [0.74, "#8e4c3c"],
            [0.82, "#3e2228"],
            [1, "#140c10"],
          ]}
        />
        <Rad
          id="vg-sun"
          s={[
            [0, "#fff0c8", 0.55],
            [0.14, "#ffd08a", 0.36],
            [0.4, "#ffb36b", 0.12],
            [1, "#ff9a50", 0],
          ]}
        />
        <Rad
          id="vg-cloud"
          s={[
            [0, "#d08060", 0.32],
            [1, "#d08060", 0],
          ]}
        />
        <Lin
          id="vg-night"
          s={[
            [0, "#020309", 0.94],
            [0.65, "#04050e", 0.82],
            [1, "#070810", 0.5],
          ]}
        />
        <Rad
          id="vg-lamp"
          s={[
            [0, "#fff1c4", 0.95],
            [0.18, "#ffc56a", 0.55],
            [0.5, "#ff9a40", 0.14],
            [1, "#ff9a40", 0],
          ]}
        />
        <Rad
          id="vg-door"
          s={[
            [0, "#ffe9b0", 0.8],
            [0.3, "#f4c76a", 0.3],
            [1, "#d5b77c", 0],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#vg-sky)" />
        <path
          d={dots(70, 31, [0, 0, 1920, 420], [0.6, 1.6])}
          fill="#e8e0ff"
          className={styles.vgStars}
        />
        <g className={styles.vgSuns}>
          {[
            [830, 652, 92],
            [902, 628, 104],
            [972, 656, 98],
            [1042, 632, 90],
            [1112, 660, 96],
          ].map(([x, y, r]) => (
            <g key={x}>
              <circle cx={x} cy={y} r={r} fill="url(#vg-sun)" />
              <circle cx={x} cy={y} r={r * 0.2} fill="#ffe6bc" opacity="0.22" />
            </g>
          ))}
        </g>
        <ellipse cx="420" cy="520" rx="420" ry="16" fill="url(#vg-cloud)" />
        <ellipse cx="1480" cy="560" rx="460" ry="18" fill="url(#vg-cloud)" />
        <ellipse
          cx="1240"
          cy="470"
          rx="280"
          ry="10"
          fill="url(#vg-cloud)"
          opacity="0.7"
        />
        <rect
          width="1920"
          height="1080"
          fill="url(#vg-night)"
          className={styles.vgNight}
        />
      </Layer>
      <Layer depth="far">
        <path
          d="M-40 770C200 712 400 730 600 744C780 756 920 700 1100 694C1280 690 1460 690 1660 706C1800 716 1880 704 1960 708V1120H-40Z"
          fill="#26182a"
        />
        <path
          d="M-40 800C240 770 520 790 760 782C1000 774 1240 790 1500 776C1700 766 1840 780 1960 776V1120H-40Z"
          fill="#1b111d"
        />
        <g className={styles.vgThread}>
          <path
            d="M960 800C990 770 1040 760 1060 730C1076 708 1090 700 1100 690"
            fill="none"
            stroke="#f4dca6"
            strokeWidth="1.6"
            opacity="0.55"
            strokeDasharray="6 7"
          />
          <circle cx="1100" cy="676" r="64" fill="url(#vg-door)" />
          <rect x="1095" y="660" width="10" height="30" rx="1" fill="#fff0c4" />
        </g>
      </Layer>
      <Layer depth="mid">
        <House x={-30} w={240} top={680} apex={590} chimney={0.7} />
        <House x={300} w={270} top={620} apex={510} chimney={0.15} />
        <House x={612} w={160} top={736} apex={690} />
        <House x={812} w={130} top={760} apex={724} />
        <House x={980} w={150} top={752} apex={712} chimney={0.6} />
        <House x={1170} w={160} top={726} apex={680} />
        <House x={1380} w={230} top={670} apex={590} chimney={0.68} />
        <House x={1660} w={300} top={636} apex={548} />
        <rect x="-40" y="880" width="2000" height="220" fill="#0d080d" />
        <rect x="404" y="760" width="56" height="120" fill="#0b070b" />
        <path d="M570 700H612M600 700V716" stroke="#0c070c" strokeWidth="5" />
        <g transform="translate(606 742)">
          <circle r="22" fill="#1a1016" stroke="#7a4a40" strokeWidth="2" />
          <path
            d="M0 14V-12M0 2C-8 -2 -12 -8 -12 -14C-6 -12 -2 -8 0 -2M0 -4C6 -8 10 -14 10 -18C4 -16 1 -12 0 -6"
            fill="none"
            stroke="#9a6a52"
            strokeWidth="2"
          />
        </g>
        <g fill="#2a1a1a">
          <path d="M330 628L340 660L350 628ZM364 626L372 652L380 626ZM520 628L528 656L536 628Z" />
        </g>
        <VillageLamp x={435} y={566} r={70} i={6}>
          <circle cx="435" cy="566" r="17" fill="#ffcf7a" opacity="0.85" />
          <path d="M418 566H452M435 549V583" stroke="#3a2016" strokeWidth="3" />
        </VillageLamp>
        <VillageLamp x={482} y={748} r={60} i={10}>
          <rect x="474" y="736" width="16" height="22" rx="3" fill="#ffd48a" />
        </VillageLamp>
        <VillageLamp x={92} y={760} r={64} i={5}>
          <rect
            x="74"
            y="740"
            width="36"
            height="44"
            fill="#f7b866"
            opacity="0.85"
          />
          <path d="M92 740V784M74 762H110" stroke="#2a1612" strokeWidth="3" />
        </VillageLamp>
        <VillageLamp x={692} y={786} r={44} i={7}>
          <rect
            x="680"
            y="774"
            width="24"
            height="26"
            fill="#f0a85a"
            opacity="0.8"
          />
        </VillageLamp>
        <VillageLamp x={1056} y={800} r={40} i={2}>
          <rect
            x="1046"
            y="790"
            width="20"
            height="22"
            fill="#e89e56"
            opacity="0.75"
          />
        </VillageLamp>
        <VillageLamp x={1250} y={778} r={46} i={4}>
          <rect
            x="1238"
            y="764"
            width="24"
            height="28"
            fill="#f2aa5c"
            opacity="0.8"
          />
        </VillageLamp>
        <VillageLamp x={1450} y={736} r={56} i={3}>
          <rect
            x="1434"
            y="718"
            width="32"
            height="38"
            fill="#f7b866"
            opacity="0.85"
          />
          <path
            d="M1450 718V756M1434 737H1466"
            stroke="#2a1612"
            strokeWidth="3"
          />
        </VillageLamp>
        <VillageLamp x={1740} y={718} r={58} i={8}>
          <rect
            x="1724"
            y="700"
            width="32"
            height="38"
            fill="#f7b866"
            opacity="0.85"
          />
        </VillageLamp>
        <VillageLamp x={1866} y={724} r={54} i={0}>
          <rect
            x="1852"
            y="708"
            width="28"
            height="34"
            fill="#f0a85a"
            opacity="0.8"
          />
        </VillageLamp>
      </Layer>
      <div className={styles.vgFireflies}>
        {particles(10, 32, styles.firefly, {
          x: [8, 92],
          y: [55, 80],
          size: [2, 3.5],
          dur: [9, 16],
          dy: [-60, -20],
          dx: [-50, 50],
          op: [0.5, 0.9],
        })}
      </div>
      <Layer depth="near">
        <g fill="#07040a">
          <rect x="128" y="500" width="12" height="600" />
          <rect x="1784" y="500" width="12" height="600" />
          <path d="M108 498H160L150 484H118Z M1764 498H1816L1806 484H1774Z" />
          <path d="M-40 980L80 960L240 975L400 952L520 970V1120H-40ZM1400 1120V972L1560 950L1700 968L1840 948L1960 960V1120Z" />
          <path
            d="M0 930H520M0 970H520M1420 930H1920M1420 966H1920"
            stroke="#07040a"
            strokeWidth="6"
          />
          {[20, 120, 220, 320, 420, 1440, 1540, 1640, 1740, 1840].map((x) => (
            <rect key={x} x={x} y="912" width="10" height="90" />
          ))}
        </g>
        <VillageLamp x={134} y={520} r={120} i={9}>
          <path d="M118 500H150L146 540H122Z" fill="#ffd690" />
        </VillageLamp>
        <VillageLamp x={1790} y={520} r={120} i={1}>
          <path d="M1774 500H1806L1802 540H1778Z" fill="#ffd690" />
        </VillageLamp>
      </Layer>
    </>
  );
}

const FG_HORSE =
  "M-56 4C-62 -14 -46 -28 -20 -26L20 -26C30 -40 36 -56 46 -64C54 -70 66 -68 72 -60L86 -46C88 -40 82 -36 76 -38L62 -44C54 -36 48 -22 44 -8C48 -2 58 0 66 -10L72 -6C64 8 52 12 40 10L32 20L36 44L28 44L22 22L-30 22L-36 46L-44 46L-42 20C-52 18 -62 30 -72 38C-74 26 -64 12 -56 4Z";
const FG_RIDER =
  "M-6 -40a9 9 0 1 0 0.1 0ZM-14 -30Q-4 -36 6 -30L10 -6L22 6L18 12L4 2L-12 0Z";
const FG_CHILD =
  "M0 -84a10 10 0 1 0 0.1 0ZM-10 -64Q0 -70 10 -64L13 -24L11 0H4L2 -22H-2L-4 0H-11L-13 -24ZM-10 -60L-28 -44L-24 -40L-8 -52Z";

/** One carousel horse on its pole, with the shadow that has left it (or come back). */
function CarouselHorse(props: {
  x: number;
  y: number;
  flip?: boolean;
  s: number;
  d: number;
  sx: number;
  sy: number;
  rider?: boolean;
}): JSX.Element {
  const scale = `scale(${props.flip ? -props.s : props.s} ${props.s})`;
  return (
    <g>
      <path
        d={`M${props.x} 500V770`}
        stroke="#c8915a"
        strokeWidth="3"
        opacity="0.7"
      />
      <g className={styles.fgBob} style={vars({ "--d": `${props.d}s` })}>
        <g
          className={styles.fgShadow}
          style={vars({ "--sx": `${props.sx}px`, "--sy": `${props.sy}px` })}
        >
          <g
            className={styles.fgDrift}
            style={vars({ "--d": `${props.d * 3}s` })}
          >
            <path
              d={FG_HORSE}
              transform={`translate(${props.x + 8} ${props.y + 10}) ${scale}`}
              fill="#000000"
              opacity="0.7"
            />
          </g>
        </g>
        <path
          d={FG_HORSE}
          transform={`translate(${props.x} ${props.y}) ${scale}`}
          fill="url(#fg-horse)"
          stroke="#ff9a7a"
          strokeWidth="1.5"
          strokeOpacity="0.45"
        />
        {props.rider && (
          <path
            d={FG_RIDER}
            transform={`translate(${props.x - 4} ${props.y - 22}) ${scale}`}
            fill="#000"
            opacity="0.85"
          />
        )}
      </g>
    </g>
  );
}

/** 3. The abandoned fairground: Tibalt's ward of copper horses and soot-red lamps. */
function Fairground(): JSX.Element {
  const spokes = Array.from({ length: 16 }, (_, i) => (i * Math.PI) / 8);
  const bulbs = (p0: P, c: P, p1: P, count: number): JSX.Element => (
    <g>
      <path
        d={`M${p0[0]} ${p0[1]}Q${c[0]} ${c[1]} ${p1[0]} ${p1[1]}`}
        fill="none"
        stroke="#2a1210"
        strokeWidth="2"
      />
      {Array.from({ length: count }, (_, i) => (i + 0.5) / count).map(
        (t, i) => {
          const x = n1(
            (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
          );
          const y = n1(
            (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1],
          );
          return (
            <g
              key={i}
              className={styles.fgBulb}
              style={vars({ "--d": `${-((i * 0.37) % 2.4)}s` })}
            >
              <path d={`M${x} ${y}v6`} stroke="#2a1210" strokeWidth="2" />
              <circle cx={x} cy={y + 10} r="24" fill="url(#fg-lamp)" />
              <circle cx={x} cy={y + 10} r="4" fill="#ffb09a" />
            </g>
          );
        },
      )}
    </g>
  );
  return (
    <>
      <Defs>
        <Lin
          id="fg-sky"
          s={[
            [0, "#070405"],
            [0.45, "#170a0c"],
            [0.72, "#36130f"],
            [0.86, "#2a0f0d"],
            [1, "#0e0607"],
          ]}
        />
        <Lin
          id="fg-copper"
          s={[
            [0, "#c0805a"],
            [0.45, "#82462a"],
            [1, "#3a1c12"],
          ]}
        />
        <Lin
          id="fg-horse"
          s={[
            [0, "#a8684a"],
            [0.5, "#6a3424"],
            [1, "#2e140e"],
          ]}
        />
        <Rad
          id="fg-lamp"
          s={[
            [0, "#ffb4a0", 0.95],
            [0.22, "#e0503a", 0.5],
            [1, "#a02818", 0],
          ]}
        />
        <Rad
          id="fg-haze"
          s={[
            [0, "#8a3020", 0.4],
            [1, "#8a3020", 0],
          ]}
        />
        <Rad
          id="fg-fog"
          s={[
            [0, "#3a2020", 0.6],
            [1, "#3a2020", 0],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#fg-sky)" />
        <circle cx="380" cy="190" r="74" fill="#5a221c" opacity="0.55" />
        <circle cx="380" cy="190" r="160" fill="url(#fg-haze)" />
        <g fill="#0c0606" opacity="0.5">
          <ellipse cx="500" cy="230" rx="420" ry="26" />
          <ellipse cx="1300" cy="320" rx="560" ry="30" />
          <ellipse cx="900" cy="150" rx="380" ry="18" />
        </g>
      </Layer>
      <Layer depth="far">
        <ellipse cx="960" cy="720" rx="1100" ry="120" fill="url(#fg-haze)" />
        <g fill="#130809">
          <path d="M40 800L160 610L280 800Z M220 800L330 640L440 800Z M-40 820L60 680L140 820Z" />
          <path
            d="M160 610L163 580M330 640L333 612"
            stroke="#130809"
            strokeWidth="4"
          />
        </g>
        <g stroke="#3a1612" strokeWidth="3" opacity="0.7">
          <path d="M160 610L120 800M160 610L200 800M330 640L300 800M330 640L362 800" />
        </g>
        <g className={styles.fgWheel}>
          <g fill="none" stroke="#1d0d0d">
            <circle cx="1560" cy="400" r="300" strokeWidth="10" />
            <circle cx="1560" cy="400" r="282" strokeWidth="4" />
            <circle cx="1560" cy="400" r="40" strokeWidth="14" />
            {spokes.map((a) => (
              <path
                key={a}
                d={`M1560 400L${n1(1560 + Math.cos(a) * 300)} ${n1(400 + Math.sin(a) * 300)}`}
                strokeWidth="4"
              />
            ))}
          </g>
          {spokes.map((a, i) => (
            <g key={a}>
              <path
                d={`M${n1(1560 + Math.cos(a) * 300 - 16)} ${n1(400 + Math.sin(a) * 300 + 6)}h32l-4 26h-24Z`}
                fill="#1a0b0b"
              />
              {i % 3 !== 1 && (
                <circle
                  cx={n1(1560 + Math.cos(a + 0.2) * 300)}
                  cy={n1(400 + Math.sin(a + 0.2) * 300)}
                  r="3"
                  fill="#e05a40"
                  opacity="0.7"
                />
              )}
            </g>
          ))}
        </g>
        <path
          d="M1560 400L1400 900M1560 400L1720 900M1450 760H1670"
          stroke="#1d0d0d"
          strokeWidth="14"
        />
      </Layer>
      <Layer depth="mid">
        <ellipse
          cx="760"
          cy="640"
          rx="520"
          ry="300"
          fill="url(#fg-haze)"
          opacity="0.8"
        />
        <path d="M760 300V340" stroke="#a46a40" strokeWidth="5" />
        <path d="M762 302L800 312L762 324Z" fill="#7a2a20" />
        <path d="M760 336L1050 470Q760 506 470 470Z" fill="url(#fg-copper)" />
        <g stroke="#5a2a18" strokeWidth="3" opacity="0.7">
          {[-240, -160, -80, 0, 80, 160, 240].map((dx) => (
            <path
              key={dx}
              d={`M760 340L${760 + dx * 1.2} ${486 - Math.abs(dx) * 0.06}`}
            />
          ))}
        </g>
        <path
          d="M470 470Q760 506 1050 470V488Q760 524 470 488Z"
          fill="#7a3a22"
        />
        <path
          d={`M470 488${Array.from({ length: 12 }, (_, i) => `q${24.2} 26 48.3 ${i < 6 ? 2.6 : -2.6}`).join("")}`}
          fill="#5e2a1a"
        />
        {Array.from({ length: 11 }, (_, i) => 494 + i * 48.3).map((x, i) => (
          <circle
            key={x}
            cx={x}
            cy={490 + (i < 6 ? i : 11 - i) * 2.4}
            r="4"
            fill="#ff8a6a"
            className={styles.fgBulbSmall}
            style={vars({ "--d": `${-i * 0.3}s` })}
          />
        ))}
        <rect x="736" y="500" width="48" height="280" fill="#2a120c" />
        <rect
          x="744"
          y="520"
          width="32"
          height="220"
          fill="#5a2a1c"
          opacity="0.5"
        />
        <path
          d="M470 770Q760 810 1050 770V800Q760 842 470 800Z"
          fill="#2a120c"
        />
        <ellipse cx="760" cy="770" rx="290" ry="34" fill="#4a2216" />
        <CarouselHorse x={560} y={650} s={0.95} d={0} sx={-70} sy={30} flip />
        <CarouselHorse x={680} y={680} s={1.1} d={-1.3} sx={60} sy={42} />
        <CarouselHorse x={860} y={672} s={1.12} d={-2.4} sx={-56} sy={36} />
        <CarouselHorse x={968} y={640} s={0.92} d={-0.7} sx={74} sy={26} flip />
        <g className={styles.fgTrapped}>
          <g className={styles.fgDrift} style={vars({ "--d": "-1s" })}>
            <path
              d={FG_RIDER}
              transform="translate(856 646) scale(1.12)"
              fill="#000"
              opacity="0.9"
            />
            <path
              d={FG_RIDER}
              transform="translate(856 646) scale(1.12)"
              fill="none"
              stroke="#d0583f"
              strokeWidth="1"
              opacity="0.35"
            />
          </g>
        </g>
        <path
          d={FG_CHILD}
          transform="translate(1210 846)"
          fill="#1a0c0a"
          stroke="#c46a50"
          strokeWidth="1.2"
          strokeOpacity="0.5"
        />
        <g className={styles.fgReturned}>
          <path
            d={FG_CHILD}
            transform="translate(1236 846) scale(1 1)"
            fill="#000"
            opacity="0.55"
          />
          <ellipse
            cx="1214"
            cy="848"
            rx="34"
            ry="6"
            fill="#000"
            opacity="0.6"
          />
        </g>
      </Layer>
      <Layer depth="near" className={styles.fgLamps}>
        {bulbs([77, 170], [480, 330], [1000, 150], 8)}
        {bulbs([1000, 150], [1400, 300], [1837, 160], 6)}
        <g fill="#080404">
          <rect x="70" y="160" width="14" height="940" />
          <rect x="1830" y="150" width="14" height="950" />
          <path d="M-40 1120V900L60 870L180 890L260 860V1120Z M1640 1120V880L1760 860L1960 880V1120Z" />
          <path d="M110 920H320V846L215 806L110 846Z" />
        </g>
        <path
          d="M110 846L215 806L320 846"
          fill="none"
          stroke="#7a2a20"
          strokeWidth="3"
          opacity="0.6"
        />
        <rect
          x="160"
          y="862"
          width="60"
          height="34"
          fill="#3a1410"
          opacity="0.8"
        />
        <ellipse cx="960" cy="1000" rx="1100" ry="140" fill="url(#fg-fog)" />
      </Layer>
      {particles(12, 41, styles.soot, {
        y: [-5, 60],
        size: [3, 6],
        dur: [16, 28],
        dx: [-80, 40],
        dy: [380, 620],
        op: [0.4, 0.8],
      })}
      {particles(6, 42, styles.ember, {
        x: [25, 70],
        y: [50, 85],
        size: [2, 4],
        dur: [9, 15],
        op: [0.4, 0.8],
      })}
    </>
  );
}

/** A cage on the foundry's overhead rail. */
function Cage({ x }: { x: number }): JSX.Element {
  return (
    <g transform={`translate(${x} 262)`}>
      <path
        d="M0 0V58"
        stroke="#3a2a20"
        strokeWidth="3"
        strokeDasharray="6 3"
      />
      <path d="M-34 84Q0 50 34 84Z" fill="#2a1d16" />
      <rect
        x="-34"
        y="84"
        width="68"
        height="96"
        fill="#0d0907"
        opacity="0.7"
      />
      <g stroke="#6a4a34" strokeWidth="3">
        {[-34, -22, -11, 0, 11, 22, 34].map((bx) => (
          <path key={bx} d={`M${bx} 84V180`} />
        ))}
      </g>
      <rect x="-38" y="178" width="76" height="8" fill="#4a3426" />
      <rect x="-38" y="80" width="76" height="6" fill="#4a3426" />
      <circle cx="4" cy="150" r="5" fill="#e9b060" opacity="0.4" />
    </g>
  );
}

/** 4. The salvage foundry: cages ride the rail into the furnace; past it the metal turns gold. */
function Foundry(): JSX.Element {
  return (
    <>
      <Defs>
        <Lin
          id="fd-bg"
          s={[
            [0, "#060505"],
            [0.6, "#150d09"],
            [1, "#0b0705"],
          ]}
        />
        <Rad
          id="fd-glow"
          s={[
            [0, "#ffcf7a", 0.75],
            [0.25, "#ff8a2a", 0.4],
            [0.6, "#8a3210", 0.14],
            [1, "#8a3210", 0],
          ]}
        />
        <Lin
          id="fd-rail"
          x2={1}
          y2={0}
          s={[
            [0, "#3a2a20"],
            [0.62, "#6a4a30"],
            [0.8, "#b88f4a"],
            [1, "#f2d690"],
          ]}
        />
        <Lin
          id="fd-gold"
          s={[
            [0, "#fff3cc"],
            [0.4, "#e8c26a"],
            [1, "#9a7434"],
          ]}
        />
        <Lin
          id="fd-mouth"
          s={[
            [0, "#f6c878"],
            [0.45, "#e07a2a"],
            [1, "#7a2c0a"],
          ]}
        />
        <Lin
          id="fd-iron"
          s={[
            [0, "#2e231d"],
            [1, "#120c09"],
          ]}
        />
        <Rad
          id="fd-exit"
          s={[
            [0, "#fff1c4", 0.55],
            [0.4, "#e8c26a", 0.2],
            [1, "#e8c26a", 0],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#fd-bg)" />
        <circle cx="1380" cy="560" r="760" fill="url(#fd-glow)" opacity="0.7" />
        <path
          d="M-40 -40H1960V120L1880 150L1840 110L1760 170L1700 130L1600 180L1520 120L1440 160L1360 110L1260 170L1180 120L1080 150L1000 100L900 160L820 120L720 170L640 110L540 150L460 100L360 160L280 120L180 170L100 120L-40 160Z"
          fill="#090605"
        />
        <g stroke="#1a110c" strokeWidth="5" strokeDasharray="9 4">
          <path d="M210 160V360M520 140V300M1720 160V420" />
        </g>
        <path
          d="M1720 420q-14 0 -14 16q0 22 22 22"
          fill="none"
          stroke="#1a110c"
          strokeWidth="7"
        />
      </Layer>
      <Layer depth="far">
        <path
          d="M-40 760L60 700L120 720L180 650L260 700L340 680L420 720L520 690L620 740L700 720L780 760L880 750V1120H-40Z"
          fill="#1a110c"
        />
        <path d="M1060 780L1140 730L1220 750V1120H1060Z" fill="#1a110c" />
        <g fill="none" stroke="#2a1c14" strokeWidth="5">
          <circle cx="240" cy="672" r="40" />
          <path d="M100 700L190 610M500 700L560 620L640 640M330 682L380 620" />
          <path d="M40 260V780M160 260V780M40 300L160 380M160 300L40 380M40 420L160 500M160 420L40 500M40 540L160 620M160 540L40 620" />
        </g>
      </Layer>
      <Layer depth="mid">
        <path
          d="M-40 840L40 780L90 800L150 730L210 760L260 700L330 740L380 720L450 770L520 750L600 800L680 790L760 830L860 820L960 860V1120H-40Z"
          fill="#120b08"
        />
        <path
          d="M40 780L90 800L150 730L210 760L260 700L330 740L380 720L450 770L520 750L600 800L680 790L760 830L860 820"
          fill="none"
          stroke="#b8784a"
          strokeWidth="2.5"
          opacity="0.4"
        />
        <g fill="none" stroke="#1c120c" strokeWidth="9" strokeLinecap="round">
          <path d="M120 760L200 690M300 720L340 650L410 660M560 780L640 730" />
          <circle cx="470" cy="745" r="34" />
        </g>
        <g fill="none" stroke="#8a5a34" strokeWidth="2" opacity="0.45">
          <path d="M120 754L196 688M300 714L338 646" />
          <path d="M440 722A34 34 0 0 1 500 728" />
        </g>
        <rect x="-40" y="236" width="1340" height="26" fill="url(#fd-rail)" />
        <path d="M-40 236H1300M-40 262H1300" stroke="#0c0806" strokeWidth="2" />
        <g stroke="#2a1c14" strokeWidth="3" opacity="0.8">
          {Array.from({ length: 18 }, (_, i) => -20 + i * 76).map((x) => (
            <path
              key={x}
              d={`M${x} 236L${x + 38} 262L${x + 76} 236`}
              fill="none"
            />
          ))}
        </g>
        <g className={styles.fdConveyor}>
          {[-300, 0, 300, 600, 900, 1200].map((x) => (
            <Cage key={x} x={x} />
          ))}
        </g>
        <path
          d="M1230 1120V300Q1230 170 1380 150Q1530 170 1530 300V1120Z"
          fill="url(#fd-iron)"
        />
        <path d="M1300 160V-40H1340V160Z" fill="#160e0a" />
        <path
          d="M1230 300Q1230 170 1380 150Q1530 170 1530 300"
          fill="none"
          stroke="#5a3a24"
          strokeWidth="4"
        />
        <circle
          cx="1380"
          cy="570"
          r="230"
          fill="url(#fd-glow)"
          className={styles.fdPulse}
        />
        <path
          d="M1286 720V560A94 112 0 0 1 1474 560V720Z"
          fill="url(#fd-mouth)"
          opacity="0.85"
          className={styles.fdPulse}
        />
        <path
          d="M1286 720V560A94 112 0 0 1 1474 560V720"
          fill="none"
          stroke="#2a1810"
          strokeWidth="14"
        />
        <rect x="1250" y="720" width="260" height="22" fill="#2a1a12" />
        <g fill="#6a4a30">
          {[1250, 1290, 1470, 1510].map((x) => (
            <g key={x}>
              <circle cx={x} cy="340" r="4" />
              <circle cx={x} cy="440" r="4" />
              <circle cx={x} cy="800" r="4" />
            </g>
          ))}
        </g>
        <rect x="1230" y="244" width="40" height="40" fill="#120c09" />
        <circle cx="1720" cy="600" r="260" fill="url(#fd-exit)" />
        <path
          d="M1612 860V560A108 108 0 0 1 1828 560V860"
          fill="none"
          stroke="url(#fd-gold)"
          strokeWidth="22"
        />
        <path
          d="M1634 860V566A86 86 0 0 1 1806 566V860Z"
          fill="#f4dca6"
          opacity="0.16"
        />
        <rect
          x="1540"
          y="300"
          width="20"
          height="560"
          fill="url(#fd-gold)"
          opacity="0.85"
        />
        <rect
          x="1880"
          y="260"
          width="22"
          height="600"
          fill="url(#fd-gold)"
          opacity="0.9"
        />
        <path
          d="M1530 330H1960M1530 380H1960"
          stroke="url(#fd-gold)"
          strokeWidth="10"
          opacity="0.8"
        />
      </Layer>
      {particles(14, 51, styles.spark, {
        x: [64, 80],
        y: [56, 72],
        size: [2, 3.5],
        dur: [2.6, 5],
        dx: [-160, 120],
        dy: [-340, -160],
        op: [0.7, 1],
      })}
      {particles(8, 52, styles.ember, {
        x: [30, 90],
        y: [40, 90],
        size: [2, 4],
        dur: [10, 18],
        op: [0.3, 0.7],
      })}
      <Layer depth="near">
        <path
          d="M-40 1120V900L40 860L90 880L150 830L240 870L300 850L380 900L460 940L520 1120Z"
          fill="#080504"
        />
        <path
          d="M40 860L90 880L150 830L240 870L300 850L380 900"
          fill="none"
          stroke="#a86a3a"
          strokeWidth="2"
          opacity="0.4"
        />
        <g fill="none" stroke="#0a0605" strokeWidth="12">
          <circle cx="160" cy="900" r="70" />
          <path
            d="M160 830V970M90 900H230M110 850L210 950M210 850L110 950"
            strokeWidth="8"
          />
        </g>
        <path
          d="M1400 1120V940L1480 900L1560 930L1640 880L1760 920L1840 890L1960 920V1120Z"
          fill="#090604"
        />
        <path
          d="M1480 900L1560 930L1640 880L1760 920L1840 890"
          fill="none"
          stroke="#e8c26a"
          strokeWidth="2"
          opacity="0.4"
        />
      </Layer>
    </>
  );
}

type Facade = Record<
  "windows" | "light" | "bands" | "spires" | "arcade",
  string
>;

/** A facade that recedes toward the vanishing point (960, 610): pointed windows, an arcade,
 *  cornices and pinnacles, from its near edge (xn, top tn, bottom bn) to its far edge xf. */
function facade(
  xn: number,
  xf: number,
  tn: number,
  bn: number,
  cols: number,
  rows: number,
  lit: readonly number[],
): Facade {
  const vpx = 960;
  const vpy = 610;
  const yAt = (x: number, f: number): number =>
    vpy + ((mix(tn, bn, f) - vpy) * (x - vpx)) / (xn - vpx);
  const k = (xn - vpx) / (xf - vpx) - 1;
  const at = (s: number): number => vpx + (xn - vpx) / (1 + s * k);
  const out = { windows: "", light: "", bands: "", spires: "", arcade: "" };
  for (let c = 0; c < cols; c++) {
    const xa = at((c + 0.3) / cols);
    const xb = at((c + 0.7) / cols);
    const xm = (xa + xb) / 2;
    for (let r = 0; r < rows; r++) {
      const fa = 0.17 + (r * 0.54) / rows;
      const fb = fa + 0.34 / rows;
      const apex = yAt(xm, fa) - (yAt(xm, fb) - yAt(xm, fa)) * 0.34;
      const q = `M${n1(xa)} ${n1(yAt(xa, fa))}L${n1(xm)} ${n1(apex)}L${n1(xb)} ${n1(yAt(xb, fa))}L${n1(xb)} ${n1(yAt(xb, fb))}L${n1(xa)} ${n1(yAt(xa, fb))}Z`;
      if (lit.includes(c * rows + r)) out.light += q;
      else out.windows += q;
    }
    const aa = at((c + 0.14) / cols);
    const ab = at((c + 0.86) / cols);
    const am = (aa + ab) / 2;
    out.arcade += `M${n1(aa)} ${n1(yAt(aa, 1))}L${n1(aa)} ${n1(yAt(aa, 0.86))}Q${n1(am)} ${n1(yAt(am, 0.74))} ${n1(ab)} ${n1(yAt(ab, 0.86))}L${n1(ab)} ${n1(yAt(ab, 1))}Z`;
    const xs = at(c / cols);
    const h = (80 * (xs - vpx)) / (xn - vpx);
    out.spires += `M${n1(xs - h * 0.1)} ${n1(yAt(xs, 0))}L${n1(xs)} ${n1(yAt(xs, 0) - h)}L${n1(xs + h * 0.1)} ${n1(yAt(xs, 0))}Z`;
  }
  for (const f of [0.05, 0.13, 0.76])
    out.bands += `M${n1(xn)} ${n1(yAt(xn, f))}L${n1(xf)} ${n1(yAt(xf, f))}`;
  return out;
}

function FacadeArt({ f, lit }: { f: Facade; lit: number }): JSX.Element {
  return (
    <g>
      <path d={f.spires} fill="#2a241e" />
      <path
        d={f.bands}
        fill="none"
        stroke="#6a5c4c"
        strokeWidth="5"
        opacity="0.55"
      />
      <path
        d={f.windows}
        fill="#0e0b09"
        stroke="#5a4e40"
        strokeWidth="2"
        strokeOpacity="0.5"
      />
      <path d={f.light} fill="#e0a860" opacity={lit} />
      <path d={f.arcade} fill="#0b0907" />
    </g>
  );
}

/** 5. The rooted streets: grand stone split by roots, an overturned tram, dust and drums. */
function Streets(): JSX.Element {
  const leftNear = facade(-40, 600, 60, 1100, 6, 5, [7, 18, 26]);
  const leftFar = facade(600, 790, 470, 786, 3, 4, [5]);
  const rightNear = facade(1960, 1320, 60, 1100, 5, 5, [3, 12, 21]);
  const rightFar = facade(1320, 1130, 470, 786, 3, 4, [2, 9]);
  const archRoot = [
    ...bez([250, 1010], [380, 560], [720, 330], [990, 390], 18),
    ...bez([990, 390], [1230, 450], [1390, 600], [1560, 830], 18).slice(1),
  ];
  const leftRoot = [
    ...bez([30, 1110], [170, 900], [110, 760], [280, 640], 14),
    ...bez([280, 640], [420, 540], [350, 420], [530, 290], 14).slice(1),
  ];
  const rightRoot = [
    ...bez([1900, 1110], [1790, 950], [1850, 820], [1700, 700], 14),
    ...bez([1700, 700], [1590, 610], [1650, 490], [1530, 390], 14).slice(1),
  ];
  const cobbles = (() => {
    let d = "";
    for (let r = 0; r < 16; r++) {
      const y = 640 + 460 * (r / 15) ** 1.6;
      const half = ((y - 610) / 490) * 1000;
      const rx = 2 + half / 60;
      const n = 6 + r * 2;
      for (let i = 0; i <= n; i++) {
        const x = 960 - half * 0.86 + ((half * 1.72) / n) * (i + (r % 2) * 0.5);
        d += `M${n1(x - rx)} ${n1(y)}a${n1(rx)} ${n1(rx * 0.35)} 0 1 0 ${n1(rx * 2)} 0a${n1(rx)} ${n1(rx * 0.35)} 0 1 0 ${n1(-rx * 2)} 0`;
      }
    }
    return d;
  })();
  return (
    <>
      <Defs>
        <Lin
          id="st-sky"
          s={[
            [0, "#0d0b0a"],
            [0.42, "#241c16"],
            [0.58, "#4a3828"],
            [0.66, "#3e3024"],
            [1, "#16110d"],
          ]}
        />
        <Lin
          id="st-stone"
          x2={1}
          y2={0}
          s={[
            [0, "#3a3229"],
            [1, "#272019"],
          ]}
        />
        <Lin
          id="st-stone2"
          x2={1}
          y2={0}
          s={[
            [0, "#201a14"],
            [1, "#30281f"],
          ]}
        />
        <Lin
          id="st-shade"
          s={[
            [0, "#0a0806", 0],
            [0.55, "#0a0806", 0.15],
            [1, "#0a0806", 0.7],
          ]}
        />
        <Lin
          id="st-root"
          s={[
            [0, "#4a4130"],
            [0.35, "#2a251b"],
            [1, "#151209"],
          ]}
        />
        <Rad
          id="st-sun"
          s={[
            [0, "#e8b878", 0.42],
            [0.4, "#b07a4a", 0.14],
            [1, "#b07a4a", 0],
          ]}
        />
        <Lin
          id="st-haze"
          s={[
            [0, "#6a5440", 0],
            [0.6, "#6a5440", 0.38],
            [1, "#6a5440", 0],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#st-sky)" />
        <circle cx="960" cy="600" r="560" fill="url(#st-sun)" />
        <g fill="#2a2119">
          <path d="M840 640V500L860 470V420L880 380L900 420V470L920 500V640Z M1040 640V500L1060 470V420L1080 380L1100 420V470L1120 500V640Z" />
          <path d="M900 640V520Q900 440 960 420Q1020 440 1020 520V640Z M956 420V380H964V420Z M948 392H972V398H948Z" />
          <path d="M760 640V560L790 540L820 560V640Z M1100 640V550L1130 530L1160 550V640Z" />
        </g>
        <path
          d="M1480 640C1500 520 1440 420 1520 330C1570 270 1640 250 1690 190"
          fill="none"
          stroke="#1d1813"
          strokeWidth="40"
          strokeLinecap="round"
        />
        <path
          d="M1500 470C1560 430 1630 450 1700 400"
          fill="none"
          stroke="#1d1813"
          strokeWidth="18"
          strokeLinecap="round"
        />
        <rect y="420" width="1920" height="300" fill="url(#st-haze)" />
      </Layer>
      <Layer depth="far">
        <path d="M-40 60L600 412V786L-40 1100Z" fill="url(#st-stone)" />
        <path d="M600 470L790 548V688L600 786Z" fill="url(#st-stone2)" />
        <path d="M1960 60L1320 412V786L1960 1100Z" fill="url(#st-stone)" />
        <path d="M1320 470L1130 548V688L1320 786Z" fill="url(#st-stone2)" />
        <FacadeArt f={leftNear} lit={0.42} />
        <FacadeArt f={leftFar} lit={0.34} />
        <FacadeArt f={rightNear} lit={0.4} />
        <FacadeArt f={rightFar} lit={0.34} />
        <path
          d="M-40 60L600 412V786L-40 1100ZM1960 60L1320 412V786L1960 1100Z"
          fill="url(#st-shade)"
        />
        <path d="M600 412V786M1320 412V786" stroke="#15110d" strokeWidth="8" />
        <path d="M-40 1100L960 610L1960 1100Z" fill="#17120e" />
        <path d={cobbles} fill="#2a221a" opacity="0.7" />
        <path
          d="M640 1100L948 616M820 1100L954 616M1280 1100L972 616M1100 1100L966 616"
          stroke="#4a3e30"
          strokeWidth="3"
          opacity="0.6"
        />
        <path
          d="M470 300L500 380L470 450L520 520L490 600L530 660"
          fill="none"
          stroke="#0a0806"
          strokeWidth="7"
        />
        <path
          d="M1480 330L1450 420L1490 480L1460 560"
          fill="none"
          stroke="#0a0806"
          strokeWidth="6"
        />
        <path d={taper(leftRoot, 80, 14)} fill="url(#st-root)" />
        <path d={taper(rightRoot, 74, 12)} fill="url(#st-root)" />
        <path
          d={taper(
            bez([250, 690], [320, 640], [380, 670], [450, 600], 10),
            30,
            4,
          )}
          fill="url(#st-root)"
        />
        <path
          d={taper(
            bez([1720, 720], [1660, 690], [1620, 730], [1560, 700], 10),
            26,
            4,
          )}
          fill="url(#st-root)"
        />
        <path d={taper(archRoot, 110, 34)} fill="url(#st-root)" />
        <path
          d={taper(
            bez([700, 360], [690, 430], [720, 480], [705, 560], 10),
            12,
            1,
          )}
          fill="#1c1810"
        />
        <path
          d={taper(
            bez([1210, 470], [1225, 520], [1195, 580], [1212, 640], 10),
            10,
            1,
          )}
          fill="#1c1810"
        />
        <path
          d={taper(
            bez([860, 380], [870, 420], [850, 450], [862, 500], 8),
            8,
            1,
          )}
          fill="#1c1810"
        />
        <path
          d={`M${archRoot
            .slice(3, 33)
            .map(([x, y]) => `${n1(x)} ${n1(y - 22)}`)
            .join("L")}`}
          fill="none"
          stroke="#6a5a40"
          strokeWidth="3"
          opacity="0.45"
          strokeDasharray="40 18 12 22"
        />
      </Layer>
      <div className={styles.stPulse} />
      <Layer depth="mid" className={styles.stStreaks}>
        <g className={styles.stWind} stroke="#d8b888" strokeLinecap="round">
          {Array.from({ length: 14 }, (_, i) => i).map((i) => {
            const x = ((i * 337) % 2100) - 100;
            const y = 120 + ((i * 211) % 760);
            return (
              <path
                key={i}
                d={`M${x} ${y}l${180 + (i % 3) * 60} ${70 + (i % 3) * 22}`}
                strokeWidth={1 + (i % 3)}
                opacity={0.08 + (i % 4) * 0.025}
              />
            );
          })}
        </g>
      </Layer>
      {particles(16, 61, styles.dust, {
        x: [-5, 95],
        y: [20, 90],
        size: [2, 5],
        dur: [8, 14],
        dx: [180, 320],
        dy: [60, 140],
        op: [0.25, 0.6],
      })}
      <Layer depth="near">
        <g transform="rotate(-9 1500 840)">
          <path
            d="M1250 760Q1250 730 1290 730H1720Q1760 730 1760 768V880Q1760 900 1730 900H1280Q1250 900 1250 870Z"
            fill="#2c261f"
          />
          <rect
            x="1250"
            y="836"
            width="510"
            height="16"
            fill="#7a5530"
            opacity="0.85"
          />
          <rect
            x="1250"
            y="856"
            width="510"
            height="4"
            fill="#7a5530"
            opacity="0.6"
          />
          <g fill="#0d0b09">
            {[1282, 1348, 1414, 1480, 1546, 1612, 1678].map((x) => (
              <rect key={x} x={x} y="752" width="50" height="62" rx="5" />
            ))}
          </g>
          <path
            d="M1352 754L1372 786L1360 812M1556 760L1572 796M1416 790L1440 770"
            stroke="#b0a088"
            strokeWidth="1.5"
            opacity="0.5"
          />
          <g fill="#16120e">
            <rect x="1290" y="700" width="130" height="30" rx="4" />
            <rect x="1590" y="700" width="130" height="30" rx="4" />
          </g>
          <g fill="#0d0b09" stroke="#5a4c3a" strokeWidth="2">
            {[1318, 1392, 1618, 1692].map((x) => (
              <circle key={x} cx={x} cy="700" r="22" />
            ))}
          </g>
          <path
            d="M1500 900L1470 970L1540 1010M1470 970L1430 1000"
            fill="none"
            stroke="#16120e"
            strokeWidth="6"
          />
          <path
            d="M1290 730H1720"
            stroke="#8a7658"
            strokeWidth="2"
            opacity="0.6"
          />
        </g>
        <path
          d="M-40 1120V1000L120 976L200 990L260 960L340 990L420 1120ZM1180 1120L1240 960L1300 980L1400 946L1500 992L1700 960L1960 980V1120Z"
          fill="#090706"
        />
        <path
          d="M120 976L200 990L260 960L340 990M1240 960L1300 980L1400 946L1500 992"
          fill="none"
          stroke="#7a6248"
          strokeWidth="2"
          opacity="0.4"
        />
        <g fill="#0c0a08">
          <path d="M440 1010L470 980L520 990L540 1020Z M560 1040L580 1020L620 1030L616 1050Z" />
        </g>
      </Layer>
    </>
  );
}

/** 6. The tribunal: a symmetrical hall of marble and blue glass, its air full of petitions. */
function Tribunal(): JSX.Element {
  const far = petitions(130, 71, [0, 40, 1920, 760], [8, 12], 0.16);
  const mid = petitions(80, 72, [0, 60, 1920, 820], [14, 22], 0.2);
  const big = [
    [150, 260, -0.06],
    [330, 520, 0.05],
    [1590, 300, 0.04],
    [1760, 560, -0.05],
    [250, 760, 0.03],
    [1680, 800, -0.04],
  ] as const;
  const columns = [
    [40, 150, 0, 1080],
    [300, 104, 110, 880],
    [480, 72, 200, 760],
    [610, 50, 262, 690],
    [700, 34, 304, 650],
  ] as const;
  return (
    <>
      <Defs>
        <Lin
          id="tb-wall"
          s={[
            [0, "#070a10"],
            [1, "#101824"],
          ]}
        />
        <Lin
          id="tb-glass"
          s={[
            [0, "#a4cff0", 0.75],
            [0.5, "#4a7fb5", 0.6],
            [1, "#163050", 0.7],
          ]}
        />
        <Lin
          id="tb-col"
          x2={1}
          y2={0}
          s={[
            [0, "#1a212c"],
            [0.3, "#7a8798"],
            [0.5, "#aab6c6"],
            [0.72, "#6a7686"],
            [1, "#151b25"],
          ]}
        />
        <Lin
          id="tb-shaft"
          s={[
            [0, "#9cc8ee", 0.16],
            [1, "#9cc8ee", 0],
          ]}
        />
        <Lin
          id="tb-floor"
          s={[
            [0, "#1a2330"],
            [1, "#05070a"],
          ]}
        />
        <Rad
          id="tb-cold"
          s={[
            [0, "#8fc3ea", 0.3],
            [1, "#8fc3ea", 0],
          ]}
        />
        <g id="tb-half">
          {columns.map(([x, w, top, bottom]) => (
            <g key={x}>
              <rect
                x={x}
                y={top}
                width={w}
                height={bottom - top}
                fill="url(#tb-col)"
              />
              <rect
                x={x - w * 0.14}
                y={top}
                width={w * 1.28}
                height={w * 0.3}
                fill="#9aa6b6"
                opacity="0.8"
              />
              <rect
                x={x - w * 0.14}
                y={bottom - w * 0.28}
                width={w * 1.28}
                height={w * 0.28}
                fill="#5a6676"
              />
            </g>
          ))}
          <path
            d="M110 110Q260 -20 404 200M404 200Q470 120 556 262M556 262Q600 220 660 304"
            fill="none"
            stroke="#2a3444"
            strokeWidth="10"
          />
        </g>
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#tb-wall)" />
        <path d="M800 640V260Q960 60 1120 260V640Z" fill="url(#tb-glass)" />
        <path
          d="M640 600V330Q690 250 740 330V600ZM1180 600V330Q1230 250 1280 330V600Z"
          fill="url(#tb-glass)"
          opacity="0.7"
        />
        <g stroke="#0c121c" strokeWidth="5" fill="none">
          <path d="M800 640V260Q960 60 1120 260V640M960 140V640M880 180V640M1040 180V640M800 340H1120M800 440H1120M800 540H1120" />
          <path d="M690 270V600M640 420H740M1230 270V600M1180 420H1280" />
        </g>
        <path d="M800 640L1120 640L1260 1080L660 1080Z" fill="url(#tb-shaft)" />
      </Layer>
      <Layer depth="far">
        <path d="M-40 1120L760 650H1160L1960 1120Z" fill="url(#tb-floor)" />
        <g stroke="#243042" strokeWidth="2" opacity="0.7">
          {[-600, -300, -100, 60, 200, 340].map((dx) => (
            <path
              key={dx}
              d={`M${960 + dx * 0.25} 650L${960 + dx * 2.6} 1080M${960 - dx * 0.25} 650L${960 - dx * 2.6} 1080`}
            />
          ))}
          <path d="M600 744H1320M380 870H1540" />
        </g>
        <use href="#tb-half" />
        <use href="#tb-half" transform="matrix(-1 0 0 1 1920 0)" />
        <ellipse cx="960" cy="780" rx="260" ry="40" fill="url(#tb-cold)" />
        <path
          d="M860 660H1060V640H880V620H1040V600H900V660Z"
          fill="#8e9aab"
          opacity="0.5"
        />
        <path
          d="M914 600V470Q960 430 1006 470V600Z"
          fill="#a8b4c4"
          opacity="0.55"
        />
        <path
          d="M930 600V486Q960 460 990 486V600Z"
          fill="#141c28"
          opacity="0.8"
        />
      </Layer>
      <Layer depth="mid" className={styles.tbFloatA}>
        <path d={far.sheets} fill="#9aa6b8" opacity="0.45" />
        <path d={far.stamps} fill="#a8242a" opacity="0.6" />
      </Layer>
      <Layer depth="mid" className={styles.tbFloatB}>
        <path d={mid.sheets} fill="#cdd5e0" opacity="0.72" />
        <path d={mid.lines} fill="#4a5262" opacity="0.5" />
        <path d={mid.stamps} fill="#b3262a" opacity="0.85" />
      </Layer>
      {particles(10, 73, styles.paper, {
        x: [2, 98],
        y: [8, 50],
        size: [14, 22],
        dur: [7, 12],
        op: [0.5, 0.85],
      })}
      <Layer depth="near">
        {big.map(([x, y, a], i) => (
          <g key={x} transform={`translate(${x} ${y}) rotate(${n1(a * 57.3)})`}>
            <g className={styles.tbBob} style={vars({ "--d": `${-i * 1.7}s` })}>
              <rect
                x="-30"
                y="-42"
                width="60"
                height="84"
                fill="#dfe4ea"
                opacity="0.9"
              />
              <path
                d="M-20 -30H20M-20 -22H16M-20 -14H20M-20 -6H12M-20 2H18"
                stroke="#5a6272"
                strokeWidth="1.6"
                opacity="0.6"
              />
              {i % 2 === 0 && (
                <g transform="translate(0 22) rotate(-14)">
                  <rect
                    x="-24"
                    y="-8"
                    width="48"
                    height="16"
                    rx="2"
                    fill="none"
                    stroke="#b3262a"
                    strokeWidth="2"
                  />
                  <text
                    x="0"
                    y="3.5"
                    fontSize="9"
                    fill="#b3262a"
                    textAnchor="middle"
                    fontFamily="Georgia, serif"
                    letterSpacing="0.6"
                  >
                    REJECTED
                  </text>
                </g>
              )}
            </g>
          </g>
        ))}
      </Layer>
    </>
  );
}

/** A silver mirror in a hedge, with a sheen that passes over it now and then. */
function Mirror(props: {
  x: number;
  y: number;
  rx: number;
  ry: number;
  d: number;
}): JSX.Element {
  const id = `gd-m${props.x}`;
  return (
    <g>
      <clipPath id={id}>
        <ellipse cx={props.x} cy={props.y} rx={props.rx} ry={props.ry} />
      </clipPath>
      <ellipse
        cx={props.x}
        cy={props.y}
        rx={props.rx + 9}
        ry={props.ry + 9}
        fill="none"
        stroke="#c8d6d0"
        strokeWidth="6"
        opacity="0.75"
      />
      <ellipse
        cx={props.x}
        cy={props.y}
        rx={props.rx}
        ry={props.ry}
        fill="url(#gd-mirror)"
      />
      <g clipPath={`url(#${id})`}>
        <path
          d={`M${props.x - props.rx} ${props.y + props.ry * 0.3}Q${props.x} ${props.y + props.ry * 0.1} ${props.x + props.rx} ${props.y + props.ry * 0.35}V${props.y + props.ry}H${props.x - props.rx}Z`}
          fill="#1e3a2a"
          opacity="0.7"
        />
        <ellipse
          cx={props.x - props.rx * 0.1}
          cy={props.y - props.ry * 0.05}
          rx={props.rx * 0.16}
          ry={props.ry * 0.4}
          fill="#7a8a82"
          opacity="0.5"
        />
        <g
          className={styles.gdSheen}
          style={vars({
            "--d": `${props.d}s`,
            "--len": `${n1(props.rx * 4.8)}px`,
          })}
        >
          <rect
            x={props.x - props.rx * 2.4}
            y={props.y - props.ry * 1.2}
            width={props.rx * 0.5}
            height={props.ry * 2.4}
            fill="#ffffff"
            opacity="0.5"
            transform={`rotate(18 ${props.x} ${props.y})`}
          />
        </g>
      </g>
    </g>
  );
}

function Statue(props: { x: number; flip?: boolean }): JSX.Element {
  return (
    <g transform={`translate(${props.x} 0) scale(${props.flip ? -1 : 1} 1)`}>
      <rect x="-56" y="760" width="112" height="140" fill="#1e2824" />
      <rect x="-64" y="748" width="128" height="16" fill="#46524c" />
      <path
        d="M-34 748Q-40 640 -26 560Q-20 520 0 516Q20 520 26 560Q42 640 36 748Z"
        fill="url(#gd-stone)"
      />
      <path
        d="M-14 600Q-10 680 -18 748M8 590Q14 680 10 748"
        stroke="#4a5650"
        strokeWidth="2"
        fill="none"
        opacity="0.7"
      />
      <path
        d="M22 548Q48 520 50 470L58 472Q58 530 28 566Z"
        fill="url(#gd-stone)"
      />
      <ellipse cx="0" cy="488" rx="19" ry="25" fill="#8a988f" />
      <ellipse cx="-5" cy="482" rx="9" ry="14" fill="#d2ddd6" opacity="0.35" />
      <path
        d="M-20 484Q0 448 20 484"
        fill="none"
        stroke="#7d8b84"
        strokeWidth="5"
      />
    </g>
  );
}

/** 7. The mirror garden: silver mirrors in living hedges, statues with blank faces. */
function Garden(): JSX.Element {
  return (
    <>
      <Defs>
        <Lin
          id="gd-sky"
          s={[
            [0, "#030706"],
            [0.6, "#0a1913"],
            [1, "#0d2018"],
          ]}
        />
        <Rad
          id="gd-moon"
          s={[
            [0, "#dce8e2", 0.4],
            [0.3, "#a8c4b6", 0.12],
            [1, "#a8c4b6", 0],
          ]}
        />
        <Lin
          id="gd-hedge"
          s={[
            [0, "#1d3828"],
            [1, "#0a160f"],
          ]}
        />
        <Lin
          id="gd-mirror"
          x2={1}
          s={[
            [0, "#d8e4de"],
            [0.4, "#7f9890"],
            [0.7, "#b8cac2"],
            [1, "#4e6a5e"],
          ]}
        />
        <Lin
          id="gd-stone"
          s={[
            [0, "#7c8a82"],
            [1, "#2a3430"],
          ]}
        />
        <Rad
          id="gd-mist"
          s={[
            [0, "#9ab8aa", 0.22],
            [1, "#9ab8aa", 0],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#gd-sky)" />
        <circle cx="430" cy="160" r="420" fill="url(#gd-moon)" />
        <circle cx="430" cy="160" r="34" fill="#e2ece6" opacity="0.7" />
        <path
          d={dots(60, 81, [0, 0, 1920, 360], [0.6, 1.4])}
          fill="#dfeee6"
          opacity="0.5"
        />
        <g fill="#06100b">
          <path d="M-40 520Q20 380 120 400Q160 300 260 330Q330 260 420 320Q500 290 560 360Q640 330 700 420L720 600H-40Z" />
          <path d="M1240 600L1260 400Q1320 320 1420 350Q1480 270 1580 310Q1660 260 1740 330Q1840 300 1900 380Q1960 360 1980 420V600Z" />
        </g>
      </Layer>
      <Layer depth="far">
        <path
          d="M560 720V540H880V600Q880 520 960 520Q1040 520 1040 600V540H1360V720Z"
          fill="#11241a"
        />
        <path
          d="M880 720V600Q880 520 960 520Q1040 520 1040 600V720Z"
          fill="#2a4438"
          opacity="0.6"
        />
        <ellipse cx="960" cy="640" rx="140" ry="90" fill="url(#gd-mist)" />
        <g fill="#132a1e">
          <path d="M640 540L670 450L700 540ZM1220 540L1250 450L1280 540Z" />
          <circle cx="800" cy="520" r="24" />
          <circle cx="1120" cy="520" r="24" />
        </g>
        <path d="M-40 1120L760 720H1160L1960 1120Z" fill="#0c1a12" />
        <path
          d={dots(
            30,
            82,
            [700, 730, 1220, 900],
            [3, 7],
            (x, y) => Math.abs(x - 960) < 60 + (y - 720) * 0.9,
          )}
          fill="#4a5e54"
          opacity="0.6"
        />
      </Layer>
      <Layer depth="mid">
        <path
          d="M-40 360Q60 340 160 352Q300 330 440 370Q540 360 620 400V880H-40Z"
          fill="url(#gd-hedge)"
        />
        <path
          d="M1960 360Q1860 340 1760 352Q1620 330 1480 370Q1380 360 1300 400V880H1960Z"
          fill="url(#gd-hedge)"
        />
        <path
          d={dots(140, 83, [-40, 360, 620, 880], [3, 9])}
          fill="#24402e"
          opacity="0.7"
        />
        <path
          d={dots(140, 84, [1300, 360, 1960, 880], [3, 9])}
          fill="#24402e"
          opacity="0.7"
        />
        <path
          d={dots(90, 89, [-40, 340, 620, 470], [2, 6])}
          fill="#4a6e58"
          opacity="0.5"
        />
        <path
          d={dots(90, 90, [1300, 340, 1960, 470], [2, 6])}
          fill="#4a6e58"
          opacity="0.5"
        />
        <path
          d="M-40 360Q60 340 160 352Q300 330 440 370Q540 360 620 400M1960 360Q1860 340 1760 352Q1620 330 1480 370Q1380 360 1300 400"
          fill="none"
          stroke="#8fb4a0"
          strokeWidth="2.5"
          opacity="0.35"
        />
        <Mirror x={200} y={600} rx={78} ry={130} d={0} />
        <Mirror x={470} y={640} rx={52} ry={92} d={-3} />
        <Mirror x={1720} y={600} rx={78} ry={130} d={-5} />
        <Mirror x={1450} y={640} rx={52} ry={92} d={-8} />
        <Statue x={690} />
        <Statue x={1230} flip />
      </Layer>
      {particles(9, 85, styles.mote, {
        x: [5, 95],
        y: [30, 80],
        size: [2, 4],
        dur: [12, 20],
        op: [0.35, 0.75],
      })}
      {particles(8, 86, styles.petal, {
        x: [0, 100],
        y: [-10, 40],
        size: [6, 9],
        dur: [14, 22],
        dx: [80, 220],
        dy: [500, 760],
        op: [0.5, 0.8],
      })}
      <Layer depth="near">
        <path
          d="M-40 1120V900Q20 860 90 880Q150 840 220 870Q290 850 340 900Q380 960 360 1120Z"
          fill="#06100a"
        />
        <path
          d="M1960 1120V900Q1900 860 1830 880Q1770 840 1700 870Q1630 850 1580 900Q1540 960 1560 1120Z"
          fill="#06100a"
        />
        <path
          d={dots(24, 87, [0, 870, 340, 960], [2, 4])}
          fill="#d8e6de"
          opacity="0.6"
        />
        <path
          d={dots(24, 88, [1580, 870, 1920, 960], [2, 4])}
          fill="#d8e6de"
          opacity="0.6"
        />
      </Layer>
    </>
  );
}

/** A couple of dancers, hands joined high; origin at the lady's feet. */
function Couple(props: {
  x: number;
  y: number;
  s: number;
  flip?: boolean;
  d: number;
}): JSX.Element {
  return (
    <g
      transform={`translate(${props.x} ${props.y}) scale(${props.flip ? -props.s : props.s} ${props.s})`}
    >
      <g className={styles.rvDancer} style={vars({ "--d": `${props.d}s` })}>
        <g
          fill="#0d0805"
          stroke="#0d0805"
          strokeWidth="6"
          strokeLinecap="round"
        >
          <circle cx="0" cy="-160" r="10" stroke="none" />
          <circle cx="-8" cy="-167" r="5" stroke="none" />
          <path d="M-8 -150Q0 -153 8 -150L6 -112H-6Z" stroke="none" />
          <path
            d="M-6 -114Q-30 -66 -60 -6Q-34 4 -6 -2Q20 3 42 -4Q22 -60 6 -114Z"
            stroke="none"
          />
          <path
            d="M6 -146Q24 -160 38 -170M-6 -146Q-28 -138 -44 -122"
            fill="none"
          />
          <circle cx="70" cy="-172" r="10.5" stroke="none" />
          <path d="M58 -158H82L84 -100H56Z" stroke="none" />
          <path
            d="M82 -104L96 -56L78 -64Z M58 -100L52 0H61L68 -62L74 0H83L82 -100Z"
            stroke="none"
          />
          <path
            d="M60 -154Q46 -166 38 -170M80 -152Q96 -128 92 -108"
            fill="none"
          />
        </g>
        <path
          d="M-6 -114Q-30 -66 -60 -6"
          fill="none"
          stroke="#f2c66d"
          strokeWidth="1.5"
          opacity="0.35"
        />
      </g>
    </g>
  );
}

/** 8. The captured revel: a starry vault, gold banners and lanterns, dancers who cannot stop. */
function Revel(): JSX.Element {
  const lanterns = [
    [150, 214],
    [380, 270],
    [610, 312],
    [840, 330],
    [1080, 330],
    [1310, 312],
    [1540, 270],
    [1770, 214],
  ] as const;
  const arches = [300, 540, 780, 1140, 1380, 1620];
  return (
    <>
      <Defs>
        <Lin
          id="rv-ceil"
          s={[
            [0, "#060510"],
            [1, "#16122b"],
          ]}
        />
        <Lin
          id="rv-hall"
          s={[
            [0, "#120c06"],
            [0.5, "#2a1d0b"],
            [0.7, "#1e1508"],
            [1, "#0c0804"],
          ]}
        />
        <Rad
          id="rv-gold"
          s={[
            [0, "#f6c56a", 0.42],
            [0.5, "#c9903a", 0.14],
            [1, "#c9903a", 0],
          ]}
        />
        <Rad
          id="rv-star"
          s={[
            [0, "#a8e0cc", 0.3],
            [0.6, "#6aa89a", 0.1],
            [1, "#6aa89a", 0],
          ]}
        />
        <Rad
          id="rv-lantern"
          s={[
            [0, "#fff0c0", 0.9],
            [0.25, "#f2c66d", 0.4],
            [1, "#f2c66d", 0],
          ]}
        />
        <Lin
          id="rv-banner"
          s={[
            [0, "#e4bd74"],
            [1, "#7e5a28"],
          ]}
        />
        <Lin
          id="rv-arch"
          s={[
            [0, "#f6d08a", 0.5],
            [0.7, "#a8742e", 0.25],
            [1, "#4a3010", 0.1],
          ]}
        />
        <Lin
          id="rv-col"
          x2={1}
          y2={0}
          s={[
            [0, "#1a1208"],
            [0.4, "#4a3616"],
            [1, "#120c05"],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#rv-hall)" />
        <path
          d="M-40 -40H1960V420Q1440 300 960 300Q480 300 -40 420Z"
          fill="url(#rv-ceil)"
        />
        <path
          d={dots(
            160,
            91,
            [0, 0, 1920, 400],
            [0.6, 1.8],
            (x, y) => y < 296 + Math.abs(x - 960) * 0.12,
          )}
          fill="#f2e8c8"
          opacity="0.7"
        />
        <g fill="none" stroke="#6a5226" opacity="0.8">
          <path
            d="M-40 420Q480 300 960 300Q1440 300 1960 420"
            strokeWidth="6"
          />
          <path
            d="M240 340Q400 120 600 -40M1680 340Q1520 120 1320 -40M720 305Q800 120 860 -40M1200 305Q1120 120 1060 -40"
            strokeWidth="3"
          />
        </g>
        <g className={styles.rvArches}>
          {arches.map((x) => (
            <g key={x}>
              <path
                d={`M${x - 74} 760V560Q${x} 456 ${x + 74} 560V760Z`}
                fill="url(#rv-arch)"
              />
              <path
                d={`M${x - 74} 760V560Q${x} 456 ${x + 74} 560V760`}
                fill="none"
                stroke="#8a6a30"
                strokeWidth="3"
                opacity="0.6"
              />
            </g>
          ))}
          {[180, 420, 660, 900, 1020, 1260, 1500, 1740].map((x) => (
            <rect
              key={x}
              x={x - 16}
              y="470"
              width="32"
              height="300"
              fill="url(#rv-col)"
            />
          ))}
          <path
            d="M-40 470H1960"
            stroke="#8a6a30"
            strokeWidth="4"
            opacity="0.5"
          />
        </g>
        <ellipse
          cx="960"
          cy="640"
          rx="900"
          ry="300"
          fill="url(#rv-gold)"
          className={styles.rvGoldWash}
        />
        <ellipse
          cx="960"
          cy="420"
          rx="1000"
          ry="460"
          fill="url(#rv-star)"
          className={styles.rvStarWash}
        />
      </Layer>
      <Layer depth="far" className={styles.rvDecor}>
        <path
          d="M-40 150Q480 360 960 340Q1440 360 1960 150"
          fill="none"
          stroke="#7a5a28"
          strokeWidth="2.5"
        />
        <path
          d="M-40 90Q480 240 960 240Q1440 240 1960 90"
          fill="none"
          stroke="#7a5a28"
          strokeWidth="2"
          opacity="0.6"
        />
        {[180, 400, 1520, 1740].map((x, i) => (
          <g
            key={x}
            className={styles.rvBanner}
            style={vars({ "--d": `${-i * 1.9}s` })}
          >
            <path
              d={`M${x - 44} -20H${x + 44}V${500 + (i % 2) * 40}L${x} ${460 + (i % 2) * 40}L${x - 44} ${500 + (i % 2) * 40}Z`}
              fill="url(#rv-banner)"
            />
            <path
              d={`M${x - 34} -20V${480 + (i % 2) * 40}M${x + 34} -20V${480 + (i % 2) * 40}`}
              stroke="#5a3e16"
              strokeWidth="2"
            />
            <path
              d={`M${x} 190l9 22l22 -9l-9 22l22 9l-22 9l9 22l-22 -9l-9 22l-9 -22l-22 9l9 -22l-22 -9l22 -9l-9 -22l22 9Z`}
              fill="#5a3c14"
              opacity="0.8"
            />
          </g>
        ))}
        {lanterns.map(([x, y], i) => (
          <g
            key={x}
            className={styles.rvLantern}
            style={vars({ "--d": `${-i * 0.8}s` })}
          >
            <path
              d={`M${x} ${y - 24}V${y - 8}`}
              stroke="#5a3e16"
              strokeWidth="2"
            />
            <circle cx={x} cy={y + 14} r="70" fill="url(#rv-lantern)" />
            <ellipse cx={x} cy={y + 14} rx="15" ry="20" fill="#f6cf7a" />
            <path
              d={`M${x - 15} ${y + 14}H${x + 15}M${x} ${y - 6}V${y + 34}`}
              stroke="#a8762e"
              strokeWidth="1.5"
              opacity="0.7"
            />
          </g>
        ))}
      </Layer>
      <Layer depth="mid" className={styles.rvFloor}>
        <ellipse
          cx="960"
          cy="790"
          rx="860"
          ry="80"
          fill="url(#rv-gold)"
          className={styles.rvGoldWash}
        />
        <g fill="#100a05">
          <path d="M120 820L180 740H420L400 820Z M1800 820L1740 740H1500L1520 820Z" />
          <path
            d="M140 820V880M390 820V880M1780 820V880M1530 820V880"
            stroke="#100a05"
            strokeWidth="8"
          />
        </g>
        <path
          d="M180 740H420M1740 740H1500"
          stroke="#c99a4a"
          strokeWidth="2"
          opacity="0.5"
        />
        {[200, 250, 300, 350, 1570, 1620, 1670, 1720].map((x) => (
          <g key={x}>
            <circle cx={x} cy="722" r="16" fill="url(#rv-lantern)" />
            <rect
              x={x - 2}
              y="724"
              width="4"
              height="16"
              fill="#e8d8b0"
              opacity="0.7"
            />
          </g>
        ))}
        <Couple x={560} y={800} s={0.95} d={0} />
        <Couple x={760} y={752} s={0.66} flip d={-1.1} />
        <Couple x={930} y={724} s={0.48} d={-2.3} />
        <Couple x={1180} y={752} s={0.66} d={-0.6} />
        <Couple x={1380} y={800} s={0.95} flip d={-1.8} />
      </Layer>
      <div className={styles.rvMotes}>
        {particles(12, 92, styles.mote, {
          x: [5, 95],
          y: [20, 85],
          size: [2, 4],
          dur: [10, 18],
          op: [0.4, 0.8],
        })}
      </div>
      <Layer depth="near">
        <path
          d="M-40 -40H120V1120H-40ZM1800 -40H1960V1120H1800Z"
          fill="#0b0703"
        />
        <path
          d="M120 -40V1120M1800 -40V1120"
          stroke="#8a6a30"
          strokeWidth="3"
          opacity="0.6"
        />
        <path
          d="M120 300H160V340H120ZM1760 300H1800V340H1760Z"
          fill="#3a2a10"
        />
        <path
          d="M-40 1120V960Q480 920 960 920Q1440 920 1960 960V1120Z"
          fill="#0a0604"
        />
      </Layer>
    </>
  );
}

const TR_FIGURE =
  "M0 -118a12 12 0 1 0 0.1 0ZM-14 -100H14L18 -50H-18ZM-14 -48H-3L-6 0H-14ZM3 -48H14L14 0H6ZM-18 -98L-30 -54L-24 -52L-12 -90Z";

/** 9. The transit works: suspended ribs across a gulf, blue arcs, unfinished figures beyond. */
function Transit(): JSX.Element {
  const ribs = [80, 260, 430, 590, 740, 880, 1010, 1130, 1240];
  const spineY = (x: number): number =>
    420 + (x / 1300) * 140 - Math.sin((x / 1300) * Math.PI) * 60;
  const apex = (x: number): P => [x, spineY(x) - 300 * (1 - x / 1700)];
  const arcs = [
    bolt(103, ...apex(260), 330, 90, ...apex(590), 12, 26),
    bolt(104, ...apex(590), 650, 190, ...apex(880), 11, 22),
    bolt(105, ...apex(880), 930, 300, ...apex(1130), 10, 18),
    bolt(106, 430, n1(spineY(430)), 600, 640, 740, n1(spineY(740)), 10, 22),
    bolt(107, 1240, n1(spineY(1240)), 1330, 470, 1420, 592, 9, 18),
  ];
  let lattice = "";
  for (let x = -40; x < 1300; x += 44) {
    const y0 = spineY(x);
    const y1 = spineY(x + 44);
    const depth = 46 * (1 - x / 2200);
    lattice += `M${x} ${n1(y0)}L${x + 22} ${n1((y0 + y1) / 2 + depth)}L${x + 44} ${n1(y1)}`;
  }
  return (
    <>
      <Defs>
        <Lin
          id="tr-sky"
          s={[
            [0, "#02040a"],
            [0.5, "#050c1a"],
            [0.78, "#0b1d33"],
            [1, "#03060c"],
          ]}
        />
        <Rad
          id="tr-abyss"
          s={[
            [0, "#3a86cc", 0.5],
            [0.5, "#1a4a80", 0.16],
            [1, "#1a4a80", 0],
          ]}
        />
        <Lin
          id="tr-metal"
          s={[
            [0, "#536379"],
            [1, "#151c28"],
          ]}
        />
        <Rad
          id="tr-arc"
          s={[
            [0, "#9ae6ff", 0.5],
            [1, "#5cc8ff", 0],
          ]}
        />
        <clipPath id="tr-half">
          <rect x="-200" y="-200" width="400" height="140" />
        </clipPath>
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#tr-sky)" />
        <ellipse cx="900" cy="1000" rx="900" ry="380" fill="url(#tr-abyss)" />
        <path
          d={dots(60, 101, [0, 0, 1920, 500], [0.5, 1.3])}
          fill="#bfe4ff"
          opacity="0.45"
        />
        <g fill="#0a1524">
          <path d="M1500 620V300L1520 280L1540 300V620ZM1600 620V200L1612 170L1624 200V620ZM1720 620V340H1760V620Z" />
        </g>
      </Layer>
      <Layer depth="far">
        <path
          d="M1240 1120V640L1300 600L1420 590L1600 604L1760 596L1960 610V1120Z"
          fill="#081120"
        />
        <path
          d="M1240 640L1300 600L1420 590L1600 604L1760 596L1960 610"
          fill="none"
          stroke="#3a7ab8"
          strokeWidth="2"
          opacity="0.6"
        />
        <g opacity="0.35" fill="none" stroke="#3a5a80">
          <path d="M-40 700Q600 660 1240 720" strokeWidth="8" />
          {[80, 300, 520, 740, 960, 1160].map((x) => (
            <path
              key={x}
              d={`M${x - 70 * (1 - x / 2400)} ${n1(700 - x * 0.012 + (x / 1240) ** 2 * 30)}a${n1(70 * (1 - x / 2400))} ${n1(140 * (1 - x / 2400))} 0 0 1 ${n1(140 * (1 - x / 2400))} 0`}
              strokeWidth="5"
            />
          ))}
        </g>
        <path
          d={dots(9, 108, [1300, 588, 1940, 600], [1.6, 2.4])}
          fill="#8fe0ff"
          opacity="0.8"
        />
        {[
          [1390, 0.95, false],
          [1470, 1.05, true],
          [1560, 0.9, false],
          [1660, 1.1, true],
          [1760, 1, false],
        ].map(([x, s, f], i) => (
          <g
            key={String(x)}
            transform={`translate(${x} 600) scale(${f ? -Number(s) : Number(s)} ${s})`}
            className={i % 2 ? styles.trFlicker : undefined}
            style={vars({ "--d": `${-i * 1.3}s` })}
          >
            <path
              d={TR_FIGURE}
              fill="#0d1b2e"
              stroke="#6ab8f0"
              strokeWidth="1.5"
              strokeOpacity="0.7"
              strokeDasharray={i % 2 ? "8 6" : "30 10 4 10"}
            />
            <rect
              x="-20"
              y={-80 + i * 12}
              width="40"
              height="18"
              fill="#081120"
            />
          </g>
        ))}
        <ellipse
          cx="1580"
          cy="600"
          rx="300"
          ry="30"
          fill="url(#tr-arc)"
          opacity="0.5"
        />
      </Layer>
      <Layer depth="mid">
        <g stroke="#1e2a3c" strokeWidth="2" opacity="0.8">
          {ribs.map((x) => (
            <path
              key={x}
              d={`M${x} -40V${n1(spineY(x) - 300 * (1 - x / 1700))}`}
            />
          ))}
        </g>
        <path
          d={`M-60 ${n1(spineY(0))}${ribs.map((x) => `L${x} ${n1(spineY(x))}`).join("")}L1320 ${n1(spineY(1320))}`}
          fill="none"
          stroke="url(#tr-metal)"
          strokeWidth="18"
        />
        <path
          d={`M-60 ${n1(spineY(0))}${ribs.map((x) => `L${x} ${n1(spineY(x))}`).join("")}`}
          fill="none"
          stroke="#5cc8ff"
          strokeWidth="40"
          opacity="0.07"
        />
        <path d={lattice} fill="none" stroke="#2a3a52" strokeWidth="3" />
        <path
          d={`M-60 ${n1(spineY(0) + 46)}${ribs.map((x) => `L${x} ${n1(spineY(x) + 46 * (1 - x / 2200))}`).join("")}`}
          fill="none"
          stroke="#1e2a3c"
          strokeWidth="8"
        />
        {ribs.map((x, i) => {
          const s = 1 - x / 1700;
          const y = spineY(x);
          const rx = 150 * s;
          const ry = 300 * s;
          return (
            <g key={x}>
              <path
                d={`M${n1(x - rx)} ${n1(y)}A${n1(rx)} ${n1(ry)} 0 0 1 ${n1(x + rx)} ${n1(y)}`}
                fill="none"
                stroke="url(#tr-metal)"
                strokeWidth={n1(16 * s + 3)}
                strokeDasharray={
                  i % 3 === 2 ? `${n1(260 * s)} ${n1(90 * s)}` : undefined
                }
              />
              <path
                d={`M${n1(x - rx)} ${n1(y)}A${n1(rx)} ${n1(ry)} 0 0 1 ${n1(x + rx)} ${n1(y)}`}
                fill="none"
                stroke="#7a9cc4"
                strokeWidth="1.5"
                opacity="0.4"
                transform="translate(-3 -3)"
              />
              <circle
                cx={x}
                cy={n1(y)}
                r={n1(9 * s + 3)}
                fill="#2a3a52"
                stroke="#5cc8ff"
                strokeWidth="1.5"
                strokeOpacity="0.6"
              />
            </g>
          );
        })}
        {[
          [260, 590],
          [590, 880],
          [880, 1130],
        ].map(([a, b], i) => (
          <g
            key={a}
            className={styles.trPulse}
            style={vars({ "--d": `${-i * 1.4}s` })}
          >
            <path
              d={`M${a} ${n1(spineY(a))}Q${(a + b) / 2} ${n1((spineY(a) + spineY(b)) / 2 + 190 - i * 40)} ${b} ${n1(spineY(b))}`}
              fill="none"
              stroke="#5cc8ff"
              strokeWidth="14"
              opacity="0.16"
            />
            <path
              d={`M${a} ${n1(spineY(a))}Q${(a + b) / 2} ${n1((spineY(a) + spineY(b)) / 2 + 190 - i * 40)} ${b} ${n1(spineY(b))}`}
              fill="none"
              stroke="#9ae6ff"
              strokeWidth="2.5"
              opacity="0.8"
            />
          </g>
        ))}
        {arcs.map((d, i) => (
          <g
            key={d}
            className={styles.trArc}
            style={vars({ "--d": `${-i * 0.7}s` })}
          >
            <path
              d={d}
              fill="none"
              stroke="#5cc8ff"
              strokeWidth="16"
              opacity="0.2"
              strokeLinejoin="round"
            />
            <path
              d={d}
              fill="none"
              stroke="#7fd8ff"
              strokeWidth="5"
              opacity="0.45"
              strokeLinejoin="round"
            />
            <path
              d={d}
              fill="none"
              stroke="#effaff"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </g>
        ))}
        <g transform="translate(1290 540)">
          <circle r="150" fill="url(#tr-arc)" opacity="0.5" />
          <g className={styles.trRing}>
            <circle
              r="110"
              fill="none"
              stroke="#5cc8ff"
              strokeWidth="5"
              strokeDasharray="120 50 40 60"
              opacity="0.85"
            />
            <circle
              r="94"
              fill="none"
              stroke="#bfe9ff"
              strokeWidth="1.5"
              strokeDasharray="20 14"
              opacity="0.6"
            />
          </g>
        </g>
      </Layer>
      {particles(12, 102, styles.mote, {
        x: [10, 80],
        y: [60, 100],
        size: [2, 4],
        dur: [10, 18],
        dy: [-300, -160],
        op: [0.4, 0.8],
      })}
      <Layer depth="near">
        <path
          d="M-40 1120V780L120 770L300 800L420 790L520 840L560 1120Z"
          fill="#060a12"
        />
        <path
          d="M-40 780L120 770L300 800L420 790L520 840"
          fill="none"
          stroke="#4a7ab0"
          strokeWidth="2"
          opacity="0.5"
        />
        <g stroke="#060a12" strokeWidth="8">
          <path d="M60 770V600M200 780V560M60 640H200M60 700L200 620" />
        </g>
        <path
          d="M480 830Q520 960 500 1120M540 860Q600 980 620 1120"
          fill="none"
          stroke="#0a1220"
          strokeWidth="5"
        />
        <g stroke="#0a1220" strokeWidth="5">
          <path
            d="M260 800V740M330 806V746M400 798V738M470 820V760M240 742Q360 730 480 762"
            fill="none"
          />
        </g>
        <circle cx="60" cy="600" r="40" fill="url(#tr-arc)" opacity="0.7" />
        <circle cx="60" cy="600" r="5" fill="#bfe9ff" />
      </Layer>
    </>
  );
}

const PR_WORLDS = [
  {
    hue: "#f4f1e6",
    sky: ["#f6f2e4", "#bdb59a"],
    land: "#e2dbc2",
    sun: "#ffffff",
    ground: "M-60 14Q-30 0 0 10Q30 20 60 6V60H-60Z",
    detail: "M-20 10V-6M-17 10V-14M16 14V0",
  },
  {
    hue: "#6fb6ff",
    sky: ["#8ccaf2", "#2a5a9a"],
    land: "#173a6e",
    sun: "#e4f4ff",
    ground: "M-60 8H60V60H-60Z",
    detail: "M-30 8Q-18 -4 -6 8ZM14 8Q24 0 34 8Z",
  },
  {
    hue: "#a77ae8",
    sky: ["#3c2454", "#120a1c"],
    land: "#0b0612",
    sun: "#c4a2ff",
    ground: "M-60 18Q-20 6 0 16Q30 26 60 12V60H-60Z",
    detail: "M-26 16V-8M-26 -2L-34 -10M-26 2L-18 -6M20 18V-2M20 4L28 -4",
  },
  {
    hue: "#ff7a4a",
    sky: ["#f07a44", "#6a1a14"],
    land: "#2a0a08",
    sun: "#ffd2a0",
    ground: "M-60 20L-34 -6L-18 10L0 -14L18 8L36 -2L60 18V60H-60Z",
    detail: "M-2 -12L2 -12L6 -20L-6 -20Z",
  },
  {
    hue: "#7ad48a",
    sky: ["#b4e0a8", "#3a7a4a"],
    land: "#12301c",
    sun: "#f4ffe0",
    ground:
      "M-60 12Q-48 -2 -36 10Q-24 -4 -12 10Q0 -6 12 10Q24 -2 36 10Q48 -4 60 10V60H-60Z",
    detail: "",
  },
] as const;

/** 10. The prism observatory: five miniature worlds orbit a fractured silver prism. */
function Prism(): JSX.Element {
  return (
    <>
      <Defs>
        <Rad
          id="pr-bg"
          cy={0.32}
          s={[
            [0, "#1b1f38"],
            [0.5, "#0c0e1c"],
            [1, "#05060c"],
          ]}
        />
        <Rad
          id="pr-glow"
          s={[
            [0, "#eef2ff", 0.5],
            [0.3, "#b8c4ff", 0.16],
            [1, "#b8c4ff", 0],
          ]}
        />
        <Lin
          id="pr-face1"
          x2={1}
          s={[
            [0, "#f4f7ff"],
            [1, "#9aa6c8"],
          ]}
        />
        <Lin
          id="pr-face2"
          x2={1}
          s={[
            [0, "#7a86a8"],
            [1, "#363e5a"],
          ]}
        />
        <Rad
          id="pr-shade"
          s={[
            [0, "#000", 0],
            [0.7, "#000", 0.1],
            [1, "#000", 0.6],
          ]}
        />
        <clipPath id="pr-clip">
          <circle r="54" />
        </clipPath>
        {PR_WORLDS.map((w, i) => (
          <g key={i}>
            <Lin
              id={`pr-sky${i}`}
              s={[
                [0, w.sky[0]],
                [1, w.sky[1]],
              ]}
            />
            <Rad
              id={`pr-halo${i}`}
              s={[
                [0, w.hue, 0.32],
                [1, w.hue, 0],
              ]}
            />
          </g>
        ))}
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#pr-bg)" />
        <path
          d={dots(120, 111, [0, 0, 1920, 700], [0.5, 1.5])}
          fill="#dfe6ff"
          opacity="0.5"
        />
        <g fill="none" stroke="#8a96c0" strokeWidth="2" opacity="0.18">
          <ellipse
            cx="960"
            cy="330"
            rx="820"
            ry="250"
            transform="rotate(-8 960 330)"
          />
          <ellipse
            cx="960"
            cy="330"
            rx="760"
            ry="520"
            transform="rotate(24 960 330)"
          />
          <ellipse
            cx="960"
            cy="330"
            rx="900"
            ry="160"
            transform="rotate(6 960 330)"
          />
        </g>
      </Layer>
      <Layer depth="far">
        <circle
          cx="960"
          cy="300"
          r="380"
          fill="url(#pr-glow)"
          className={styles.prBreathe}
        />
        <ellipse
          cx="960"
          cy="320"
          rx="640"
          ry="170"
          fill="none"
          stroke="#c8d2f0"
          strokeWidth="1.5"
          opacity="0.25"
          strokeDasharray="4 10"
        />
        <g opacity="0.07">
          {PR_WORLDS.map((w, i) => (
            <path
              key={i}
              d={`M960 330L${n1(960 + Math.cos(0.5 + i * 0.55) * 1100)} ${n1(330 + Math.sin(0.5 + i * 0.55) * 900)}L${n1(960 + Math.cos(0.62 + i * 0.55) * 1100)} ${n1(330 + Math.sin(0.62 + i * 0.55) * 900)}Z`}
              fill={w.hue}
            />
          ))}
        </g>
      </Layer>
      <Layer depth="mid">
        {PR_WORLDS.map((w, i) => (
          <g key={i} transform="translate(960 320)">
            <g
              className={styles.prOrbitX}
              style={vars({
                "--d": `${-i * 16}s`,
                "--bx": `${n1(-640 * Math.cos((Math.PI * i * 16) / 40))}px`,
              })}
            >
              <g
                className={styles.prOrbitY}
                style={vars({
                  "--d": `${-i * 16 - 20}s`,
                  "--by": `${n1(-160 * Math.cos((Math.PI * (i * 16 + 20)) / 40))}px`,
                  "--bs":
                    n1(
                      (0.68 +
                        0.2 * (1 - Math.cos((Math.PI * (i * 16 + 20)) / 40))) *
                        100,
                    ) / 100,
                })}
              >
                <circle r="96" fill={`url(#pr-halo${i})`} />
                <g clipPath="url(#pr-clip)">
                  <rect
                    x="-60"
                    y="-60"
                    width="120"
                    height="120"
                    fill={`url(#pr-sky${i})`}
                  />
                  <circle cx="18" cy="-18" r="10" fill={w.sun} opacity="0.9" />
                  <path d={w.ground} fill={w.land} />
                  {w.detail && (
                    <path
                      d={w.detail}
                      fill={w.land}
                      stroke={w.land}
                      strokeWidth="3"
                    />
                  )}
                  <circle r="54" fill="url(#pr-shade)" />
                </g>
                <circle
                  r="54"
                  fill="none"
                  stroke={w.hue}
                  strokeWidth="2"
                  opacity="0.8"
                />
                <path
                  d="M-40 -30A50 50 0 0 1 -6 -50"
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="3"
                  opacity="0.4"
                  strokeLinecap="round"
                />
              </g>
            </g>
          </g>
        ))}
        <path
          d="M960 150L1022 240L1000 440L960 470L920 440L898 240Z"
          fill="url(#pr-face2)"
        />
        <path
          d="M960 150L1022 240L1000 440L960 470Z"
          fill="url(#pr-face1)"
          opacity="0.9"
        />
        <path
          d="M960 150L898 240L960 270L1022 240Z"
          fill="#ffffff"
          opacity="0.55"
        />
        <path
          d="M960 150V470M898 240L960 270L1022 240"
          fill="none"
          stroke="#ffffff"
          strokeWidth="1.5"
          opacity="0.5"
        />
        <path
          d="M940 200L962 260L944 300L976 360L958 420M962 260L1000 290M976 360L1004 380"
          fill="none"
          stroke="#2a3150"
          strokeWidth="2.5"
        />
        <g className={styles.prShard}>
          <path
            d="M1046 300L1070 330L1056 392L1034 350Z"
            fill="url(#pr-face1)"
            opacity="0.85"
          />
        </g>
      </Layer>
      {particles(15, 112, styles.prMote, {
        x: [20, 80],
        y: [10, 70],
        size: [2, 4],
        dur: [9, 16],
        op: [0.5, 0.9],
      })}
      <Layer depth="near">
        <ellipse cx="960" cy="1060" rx="900" ry="230" fill="#070811" />
        <ellipse
          cx="960"
          cy="1060"
          rx="900"
          ry="230"
          fill="none"
          stroke="#4a5280"
          strokeWidth="2"
          opacity="0.4"
        />
        <ellipse
          cx="960"
          cy="1070"
          rx="640"
          ry="150"
          fill="none"
          stroke="#4a5280"
          strokeWidth="1.5"
          opacity="0.25"
        />
      </Layer>
    </>
  );
}

/** A row of the faceless audience behind a gallery rail; some of them applaud. */
function Audience(props: {
  x: number;
  y: number;
  n: number;
  s: number;
  seed: number;
  dim?: boolean;
}): JSX.Element {
  const rand = prng(props.seed);
  const people: JSX.Element[] = [];
  for (let i = 0; i < props.n; i++) {
    const x = props.x + i * 70 * props.s + (rand() - 0.5) * 14;
    const y = props.y + (rand() - 0.5) * 8;
    const claps = !props.dim && rand() < 0.6;
    people.push(
      <g key={i} transform={`translate(${n1(x)} ${n1(y)}) scale(${props.s})`}>
        <path d="M-32 40Q-30 -4 0 -8Q30 -4 32 40Z" fill="#1a1226" />
        <ellipse
          cx="0"
          cy="-28"
          rx="15"
          ry="19"
          fill="#bfb0d6"
          opacity={props.dim ? 0.22 : 0.42}
        />
        <path
          d="M-16 -28Q-17 -50 0 -50Q17 -50 16 -28Q11 -42 0 -42Q-11 -42 -16 -28Z"
          fill="#1a1226"
        />
        {claps && (
          <g
            className={styles.nmClap}
            style={vars({ "--d": `${-n1(rand() * 0.8)}s` })}
          >
            <ellipse
              cx="-12"
              cy="-2"
              rx="6"
              ry="9"
              fill="#bfb0d6"
              opacity="0.5"
              transform="rotate(-20 -12 -2)"
            />
            <ellipse
              cx="12"
              cy="-2"
              rx="6"
              ry="9"
              fill="#bfb0d6"
              opacity="0.5"
              transform="rotate(20 12 -2)"
            />
          </g>
        )}
      </g>,
    );
  }
  return <g>{people}</g>;
}

/** The backs of the nearest audience, at the bottom corners. */
function Backs(props: { x: number; n: number; seed: number }): JSX.Element {
  const rand = prng(props.seed);
  return (
    <g fill="#08050c" stroke="#7a5aa8" strokeWidth="2" strokeOpacity="0.45">
      {Array.from({ length: props.n }, (_, i) => {
        const x = props.x + i * 110 + rand() * 20;
        const y = 930 + rand() * 30;
        return (
          <path
            key={i}
            d={`M${n1(x - 60)} 1120Q${n1(x - 58)} ${n1(y + 50)} ${n1(x - 20)} ${n1(y + 40)}A26 30 0 1 1 ${n1(x + 20)} ${n1(y + 40)}Q${n1(x + 58)} ${n1(y + 50)} ${n1(x + 60)} 1120Z`}
          />
        );
      })}
    </g>
  );
}

/** 11. The nightmare archive: rooms warped out of true, a faceless crowd, violet smoke. */
function Nightmare(): JSX.Element {
  const books = (rows: number, seed: number): JSX.Element[] => {
    const rand = prng(seed);
    const out: JSX.Element[] = [];
    for (let r = 0; r < rows; r++) {
      let x = 12;
      while (x < 270) {
        const w = 10 + rand() * 14;
        const h = 56 + rand() * 30;
        const lean = rand() < 0.12 ? 10 + rand() * 12 : 0;
        const base = r * 112 + 104;
        out.push(
          <rect
            key={`${r}-${n1(x)}`}
            x={n1(x)}
            y={n1(base - h)}
            width={n1(w)}
            height={n1(h)}
            fill={rand() < 0.5 ? "#2a1c3c" : "#221632"}
            stroke="#5a4478"
            strokeWidth="1"
            strokeOpacity="0.5"
            transform={
              lean ? `rotate(${n1(lean)} ${n1(x + w)} ${base})` : undefined
            }
          />,
        );
        x += w + 2 + (lean ? 8 : 0);
      }
    }
    return out;
  };
  return (
    <>
      <Defs>
        <Lin
          id="nm-bg"
          s={[
            [0, "#06040b"],
            [0.5, "#180e24"],
            [1, "#08050d"],
          ]}
        />
        <Rad
          id="nm-violet"
          s={[
            [0, "#9a6ae0", 0.42],
            [0.5, "#6a3ab0", 0.12],
            [1, "#6a3ab0", 0],
          ]}
        />
        <Rad
          id="nm-smoke"
          s={[
            [0, "#76628f", 0.4],
            [1, "#76628f", 0],
          ]}
        />
        <Lin
          id="nm-spot"
          s={[
            [0, "#c9a8ff", 0.16],
            [1, "#c9a8ff", 0],
          ]}
        />
        <Lin
          id="nm-door"
          s={[
            [0, "#e8dcff"],
            [1, "#8a62d0"],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#nm-bg)" />
        <ellipse cx="960" cy="330" rx="720" ry="440" fill="url(#nm-violet)" />
      </Layer>
      <Layer depth="far" className={styles.nmWarp}>
        {[0, 1, 2, 3, 4, 5, 6].map((k) => {
          const f = 0.78 ** k;
          return (
            <rect
              key={k}
              x={n1(960 - 300 * f)}
              y={n1(330 - 250 * f)}
              width={n1(600 * f)}
              height={n1(560 * f)}
              transform={`rotate(${k * 4 - 6} 960 330) skewX(${k % 2 ? 4 : -3})`}
              fill={k === 6 ? "url(#nm-door)" : "#140c1e"}
              fillOpacity={k === 6 ? 0.55 : 0.5}
              stroke="#5e4882"
              strokeWidth={n1(6 * f + 1.5)}
              opacity={n1(0.9 - k * 0.06)}
            />
          );
        })}
        <g transform="translate(150 180) skewY(-12) rotate(-5)">
          <path d="M300 0L340 -30V540L300 560Z" fill="#1a1028" />
          <rect
            x="0"
            y="0"
            width="300"
            height="560"
            fill="#100a18"
            stroke="#4e3a6c"
            strokeWidth="5"
          />
          {[0, 1, 2, 3, 4].map((r) => (
            <path
              key={r}
              d={`M0 ${r * 112 + 104}H300`}
              stroke="#4e3a6c"
              strokeWidth="6"
            />
          ))}
          {books(5, 131)}
        </g>
        <g fill="#2a1c3c" stroke="#5a4478" strokeWidth="1">
          <rect
            x="520"
            y="230"
            width="18"
            height="70"
            transform="rotate(38 529 265)"
          />
          <rect
            x="580"
            y="330"
            width="16"
            height="62"
            transform="rotate(-24 588 361)"
          />
        </g>
        <g transform="translate(1420 220) rotate(7)">
          <rect
            x="0"
            y="80"
            width="190"
            height="380"
            fill="#0c0714"
            stroke="#5e4882"
            strokeWidth="6"
          />
          <path
            d="M8 88V452L120 420V120Z"
            fill="url(#nm-door)"
            opacity="0.28"
          />
          <path
            d="M120 120L176 80V470L120 420Z"
            fill="#1c122a"
            stroke="#5e4882"
            strokeWidth="3"
          />
          <circle
            cx="95"
            cy="0"
            r="54"
            fill="#140c1e"
            stroke="#7a5aa8"
            strokeWidth="5"
          />
          <circle
            cx="95"
            cy="0"
            r="40"
            fill="none"
            stroke="#7a5aa8"
            strokeWidth="1.5"
            strokeDasharray="2 10"
            opacity="0.7"
          />
        </g>
        <g transform="skewY(-8)">
          {Array.from({ length: 8 }, (_, i) => i).map((i) => (
            <path
              key={i}
              d={`M${1180 + i * 62} ${860 - i * 52}h62v-14h-62Z`}
              fill="#24183a"
              stroke="#5e4882"
              strokeWidth="2"
            />
          ))}
        </g>
      </Layer>
      <Layer depth="mid" className={styles.nmDrift}>
        <ellipse cx="480" cy="580" rx="580" ry="150" fill="url(#nm-smoke)" />
        <ellipse cx="1480" cy="500" rx="620" ry="170" fill="url(#nm-smoke)" />
        <ellipse
          cx="960"
          cy="180"
          rx="720"
          ry="120"
          fill="url(#nm-smoke)"
          opacity="0.6"
        />
      </Layer>
      <Layer depth="mid">
        <path d="M860 -40H1060L1260 1000H660Z" fill="url(#nm-spot)" />
        <ellipse
          cx="960"
          cy="900"
          rx="320"
          ry="40"
          fill="#c9a8ff"
          opacity="0.06"
        />
        <Audience x={20} y={310} n={7} s={0.8} seed={121} dim />
        <Audience x={1440} y={310} n={7} s={0.8} seed={122} dim />
        <Audience x={-10} y={392} n={7} s={1} seed={123} />
        <Audience x={1480} y={392} n={7} s={1} seed={124} />
        <path
          d="M-40 420H500L520 470H-40ZM1960 420H1420L1400 470H1960Z"
          fill="#1c1228"
        />
        <path
          d="M-40 420H500M1960 420H1420"
          stroke="#9a78cc"
          strokeWidth="2.5"
          opacity="0.6"
        />
        <g fill="#140c1e">
          {[
            30, 110, 190, 270, 350, 430, 1490, 1570, 1650, 1730, 1810, 1890,
          ].map((x) => (
            <rect key={x} x={x - 6} y="470" width="12" height="60" />
          ))}
        </g>
        <path d="M-40 530H500M1960 530H1420" stroke="#4e3a6c" strokeWidth="6" />
      </Layer>
      {particles(12, 125, styles.mote, {
        x: [5, 95],
        y: [40, 95],
        size: [2, 5],
        dur: [12, 20],
        dy: [-260, -120],
        op: [0.3, 0.7],
      })}
      <Layer depth="near">
        <Backs x={40} n={4} seed={126} />
        <Backs x={1550} n={4} seed={127} />
      </Layer>
      <Layer depth="near" className={styles.nmDrift}>
        <ellipse cx="220" cy="1010" rx="560" ry="150" fill="url(#nm-smoke)" />
        <ellipse cx="1700" cy="990" rx="560" ry="150" fill="url(#nm-smoke)" />
      </Layer>
    </>
  );
}

const AM_KNIGHT =
  "M14 -101a11 13 0 1 0 0.1 0ZM2 -78Q22 -82 30 -64L32 -40Q20 -34 4 -36Q-4 -56 2 -78ZM8 -82a13 9 0 1 0 26 0a13 9 0 1 0 -26 0ZM6 -40L42 -38L44 -26L8 -24ZM34 -30H45L43 0H32ZM4 -32L-32 -8L-30 0L10 -14ZM50 -66H54V4H50ZM42 -60H62V-56H42ZM24 -66L50 -60V-54L26 -56Z";

/** 12. The conquest amphitheater: basalt tiers, red banners, rows of empty armor kneeling. */
function Amphitheater(): JSX.Element {
  const tiers = [0, 1, 2, 3, 4, 5];
  const row = (side: 1 | -1): JSX.Element[] =>
    [0, 1, 2, 3, 4, 5].map((k) => {
      const t = k / 5;
      const x = 960 - side * mix(860, 330, t);
      const y = mix(930, 690, t);
      const s = mix(1.5, 0.5, t);
      return (
        <use
          key={`${side}${k}`}
          href="#am-knight"
          transform={`translate(${n1(x)} ${n1(y)}) scale(${n1(side * s * 10) / 10} ${n1(s * 10) / 10})`}
        />
      );
    });
  return (
    <>
      <Defs>
        <Lin
          id="am-sky"
          s={[
            [0, "#060303"],
            [0.45, "#1c0909"],
            [0.62, "#3a1410"],
            [1, "#100505"],
          ]}
        />
        <Rad
          id="am-sun"
          s={[
            [0, "#ff8a5a", 0.45],
            [0.35, "#c8443a", 0.16],
            [1, "#c8443a", 0],
          ]}
        />
        <Lin
          id="am-banner"
          s={[
            [0, "#9c2a24"],
            [1, "#420c0a"],
          ]}
        />
        <Lin
          id="am-sand"
          s={[
            [0, "#2a1a14"],
            [1, "#0a0605"],
          ]}
        />
        <Rad
          id="am-step"
          s={[
            [0, "#c89a7a", 0.5],
            [1, "#c89a7a", 0],
          ]}
        />
        <path
          id="am-knight"
          d={AM_KNIGHT}
          fill="#0d0a0a"
          stroke="#c8443a"
          strokeWidth="1.2"
          strokeOpacity="0.55"
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#am-sky)" />
        <circle cx="960" cy="260" r="460" fill="url(#am-sun)" />
        <circle cx="960" cy="260" r="58" fill="#c0503a" opacity="0.45" />
        <g fill="#0c0505" opacity="0.6">
          <ellipse cx="760" cy="240" rx="460" ry="16" />
          <ellipse cx="1220" cy="300" rx="420" ry="12" />
        </g>
      </Layer>
      <Layer depth="far">
        {tiers.map((k) => (
          <path
            key={k}
            d={`M${-100 + k * 70} 720A${1060 - k * 70} ${330 - k * 36} 0 0 1 ${2020 - k * 70} 720Z`}
            fill={k % 2 ? "#151010" : "#1d1616"}
          />
        ))}
        {tiers.map((k) => (
          <path
            key={`e${k}`}
            d={`M${-100 + k * 70} 720A${1060 - k * 70} ${330 - k * 36} 0 0 1 ${2020 - k * 70} 720`}
            fill="none"
            stroke="#5a2a24"
            strokeWidth="2"
            opacity="0.5"
          />
        ))}
        <g fill="#0e0909">
          {Array.from({ length: 23 }, (_, i) => i).map((i) => {
            const a = Math.PI + (i / 22) * Math.PI;
            const x = 960 + Math.cos(a) * 1060;
            const y = 720 + Math.sin(a) * 330;
            return (
              <rect
                key={i}
                x={n1(x - 9)}
                y={n1(y - 60)}
                width="18"
                height="64"
              />
            );
          })}
        </g>
        {[300, 560, 1360, 1620].map((x, i) => {
          const y =
            720 - Math.sqrt(Math.max(0, 1 - ((x - 960) / 1060) ** 2)) * 330;
          return (
            <g
              key={x}
              className={styles.amBanner}
              style={vars({ "--d": `${-i * 1.6}s` })}
            >
              <path
                d={`M${x - 34} ${n1(y - 50)}H${x + 34}V${n1(y + 170)}L${x} ${n1(y + 146)}L${x - 34} ${n1(y + 170)}Z`}
                fill="url(#am-banner)"
              />
              <path
                d={`M${x} ${n1(y + 10)}l18 18l-18 30l-18 -30Z M${x - 20} ${n1(y + 74)}h40`}
                fill="#160606"
                stroke="#160606"
                strokeWidth="4"
              />
            </g>
          );
        })}
        <path d="M-40 1120V700Q960 640 1960 700V1120Z" fill="url(#am-sand)" />
        <g className={styles.amSteps}>
          {[0, 1, 2, 3, 4, 5].map((k) => (
            <ellipse
              key={k}
              cx={760 + k * 80}
              cy={700 - (k % 2) * 8}
              rx="26"
              ry="5"
              fill="url(#am-step)"
              style={vars({ "--i": k })}
              className={styles.amStep}
            />
          ))}
        </g>
      </Layer>
      <Layer depth="mid">
        {row(1)}
        {row(-1)}
      </Layer>
      {particles(14, 131, styles.ember, {
        x: [0, 100],
        y: [30, 95],
        size: [2, 4],
        dur: [12, 20],
        dx: [-60, 60],
        dy: [-260, -140],
        op: [0.3, 0.7],
      })}
      <Layer depth="near">
        <path
          d="M-40 1120V1000Q300 960 600 1010L640 1120ZM1960 1120V1000Q1620 960 1320 1010L1280 1120Z"
          fill="#070404"
        />
      </Layer>
    </>
  );
}

const GL_BUSTS = [
  "M8 130Q12 96 36 88H64Q88 96 92 130ZM50 40a16 20 0 1 0 0.1 0ZM36 48Q24 30 18 12Q30 24 38 36ZM64 48Q76 30 82 12Q70 24 62 36Z",
  "M8 130Q12 96 36 88H64Q88 96 92 130ZM50 40a16 20 0 1 0 0.1 0ZM28 92Q26 50 50 26Q74 50 72 92Z",
  "M8 130Q12 96 36 88H64Q88 96 92 130ZM50 40a16 20 0 1 0 0.1 0ZM34 44L36 28L42 36L50 24L58 36L64 28L66 44Z",
  "M8 130Q12 96 36 88H64Q88 96 92 130ZM50 40a16 20 0 1 0 0.1 0ZM32 96Q28 60 34 46Q50 30 66 46Q72 60 68 96Z",
  "M8 130Q12 96 36 88H64Q88 96 92 130ZM34 70V46Q34 34 50 32Q66 34 66 46V70ZM50 32V14",
];

/** A platinum frame on its chain, holding the dim shape of a bound champion. */
function Portrait(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  skew: number;
  bust: number;
  d: number;
}): JSX.Element {
  const { x, y, w, h } = props;
  return (
    <g transform={`translate(${x} ${y}) skewY(${props.skew})`}>
      <path
        d={`M${w * 0.2} -900L${w / 2} ${-h * 0.12}L${w * 0.8} -900`}
        fill="none"
        stroke="#8a929e"
        strokeWidth={n1(w / 60)}
        strokeDasharray={`${n1(w / 22)} ${n1(w / 50)}`}
        opacity="0.7"
      />
      <g className={styles.glSway} style={vars({ "--d": `${props.d}s` })}>
        <rect
          x={-w * 0.06}
          y={-h * 0.05}
          width={w * 1.12}
          height={h * 1.1}
          fill="none"
          stroke="url(#gl-plat)"
          strokeWidth={n1(w / 14)}
        />
        <rect x="0" y="0" width={w} height={h} fill="url(#gl-canvas)" />
        <path
          d={GL_BUSTS[props.bust]}
          transform={`translate(${n1(w * 0.12)} ${n1(h * 0.18)}) scale(${n1(((w * 0.76) / 100) * 100) / 100} ${n1(((h * 0.8) / 130) * 100) / 100})`}
          fill="#2a313c"
          stroke="#aeb8c8"
          strokeWidth="1"
          strokeOpacity="0.14"
        />
        <rect
          x="0"
          y="0"
          width={w}
          height={h}
          fill="none"
          stroke="#d8dde6"
          strokeWidth="1"
          opacity="0.35"
        />
      </g>
    </g>
  );
}

/** 13. The gallery of bound champions: empty frames on platinum chains, black marble. */
function Gallery(): JSX.Element {
  const veins = (seed: number): string => {
    const rand = prng(seed);
    let d = "";
    for (let i = 0; i < 9; i++) {
      let x = rand() * 1920;
      let y = rand() * 700;
      d += `M${n1(x)} ${n1(y)}`;
      for (let k = 0; k < 6; k++) {
        x += 40 + rand() * 90;
        y += (rand() - 0.4) * 80;
        d += `L${n1(x)} ${n1(y)}`;
      }
    }
    return d;
  };
  return (
    <>
      <Defs>
        <Lin
          id="gl-wall"
          s={[
            [0, "#08090b"],
            [1, "#131519"],
          ]}
        />
        <Lin
          id="gl-plat"
          x2={1}
          y2={1}
          s={[
            [0, "#f4f6fa"],
            [0.35, "#9aa2ae"],
            [0.6, "#5a616c"],
            [1, "#dce1ea"],
          ]}
        />
        <Rad
          id="gl-canvas"
          s={[
            [0, "#20252e"],
            [1, "#090a0d"],
          ]}
        />
        <Lin
          id="gl-shaft"
          s={[
            [0, "#e2e9f4", 0.16],
            [1, "#e2e9f4", 0],
          ]}
        />
        <Lin
          id="gl-floor"
          s={[
            [0, "#14161b"],
            [1, "#040405"],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#gl-wall)" />
        <path d="M700 250H1220V700H700Z" fill="#0d0e11" />
        <path
          d={veins(141)}
          fill="none"
          stroke="#a8b0bc"
          strokeWidth="1.2"
          opacity="0.1"
        />
        <path
          d="M-40 -40L700 250V700L-40 1120ZM1960 -40L1220 250V700L1960 1120Z"
          fill="#0a0b0e"
        />
        <path
          d="M700 250V700M1220 250V700M-40 -40L700 250M1960 -40L1220 250"
          stroke="#2a2f38"
          strokeWidth="3"
        />
        <path d="M-40 1120L700 700H1220L1960 1120Z" fill="url(#gl-floor)" />
        <g stroke="#1e222a" strokeWidth="2">
          <path d="M760 700L300 1120M860 700L740 1120M960 700V1120M1060 700L1180 1120M1160 700L1620 1120M500 840H1420M300 950H1620" />
        </g>
        <ellipse
          cx="960"
          cy="760"
          rx="220"
          ry="26"
          fill="#d8dde6"
          opacity="0.06"
        />
      </Layer>
      <Layer depth="far">
        <g className={styles.glShafts}>
          <path d="M840 -40H1080L1180 1080H740Z" fill="url(#gl-shaft)" />
          <path
            d="M230 -40H390L520 1080H180Z"
            fill="url(#gl-shaft)"
            opacity="0.7"
          />
          <path
            d="M1530 -40H1690L1740 1080H1400Z"
            fill="url(#gl-shaft)"
            opacity="0.7"
          />
        </g>
        <Portrait x={890} y={330} w={140} h={176} skew={0} bust={4} d={-2} />
        <Portrait x={600} y={330} w={70} h={96} skew={21} bust={2} d={-1} />
        <Portrait x={1250} y={354} w={70} h={96} skew={-21} bust={3} d={-3.3} />
      </Layer>
      <Layer depth="mid">
        <Portrait x={70} y={250} w={240} h={310} skew={16} bust={0} d={0} />
        <Portrait x={410} y={300} w={140} h={186} skew={19} bust={1} d={-2.5} />
        <Portrait
          x={1610}
          y={320}
          w={240}
          h={310}
          skew={-16}
          bust={3}
          d={-1.2}
        />
        <Portrait
          x={1370}
          y={346}
          w={140}
          h={186}
          skew={-19}
          bust={4}
          d={-3.7}
        />
      </Layer>
      {particles(12, 142, styles.mote, {
        x: [40, 60],
        y: [5, 80],
        size: [1.5, 3],
        dur: [14, 24],
        dy: [80, 160],
        op: [0.3, 0.6],
      })}
      <Layer depth="near">
        <path
          d="M-40 1120V960L200 920L260 1120ZM1960 1120V960L1720 920L1660 1120Z"
          fill="#040405"
        />
      </Layer>
    </>
  );
}

/** 14. The counterfeit citadel: an Amonkhet-like throne built of panels under a painted triumph. */
function Citadel(): JSX.Element {
  const rays = Array.from({ length: 18 }, (_, i) => (i / 18) * Math.PI * 2);
  const obelisk = (x: number, top: number, w: number): JSX.Element => (
    <g>
      <path
        d={`M${x - w / 2} 820L${x - w * 0.34} ${top + w * 0.6}H${x + w * 0.34}L${x + w / 2} 820Z`}
        fill="url(#ct-stone)"
      />
      <path
        d={`M${x - w * 0.34} ${top + w * 0.6}L${x} ${top}L${x + w * 0.34} ${top + w * 0.6}Z`}
        fill="url(#ct-gold)"
      />
      <g stroke="#0c0804" strokeWidth="2.5">
        {[0.25, 0.45, 0.65, 0.82].map((f) => (
          <path
            key={f}
            d={`M${n1(x - w * mix(0.34, 0.5, f))} ${n1(mix(top + w * 0.6, 820, f))}H${n1(x + w * mix(0.34, 0.5, f))}`}
          />
        ))}
      </g>
      <path
        d={`M${x - w * 0.34} ${top + w * 0.6}L${x - w / 2} 820`}
        stroke="#e8c26a"
        strokeWidth="2"
        opacity="0.4"
      />
    </g>
  );
  return (
    <>
      <Defs>
        <Lin
          id="ct-sky"
          s={[
            [0, "#0e0a06"],
            [0.4, "#2a1d0c"],
            [0.68, "#5a3a14"],
            [0.8, "#3e280e"],
            [1, "#140c05"],
          ]}
        />
        <radialGradient
          id="ct-rayfade"
          gradientUnits="userSpaceOnUse"
          cx="0"
          cy="0"
          r="1300"
        >
          {stops([
            [0, "#ffe3a0", 0.2],
            [0.5, "#ffe3a0", 0.07],
            [1, "#ffe3a0", 0],
          ])}
        </radialGradient>
        <Lin
          id="ct-ray"
          s={[
            [0, "#ffe3a0", 0.18],
            [1, "#ffe3a0", 0],
          ]}
        />
        <Rad
          id="ct-sun"
          s={[
            [0, "#fff1c4", 0.8],
            [0.2, "#f2c66d", 0.36],
            [1, "#f2c66d", 0],
          ]}
        />
        <Lin
          id="ct-stone"
          x2={1}
          y2={0}
          s={[
            [0, "#3a2c1a"],
            [0.5, "#241a0e"],
            [1, "#140e07"],
          ]}
        />
        <Lin
          id="ct-gold"
          s={[
            [0, "#fff1c4"],
            [0.5, "#d9ae5a"],
            [1, "#7a5a28"],
          ]}
        />
        <Lin
          id="ct-sand"
          s={[
            [0, "#4a3218"],
            [1, "#100a04"],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#ct-sky)" />
        <g transform="translate(960 400)">
          <g className={styles.ctRays} fill="url(#ct-rayfade)">
            {rays.map((a) => (
              <path
                key={a}
                d={`M0 0L${n1(Math.cos(a - 0.05) * 1300)} ${n1(Math.sin(a - 0.05) * 1300)}L${n1(Math.cos(a + 0.05) * 1300)} ${n1(Math.sin(a + 0.05) * 1300)}Z`}
              />
            ))}
          </g>
        </g>
        <circle cx="960" cy="400" r="400" fill="url(#ct-sun)" />
        <g stroke="#140c04" strokeWidth="3" opacity="0.55">
          {[240, 480, 720, 960, 1200, 1440, 1680].map((x) => (
            <path key={x} d={`M${x} -40V760`} />
          ))}
          {[160, 340, 520, 700].map((y) => (
            <path key={y} d={`M-40 ${y}H1960`} />
          ))}
        </g>
        <path
          d={dots(
            70,
            151,
            [0, 0, 1920, 760],
            [2, 2.6],
            (x, y) =>
              Math.abs((x % 240) - 0) < 8 &&
              Math.abs(((y - 160) % 180) - 0) < 8,
          )}
          fill="#8a6a3a"
        />
        <rect
          x="1440"
          y="0"
          width="240"
          height="160"
          fill="#2a1c0c"
          opacity="0.6"
          transform="translate(6 4)"
        />
        <path d="M1680 160L1620 160L1680 100Z" fill="#090604" />
        <path
          d="M1620 160L1680 100"
          stroke="#e8c26a"
          strokeWidth="2"
          opacity="0.5"
        />
        <path d="M1640 160L1660 130" stroke="#3a2a14" strokeWidth="3" />
        <rect
          x="240"
          y="340"
          width="240"
          height="180"
          fill="#f2c66d"
          className={styles.ctFlicker}
        />
      </Layer>
      <Layer depth="far">
        <path
          d="M-40 800Q300 720 640 760Q900 790 1180 750Q1500 710 1960 780V1120H-40Z"
          fill="#2a1c0c"
        />
        <path
          d="M640 760L640 800M1180 750L1180 800"
          stroke="#120c05"
          strokeWidth="3"
        />
        {obelisk(600, 420, 50)}
        {obelisk(1320, 430, 50)}
        <path
          d="M1590 220L1640 820M1640 300L1590 400L1640 500L1590 600L1640 700"
          stroke="#2a1d0e"
          strokeWidth="6"
          fill="none"
        />
        {obelisk(330, 150, 96)}
        {obelisk(1590, 150, 96)}
      </Layer>
      <Layer depth="mid">
        <path d="M700 800L740 720H1180L1220 800Z" fill="#1e150b" />
        <g stroke="#e8c26a" strokeWidth="1.5" opacity="0.35">
          {[730, 740, 750, 760, 770, 780, 790].map((y) => (
            <path
              key={y}
              d={`M${n1(740 - (y - 720) * 0.5)} ${y}H${n1(1180 + (y - 720) * 0.5)}`}
            />
          ))}
        </g>
        <path
          d="M800 720V420Q800 330 812 250L830 214L860 320H1060L1090 214L1108 250Q1120 330 1120 420V720Z"
          fill="url(#ct-stone)"
        />
        <path
          d={taper(
            bez([830, 226], [750, 196], [700, 150], [720, 72], 14),
            30,
            3,
          )}
          fill="url(#ct-gold)"
        />
        <path
          d={taper(
            bez([1090, 226], [1170, 196], [1220, 150], [1200, 72], 14),
            30,
            3,
          )}
          fill="url(#ct-gold)"
        />
        <path d="M860 320H1060V600H860Z" fill="#160f07" />
        <path
          d="M840 600H1080V640H840Z M780 560H860V720H780Z M1060 560H1140V720H1060Z"
          fill="#2a1d0e"
        />
        <path
          d="M780 560H860M1060 560H1140M840 600H1080"
          stroke="url(#ct-gold)"
          strokeWidth="5"
        />
        <path
          d="M960 330L990 380L960 430L930 380Z"
          fill="url(#ct-gold)"
          opacity="0.8"
        />
        <g stroke="#0a0603" strokeWidth="2.5">
          <path d="M800 480H1120M800 380H860M1060 380H1120M960 600V720M880 640V720M1040 640V720" />
        </g>
        <g fill="#c8a058">
          {[810, 850, 1070, 1110].map((x) => (
            <circle key={x} cx={x} cy="488" r="3" />
          ))}
        </g>
      </Layer>
      {particles(14, 152, styles.dust, {
        x: [-5, 90],
        y: [40, 90],
        size: [2, 4],
        dur: [12, 20],
        dx: [220, 380],
        dy: [-40, 20],
        op: [0.3, 0.6],
      })}
      <Layer depth="near">
        <path
          d="M-40 1120V940Q400 900 760 960Q1100 1010 1480 940Q1760 900 1960 930V1120Z"
          fill="url(#ct-sand)"
        />
        <g transform="rotate(-18 260 950)">
          <rect x="170" y="910" width="180" height="120" fill="#3a2a14" />
          <path
            d="M170 910H350"
            stroke="#e8c26a"
            strokeWidth="5"
            opacity="0.7"
          />
        </g>
        <g transform="rotate(12 1650 960)">
          <rect x="1580" y="930" width="150" height="90" fill="#2e2010" />
          <path
            d="M1580 930H1730M1580 960H1730"
            stroke="#0a0603"
            strokeWidth="2"
          />
        </g>
      </Layer>
    </>
  );
}

/** 15. The chamber of living names: black glass walls burning with violet script, one exit. */
function Names(): JSX.Element {
  const left = scriptWall(161, 0, -60, 1140, 2.2, 560, 180, 700, 1, 16, 3);
  const right = scriptWall(162, 1920, -60, 1140, 2.2, 1360, 180, 700, 1, 16, 3);
  const back = scriptWall(
    163,
    580,
    200,
    680,
    1,
    1340,
    200,
    680,
    1,
    11,
    3,
    (x) => x > 880 && x < 1040,
  );
  const groups = [...left, ...right, ...back];
  return (
    <>
      <Defs>
        <Lin
          id="nz-glass"
          s={[
            [0, "#05040a"],
            [1, "#0e0b16"],
          ]}
        />
        <Lin
          id="nz-side"
          x2={1}
          y2={0}
          s={[
            [0, "#0c0a14"],
            [1, "#060509"],
          ]}
        />
        <Lin
          id="nz-exit"
          s={[
            [0, "#e4d8ff"],
            [0.5, "#b49af0"],
            [1, "#6a4ab8"],
          ]}
        />
        <Rad
          id="nz-glow"
          s={[
            [0, "#dccbff", 0.5],
            [0.4, "#a678e8", 0.14],
            [1, "#a678e8", 0],
          ]}
        />
        <Lin
          id="nz-spill"
          s={[
            [0, "#c9b0ff", 0.28],
            [1, "#c9b0ff", 0],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#nz-glass)" />
        <path d="M-40 -60L560 180V700L-40 1140Z" fill="url(#nz-side)" />
        <path d="M1960 -60L1360 180V700L1960 1140Z" fill="url(#nz-side)" />
        <path d="M-40 1140L560 700H1360L1960 1140Z" fill="#050408" />
        <path
          d="M560 180V700M1360 180V700M560 180H1360M560 700H1360"
          stroke="#2a2240"
          strokeWidth="3"
        />
        <path
          d="M80 -40L380 1120M1840 -40L1540 1120"
          stroke="#ffffff"
          strokeWidth="60"
          opacity="0.025"
        />
        <path d="M860 700L1060 700L1300 1140L620 1140Z" fill="url(#nz-spill)" />
      </Layer>
      <Layer depth="far" className={styles.nzScript}>
        {groups.map((d, i) => (
          <g
            key={i}
            className={styles.nzFlicker}
            style={vars({ "--d": `${-n1((i * 1.37) % 5)}s` })}
          >
            <path
              d={d}
              fill="none"
              stroke="#a678e8"
              strokeWidth="5"
              opacity="0.18"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={styles.nzGlow}
            />
            <path
              d={d}
              fill="none"
              stroke="#c9a8ff"
              strokeWidth="1.6"
              opacity="0.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))}
      </Layer>
      <Layer depth="mid">
        <circle
          cx="960"
          cy="520"
          r="300"
          fill="url(#nz-glow)"
          className={styles.nzExitGlow}
        />
        <path
          d="M910 700V420A50 50 0 0 1 1010 420V700Z"
          fill="url(#nz-exit)"
          opacity="0.85"
        />
        <path
          d="M898 700V420A62 62 0 0 1 1022 420V700"
          fill="none"
          stroke="#3a2c5a"
          strokeWidth="10"
        />
      </Layer>
      <div className={styles.nzEmbers}>
        {particles(12, 164, styles.ember, {
          x: [3, 97],
          y: [20, 90],
          size: [2, 4],
          dur: [8, 14],
          dy: [-220, -120],
          op: [0.4, 0.9],
        })}
      </div>
    </>
  );
}

const TH_GEMS = ["#fbf6e6", "#7ab8ff", "#8a62b8", "#ff6a4a", "#5ad07a"];

/** A lens-shaped petal from (x, y) along angle a. */
function petal(
  x: number,
  y: number,
  a: number,
  len: number,
  w: number,
): string {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const mx = x + c * len * 0.55;
  const my = y + s * len * 0.55;
  return `M${n1(x)} ${n1(y)}Q${n1(mx - s * w)} ${n1(my + c * w)} ${n1(x + c * len)} ${n1(y + s * len)}Q${n1(mx + s * w)} ${n1(my - c * w)} ${n1(x)} ${n1(y)}Z`;
}

/** 16. The Sphinx's throne: five colours high on steps, windows onto saved worlds. */
function Throne(): JSX.Element {
  const windows: JSX.Element[] = [];
  for (let side = 0; side < 2; side++) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const x = side ? 1390 + c * 116 : 90 + c * 116;
        const y = 160 + r * 136;
        const g = (r * 4 + c + side * 2) % 5;
        windows.push(
          <g key={`${side}${r}${c}`}>
            <path
              d={`M${x} ${y + 88}V${y + 28}A32 28 0 0 1 ${x + 64} ${y + 28}V${y + 88}Z`}
              fill={`url(#th-w${g})`}
            />
            <path
              d={`M${x} ${y + 74}Q${x + 18} ${y + 60} ${x + 36} ${y + 70}T${x + 64} ${y + 66}V${y + 88}H${x}Z`}
              fill="#000"
              opacity="0.5"
            />
            <circle
              cx={x + 44}
              cy={y + 34}
              r="5"
              fill="#fff6dc"
              opacity="0.5"
            />
            <path
              d={`M${x} ${y + 88}V${y + 28}A32 28 0 0 1 ${x + 64} ${y + 28}V${y + 88}Z`}
              fill="none"
              stroke="#a88a50"
              strokeWidth="3"
            />
          </g>,
        );
      }
    }
  }
  const crackGroups = [
    crack(171, 960, 300, -1.9, 150, 6),
    crack(172, 960, 300, -1.2, 150, 6),
    crack(173, 960, 420, 1.7, 240, 7),
    crack(174, 920, 430, 2.5, 300, 8),
    crack(175, 1000, 430, 0.6, 300, 8),
    crack(176, 800, 300, 3.1, 560, 10),
    crack(177, 1120, 300, 0.05, 560, 10),
    crack(178, 760, 520, 2.8, 460, 9),
    crack(179, 1160, 520, 0.3, 460, 9),
  ];
  return (
    <>
      <Defs>
        <Rad
          id="th-bg"
          cy={0.28}
          s={[
            [0, "#3a2c14"],
            [0.45, "#140e06"],
            [1, "#060403"],
          ]}
        />
        <Rad
          id="th-halo"
          s={[
            [0, "#fff8e2", 0.8],
            [0.22, "#f4dca6", 0.42],
            [0.6, "#d5b77c", 0.1],
            [1, "#d5b77c", 0],
          ]}
        />
        <radialGradient
          id="th-ray"
          gradientUnits="userSpaceOnUse"
          cx="0"
          cy="0"
          r="820"
        >
          {stops([
            [0, "#fff1c4", 0.2],
            [0.6, "#fff1c4", 0.06],
            [1, "#fff1c4", 0],
          ])}
        </radialGradient>
        <Lin
          id="th-gold"
          s={[
            [0, "#fff3cf"],
            [0.5, "#e2c07a"],
            [1, "#8d6c3c"],
          ]}
        />
        <Lin
          id="th-back"
          s={[
            [0, "#fffaf0"],
            [0.45, "#f0d79c"],
            [1, "#a8823e"],
          ]}
        />
        <Lin
          id="th-step"
          s={[
            [0, "#221a0d"],
            [1, "#0a0805"],
          ]}
        />
        <Lin
          id="th-w0"
          s={[
            [0, "#e6e0cc"],
            [1, "#8a7e5c"],
          ]}
        />
        <Lin
          id="th-w1"
          s={[
            [0, "#7ab0dc"],
            [1, "#22406e"],
          ]}
        />
        <Lin
          id="th-w2"
          s={[
            [0, "#52366e"],
            [1, "#140a1e"],
          ]}
        />
        <Lin
          id="th-w3"
          s={[
            [0, "#d8784e"],
            [1, "#5a1a12"],
          ]}
        />
        <Lin
          id="th-w4"
          s={[
            [0, "#94c88c"],
            [1, "#245c32"],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#th-bg)" />
        <g className={styles.thWindows}>{windows}</g>
        <g fill="#1a1309">
          <rect x="610" y="-40" width="56" height="940" />
          <rect x="1254" y="-40" width="56" height="940" />
        </g>
        <path
          d="M610 -40V900M666 -40V900M1254 -40V900M1310 -40V900"
          stroke="#8d6c3c"
          strokeWidth="2"
          opacity="0.45"
        />
      </Layer>
      <Layer depth="far" className={styles.thRadiance}>
        <circle cx="960" cy="290" r="560" fill="url(#th-halo)" />
        <g transform="translate(960 290)">
          <g className={styles.thRays} fill="url(#th-ray)">
            {Array.from({ length: 24 }, (_, i) => (i / 24) * Math.PI * 2).map(
              (a) => (
                <path
                  key={a}
                  d={`M0 0L${n1(Math.cos(a - 0.03) * 820)} ${n1(Math.sin(a - 0.03) * 820)}L${n1(Math.cos(a + 0.03) * 820)} ${n1(Math.sin(a + 0.03) * 820)}Z`}
                />
              ),
            )}
          </g>
        </g>
      </Layer>
      <Layer depth="mid">
        {Array.from({ length: 12 }, (_, k) => k).map((k) => {
          const y = 478 + k * 34;
          const half = 180 + k * 48;
          return (
            <g key={k}>
              <rect
                x={960 - half}
                y={y}
                width={half * 2}
                height="34"
                fill="url(#th-step)"
              />
              <path
                d={`M${960 - half} ${y}H${960 + half}`}
                stroke="#e2c07a"
                strokeWidth="2"
                opacity={n1(0.42 - k * 0.03)}
              />
            </g>
          );
        })}
        <g className={styles.thSeat}>
          {TH_GEMS.map((c, i) => (
            <g key={c}>
              <path
                d={petal(
                  960,
                  262,
                  ((-90 + (i - 2) * 28) * Math.PI) / 180,
                  168 - Math.abs(i - 2) * 16,
                  24,
                )}
                fill={c}
                opacity="0.92"
              />
              <path
                d={petal(
                  960,
                  262,
                  ((-90 + (i - 2) * 28) * Math.PI) / 180,
                  168 - Math.abs(i - 2) * 16,
                  24,
                )}
                fill="none"
                stroke="#f4dca6"
                strokeWidth="2.5"
              />
            </g>
          ))}
          <path
            d="M876 478V262Q876 204 960 170Q1044 204 1044 262V478Z"
            fill="url(#th-back)"
          />
          <path
            d="M876 478V262Q876 204 960 170Q1044 204 1044 262V478"
            fill="none"
            stroke="#8d6c3c"
            strokeWidth="4"
          />
          <path
            d="M902 440V272Q902 228 960 202Q1018 228 1018 272V440Z"
            fill="#6a4e22"
            opacity="0.35"
          />
          <circle
            cx="960"
            cy="300"
            r="30"
            fill="none"
            stroke="#8d6c3c"
            strokeWidth="3"
          />
          {TH_GEMS.map((c, i) => (
            <circle
              key={c}
              cx={n1(960 + Math.cos(((i * 72 - 90) * Math.PI) / 180) * 30)}
              cy={n1(300 + Math.sin(((i * 72 - 90) * Math.PI) / 180) * 30)}
              r="7"
              fill={c}
              stroke="#8d6c3c"
              strokeWidth="1.5"
            />
          ))}
          <path
            d="M820 478V372H872V478ZM1048 478V372H1100V478Z"
            fill="#3a2a12"
          />
          <path
            d="M814 364H878V376H814ZM1042 364H1106V376H1042Z"
            fill="url(#th-gold)"
          />
          <circle
            cx="846"
            cy="392"
            r="11"
            fill="none"
            stroke="url(#th-gold)"
            strokeWidth="4"
          />
          <circle
            cx="1074"
            cy="392"
            r="11"
            fill="none"
            stroke="url(#th-gold)"
            strokeWidth="4"
          />
          <path d="M864 404H1056V430H864Z" fill="url(#th-gold)" />
          <path d="M872 430H1048V478H872Z" fill="#2a1f0e" />
          <path d="M790 470H1130V482H790Z" fill="url(#th-gold)" />
        </g>
      </Layer>
      <Layer depth="mid" className={styles.thCracks}>
        {crackGroups.map((d, i) => (
          <g key={i} className={styles.thCrack} style={vars({ "--i": i })}>
            <path
              d={d}
              fill="none"
              stroke="#ffd98a"
              strokeWidth="7"
              opacity="0.22"
              strokeLinejoin="round"
            />
            <path
              d={d}
              fill="none"
              stroke="#fff4d0"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </g>
        ))}
      </Layer>
      <div className={styles.thDark} />
      <div className={styles.thMotes}>
        {particles(14, 172, styles.mote, {
          x: [25, 75],
          y: [10, 75],
          size: [2, 4],
          dur: [10, 18],
          op: [0.5, 0.9],
        })}
      </div>
    </>
  );
}

/** A village's lights on the dawn horizon; `i` is its place in the rolling wave. */
function DawnLights(props: {
  x: number;
  y: number;
  s: number;
  i: number;
}): JSX.Element {
  const { x, y, s } = props;
  return (
    <g className={styles.dwLights} style={vars({ "--i": props.i })}>
      <circle cx={x} cy={y} r={40 * s} fill="url(#dw-light)" />
      <g fill="#fff0c0">
        <rect
          x={n1(x - 16 * s)}
          y={n1(y)}
          width={n1(3.5 * s)}
          height={n1(3.5 * s)}
        />
        <rect
          x={n1(x - 3 * s)}
          y={n1(y - 6 * s)}
          width={n1(3.5 * s)}
          height={n1(4.5 * s)}
        />
        <rect
          x={n1(x + 9 * s)}
          y={n1(y + 1 * s)}
          width={n1(3.5 * s)}
          height={n1(3.5 * s)}
        />
      </g>
    </g>
  );
}

/** Rooftops and a tower, centred on x, standing on y. */
function hamlet(x: number, y: number, s: number): string {
  const house = (hx: number, w: number, h: number): string =>
    `M${n1(hx)} ${n1(y)}V${n1(y - h * s)}L${n1(hx + (w / 2) * s)} ${n1(y - (h + w * 0.5) * s)}L${n1(hx + w * s)} ${n1(y - h * s)}V${n1(y)}Z`;
  return (
    house(x - 34 * s, 18, 10) +
    house(x - 14 * s, 16, 14) +
    `M${n1(x + 4 * s)} ${n1(y)}V${n1(y - 30 * s)}L${n1(x + 9 * s)} ${n1(y - 40 * s)}L${n1(x + 14 * s)} ${n1(y - 30 * s)}V${n1(y)}Z` +
    house(x + 16 * s, 20, 9)
  );
}

/** A small floating land, flat-topped with a rocky underside. */
function island(x: number, y: number, w: number): string {
  const t = (k: number): number => n1(w * k);
  return `M${x - w / 2} ${y}C${x - w / 2} ${y - t(0.06)} ${x - w / 3} ${y - t(0.1)} ${x - w / 5} ${y - t(0.08)}C${x - w / 10} ${y - t(0.16)} ${x + w / 8} ${y - t(0.14)} ${x + w / 5} ${y - t(0.07)}C${x + w / 3} ${y - t(0.09)} ${x + w / 2} ${y - t(0.05)} ${x + w / 2} ${y}L${x + t(0.4)} ${y + t(0.12)}L${x + t(0.3)} ${y + t(0.14)}L${x + t(0.22)} ${y + t(0.3)}L${x + t(0.12)} ${y + t(0.26)}L${x + t(0.04)} ${y + t(0.5)}L${x - t(0.06)} ${y + t(0.3)}L${x - t(0.16)} ${y + t(0.34)}L${x - t(0.24)} ${y + t(0.18)}L${x - t(0.38)} ${y + t(0.12)}Z`;
}

/** 17. Dawn across the worlds: lamps relight in a rolling wave under a warm sky. */
function Dawn(): JSX.Element {
  const far = [
    [110, 772, 1.1],
    [360, 764, 1],
    [610, 774, 0.95],
    [830, 766, 0.85],
    [1290, 762, 0.85],
    [1520, 770, 0.95],
    [1760, 762, 1.1],
  ] as const;
  const near = [
    [230, 852, 1.9],
    [560, 868, 1.6],
    [1500, 864, 1.6],
    [1760, 848, 1.9],
  ] as const;
  const river = [
    ...bez([1150, 776], [1230, 810], [1170, 860], [1310, 920], 12),
    ...bez([1310, 920], [1450, 980], [1380, 1040], [1560, 1110], 12).slice(1),
  ];
  return (
    <>
      <Defs>
        <Lin
          id="dw-sky"
          s={[
            [0, "#09111f"],
            [0.32, "#1c2240"],
            [0.52, "#3e3252"],
            [0.63, "#734658"],
            [0.69, "#a46258"],
            [0.72, "#be7e5e"],
            [0.76, "#52343a"],
            [1, "#120c10"],
          ]}
        />
        <Rad
          id="dw-sun"
          s={[
            [0, "#fff0c8", 0.65],
            [0.22, "#ffc98a", 0.28],
            [1, "#ffc98a", 0],
          ]}
        />
        <Rad
          id="dw-light"
          s={[
            [0, "#fff2c0", 0.85],
            [0.3, "#ffc070", 0.34],
            [1, "#ffc070", 0],
          ]}
        />
        <Rad
          id="dw-band"
          s={[
            [0, "#ffd9a0", 0.32],
            [1, "#ffd9a0", 0],
          ]}
        />
        <Rad
          id="dw-cloud"
          s={[
            [0, "#f0a882", 0.34],
            [1, "#f0a882", 0],
          ]}
        />
        <Lin
          id="dw-river"
          s={[
            [0, "#f6c890", 0.8],
            [0.5, "#c07a5e", 0.5],
            [1, "#4a2a30", 0.4],
          ]}
        />
      </Defs>
      <Layer depth="sky">
        <rect width="1920" height="1080" fill="url(#dw-sky)" />
        <path
          d={dots(50, 181, [0, 0, 1920, 300], [0.5, 1.3])}
          fill="#e8ecff"
          opacity="0.4"
        />
        <circle cx="1140" cy="790" r="600" fill="url(#dw-sun)" />
        <ellipse cx="520" cy="560" rx="520" ry="26" fill="url(#dw-cloud)" />
        <ellipse cx="1400" cy="610" rx="440" ry="22" fill="url(#dw-cloud)" />
        <ellipse
          cx="980"
          cy="500"
          rx="300"
          ry="14"
          fill="url(#dw-cloud)"
          opacity="0.7"
        />
        <ellipse
          cx="300"
          cy="660"
          rx="300"
          ry="16"
          fill="url(#dw-cloud)"
          opacity="0.8"
        />
        <path d={island(300, 300, 190)} fill="#1c1a2e" />
        <path d={island(1640, 250, 230)} fill="#1c1a2e" />
        <path d={island(1180, 170, 110)} fill="#1a182a" opacity="0.8" />
        <path d={hamlet(300, 286, 0.8)} fill="#1c1a2e" />
        <path d={hamlet(1640, 230, 0.9)} fill="#1c1a2e" />
        <path d={dots(7, 183, [230, 270, 370, 290], [5, 9])} fill="#1c1a2e" />
        <path
          d={dots(8, 184, [1550, 222, 1730, 240], [6, 10])}
          fill="#1c1a2e"
        />
        <circle cx="304" cy="282" r="3" fill="#ffd28a" />
        <circle cx="1650" cy="224" r="3" fill="#ffd28a" />
        <path
          d="M310 336Q300 380 314 420M1660 300Q1650 360 1664 400"
          fill="none"
          stroke="#b0c8e8"
          strokeWidth="2"
          opacity="0.25"
        />
        <path
          d="M304 330Q380 560 330 760M1646 300Q1560 540 1500 770M320 290Q760 140 1180 175Q1420 190 1630 236"
          fill="none"
          stroke="#f4c88a"
          strokeWidth="1.5"
          opacity="0.32"
          strokeDasharray="3 9"
        />
        <g
          className={styles.dwBirds}
          fill="none"
          stroke="#1a1626"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M700 380q10 -8 20 0q10 -8 20 0M760 410q8 -6 16 0q8 -6 16 0M640 420q7 -5 14 0q7 -5 14 0" />
        </g>
      </Layer>
      <Layer depth="far">
        <path
          d="M-40 780L120 700L220 740L330 680L470 750L560 720L700 768H1300L1420 724L1520 750L1640 690L1760 730L1860 676L1960 720V800H-40Z"
          fill="#46344a"
          opacity="0.7"
        />
        <path
          d="M-40 786C140 756 300 768 460 760C640 752 760 774 900 770C1060 766 1180 750 1340 756C1520 762 1700 746 1960 764V1120H-40Z"
          fill="#3a2a40"
        />
        <path
          d="M-40 800C200 780 420 796 640 790C860 784 1000 776 1220 782C1440 788 1660 772 1960 786V1120H-40Z"
          fill="#2c2034"
        />
        <ellipse
          cx="960"
          cy="776"
          rx="300"
          ry="26"
          fill="url(#dw-band)"
          className={styles.dwBand}
        />
        {far.map(([x, y, s]) => (
          <path key={x} d={hamlet(x, y + 10, s)} fill="#261c2e" />
        ))}
        {far.map(([x, y, s], i) => (
          <DawnLights key={x} x={x} y={y} s={s} i={i < 4 ? i * 2 : i * 2 + 1} />
        ))}
      </Layer>
      <Layer depth="mid">
        <path
          d="M-40 866C220 830 480 854 720 850C960 846 1180 838 1420 848C1640 858 1800 834 1960 840V1120H-40Z"
          fill="#191019"
        />
        <path
          d={dots(
            70,
            185,
            [-40, 836, 1960, 856],
            [5, 11],
            (x, y) => y > 850 - Math.sin(x / 300) * 8 && (x < 700 || x > 1250),
          )}
          fill="#191019"
        />
        <path d={taper(river, 6, 130)} fill="url(#dw-river)" opacity="0.6" />
        {near.map(([x, y, s]) => (
          <path key={x} d={hamlet(x, y, s)} fill="#140c14" />
        ))}
        {near.map(([x, y, s], i) => (
          <DawnLights
            key={x}
            x={x}
            y={y - 6 * s}
            s={s}
            i={i < 2 ? i * 4 + 1 : i * 4 + 2}
          />
        ))}
      </Layer>
      {particles(10, 182, styles.mote, {
        x: [5, 95],
        y: [55, 90],
        size: [2, 4],
        dur: [12, 20],
        op: [0.4, 0.8],
      })}
      <Layer depth="near">
        <path
          d="M-40 1120V950Q300 920 640 960Q900 990 1200 960Q1560 920 1960 950V1120Z"
          fill="#0a0609"
        />
        <rect x="236" y="760" width="8" height="220" fill="#0a0609" />
        <path d="M222 762H258L250 740H230Z" fill="#0a0609" />
        <DawnLights x={240} y={776} s={1.4} i={0} />
      </Layer>
    </>
  );
}

const SCENES: Record<SceneryId, () => JSX.Element> = {
  refuge: Refuge,
  village: Village,
  fairground: Fairground,
  foundry: Foundry,
  streets: Streets,
  tribunal: Tribunal,
  garden: Garden,
  revel: Revel,
  transit: Transit,
  prism: Prism,
  nightmare: Nightmare,
  amphitheater: Amphitheater,
  gallery: Gallery,
  citadel: Citadel,
  names: Names,
  throne: Throne,
  dawn: Dawn,
};

/** A cut scene's painted, slowly moving backdrop. It fills its positioned parent. */
export function Scenery({ id, phase, className }: SceneryProps): JSX.Element {
  const Scene = SCENES[id];
  return (
    <div
      className={[styles.scenery, className].join(" ")}
      data-scenery={id}
      data-phase={phase ?? "default"}
      aria-hidden="true"
      style={{ "--scene-accent": SCENERY_ACCENTS[id] } as CSSProperties}
    >
      <Scene />
      <div className={styles.vignette} />
      <div className={styles.floor} />
    </div>
  );
}
