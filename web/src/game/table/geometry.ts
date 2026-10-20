import type { Arrangement, Diamond, Point, Rect, Regions, SU } from "./types";

// The table's geometry in stage units (su): every number the layout uses lives here, so the
// table can be tuned on screenshots while the tests hold its invariants (design §8). Rectangles
// are written by their edges, as the design's tables give them.

/** The perspective size law: a card centred at y is drawn at s(y) of its size at the near edge. */
export const s = (y: SU): number => (y + 1620) / 2700;

export const BASE_CARD = { w: 150, h: 209.52 } as const;

/** Row cards are scaled by `c` on top of s(y): smaller opponents as more of them share the top. */
export const C_FACTOR: Record<Arrangement, { you: number; opponents: number }> =
  {
    duel: { you: 0.9, opponents: 0.9 },
    three: { you: 0.9, opponents: 0.78 },
    four: { you: 0.9, opponents: 0.66 },
  };

/** A row card's size at its centre line. */
export function rowCard(yCentre: SU, c: number): { w: SU; h: SU } {
  const k = s(yCentre) * c;
  return { w: BASE_CARD.w * k, h: BASE_CARD.h * k };
}

export const MIN_HIT = 36;
export const MIN_HAND_SLICE = 40;
/** Cards shown with their own hit in a pile, or attachments beside a host, before a "+N". */
export const PILE_CAP = 5;
export const ATTACHMENT_CAP = 4;
/** The smallest scale a row may shrink its cards to before they overlap. */
export const MIN_ROW_SCALE = 0.72;
/** The space a row keeps at its end for "+M" when its units cannot all have hits. */
export const ROW_MORE = 56;

export function rect(x0: SU, y0: SU, x1: SU, y1: SU): Rect {
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function diamond(cx: SU, cy: SU, side: SU): Diamond {
  return { cx, cy, side };
}

/** A diamond button's box: the bounding square of the turned square (side·√2). */
export function diamondBox(d: Diamond): Rect {
  const half = (d.side * Math.SQRT2) / 2;
  return { x: d.cx - half, y: d.cy - half, w: half * 2, h: half * 2 };
}

export function centre(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Whether p lies in r (left and top edges inclusive, right and bottom exclusive). */
export function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

/** Whether two rectangles share area; rectangles that only touch do not. */
export function overlaps(a: Rect, b: Rect, epsilon = 1e-6): boolean {
  return (
    a.x + a.w > b.x + epsilon &&
    b.x + b.w > a.x + epsilon &&
    a.y + a.h > b.y + epsilon &&
    b.y + b.h > a.y + epsilon
  );
}

/* ---------- the band (§8.2) ---------- */
export const BAND = {
  rect: rect(0, 488, 1920, 532),
  y: 510,
  hud: {
    side: 26,
    menu: 32,
    log: 76,
    priority: 120,
    fullscreen: 164,
    inspection: 208,
  },
  turnText: rect(236, 494, 470, 526),
  status: rect(476, 494, 592, 526),
  /** Step text is right-aligned to x 1530, or 1410 while the combat icons show. */
  stepRight: 1530,
  stepRightCombat: 1410,
  stepWidth: 280,
  combatIcons: { x: [1436, 1466, 1496] as const, side: 17 },
  phases: { x: [1572, 1652, 1732, 1812, 1892] as const, side: 22.6 },
  emblem: diamond(960, 510, 112),
  emblemCaption: rect(860, 594, 1060, 630),
} as const;

/* ---------- the stack (§8.3) ---------- */
export const STACK = {
  lane: rect(600, 446, 1320, 574),
  top: { cx: 960, cy: 510, w: 92, h: 128 },
  /** Older items fan left behind the top one, each a little smaller. */
  step: 46,
  shrink: 0.94,
  drawn: 6,
  more: diamond(644, 510, 26),
  abilityScale: 0.8,
} as const;

/* ---------- the hand (§8.5) ---------- */
export const HAND = {
  area: rect(490, 948, 1440, 1080),
  centre: 965,
  card: { w: 180, h: 251.4 },
  maxStep: 150,
  spread: 770,
  minStep: 40,
  slots: 20,
  restTop: 948,
  arc: 20,
  halfWidth: 475,
  tilt: 3.2,
  maxTilt: 14,
  rise: { scale: 1.5, bottom: 1072, minX: 143, maxX: 1777 },
} as const;

export interface RowSpec {
  y: SU;
  x0: SU;
  x1: SU;
}

export interface PedestalSpec {
  pile: Rect;
  top: Rect;
  front: Rect;
}

/** One player's plate and zones, in absolute stage units. */
export interface SeatGeometry {
  area: Rect;
  portrait: Diamond;
  life: Diamond;
  target: Rect;
  counts: { hand: Diamond; graveyard: Diamond; library: Diamond };
  name: { anchor: Point; align: "left" | "right"; size: SU; maxWidth: SU };
  title: { anchor: Point; align: "left" | "right"; size: SU; maxWidth: SU };
  pills: Rect;
  statusRow: Rect;
  expand: Diamond;
  graveyard: Rect;
  exile: Rect;
  library: PedestalSpec;
  /** The command tile: its button and the picture on it. */
  command: { tile: Rect; card: Rect };
  front: RowSpec;
  back: RowSpec;
}

/* ---------- your side (§8.4) ---------- */
export const YOU = {
  area: rect(0, 532, 1920, 1080),
  portrait: diamond(118, 912, 124),
  life: diamond(118, 1004, 56),
  target: rect(30, 824, 206, 1044),
  counts: {
    hand: diamond(186, 1022, 30),
    graveyard: diamond(232, 1022, 30),
    library: diamond(278, 1022, 30),
  },
  name: {
    anchor: { x: 220, y: 952 },
    align: "left" as const,
    size: 24,
    maxWidth: 250,
  },
  title: {
    anchor: { x: 220, y: 976 },
    align: "left" as const,
    size: 18,
    maxWidth: 250,
  },
  pills: rect(220, 981, 470, 1000),
  statusRow: rect(226, 826, 490, 850),
  phaseCaption: rect(220, 856, 470, 876),
  phaseBar: rect(220, 882, 470, 890),
  expand: diamond(330, 1022, 26),
  front: { y: 668, x0: 480, x1: 1560 },
  back: { y: 846, x0: 500, x1: 1560 },
  /** Your command cards: the top one here, earlier ones fanned 40 su to its left. */
  commandCard: rect(1604, 596, 1696, 724),
  commandFan: 40,
  commandCap: 2,
  commandPlate: rect(1600, 728, 1700, 764),
  exile: rect(1604, 780, 1696, 908),
  library: {
    pile: rect(1730, 676, 1850, 844),
    top: rect(1716, 840, 1864, 856),
    front: rect(1716, 856, 1864, 884),
  },
  graveyard: rect(1730, 896, 1850, 1064),
};

/* ---------- one opponent, or the expanded one (§8.6) ---------- */
export const DUEL: SeatGeometry = {
  area: rect(0, 0, 1920, 488),
  portrait: diamond(1802, 168, 124),
  life: diamond(1802, 260, 56),
  target: rect(1714, 80, 1890, 300),
  counts: {
    hand: diamond(1734, 278, 30),
    graveyard: diamond(1688, 278, 30),
    library: diamond(1642, 278, 30),
  },
  name: {
    anchor: { x: 1890, y: 40 },
    align: "right",
    size: 24,
    maxWidth: 440,
  },
  title: {
    anchor: { x: 1890, y: 64 },
    align: "right",
    size: 18,
    maxWidth: 440,
  },
  // Under the title and left of the portrait, clear of the chips when this is the expanded seat.
  pills: rect(1300, 68, 1710, 90),
  statusRow: rect(1430, 92, 1712, 116),
  expand: diamond(1872, 330, 26),
  graveyard: rect(65, 37, 155, 163),
  exile: rect(186, 47, 262, 153),
  library: {
    pile: rect(65, 217, 155, 343),
    top: rect(51, 343, 169, 355),
    front: rect(51, 355, 169, 380),
  },
  command: { tile: rect(182, 196, 266, 342), card: rect(186, 196, 262, 302) },
  back: { y: 196, x0: 290, x1: 1520 },
  front: { y: 350, x0: 290, x1: 1600 },
};

/** A column's geometry relative to its left edge X0 (three and four players). */
function column(
  x0: SU,
  width: SU,
  g: {
    name: { dx: SU; y: SU; size: SU; maxWidth: SU };
    title: { y: SU };
    pills: [SU, SU, SU, SU];
    statusRow: [SU, SU, SU, SU];
    portrait: [SU, SU, SU];
    life: [SU, SU, SU];
    target: [SU, SU, SU, SU];
    counts: { y: SU; side: SU; hand: SU; graveyard: SU; library: SU };
    expand: [SU, SU, SU];
    graveyard: [SU, SU, SU, SU];
    library: { pile: [SU, SU, SU, SU]; top: [SU, SU, SU, SU]; front: [SU, SU] };
    exile: [SU, SU, SU, SU];
    command: { tile: [SU, SU, SU, SU]; card: [SU, SU, SU, SU] };
    back: RowSpec;
    front: RowSpec;
  },
): SeatGeometry {
  const r = ([a, b, c, d]: [SU, SU, SU, SU]) => rect(x0 + a, b, x0 + c, d);
  const dia = ([dx, y, side]: [SU, SU, SU]) => diamond(x0 + dx, y, side);
  const top = g.library.top;
  return {
    area: rect(x0, 0, x0 + width, 476),
    portrait: dia(g.portrait),
    life: dia(g.life),
    target: r(g.target),
    counts: {
      hand: diamond(x0 + g.counts.hand, g.counts.y, g.counts.side),
      graveyard: diamond(x0 + g.counts.graveyard, g.counts.y, g.counts.side),
      library: diamond(x0 + g.counts.library, g.counts.y, g.counts.side),
    },
    name: {
      anchor: { x: x0 + g.name.dx, y: g.name.y },
      align: "right",
      size: g.name.size,
      maxWidth: g.name.maxWidth,
    },
    title: {
      anchor: { x: x0 + g.name.dx, y: g.title.y },
      align: "right",
      size: 18,
      maxWidth: g.name.maxWidth,
    },
    pills: r(g.pills),
    statusRow: r(g.statusRow),
    expand: dia(g.expand),
    graveyard: r(g.graveyard),
    exile: r(g.exile),
    library: {
      pile: r(g.library.pile),
      top: r(top),
      front: rect(
        x0 + top[0],
        g.library.front[0],
        x0 + top[2],
        g.library.front[1],
      ),
    },
    command: { tile: r(g.command.tile), card: r(g.command.card) },
    back: { y: g.back.y, x0: x0 + g.back.x0, x1: x0 + g.back.x1 },
    front: { y: g.front.y, x0: x0 + g.front.x0, x1: x0 + g.front.x1 },
  };
}

/* ---------- two opponents (§8.7) ---------- */
export const THREE = {
  width: 960,
  columns: [0, 960] as const,
  seat: (x0: SU): SeatGeometry =>
    column(x0, 960, {
      name: { dx: 800, y: 40, size: 22, maxWidth: 440 },
      title: { y: 62 },
      pills: [360, 106, 800, 126],
      statusRow: [560, 80, 800, 104],
      portrait: [880, 86, 100],
      life: [880, 160, 44],
      target: [809, 15, 951, 191],
      counts: { y: 176, side: 24, hand: 828, graveyard: 792, library: 756 },
      expand: [934, 230, 26],
      graveyard: [16, 31, 88, 132],
      library: {
        pile: [100, 26, 172, 127],
        top: [89, 127, 183, 137],
        front: [137, 158],
      },
      exile: [185, 38, 247, 126],
      command: { tile: [264, 31, 336, 152], card: [268, 31, 332, 120] },
      back: { y: 222, x0: 20, x1: 730 },
      front: { y: 380, x0: 20, x1: 940 },
    }),
};

/* ---------- three opponents (§8.8) ---------- */
export const FOUR = {
  width: 640,
  columns: [0, 640, 1280] as const,
  seat: (x0: SU): SeatGeometry =>
    column(x0, 640, {
      name: { dx: 504, y: 36, size: 20, maxWidth: 230 },
      title: { y: 56 },
      pills: [274, 92, 504, 112],
      statusRow: [300, 66, 500, 88],
      portrait: [578, 74, 84],
      life: [578, 136, 38],
      target: [519, 15, 637, 163],
      counts: { y: 150, side: 21, hand: 534, graveyard: 504, library: 474 },
      expand: [604, 200, 26],
      graveyard: [10, 32, 70, 116],
      library: {
        pile: [76, 28, 136, 112],
        top: [67, 112, 145, 120],
        front: [120, 138],
      },
      exile: [144, 37, 196, 111],
      command: { tile: [206, 32, 266, 134], card: [209, 32, 263, 107] },
      back: { y: 232, x0: 14, x1: 570 },
      front: { y: 384, x0: 14, x1: 626 },
    }),
};

/* ---------- chips: collapsed opponents while another is expanded (§8.8) ---------- */
export const CHIP = {
  /** Chip centres for the opponents left over: one in three players, two in four. */
  centres: { three: [920], four: [720, 1120] } as Record<
    "three" | "four",
    SU[]
  >,
  y: 64,
  half: 110,
  top: 20,
  bottom: 108,
  portrait: { dx: -64, side: 64 },
  life: { dx: -26, dy: 22, side: 30 },
  name: { dx: -14, y: 54, size: 18, maxWidth: 124 },
  counts: { y: 92, side: 18, dx: [16, 46, 76] as const },
  /** Expand and the chipped battlefield's "+N" sit just right of the chip button. */
  expand: { dx: 130, y: 40, side: 26 },
  more: { dx0: 112, dx1: 168, y0: 64, y1: 104 },
} as const;

/* ---------- regions (§8.9) ---------- */
export const REGIONS: Regions = {
  column: rect(16, 540, 460, 812),
  drawer: rect(1416, 24, 1896, 1056),
  gameMenu: rect(16, 140, 356, 480),
  alerts: rect(560, 330, 1360, 470),
  magnifier: {
    right: {
      1: {
        card: rect(1466, 200, 1896, 800),
        panel: rect(1150, 200, 1450, 620),
      },
      2: { card: rect(1296, 120, 1896, 960), panel: rect(980, 120, 1280, 720) },
    },
    left: {
      1: { card: rect(24, 200, 454, 800), panel: rect(470, 200, 770, 620) },
      2: { card: rect(24, 120, 624, 960), panel: rect(640, 120, 940, 720) },
    },
  },
};

/** Option menus: 320 su wide, 44 su per item, below the hit when there is room. */
export const MENU = { width: 320, item: 44, margin: 8 } as const;

/* ---------- drops (§8.9) ---------- */
export const DROPS = {
  yours: rect(480, 588, 1560, 932),
  band: rect(600, 488, 1320, 532),
  opponentsHalf: rect(0, 0, 1920, 480),
} as const;

/* ---------- the table plane (§8.1) ---------- */
export const PLANE = {
  quad: [
    { x: -22, y: -60 },
    { x: 1942, y: -60 },
    { x: 2660, y: 1080 },
    { x: -740, y: 1080 },
  ] as [Point, Point, Point, Point],
  vanishingPoint: { x: 960, y: -1620 },
  fieldLines: [-100, 2020] as const,
  rims: [124, 938] as const,
  /** Diamond sockets are a little larger than what sits in them. */
  socketMargin: 16,
  bandSocket: diamond(960, 510, 120),
} as const;
