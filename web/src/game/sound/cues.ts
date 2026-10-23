import type { Seat } from "../types";
import {
  STAGE_W,
  type Exit,
  type Rect,
  type TableDiff,
  type TableEvent,
  type TableLayout,
  type ZoneName,
} from "../table/types";
import { clampPan, MAX_VOICES } from "./engine";
import type { Cue } from "./recipes";

// Which sounds a change to the table makes (design §17). Cues come only from the events derived
// from committed views (never from the log), so a sound can tell nothing the table does not show.
// Each cue is panned to where its card or player sits on the stage.

export interface CueCall {
  cue: Cue;
  pan: number;
  delayMs: number;
  low?: boolean;
}

/** One diff's cues start this far apart. */
export const CUE_STAGGER_MS = 60;

/** When a diff would make more cues than voices, the first of these are kept. */
const RANK: Cue[] = [
  "victory",
  "defeat",
  "drawGame",
  "yourTurn",
  "cast",
  "resolve",
  "attack",
  "block",
  "damage",
  "lifeGain",
  "die",
  "enter",
  "land",
  "refused",
  "phase",
  "draw",
  "counter",
  "tap",
  "tick",
];

const COMBAT_STEPS = new Set([
  "begin_combat",
  "declare_attackers",
  "declare_blockers",
  "first_combat_damage",
  "combat_damage",
  "end_combat",
]);

/** (x − 960) / 1600, within ±0.6: the stage's centre is straight ahead. */
export function panAt(x: number): number {
  return clampPan((x - STAGE_W / 2) / 1600);
}

function centre(rect: Rect): number {
  return rect.x + rect.w / 2;
}

function nodeX(layout: TableLayout, key: string): number | null {
  const node = layout.nodes.get(key);
  if (node) return centre(node.kind === "card" ? node.footprint : node.hit);
  // A card that went to a graveyard or exile is shown on its zone tile.
  const tile = layout.zones.find((zone) => zone.topKey === key);
  return tile ? centre(tile.card) : null;
}

function seatX(layout: TableLayout, seat: Seat | null): number | null {
  if (seat === null) return null;
  return layout.players.get(seat)?.portrait.cx ?? null;
}

function tileX(
  layout: TableLayout,
  seat: Seat,
  zone: ZoneName | "library",
): number | null {
  const tile = layout.zones.find(
    (found) => found.seat === seat && found.zone === zone,
  );
  return tile ? centre(tile.card) : null;
}

function exitX(layout: TableLayout, to: Exit): number | null {
  if (to.kind === "node") return nodeX(layout, to.key);
  if (to.kind === "vanish") return null;
  if (to.anchor === "band") return STAGE_W / 2;
  if (to.anchor === "hand")
    return layout.players.get(to.seat)?.counts.hand.cx ?? null;
  return tileX(layout, to.seat, to.anchor) ?? seatX(layout, to.seat);
}

function meanX(layout: TableLayout, keys: string[]): number | null {
  const xs = keys.flatMap((key) => {
    const x = nodeX(layout, key);
    return x === null ? [] : [x];
  });
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Where on the stage the event happens; null for the band's events and anything not drawn. */
function eventX(event: TableEvent, layout: TableLayout): number | null {
  switch (event.type) {
    case "draw":
      return tileX(layout, event.seat, "library") ?? seatX(layout, event.seat);
    case "cast":
    case "enter":
    case "tap":
    case "damage":
      return nodeX(layout, event.key);
    case "resolve":
      return exitX(layout, event.to) ?? nodeX(layout, event.key);
    case "leave":
      return exitX(layout, event.to);
    case "counters":
      return event.key !== null
        ? nodeX(layout, event.key)
        : seatX(layout, event.seat);
    case "life":
    case "commanderDamage":
      return seatX(layout, event.seat);
    case "attack":
    case "block":
      return meanX(layout, event.keys);
    default:
      return null;
  }
}

function toGraveyard(to: Exit): boolean {
  return to.kind === "node"
    ? to.key.startsWith("graveyard:")
    : to.kind === "anchor" && to.anchor === "graveyard";
}

/** The cue for one event, or null when it makes no sound. */
function cueOf(
  event: TableEvent,
  viewSeat: Seat | null,
): { cue: Cue; low?: boolean } | null {
  switch (event.type) {
    case "draw":
      return { cue: "draw" };
    case "cast":
      return { cue: "cast" };
    case "resolve":
      // A permanent spell's bell; an instant's effect has its own sounds (damage, life).
      return event.to.kind === "node" && event.to.key.startsWith("battlefield:")
        ? { cue: "resolve" }
        : null;
    case "enter":
      return { cue: event.land ? "land" : "enter" };
    case "leave":
      // A token that dies stops existing, so no graveyard grows and it only fades: a creature
      // that vanishes has died as far as the ear goes.
      return event.creature &&
        (toGraveyard(event.to) || event.to.kind === "vanish")
        ? { cue: "die" }
        : null;
    case "tap":
      return { cue: "tap" };
    case "counters":
      return event.delta === 0
        ? null
        : { cue: "counter", low: event.delta < 0 };
    case "damage":
      return event.amount > 0 ? { cue: "damage" } : null;
    case "life":
      return event.delta < 0
        ? { cue: "damage" }
        : event.delta > 0
          ? { cue: "lifeGain" }
          : null;
    case "commanderDamage":
      return event.delta > 0 ? { cue: "damage" } : null;
    case "attack":
      return { cue: "attack" };
    case "block":
      return { cue: "block" };
    case "turn":
      // A Two-Headed Giant teammate's turn is the viewer's too (v0.5.1): the event says so.
      return (event.yours ??
        (viewSeat !== null && event.activeSeat === viewSeat))
        ? { cue: "yourTurn" }
        : null;
    case "step":
      return event.emblem !== null ? { cue: "phase" } : null;
    case "result":
      return {
        cue:
          event.outcome === "victory"
            ? "victory"
            : event.outcome === "defeat"
              ? "defeat"
              : "drawGame",
      };
    default:
      return null;
  }
}

function stagger(cues: Omit<CueCall, "delayMs">[]): CueCall[] {
  return cues.map((cue, i) => ({ ...cue, delayMs: i * CUE_STAGGER_MS }));
}

/** The cues for one diff, in event order and staggered. A baseline (a first draw, a resync, a tab
 * coming back) makes none. Each cue sounds at most once per diff, panned to its first event: five
 * lands untapping make one tap, not a rattle. "Your Turn" stands in for the turn's step emblem. */
export function cuesFor(
  diff: TableDiff,
  layout: TableLayout | null,
  viewSeat: Seat | null,
): CueCall[] {
  if (diff.baseline) return [];
  const picked = new Map<Cue, Omit<CueCall, "delayMs">>();
  for (const event of diff.events) {
    const found = cueOf(event, viewSeat);
    if (!found || picked.has(found.cue)) continue;
    const x = layout ? eventX(event, layout) : null;
    picked.set(found.cue, {
      cue: found.cue,
      pan: x === null ? 0 : panAt(x),
      ...(found.low ? { low: true } : {}),
    });
  }
  if (picked.has("yourTurn")) picked.delete("phase");
  let cues = [...picked.values()];
  if (cues.length > MAX_VOICES) {
    const kept = new Set(
      [...cues]
        .sort((a, b) => RANK.indexOf(a.cue) - RANK.indexOf(b.cue))
        .slice(0, MAX_VOICES),
    );
    cues = cues.filter((cue) => kept.has(cue));
  }
  return stagger(cues);
}

/** The attack sounds once per combat: a new turn, or a step outside combat, ends that combat.
 * `sounded` says whether this combat's attack has sounded already; the result says it again. */
export function attackOnce(
  cues: CueCall[],
  diff: TableDiff,
  sounded: boolean,
): { cues: CueCall[]; sounded: boolean } {
  const ended = diff.events.some(
    (event) =>
      event.type === "turn" ||
      (event.type === "step" && !COMBAT_STEPS.has(event.step ?? "")),
  );
  const already = sounded && !ended;
  if (!cues.some((call) => call.cue === "attack"))
    return { cues, sounded: already };
  if (!already) return { cues, sounded: true };
  return {
    cues: stagger(cues.filter((call) => call.cue !== "attack")),
    sounded: true,
  };
}
