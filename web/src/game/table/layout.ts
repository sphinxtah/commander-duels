import type { Seat } from "../types";
import {
  ATTACHMENT_CAP,
  BAND,
  C_FACTOR,
  CHIP,
  DROPS,
  DUEL,
  FOUR,
  HAND,
  MENU,
  MIN_HAND_SLICE,
  MIN_HIT,
  MIN_ROW_SCALE,
  PILE_CAP,
  PLANE,
  REGIONS,
  ROW_MORE,
  STACK,
  TEAM_HAND,
  THREE,
  YOU,
  centre,
  clamp,
  contains,
  diamond,
  diamondBox,
  overlaps,
  rect,
  rowCard,
  withTeamHand,
  type RowSpec,
  type SeatGeometry,
} from "./geometry";
import {
  STAGE_H,
  STAGE_W,
  type Arrangement,
  type BadgePlacement,
  type BandLayout,
  type CardNode,
  type CurvePlacement,
  type Diamond,
  type DropZone,
  type LayoutTable,
  type MoreNode,
  type PipPlacement,
  type PlayerNode,
  type Point,
  type Rect,
  type RowLayout,
  type SU,
  type TableCard,
  type TableLayout,
  type TableModel,
  type TablePlayer,
  type TableUnit,
  type TagPlacement,
  type ZoneTile,
} from "./types";

// The table's layout: where every card, plate, tile and button sits on the 1920 × 1080 stage
// (design §8). Both pictures draw from it: the PixiJS scene paints the faces and the DOM layer
// puts a real, named button at each hit. Hits never overlap and are never smaller than 36 su,
// so a pointer, a test or a screen reader always reaches exactly one thing; validateHits checks
// that on every layout the tests make.

const EPSILON = 1e-6;

/* ---------- row packing (§8.11) ---------- */

export interface RowUnitBox {
  key: string;
  /** Cards in the unit: 1 for a single or a host, or a pile's members (bottom to top). */
  members: number;
  /** Each attachment's tapped state, for a host. */
  attachments: boolean[];
  tapped: boolean;
  pips: boolean;
  /** Something in the unit is offered: it keeps its hits before anything else when space runs out. */
  offered: boolean;
  /** A wider gap before this unit: the back row's step from lands to other permanents. */
  separate?: boolean;
}

export interface PackedElement {
  /** A single's or pile's member (counted from the bottom), the host, an attachment, or the
   * unit's "+N" strip. */
  kind: "member" | "host" | "attachment" | "more";
  index: number;
  face: Rect;
  rotation: 0 | 90;
  footprint: Rect;
  hit: Rect | null;
}

export interface PackedUnit {
  key: string;
  x: SU;
  width: SU;
  /** Units beyond what the row can show: drawn under its "+M", without hits. */
  overflow: boolean;
  elements: PackedElement[];
}

export interface PackedRow {
  scale: number;
  card: { w: SU; h: SU };
  mode: "natural" | "shrunk" | "overlap" | "overflow";
  units: PackedUnit[];
  /** The "+M" button when some units overflow. */
  more: Rect | null;
}

interface Metrics {
  w: SU;
  h: SU;
  /** A pile member's or attachment's visible strip. */
  strip: SU;
}

function metrics(base: { w: SU; h: SU }, f: number): Metrics {
  const w = base.w * f;
  return { w, h: base.h * f, strip: Math.max(0.24 * w, MIN_HIT) };
}

function shape(u: RowUnitBox) {
  const pile = u.members > 1;
  const shown = pile ? Math.min(u.members, PILE_CAP) : 1;
  const shownAttachments = Math.min(u.attachments.length, ATTACHMENT_CAP);
  return {
    pile,
    shown,
    pileMore: pile && u.members > shown,
    shownAttachments,
    attachmentMore: u.attachments.length > shownAttachments,
  };
}

/** A unit's width on the row, and how much of its right side the next unit may cover while
 * every member keeps a hit at least 36 su wide and 30% of the unit stays in view. */
function unitWidth(u: RowUnitBox, m: Metrics): { width: SU; cover: SU } {
  const sh = shape(u);
  const cw = u.tapped ? m.h : m.w;
  const pips = u.pips ? 0.12 * m.w : 0;
  let width: SU;
  let needed: SU;
  if (sh.pile) {
    const strips = (sh.pileMore ? 1 : 0) + sh.shown - 1;
    width = strips * m.strip + cw + pips;
    needed = strips * m.strip + MIN_HIT;
  } else if (u.attachments.length > 0) {
    const strips = sh.shownAttachments + (sh.attachmentMore ? 1 : 0);
    width = cw + strips * m.strip + pips;
    needed = cw + strips * m.strip;
  } else {
    width = cw + pips;
    needed = MIN_HIT;
  }
  return { width, cover: Math.max(0, width - Math.max(0.3 * width, needed)) };
}

function unitElements(
  u: RowUnitBox,
  x: SU,
  visibleRight: SU,
  m: Metrics,
  yc: SU,
  hits: boolean,
): PackedElement[] {
  const sh = shape(u);
  const top = yc - m.h / 2;
  const bottom = yc + m.h / 2;
  const card = (left: SU, tapped: boolean, lift = 0) => {
    const fw = tapped ? m.h : m.w;
    const fh = tapped ? m.w : m.h;
    const cx = left + fw / 2;
    const cy = yc - lift;
    return {
      face: { x: cx - m.w / 2, y: cy - m.h / 2, w: m.w, h: m.h },
      rotation: (tapped ? 90 : 0) as 0 | 90,
      footprint: { x: left, y: cy - fh / 2, w: fw, h: fh },
    };
  };
  // A hit is the visible part of what is drawn, kept within the row's band.
  const hit = (x0: SU, x1: SU, fp: Rect): Rect | null => {
    if (!hits) return null;
    const right = Math.min(x1, visibleRight);
    const y0 = Math.max(fp.y, top);
    const y1 = Math.min(fp.y + fp.h, bottom);
    return right - x0 > EPSILON && y1 - y0 > EPSILON
      ? rect(x0, y0, right, y1)
      : null;
  };
  const cw = u.tapped ? m.h : m.w;
  const out: PackedElement[] = [];
  if (sh.pile) {
    let left = x;
    const hidden = u.members - sh.shown;
    if (sh.pileMore) {
      const under = card(x, u.tapped);
      out.push({
        kind: "more",
        index: 0,
        face: under.face,
        rotation: under.rotation,
        footprint: { ...under.footprint, w: m.strip },
        hit: hit(x, x + m.strip, under.footprint),
      });
      for (let i = 0; i < hidden; i++)
        out.push({ kind: "member", index: i, ...under, hit: null });
      left += m.strip;
    }
    for (let j = 0; j < sh.shown; j++) {
      const placed = card(left, u.tapped);
      const last = j === sh.shown - 1;
      out.push({
        kind: "member",
        index: hidden + j,
        ...placed,
        hit: hit(left, left + (last ? cw : m.strip), placed.footprint),
      });
      left += m.strip;
    }
    return out;
  }
  const host = card(x, u.tapped);
  out.push({
    kind: u.attachments.length > 0 ? "host" : "member",
    index: 0,
    ...host,
    hit: hit(x, x + cw, host.footprint),
  });
  // Attachments lie behind the host, each peeking out a strip further right and a little up.
  const lift = 0.1 * m.h;
  u.attachments.forEach((tapped, j) => {
    const slot = Math.min(j, sh.shownAttachments);
    const stripLeft = x + cw + slot * m.strip;
    const fw = tapped ? m.h : m.w;
    const placed = card(stripLeft + m.strip - fw, tapped, lift);
    out.push({
      kind: "attachment",
      index: j,
      ...placed,
      hit:
        j < sh.shownAttachments
          ? hit(stripLeft, stripLeft + m.strip, placed.footprint)
          : null,
    });
  });
  if (sh.attachmentMore) {
    const stripLeft = x + cw + sh.shownAttachments * m.strip;
    const under = card(stripLeft + m.strip - m.w, false, lift);
    out.push({
      kind: "more",
      index: 0,
      ...under,
      hit: hit(stripLeft, stripLeft + m.strip, under.footprint),
    });
  }
  return out;
}

/** Packs a row of units into [x0, x1]: at full size and centred when they fit; else shrunk (to
 * 72% at most), then with smaller gaps, then overlapping, each unit keeping its hits; and when
 * even that does not fit, the units that do not (the ones with nothing offered first) give way
 * to a "+M" at the row's end. */
export function packRow(
  region: { x0: SU; x1: SU; yCentre: SU },
  units: RowUnitBox[],
  c: number,
): PackedRow {
  const base = rowCard(region.yCentre, c);
  const avail = region.x1 - region.x0;
  const yc = region.yCentre;
  const empty = (f: number): PackedRow => ({
    scale: f,
    card: { w: base.w * f, h: base.h * f },
    mode: "natural",
    units: [],
    more: null,
  });
  if (units.length === 0) return empty(1);

  const gapsAt = (list: RowUnitBox[], m: Metrics) =>
    list.map((u, i) => (i === 0 ? 0 : u.separate ? 0.5 * m.w : 0.08 * m.w));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const total = (f: number) => {
    const m = metrics(base, f);
    return sum(units.map((u) => unitWidth(u, m).width)) + sum(gapsAt(units, m));
  };

  // Places a list of units from `start` with the given gaps (negative for overlap).
  const place = (
    list: RowUnitBox[],
    m: Metrics,
    start: SU,
    gaps: number[],
    hits: boolean,
  ): PackedUnit[] => {
    let x = start;
    return list.map((u, i) => {
      x += gaps[i];
      const { width } = unitWidth(u, m);
      const next = i + 1 < list.length ? gaps[i + 1] : 0;
      // A negative gap before the next unit is how much of this one it covers.
      const visibleRight = x + width + Math.min(0, next);
      const unit: PackedUnit = {
        key: u.key,
        x,
        width,
        overflow: false,
        elements: unitElements(u, x, visibleRight, m, yc, hits),
      };
      x += width;
      return unit;
    });
  };

  // Fits a list into `room` at scale `m`: with gaps (squeezed if need be), or overlapping.
  // Returns null when even the deepest overlap is too wide.
  const fit = (
    list: RowUnitBox[],
    m: Metrics,
    room: SU,
    start: SU,
    centred: boolean,
  ): { units: PackedUnit[]; overlap: boolean } | null => {
    const widths = list.map((u) => unitWidth(u, m));
    const natural = sum(widths.map((w) => w.width));
    const gaps = gapsAt(list, m);
    const gapTotal = sum(gaps);
    if (natural + gapTotal <= room + EPSILON) {
      const x = centred ? start + (room - natural - gapTotal) / 2 : start;
      return { units: place(list, m, x, gaps, true), overlap: false };
    }
    if (natural <= room + EPSILON) {
      const squeeze = gapTotal > 0 ? (room - natural) / gapTotal : 0;
      return {
        units: place(
          list,
          m,
          start,
          gaps.map((g) => g * squeeze),
          true,
        ),
        overlap: false,
      };
    }
    // Overlap evenly: every unit but the last gives up the same amount, or all it can spare.
    const excess = natural - room;
    const covers = widths.slice(0, -1).map((w) => w.cover);
    if (sum(covers) + EPSILON < excess) return null;
    const sorted = [...covers].sort((a, b) => a - b);
    let remaining = excess;
    let count = sorted.length;
    let level = 0;
    for (const cover of sorted) {
      if (cover * count >= remaining) {
        level = remaining / count;
        break;
      }
      remaining -= cover;
      count--;
    }
    const overlapGaps = list.map((_, i) =>
      i === 0 ? 0 : -Math.min(level, covers[i - 1]),
    );
    return {
      units: place(list, m, start, overlapGaps, true),
      overlap: true,
    };
  };

  if (total(1) <= avail + EPSILON) {
    const m = metrics(base, 1);
    return {
      scale: 1,
      card: { w: m.w, h: m.h },
      mode: "natural",
      units: fit(units, m, avail, region.x0, true)!.units,
      more: null,
    };
  }
  if (total(MIN_ROW_SCALE) <= avail + EPSILON) {
    // The largest scale that fits; strips have a floor, so search rather than divide.
    let lo = MIN_ROW_SCALE;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (total(mid) <= avail) lo = mid;
      else hi = mid;
    }
    const m = metrics(base, lo);
    return {
      scale: lo,
      card: { w: m.w, h: m.h },
      mode: "shrunk",
      units: fit(units, m, avail, region.x0, true)!.units,
      more: null,
    };
  }
  const m = metrics(base, MIN_ROW_SCALE);
  const card = { w: m.w, h: m.h };
  const packed = fit(units, m, avail, region.x0, false);
  if (packed)
    return {
      scale: MIN_ROW_SCALE,
      card,
      mode: packed.overlap ? "overlap" : "shrunk",
      units: packed.units,
      more: null,
    };

  // Overflow: keep what fits beside a "+M", giving way from the end, unoffered units first.
  const room = avail - ROW_MORE - 4;
  const more = rect(region.x1 - ROW_MORE, yc - 28, region.x1, yc + 28);
  const narrowest = (list: RowUnitBox[]) => {
    const widths = list.map((u) => unitWidth(u, m));
    return (
      sum(widths.map((w) => w.width)) -
      sum(widths.slice(0, -1).map((w) => w.cover))
    );
  };
  const fromEnd = units.map((_, i) => i).reverse();
  const dropped = new Set<number>();
  for (const i of [
    ...fromEnd.filter((i) => !units[i].offered),
    ...fromEnd.filter((i) => units[i].offered),
  ]) {
    const kept = units.filter((_, j) => !dropped.has(j));
    if (kept.length === 0 || narrowest(kept) <= room + EPSILON) break;
    dropped.add(i);
  }
  const keptList = units.filter((_, i) => !dropped.has(i));
  const placed =
    keptList.length > 0
      ? (fit(keptList, m, room, region.x0, false)?.units ?? [])
      : [];
  const byKey = new Map(placed.map((unit) => [unit.key, unit]));
  // What gives way is drawn as a small stack inside the "+M", scaled evenly to fit it.
  const c0 = centre(more);
  const q = (ROW_MORE - 4) / m.h;
  const mini = { w: m.w * q, h: m.h * q };
  const stacked = (rotation: 0 | 90) => {
    const fw = rotation === 90 ? mini.h : mini.w;
    const fh = rotation === 90 ? mini.w : mini.h;
    return {
      face: { x: c0.x - mini.w / 2, y: c0.y - mini.h / 2, ...mini },
      footprint: { x: c0.x - fw / 2, y: c0.y - fh / 2, w: fw, h: fh },
    };
  };
  return {
    scale: MIN_ROW_SCALE,
    card,
    mode: "overflow",
    more,
    units: units.map((u) => {
      const kept = byKey.get(u.key);
      if (kept) return kept;
      return {
        key: u.key,
        x: c0.x - mini.w / 2,
        width: mini.w,
        overflow: true,
        elements: unitElements(u, 0, 0, m, yc, false).map((element) => ({
          ...element,
          ...stacked(element.rotation),
          hit: null,
        })),
      };
    }),
  };
}

/* ---------- the hand fan (§8.5) ---------- */

/** The hand's slots: at most 20, the last one becoming "+N" when the hand holds more. */
export function fanHand(
  n: number,
): { face: Rect; rotation: number; hit: Rect }[] {
  const slots = Math.min(Math.max(0, n), HAND.slots);
  const step =
    slots > 1
      ? Math.max(
          HAND.minStep,
          Math.min(HAND.maxStep, HAND.spread / (slots - 1)),
        )
      : 0;
  const { w, h } = HAND.card;
  return Array.from({ length: slots }, (_, i) => {
    const offset = i - (slots - 1) / 2;
    const x = HAND.centre + offset * step;
    const y =
      HAND.restTop + HAND.arc * ((x - HAND.centre) / HAND.halfWidth) ** 2;
    const rotation = clamp(HAND.tilt * offset, -HAND.maxTilt, HAND.maxTilt);
    const width = i < slots - 1 ? Math.min(step, w) : w;
    return {
      face: { x: x - w / 2, y, w, h },
      rotation,
      hit: { x: x - w / 2, y, w: width, h: STAGE_H - y },
    };
  });
}

/* ---------- a teammate's hand (Two-Headed Giant, v0.5.1) ---------- */

/** Where a teammate's hand fans in their area: along its near edge, on one side of the stack's
 * lane (the side with more room). */
export function teamHandRegion(area: Rect): { x0: SU; x1: SU } {
  let x0 = area.x + TEAM_HAND.inset.left;
  let x1 = area.x + area.w - TEAM_HAND.inset.right;
  const laneX0 = STACK.lane.x - TEAM_HAND.inset.lane;
  const laneX1 = STACK.lane.x + STACK.lane.w + TEAM_HAND.inset.lane;
  if (x0 < laneX1 && x1 > laneX0) {
    if (laneX0 - x0 >= x1 - laneX1) x1 = laneX0;
    else x0 = laneX1;
  }
  return { x0, x1 };
}

/** A teammate's hand's slots: a small fan, face up, as many cards as keep a hit 36 su wide
 * each, the last slot becoming "+N" when the hand holds more. */
export function fanTeamHand(
  n: number,
  region: { x0: SU; x1: SU },
): { face: Rect; rotation: number; hit: Rect }[] {
  const { w, h } = TEAM_HAND.card;
  const spread = region.x1 - region.x0 - w;
  if (n <= 0 || spread < 0) return [];
  const slots = Math.min(n, Math.floor(spread / MIN_HIT + EPSILON) + 1);
  const step =
    slots > 1 ? Math.min(TEAM_HAND.maxStep, spread / (slots - 1)) : 0;
  const mid = (region.x0 + region.x1) / 2;
  const half = (slots - 1) / 2;
  return Array.from({ length: slots }, (_, i) => {
    const offset = i - half;
    const x = mid + offset * step;
    const y =
      TEAM_HAND.top + (half > 0 ? TEAM_HAND.arc * (offset / half) ** 2 : 0);
    const rotation = clamp(
      TEAM_HAND.tilt * offset,
      -TEAM_HAND.maxTilt,
      TEAM_HAND.maxTilt,
    );
    const width = i < slots - 1 ? Math.min(step, w) : w;
    return {
      face: { x: x - w / 2, y, w, h },
      rotation,
      hit: { x: x - w / 2, y, w: width, h },
    };
  });
}

/** The bounding box of a rectangle turned by `degrees` about a pivot. */
function turnedBox(r: Rect, degrees: number, pivot: Point): Rect {
  if (degrees === 0) return { ...r };
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const corners = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ].map(([x, y]) => ({
    x: pivot.x + (x - pivot.x) * cos - (y - pivot.y) * sin,
    y: pivot.y + (x - pivot.x) * sin + (y - pivot.y) * cos,
  }));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return rect(
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys),
  );
}

/** Where a card node's image lies once turned: the face, or for a tapped card its sideways box. */
export function imageRect(node: CardNode): Rect {
  if (node.rotation !== 90) return node.face;
  const c = centre(node.face);
  return {
    x: c.x - node.face.h / 2,
    y: c.y - node.face.w / 2,
    w: node.face.h,
    h: node.face.w,
  };
}

/* ---------- card anatomy (§8.10) ---------- */

function tagFor(
  card: TableCard,
  image: Rect,
  tapped: boolean,
): TagPlacement | null {
  const permanent = card.located.permanent;
  if (!permanent || card.card.hidden || !card.card.name) return null;
  const view = card.card;
  let text: string;
  let tone: TagPlacement["tone"];
  const loyalty = permanent.counters.loyalty;
  if (/\bPlaneswalker\b/.test(view.type_line ?? "") && loyalty !== undefined) {
    // The renderer draws loyalty in a diamond.
    text = `${loyalty}`;
    tone = "loyalty";
  } else if (view.power !== null && view.toughness !== null) {
    const toughness = Number(view.toughness);
    text = Number.isFinite(toughness)
      ? `${view.power}/${toughness - permanent.damage}`
      : `${view.power}/${view.toughness}`;
    tone =
      permanent.damage > 0
        ? "hurt"
        : (permanent.counters["+1/+1"] ?? 0) > 0
          ? "buffed"
          : "normal";
  } else return null;
  // Over the printed box, clear of the copyright line and the artist's name.
  const r = tapped
    ? {
        x: image.x + 0.065 * image.w,
        y: image.y + 0.8 * image.h,
        w: 0.225 * image.w,
        h: 0.16 * image.h,
      }
    : {
        x: image.x + 0.745 * image.w,
        y: image.y + 0.862 * image.h,
        w: 0.23 * image.w,
        h: 0.073 * image.h,
      };
  return { rect: r, text, tone };
}

/** The counters shown as pips: a planeswalker's loyalty is on its tag instead; at most six. */
function pipCounters(card: TableCard): [string, number][] {
  const permanent = card.located.permanent;
  if (!permanent) return [];
  const planeswalker = /\bPlaneswalker\b/.test(card.card.type_line ?? "");
  return Object.entries(permanent.counters)
    .filter(
      ([name, count]) => count > 0 && !(planeswalker && name === "loyalty"),
    )
    .slice(0, 6);
}

/** Counter pips run down just outside the image's right edge (down a tapped card's short side). */
function pipsFor(card: TableCard, image: Rect, w: SU): PipPlacement[] {
  return pipCounters(card).map(([counter, count], i) => ({
    centre: {
      x: image.x + image.w + 0.06 * w,
      y: image.y + (0.16 + i * 0.115) * image.h,
    },
    side: 0.078 * w,
    counter,
    count,
    colour:
      counter === "+1/+1" ? "cyan" : counter === "-1/-1" ? "red" : "violet",
  }));
}

function badgesFor(
  card: TableCard,
  image: Rect,
  w: SU,
  yours: boolean,
  count: number | null,
): BadgePlacement[] {
  const badges: BadgePlacement[] = [];
  if (card.mark !== "none")
    badges.push({
      centre: { x: image.x, y: image.y },
      side: 0.17 * w,
      glyph: card.mark === "selected" ? "selected" : "offered",
    });
  const permanent = card.located.permanent;
  if (permanent?.attacking || permanent?.blocking) {
    const glyph = permanent.attacking ? "attack" : "block";
    badges.push(
      yours
        ? {
            centre: { x: image.x - 0.11 * w, y: image.y + image.h / 2 },
            side: 0.18 * w,
            glyph,
          }
        : {
            centre: {
              x: image.x + image.w / 2,
              y: image.y + image.h + 0.09 * w,
            },
            side: 0.14 * w,
            glyph,
          },
    );
  }
  if (permanent?.summoning_sick)
    badges.push({
      centre: { x: image.x - 0.06 * w, y: image.y + image.h - 0.06 * w },
      side: 0.1 * w,
      glyph: "sick",
    });
  if (count !== null)
    badges.push({
      centre: { x: image.x + image.w, y: image.y },
      side: 0.22 * w,
      glyph: "count",
      text: `×${count}`,
    });
  return badges;
}

function menuSide(hit: Rect | null, offered: number): "below" | "above" {
  if (!hit) return "below";
  const needed = MENU.item * (offered + 1) + MENU.margin;
  return hit.y + hit.h + needed <= STAGE_H ? "below" : "above";
}

/* ---------- the layout ---------- */

/** Drawing order: rows by their distance from the viewer, then the stack and command cards
 * over the band, then the hand over everything. */
const Z = {
  row: (y: SU) => Math.round(y) * 1000,
  stack: 2_000_000,
  command: 2_100_000,
  hand: 3_000_000,
} as const;

const combatSteps = new Set([
  "declare_blockers",
  "first_combat_damage",
  "combat_damage",
  "end_combat",
]);

/** The seat a requested expansion really gets: none in a duel, and none while a chipped
 * opponent has something offered, so every offered object keeps a hit (C24). */
function expandedSeatFor(
  model: TableModel,
  requested: Seat | null,
): Seat | null {
  if (model.arrangement === "duel" || requested === null) return null;
  if (!model.opponents.some((p) => p.seat === requested)) return null;
  const offeredIn = (player: TablePlayer) =>
    [
      ...player.units.flatMap((unit) => [...unit.cards, ...unit.attachments]),
      ...player.graveyard,
      ...player.exile,
      ...player.command,
    ].some((key) => (model.cards.get(key)?.offered.length ?? 0) > 0);
  return model.opponents.some((p) => p.seat !== requested && offeredIn(p))
    ? null
    : requested;
}

export const layoutTable: LayoutTable = (model, options) => {
  const textScale = options.textScale;
  const nodes = new Map<string, CardNode | MoreNode>();
  const players = new Map<Seat, PlayerNode>();
  const zones: ZoneTile[] = [];
  const rows: RowLayout[] = [];
  const drops: DropZone[] = [];
  const risen = new Map<string, Rect>();
  const expandedSeat = expandedSeatFor(model, options.expandedSeat);
  const anchoredSeat = model.anchored?.seat ?? null;
  const commandTile = (player: TablePlayer) =>
    model.commander ||
    player.command.length > 0 ||
    player.commanders.length > 0;

  const cardNode = (
    key: string,
    unit: string,
    role: CardNode["role"],
    placed: { face: Rect; rotation: number; footprint: Rect },
    hit: Rect | null,
    z: number,
    w: SU,
    extra: { count?: number | null; member?: CardNode["member"] } = {},
  ): CardNode | null => {
    const card = model.cards.get(key);
    if (!card) return null;
    const node: CardNode = {
      kind: "card",
      key,
      id: card.id,
      unit,
      role,
      face: placed.face,
      rotation: placed.rotation,
      footprint: placed.footprint,
      hit,
      z,
      faceUp: !card.card.hidden && card.card.name !== null,
      tag: null,
      pips: [],
      badges: [],
      mark: card.mark,
      drawHeight: placed.face.h,
      menu: menuSide(hit, card.offered.length),
      ...(extra.member ? { member: extra.member } : {}),
    };
    const image = imageRect(node);
    if (card.zone === "battlefield") {
      node.tag = tagFor(card, image, node.rotation === 90);
      node.pips = pipsFor(card, image, w);
    }
    node.badges = badgesFor(
      card,
      image,
      w,
      card.controllerSeat === anchoredSeat,
      extra.count ?? null,
    );
    nodes.set(key, node);
    return node;
  };

  const moreNode = (
    key: string,
    hit: Rect | null,
    count: number,
    label: string,
    opens: MoreNode["opens"],
  ): MoreNode | null => {
    if (!hit || count <= 0) return null;
    const node: MoreNode = { kind: "more", key, hit, count, label, opens };
    nodes.set(key, node);
    return node;
  };

  const possessive = (player: TablePlayer) =>
    player.battlefieldLabel.replace(/ battlefield$/, "");
  const lower = (text: string) =>
    text.startsWith("Your") ? `your${text.slice(4)}` : text;

  /* --- one player's battlefield rows --- */
  const battlefield = (
    player: TablePlayer,
    front: RowSpec,
    back: RowSpec,
    c: number,
    attackerX: Map<string, number> | null,
  ) => {
    let frontUnits = player.units.filter((u) => u.row === "front");
    const lands = player.units.filter((u) => u.row === "back-lands");
    const others = player.units.filter((u) => u.row === "back-other");
    // During blocks, a defender's blockers line up under the attackers they block (§8.11).
    if (attackerX) {
      const blockerX = (unit: TableUnit) => {
        const card = model.cards.get(unit.cards[0]);
        const id = card?.located.permanent?.id;
        const group = model.combat.find(
          (g) =>
            g.blockers.includes(id ?? "") ||
            g.blockers.includes(card?.id ?? ""),
        );
        if (!group) return null;
        for (const attacker of group.attackers) {
          const x = attackerX.get(attacker);
          if (x !== undefined) return x;
        }
        return null;
      };
      const slots = frontUnits
        .map((unit, i) => ({ unit, i, x: blockerX(unit) }))
        .filter((entry) => entry.x !== null);
      const ordered = [...slots].sort((a, b) => a.x! - b.x! || a.i - b.i);
      const reordered = [...frontUnits];
      slots.forEach((slot, n) => (reordered[slot.i] = ordered[n].unit));
      frontUnits = reordered;
    }

    const boxOf = (unit: TableUnit, separate = false): RowUnitBox => {
      const members = [...unit.cards, ...unit.attachments].map((key) =>
        model.cards.get(key)!,
      );
      const host = members[0];
      return {
        key: unit.key,
        members: unit.cards.length,
        attachments: unit.attachments.map(
          (key) => model.cards.get(key)?.located.permanent?.tapped ?? false,
        ),
        tapped: unit.tapped,
        pips: host ? pipCounters(host).length > 0 : false,
        offered: members.some((card) => card.offered.length > 0),
        separate,
      };
    };

    const frontRow = packRow(
      { x0: front.x0, x1: front.x1, yCentre: front.y },
      frontUnits.map((u) => boxOf(u)),
      c,
    );
    const backList = [...lands, ...others];
    const backRow = packRow(
      { x0: back.x0, x1: back.x1, yCentre: back.y },
      backList.map((u, i) => boxOf(u, i === lands.length && lands.length > 0)),
      c,
    );

    const emit = (
      list: TableUnit[],
      packed: PackedRow,
      z0: number,
      rowName: "front" | "back",
    ) => {
      const keys: string[] = [];
      list.forEach((unit, u) => {
        const placed = packed.units[u];
        // Units that gave way lie under the row; the rest stack left to right.
        const zUnit = placed.overflow
          ? z0 - 64 * (list.length - u)
          : z0 + u * 64;
        const size = unit.cards.length;
        for (const element of placed.elements) {
          if (element.kind === "more") {
            const hidden =
              unit.kind === "host"
                ? unit.attachments.length - ATTACHMENT_CAP
                : size - PILE_CAP;
            const first = model.cards.get(unit.cards[0]);
            const more = moreNode(
              `more:${unit.key}`,
              element.hit,
              hidden,
              unit.kind === "host"
                ? `Show everything attached to ${first?.card.name ?? "this card"} (${hidden} more)`
                : `Show all ${size} ${first?.card.name ?? "cards"}`,
              { kind: "pile", unit: unit.key },
            );
            if (more) keys.push(more.key);
            continue;
          }
          const key =
            element.kind === "attachment"
              ? unit.attachments[element.index]
              : unit.cards[element.index];
          const pile = unit.kind === "lands" || unit.kind === "tokens";
          const role: CardNode["role"] =
            element.kind === "attachment"
              ? "attachment"
              : pile
                ? "pile-member"
                : "battlefield";
          const local =
            element.kind === "attachment"
              ? 30 - Math.min(element.index, 20)
              : pile
                ? Math.min(element.index, 50)
                : 40;
          const node = cardNode(
            key,
            unit.key,
            role,
            element,
            element.hit,
            zUnit + local,
            packed.card.w,
            {
              member: pile ? { index: element.index, size } : undefined,
              count:
                unit.kind === "tokens" && element.index === size - 1
                  ? size
                  : null,
            },
          );
          if (node?.hit) keys.push(node.key);
        }
      });
      const overflowed = list.filter((_, u) => packed.units[u].overflow);
      const counted = overflowed.reduce(
        (n, unit) => n + unit.cards.length + unit.attachments.length,
        0,
      );
      const more = moreNode(
        `more:row:${player.seat}:${rowName}`,
        packed.more,
        counted,
        `Show all of ${lower(possessive(player))} battlefield (${counted} more)`,
        { kind: "battlefield", seat: player.seat },
      );
      return { keys, more: more?.key ?? null };
    };

    // Rows nearer the bottom of the stage are nearer the viewer, so they draw on top.
    const frontOut = emit(frontUnits, frontRow, Z.row(front.y), "front");
    const backOut = emit(backList, backRow, Z.row(back.y), "back");
    // Every key listed here has a hit.
    const byX = (keys: string[]) =>
      [...keys].sort((a, b) => nodes.get(a)!.hit!.x - nodes.get(b)!.hit!.x);
    const landKeys = new Set(
      lands.flatMap((u) => [...u.cards, ...u.attachments, `more:${u.key}`]),
    );
    const backOther = backOut.keys.filter((key) => !landKeys.has(key));
    const backLands = backOut.keys.filter((key) => landKeys.has(key));
    const othersRow = [
      ...byX(frontOut.keys),
      ...(frontOut.more ? [frontOut.more] : []),
      ...byX(backOther),
      ...(backOut.more && others.length > 0 ? [backOut.more] : []),
    ];
    const landsRow = [
      ...byX(backLands),
      ...(backOut.more && others.length === 0 ? [backOut.more] : []),
    ];
    const label = player.battlefieldLabel;
    if (othersRow.length > 0)
      rows.push({
        key: `row:${player.seat}:others`,
        seat: player.seat,
        label: `${label}: creatures and other permanents`,
        nodes: othersRow,
      });
    if (landsRow.length > 0)
      rows.push({
        key: `row:${player.seat}:lands`,
        seat: player.seat,
        label: `${label}: lands`,
        nodes: landsRow,
      });
  };

  /* --- plates and tiles --- */
  const tiles = (
    player: TablePlayer,
    g: {
      graveyard: Rect;
      exile: Rect;
      library: { pile: Rect; top: Rect; front: Rect };
      command: { tile: Rect; card: Rect } | null;
    },
  ) => {
    const seat = player.seat;
    const top = (keys: string[]) => keys[keys.length - 1] ?? null;
    zones.push(
      {
        key: `tile:${seat}:graveyard`,
        seat,
        zone: "graveyard",
        card: g.graveyard,
        hit: g.graveyard,
        pedestal: null,
        label: `Graveyard ${player.graveyard.length}`,
        topKey: top(player.graveyard),
        count: player.graveyard.length,
      },
      {
        key: `tile:${seat}:exile`,
        seat,
        zone: "exile",
        card: g.exile,
        hit: g.exile,
        pedestal: null,
        label: `Exile ${player.exile.length}`,
        topKey: top(player.exile),
        count: player.exile.length,
      },
      {
        key: `tile:${seat}:library`,
        seat,
        zone: "library",
        card: g.library.pile,
        hit: null,
        pedestal: { top: g.library.top, front: g.library.front },
        label: `Library ${player.player.library_count}`,
        topKey: null,
        count: player.player.library_count,
      },
    );
    if (g.command && commandTile(player)) {
      const taxes = player.commanders.map((commander) => commander.tax);
      zones.push({
        key: `tile:${seat}:command`,
        seat,
        zone: "command",
        card: g.command.card,
        hit: g.command.tile,
        pedestal: null,
        label: `Command ${player.command.length}${taxes.length > 0 ? ` · Tax ${taxes.join("/")}` : ""}`,
        topKey: top(player.command),
        count: player.command.length,
      });
    }
  };

  const plate = (
    player: TablePlayer,
    g: Pick<
      SeatGeometry,
      | "area"
      | "portrait"
      | "life"
      | "target"
      | "counts"
      | "name"
      | "title"
      | "pills"
      | "statusRow"
      | "expand"
    >,
    phase: PlayerNode["phase"],
    chip = false,
  ) => {
    players.set(player.seat, {
      seat: player.seat,
      chip,
      area: g.area,
      portrait: g.portrait,
      life: g.life,
      counts: g.counts,
      target: g.target,
      name: { ...g.name, size: g.name.size * textScale },
      title:
        player.title && !chip
          ? { ...g.title, size: g.title.size * textScale }
          : null,
      pills: g.pills,
      statusRow: g.statusRow,
      expand: g.expand,
      phase,
    });
  };

  /* --- a teammate's hand (Two-Headed Giant, v0.5.1) --- */
  // Face up along the near edge of their area, under their front row, as many cards as keep
  // their hits; the rest behind a "+N" that lists the whole hand.
  const teamHand = (player: TablePlayer, g: SeatGeometry) => {
    const keys = player.hand;
    if (!keys || keys.length === 0) return;
    const slots = fanTeamHand(keys.length, teamHandRegion(g.area));
    if (slots.length === 0) return;
    const withHits =
      keys.length > slots.length ? slots.length - 1 : keys.length;
    const unit = `hand:${player.seat}`;
    // Under the front row: an attacker drawn towards the band passes over the fan.
    const z0 = Z.row(g.front.y) - 500;
    const handKeys: string[] = [];
    keys.forEach((key, i) => {
      const slot = slots[Math.min(i, slots.length - 1)];
      const node = cardNode(
        key,
        unit,
        "teammate-hand",
        {
          face: slot.face,
          rotation: slot.rotation,
          footprint: turnedBox(slot.face, slot.rotation, centre(slot.face)),
        },
        i < withHits ? slot.hit : null,
        z0 + i,
        slot.face.w,
      );
      if (node?.hit) handKeys.push(key);
    });
    if (keys.length > slots.length) {
      const last = slots[slots.length - 1];
      const more = moreNode(
        `more:${unit}`,
        last.hit,
        keys.length - withHits,
        `Show all ${keys.length} cards in ${player.name}'s hand (${keys.length - withHits} more)`,
        { kind: "hand", seat: player.seat },
      );
      if (more) handKeys.push(more.key);
    }
    rows.push({
      key: unit,
      seat: player.seat,
      label: `${player.name}'s hand`,
      nodes: handKeys,
    });
  };

  /* --- opponents --- */
  const opponentGeometry = new Map<Seat, { g: SeatGeometry; c: number }>();
  const chips: TablePlayer[] = [];
  // A seat that shows a teammate's hand (v0.5.1) lifts its rows for the fan under them.
  const shown = (player: TablePlayer, g: SeatGeometry, rows: Arrangement) =>
    player.hand ? withTeamHand(g, TEAM_HAND.rows[rows]) : g;
  if (model.arrangement === "duel" || expandedSeat !== null) {
    for (const player of model.opponents) {
      if (
        model.arrangement === "duel"
          ? player === model.opponents[0]
          : player.seat === expandedSeat
      )
        opponentGeometry.set(player.seat, {
          g: shown(player, DUEL, "duel"),
          c: C_FACTOR.duel.opponents,
        });
      else chips.push(player);
    }
  } else {
    const spec = model.arrangement === "three" ? THREE : FOUR;
    model.opponents.forEach((player, i) => {
      const x0 = spec.columns[i];
      if (x0 === undefined) chips.push(player);
      else
        opponentGeometry.set(player.seat, {
          g: shown(player, spec.seat(x0), model.arrangement),
          c: C_FACTOR[model.arrangement].opponents,
        });
    });
  }

  const placedOpponents = model.opponents.filter((p) =>
    opponentGeometry.has(p.seat),
  );
  const anchored = model.anchored;
  const layoutSide = (
    player: TablePlayer,
    attackerX: Map<string, number> | null,
  ) => {
    if (player === anchored)
      battlefield(
        player,
        YOU.front,
        YOU.back,
        C_FACTOR[model.arrangement].you,
        attackerX,
      );
    else {
      const { g, c } = opponentGeometry.get(player.seat)!;
      battlefield(player, g.front, g.back, c, attackerX);
    }
  };

  // During blocks a defender's blockers follow their attackers, so the attacking side is laid
  // out first and the defenders after it, knowing where the attackers are.
  const sides = [...placedOpponents, ...(anchored ? [anchored] : [])];
  const blocking =
    combatSteps.has(model.step ?? "") &&
    model.combat.some((group) => group.blockers.length > 0);
  if (blocking) {
    const keyOf = new Map<string, string>();
    for (const card of model.cards.values())
      if (card.zone === "battlefield") {
        keyOf.set(card.id, card.key);
        if (card.located.permanent)
          keyOf.set(card.located.permanent.id, card.key);
      }
    const defenders = new Set<Seat>();
    for (const group of model.combat)
      for (const id of group.blockers) {
        const seat = model.cards.get(keyOf.get(id) ?? "")?.controllerSeat;
        if (seat !== null && seat !== undefined) defenders.add(seat);
      }
    for (const side of sides)
      if (!defenders.has(side.seat)) layoutSide(side, null);
    const attackerX = new Map<string, number>();
    for (const group of model.combat)
      for (const id of group.attackers) {
        const node = nodes.get(keyOf.get(id) ?? "");
        if (node?.kind === "card") attackerX.set(id, centre(node.face).x);
      }
    for (const side of sides)
      if (defenders.has(side.seat)) layoutSide(side, attackerX);
  } else for (const side of sides) layoutSide(side, null);

  for (const player of placedOpponents) {
    const { g } = opponentGeometry.get(player.seat)!;
    plate(player, g, null);
    tiles(player, {
      graveyard: g.graveyard,
      exile: g.exile,
      library: g.library,
      command: g.command,
    });
    teamHand(player, g);
    // Nobody attacks their teammate: a drop there means nothing (v0.5.1).
    if (player.teammate) continue;
    drops.push(
      model.arrangement === "duel" || player.seat === expandedSeat
        ? {
            kind: "attack",
            rect: DROPS.opponentsHalf,
            seat: model.arrangement === "duel" ? null : player.seat,
          }
        : { kind: "attack", rect: g.area, seat: player.seat },
    );
    if (model.arrangement !== "duel" && player.seat !== expandedSeat)
      drops.push({ kind: "attack", rect: g.target, seat: player.seat });
  }

  // Chips: the opponents left over while another one's board is expanded (UI02).
  const chipCentres =
    model.arrangement === "duel" ? [] : CHIP.centres[model.arrangement];
  chips.forEach((player, i) => {
    const cx = chipCentres[i] ?? chipCentres[chipCentres.length - 1] ?? 960;
    const target = rect(cx - CHIP.half, CHIP.top, cx + CHIP.half, CHIP.bottom);
    plate(
      player,
      {
        area: target,
        portrait: diamond(cx + CHIP.portrait.dx, CHIP.y, CHIP.portrait.side),
        life: diamond(cx + CHIP.life.dx, CHIP.y + CHIP.life.dy, CHIP.life.side),
        target,
        counts: {
          hand: diamond(
            cx + CHIP.counts.dx[0],
            CHIP.counts.y,
            CHIP.counts.side,
          ),
          graveyard: diamond(
            cx + CHIP.counts.dx[1],
            CHIP.counts.y,
            CHIP.counts.side,
          ),
          library: diamond(
            cx + CHIP.counts.dx[2],
            CHIP.counts.y,
            CHIP.counts.side,
          ),
        },
        name: {
          anchor: { x: cx + CHIP.name.dx, y: CHIP.name.y },
          align: "left",
          size: CHIP.name.size,
          maxWidth: CHIP.name.maxWidth,
        },
        title: {
          anchor: { x: cx + CHIP.name.dx, y: CHIP.name.y },
          align: "left",
          size: 18,
          maxWidth: CHIP.name.maxWidth,
        },
        pills: rect(cx + CHIP.name.dx, 60, cx + CHIP.half - 4, 76),
        statusRow: rect(cx + CHIP.name.dx, 60, cx + CHIP.half - 4, 76),
        expand: diamond(cx + CHIP.expand.dx, CHIP.expand.y, CHIP.expand.side),
      },
      null,
      true,
    );
    const count = player.units.reduce(
      (n, unit) => n + unit.cards.length + unit.attachments.length,
      0,
    );
    const more = moreNode(
      `more:chip:${player.seat}`,
      rect(cx + CHIP.more.dx0, CHIP.more.y0, cx + CHIP.more.dx1, CHIP.more.y1),
      count,
      `Show ${player.player.name}'s battlefield (${count} permanents)`,
      { kind: "battlefield", seat: player.seat },
    );
    if (more)
      rows.push({
        key: `row:${player.seat}:chip`,
        seat: player.seat,
        label: player.battlefieldLabel,
        nodes: [more.key],
      });
    drops.push({ kind: "attack", rect: target, seat: player.seat });
  });

  /* --- the anchored player: plate, zones, command cards, hand --- */
  let handStep = 0;
  if (anchored) {
    plate(anchored, YOU, { caption: YOU.phaseCaption, bar: YOU.phaseBar });
    const plateRect = {
      ...YOU.commandPlate,
      h: YOU.commandPlate.h * textScale,
    };
    tiles(anchored, {
      graveyard: YOU.graveyard,
      exile: YOU.exile,
      library: YOU.library,
      command: { tile: plateRect, card: YOU.commandCard },
    });

    // Command cards: the top one whole, the one before it as a 40 su strip, the rest behind
    // a "+N" in that strip.
    const command = anchored.command;
    const unit = `command:${anchored.seat}`;
    const commandKeys: string[] = [];
    command.forEach((key, i) => {
      const fromTop = command.length - 1 - i;
      const shift = Math.min(fromTop, 1) * YOU.commandFan;
      const face = { ...YOU.commandCard, x: YOU.commandCard.x - shift };
      const hit =
        fromTop === 0
          ? YOU.commandCard
          : fromTop === 1 && command.length <= YOU.commandCap
            ? rect(face.x, face.y, face.x + YOU.commandFan, face.y + face.h)
            : null;
      const node = cardNode(
        key,
        unit,
        "command",
        { face, rotation: 0, footprint: face },
        hit,
        Z.command + i,
        face.w,
      );
      if (node?.hit) commandKeys.push(node.key);
    });
    if (command.length > YOU.commandCap) {
      const strip = rect(
        YOU.commandCard.x - YOU.commandFan,
        YOU.commandCard.y,
        YOU.commandCard.x,
        YOU.commandCard.y + YOU.commandCard.h,
      );
      const more = moreNode(
        "more:command",
        strip,
        command.length - 1,
        `Show all of ${lower(possessive(anchored))} command zone (${command.length - 1} more)`,
        { kind: "zone", seat: anchored.seat, zone: "command" },
      );
      if (more) commandKeys.unshift(more.key);
    }
    if (commandKeys.length > 0)
      rows.push({
        key: unit,
        seat: anchored.seat,
        label: anchored.battlefieldLabel.replace(
          /battlefield$/,
          "command zone",
        ),
        nodes: commandKeys,
      });

    // The hand fans along the bottom edge, partly off the stage.
    const n = model.hand.length;
    const slots = fanHand(n);
    const withHits = n > HAND.slots ? HAND.slots - 1 : n;
    handStep = slots.length > 1 ? slots[1].face.x - slots[0].face.x : 0;
    const handKeys: string[] = [];
    model.hand.forEach((key, i) => {
      const slot = slots[Math.min(i, slots.length - 1)];
      const pivot = {
        x: slot.face.x + slot.face.w / 2,
        y: slot.face.y + slot.face.h,
      };
      const hit = i < withHits ? slot.hit : null;
      const node = cardNode(
        key,
        "hand",
        "hand",
        {
          face: slot.face,
          rotation: slot.rotation,
          footprint: turnedBox(slot.face, slot.rotation, pivot),
        },
        hit,
        Z.hand + i,
        slot.face.w,
      );
      if (!node) return;
      node.menu = "above";
      if (hit) {
        handKeys.push(key);
        const { scale, bottom, minX, maxX } = HAND.rise;
        const w = HAND.card.w * scale;
        const h = HAND.card.h * scale;
        const cx = clamp(pivot.x, minX, maxX);
        risen.set(key, { x: cx - w / 2, y: bottom - h, w, h });
      }
    });
    if (n > HAND.slots) {
      const last = slots[slots.length - 1];
      const more = moreNode(
        "more:hand",
        { ...last.face, h: STAGE_H - last.face.y },
        n - withHits,
        `Show all ${n} cards in ${lower(model.handTitle)} (${n - withHits} more)`,
        { kind: "hand" },
      );
      if (more) handKeys.push(more.key);
    }
    if (handKeys.length > 0)
      rows.push({
        key: "hand",
        seat: anchored.seat,
        label: model.handTitle,
        nodes: handKeys,
      });

    drops.push(
      { kind: "battlefield", rect: DROPS.yours },
      { kind: "battlefield", rect: DROPS.band },
    );
  }

  /* --- the stack, on the band (§8.3) --- */
  const slot = (i: number) => {
    const k = STACK.shrink ** i;
    const w = STACK.top.w * k;
    const h = STACK.top.h * k;
    const cx = STACK.top.cx - STACK.step * i;
    return { x: cx - w / 2, y: STACK.top.cy - h / 2, w, h };
  };
  model.stack.forEach((entry, i) => {
    const drawn = Math.min(i, STACK.drawn - 1);
    const box = slot(drawn);
    const hit =
      i === 0
        ? box
        : i < STACK.drawn
          ? { ...box, w: slot(i - 1).x - box.x }
          : null;
    // An ability shows its source's picture a little smaller; its hit keeps the whole slot.
    const face =
      entry.item.kind === "ability"
        ? {
            x: box.x + (box.w * (1 - STACK.abilityScale)) / 2,
            y: box.y + (box.h * (1 - STACK.abilityScale)) / 2,
            w: box.w * STACK.abilityScale,
            h: box.h * STACK.abilityScale,
          }
        : box;
    cardNode(
      entry.key,
      "stack",
      "stack",
      { face, rotation: 0, footprint: box },
      hit,
      Z.stack + (STACK.drawn - drawn) * 8 - (i >= STACK.drawn ? 1 : 0),
      box.w,
    );
  });
  if (model.stack.length > STACK.drawn)
    moreNode(
      "more:stack",
      diamondBox(STACK.more),
      model.stack.length - STACK.drawn,
      `Show the whole stack (${model.stack.length - STACK.drawn} more)`,
      { kind: "stack" },
    );

  /* --- block drops: the attacking creatures --- */
  for (const card of model.cards.values()) {
    const node = nodes.get(card.key);
    if (card.located.permanent?.attacking && node?.kind === "card")
      drops.push({ kind: "card", key: card.key, rect: imageRect(node) });
  }

  /* --- curves --- */
  const portraitCentre = (seat: Seat): Point | null => {
    const p = players.get(seat)?.portrait;
    return p ? { x: p.cx, y: p.cy } : null;
  };
  const endOf = (end: { seat: Seat } | { key: string }): Point | null => {
    if ("seat" in end) return portraitCentre(end.seat);
    const node = nodes.get(end.key);
    if (node?.kind === "card") return centre(imageRect(node));
    const tile = zones.find((t) => t.topKey === end.key);
    if (tile) return centre(tile.card);
    const card = model.cards.get(end.key);
    const seat = card?.controllerSeat ?? card?.ownerSeat;
    return seat === null || seat === undefined ? null : portraitCentre(seat);
  };
  const curves: CurvePlacement[] = [];
  for (const line of model.lines) {
    let p0: Point | null;
    let p1: Point | null;
    if (line.kind === "cast" && "key" in line.to) {
      p0 = endOf(line.from);
      const node = nodes.get(line.to.key);
      if (!p0 || node?.kind !== "card") continue;
      const r = imageRect(node);
      const edges = [
        { x: r.x + r.w / 2, y: r.y },
        { x: r.x + r.w / 2, y: r.y + r.h },
        { x: r.x, y: r.y + r.h / 2 },
        { x: r.x + r.w, y: r.y + r.h / 2 },
      ];
      const from = p0;
      p1 = edges.reduce((a, b) =>
        Math.hypot(a.x - from.x, a.y - from.y) <=
        Math.hypot(b.x - from.x, b.y - from.y)
          ? a
          : b,
      );
    } else if (line.kind === "target" && "key" in line.from) {
      const node = nodes.get(line.from.key);
      if (node?.kind !== "card") continue;
      const r = imageRect(node);
      p0 = { x: r.x + r.w / 2, y: r.y };
      p1 = endOf(line.to);
    } else {
      p0 = endOf(line.from);
      p1 = endOf(line.to);
    }
    if (!p0 || !p1) continue;
    const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    curves.push({
      key: line.key,
      kind: line.kind,
      p0,
      c: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 - 0.25 * length },
      p1,
      owner: line.owner,
      emphasis: line.emphasis,
    });
  }

  /* --- the band and the table plane --- */
  const hud = (x: SU): Diamond => diamond(x, BAND.y, BAND.hud.side);
  const inCombat = model.phase === "combat";
  const stepRight = inCombat ? BAND.stepRightCombat : BAND.stepRight;
  const band: BandLayout = {
    rect: BAND.rect,
    hud: {
      menu: hud(BAND.hud.menu),
      log: hud(BAND.hud.log),
      priority: hud(BAND.hud.priority),
      fullscreen: hud(BAND.hud.fullscreen),
      // The slot is always kept; the HUD shows it to SysOp only.
      inspection: hud(BAND.hud.inspection),
    },
    turnText: BAND.turnText,
    status: BAND.status,
    stepText: rect(stepRight - BAND.stepWidth, 494, stepRight, 526),
    combatIcons: BAND.combatIcons.x.map((x) =>
      diamond(x, BAND.y, BAND.combatIcons.side),
    ) as [Diamond, Diamond, Diamond],
    phases: BAND.phases.x.map((x) => diamond(x, BAND.y, BAND.phases.side)),
    emblem: BAND.emblem,
    emblemCaption: BAND.emblemCaption,
  };

  const vp = PLANE.vanishingPoint;
  const field = (x: SU): [Point, Point] => {
    const t = (PLANE.quad[0].y - vp.y) / (STAGE_H - vp.y);
    return [
      { x: vp.x + (x - vp.x) * t, y: PLANE.quad[0].y },
      { x, y: STAGE_H },
    ];
  };
  const edgeX = (y: SU, side: 0 | 1): SU => {
    const [far, near] =
      side === 0
        ? [PLANE.quad[0], PLANE.quad[3]]
        : [PLANE.quad[1], PLANE.quad[2]];
    return far.x + ((y - far.y) / (near.y - far.y)) * (near.x - far.x);
  };
  const grooves: [Point, Point][] = [
    ...PLANE.fieldLines.map(field),
    ...PLANE.rims.map((y): [Point, Point] => [
      { x: edgeX(y, 0), y },
      { x: edgeX(y, 1), y },
    ]),
  ];
  if (expandedSeat === null && model.arrangement !== "duel")
    for (const x of (model.arrangement === "three"
      ? THREE
      : FOUR
    ).columns.slice(1))
      grooves.push([
        { x, y: 0 },
        { x, y: 476 },
      ]);
  const sockets: Diamond[] = [
    ...[...players.values()]
      .filter((p) => !p.chip)
      .map((p) =>
        diamond(
          p.portrait.cx,
          p.portrait.cy,
          p.portrait.side + PLANE.socketMargin,
        ),
      ),
    PLANE.bandSocket,
  ];

  // Rows in DOM order: opponents left to right (a teammate's hand after their battlefield), then
  // your battlefield, command zone and hand.
  const seatRank = new Map(
    [...model.opponents, ...(anchored ? [anchored] : [])].map((p, i) => [
      p.seat,
      i,
    ]),
  );
  const rank = (row: RowLayout) =>
    row.key === "hand"
      ? 3e6
      : row.key.startsWith("command:")
        ? 2e6
        : (seatRank.get(row.seat ?? -1) ?? 1e3) * 10 +
          (row.key.endsWith(":lands")
            ? 1
            : row.key.startsWith("hand:")
              ? 2
              : 0);
  rows.sort((a, b) => rank(a) - rank(b));

  return {
    arrangement: model.arrangement,
    expandedSeat,
    nodes,
    players,
    zones,
    rows,
    band,
    stackLane: STACK.lane,
    hand: { area: HAND.area, step: handStep },
    risen,
    curves,
    drops,
    regions: REGIONS,
    table: { quad: PLANE.quad, grooves, sockets },
  };
};

/* ---------- hit testing ---------- */

export interface HitEntry {
  /** A node key, a tile key, `player:<seat>`, `expand:<seat>`, `hud:<name>` or `column`. */
  key: string;
  kind: "card" | "more" | "tile" | "player" | "expand" | "hud" | "column";
  rect: Rect;
  role?: CardNode["role"];
}

const entryCache = new WeakMap<TableLayout, HitEntry[]>();

/** Every interactive box on the table, as validateHits checks them and hitTest finds them. */
export function hitEntries(layout: TableLayout): HitEntry[] {
  const cached = entryCache.get(layout);
  if (cached) return cached;
  const entries: HitEntry[] = [];
  for (const node of layout.nodes.values())
    if (node.hit)
      entries.push({
        key: node.key,
        kind: node.kind,
        rect: node.hit,
        role: node.kind === "card" ? node.role : undefined,
      });
  for (const tile of layout.zones)
    if (tile.hit) entries.push({ key: tile.key, kind: "tile", rect: tile.hit });
  for (const player of layout.players.values()) {
    entries.push({
      key: `player:${player.seat}`,
      kind: "player",
      rect: player.target,
    });
    entries.push({
      key: `expand:${player.seat}`,
      kind: "expand",
      rect: diamondBox(player.expand),
    });
  }
  for (const [name, d] of Object.entries(layout.band.hud))
    if (d)
      entries.push({ key: `hud:${name}`, kind: "hud", rect: diamondBox(d) });
  entries.push({ key: "column", kind: "column", rect: layout.regions.column });
  entryCache.set(layout, entries);
  return entries;
}

/** The node, tile or player (`player:<seat>`) under a point, or null. */
export function hitTest(layout: TableLayout, p: Point): string | null {
  for (const entry of hitEntries(layout))
    if (
      (entry.kind === "card" ||
        entry.kind === "more" ||
        entry.kind === "tile" ||
        entry.kind === "player") &&
      contains(entry.rect, p)
    )
      return entry.key;
  return null;
}

/** The most specific drop zone under a point: a card, then a portrait or column, then a half. */
export function dropZoneAt(layout: TableLayout, p: Point): DropZone | null {
  let best: DropZone | null = null;
  for (const zone of layout.drops)
    if (
      contains(zone.rect, p) &&
      (!best || zone.rect.w * zone.rect.h < best.rect.w * best.rect.h)
    )
      best = zone;
  return best;
}

/** The magnifier opens on the side away from what it shows. */
export function magnifierSide(anchorX: SU): "left" | "right" {
  return anchorX < STAGE_W / 2 ? "right" : "left";
}

/* ---------- invariants (§8.11) ---------- */

const round = (n: number) => Math.round(n * 10) / 10;
const describe = (r: Rect) =>
  `${round(r.x)}–${round(r.x + r.w)} × ${round(r.y)}–${round(r.y + r.h)}`;

/** [] when the layout keeps every invariant of §8.11; otherwise one message per problem. Given
 * the model it was made from, it also checks that every object in the hand, on the battlefield,
 * on the stack and in your command zone is a node with a hit, or counted by exactly one "+N". */
export function validateHits(
  layout: TableLayout,
  model?: TableModel,
): string[] {
  const problems: string[] = [];
  const entries = hitEntries(layout);

  // 1. Inside the stage, and 3. big enough to hit.
  for (const { key, rect: r, role } of entries) {
    if (
      r.x < -EPSILON ||
      r.y < -EPSILON ||
      r.x + r.w > STAGE_W + EPSILON ||
      r.y + r.h > STAGE_H + EPSILON
    )
      problems.push(`${key} at ${describe(r)} leaves the stage`);
    const minWidth = role === "hand" ? MIN_HAND_SLICE : MIN_HIT;
    if (r.w < minWidth - EPSILON || r.h < MIN_HIT - EPSILON)
      problems.push(
        `${key} at ${describe(r)} is smaller than ${minWidth} × ${MIN_HIT} su`,
      );
  }

  // 2. Pairwise disjoint, by a sweep along x.
  const sorted = [...entries].sort((a, b) => a.rect.x - b.rect.x);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.rect.x >= a.rect.x + a.rect.w - EPSILON) break;
      if (overlaps(a.rect, b.rect))
        problems.push(
          `${a.key} at ${describe(a.rect)} overlaps ${b.key} at ${describe(b.rect)}`,
        );
    }
  }

  // 4. Every row's DOM order follows x along each physical row, and every hit card is in one row
  // (the stack keeps its own order, top first).
  const inRows = new Map<string, number>();
  for (const row of layout.rows) {
    let previous: Rect | null = null;
    for (const key of row.nodes) {
      inRows.set(key, (inRows.get(key) ?? 0) + 1);
      const node = layout.nodes.get(key);
      if (!node?.hit) {
        problems.push(`row ${row.key} lists ${key}, which has no hit`);
        continue;
      }
      const r = node.hit;
      if (previous) {
        const shared =
          Math.min(previous.y + previous.h, r.y + r.h) -
          Math.max(previous.y, r.y);
        if (
          shared > 0.5 * Math.min(previous.h, r.h) &&
          r.x <= previous.x + EPSILON
        )
          problems.push(
            `row ${row.key} puts ${key} before the card to its left`,
          );
      }
      previous = r;
    }
  }
  for (const node of layout.nodes.values()) {
    const stack =
      node.kind === "card" ? node.role === "stack" : node.key === "more:stack";
    if (!node.hit || stack) continue;
    const count = inRows.get(node.key) ?? 0;
    if (count !== 1) problems.push(`${node.key} is in ${count} rows`);
  }

  // 5. What has no hit is counted by a "+N".
  const chipped = (seat: Seat) => layout.players.get(seat)?.chip ?? false;
  let counted = 0;
  let hitless = 0;
  for (const node of layout.nodes.values())
    if (node.kind === "more") {
      if (!(node.opens.kind === "battlefield" && chipped(node.opens.seat)))
        counted += node.count;
    } else if (!node.hit) hitless++;
  if (counted !== hitless)
    problems.push(
      `"+N" buttons count ${counted} cards, but ${hitless} cards have no hit`,
    );
  if (model) problems.push(...coverage(layout, model));

  // 7. Tags stay clear of the copyright line, pips stay off the image.
  for (const node of layout.nodes.values()) {
    if (node.kind !== "card") continue;
    const image = imageRect(node);
    const tag = node.tag?.rect;
    if (tag) {
      const clear =
        node.rotation === 90
          ? tag.x >= image.x + 0.065 * image.w - EPSILON
          : tag.y + tag.h <= image.y + 0.935 * image.h + EPSILON;
      if (!clear) problems.push(`${node.key}'s tag covers the copyright line`);
    }
    for (const pip of node.pips)
      if (
        pip.centre.x - (pip.side * Math.SQRT2) / 2 <
        image.x + image.w - EPSILON
      )
        problems.push(`${node.key}'s ${pip.counter} pip lies on the image`);
  }
  return problems;
}

/** Invariant 5 with the model: each object is one node, and each "+N" counts its own. */
function coverage(layout: TableLayout, model: TableModel): string[] {
  const problems: string[] = [];
  const expected = new Map<string, number>();
  const count = (more: string) =>
    expected.set(more, (expected.get(more) ?? 0) + 1);
  const anchored = model.anchored;
  const need = (key: string, more: string) => {
    const node = layout.nodes.get(key);
    if (!node || node.kind !== "card") problems.push(`${key} has no node`);
    else if (!node.hit) count(more);
  };
  model.hand.forEach((key) => need(key, "more:hand"));
  model.stack.forEach((entry) => need(entry.key, "more:stack"));
  anchored?.command.forEach((key) => need(key, "more:command"));
  for (const player of [anchored, ...model.opponents]) {
    if (!player) continue;
    if (layout.players.get(player.seat)?.chip) {
      for (const unit of player.units)
        for (const key of [...unit.cards, ...unit.attachments]) {
          if (layout.nodes.has(key))
            problems.push(`${key} is drawn on a chipped board`);
          count(`more:chip:${player.seat}`);
        }
      // A chipped teammate's hand waits, undrawn, until the board is collapsed again.
      for (const key of player.hand ?? [])
        if (layout.nodes.has(key))
          problems.push(`${key} is drawn beside a chip`);
      continue;
    }
    player.hand?.forEach((key) => need(key, `more:hand:${player.seat}`));
    for (const unit of player.units) {
      const keys = [...unit.cards, ...unit.attachments];
      const shown = keys.some((key) => layout.nodes.get(key)?.hit);
      const more = shown
        ? `more:${unit.key}`
        : `more:row:${player.seat}:${unit.row === "front" ? "front" : "back"}`;
      keys.forEach((key) => need(key, more));
    }
  }
  for (const [key, n] of expected) {
    const node = layout.nodes.get(key);
    if (node?.kind !== "more")
      problems.push(`${n} cards need ${key}, which is missing`);
    else if (node.count !== n)
      problems.push(`${key} counts ${node.count}, not ${n}`);
  }
  for (const node of layout.nodes.values())
    if (node.kind === "more" && !expected.has(node.key))
      problems.push(`${node.key} counts nothing`);
  return problems;
}
