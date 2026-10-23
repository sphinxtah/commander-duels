import { isCreature, isLand } from "../model";
import type { GameResultView, ObjectId, PlayerView, Seat } from "../types";
import { isToken } from "./groups";
import type {
  Anchor,
  DeriveEvents,
  Exit,
  Origin,
  TableCard,
  TableDiff,
  TableEvent,
  TableModel,
  TablePlayer,
} from "./types";

// What changed between two committed table models, as events the scene animates and the sound
// plays (UI09, design §14). Events come from the models alone, never from the log: the log can
// name a card the seat's view does not show, and an animation or a sound must never give that
// away. The pairing of a card that left one zone with one that arrived in another is cosmetic;
// where it fails, a card fades instead of flying.
//
// The table model carries no result, so deriveEvents tells the end of a game only from a won
// flag turning on. A draw, the turn limit, a closed or timed-out game and an engine error turn
// none on and give no event here; withResult adds those from the snapshot's result, and
// useTableEvents applies it when the caller passes that result.

/** A larger revision gap than this is a resync: snap to it. */
const MAX_GAP = 8;
/** More objects than this vanishing and appearing at once is a new board: snap to it. */
const MAX_CHURN = 40;

/** Zones a commander can be in that the table does not show. */
const hiddenZones = new Set(["hand", "library", "hidden", "outside"]);

/** The zone pairs tried, in this order, after the commander link and same-id pairs (§14). */
const routes: [TableCard["zone"], TableCard["zone"][]][] = [
  ["hand", ["stack"]],
  ["hand", ["battlefield"]],
  ["stack", ["battlefield"]],
  ["battlefield", ["graveyard", "exile", "hand", "command"]],
  ["stack", ["graveyard"]],
];

/** Revealed and looked-at cards are listed beside the prompt, not drawn on the table, and show a
 * face only while listed (§23.3): being shown or put away moves nothing, so they never pair,
 * cast, enter or leave. */
const onTable = (card: TableCard) =>
  card.zone !== "revealed" && card.zone !== "looked_at";

function pairableName(card: TableCard): string | null {
  if (card.card.hidden || !card.card.name) return null;
  // An ability is named after its source, which has not moved.
  if (card.zone === "stack" && card.located.stack?.kind === "ability")
    return null;
  return card.card.name;
}

function seatsMeet(a: TableCard, b: TableCard): boolean {
  const from = [a.ownerSeat, a.controllerSeat].filter((s) => s !== null);
  return [b.ownerSeat, b.controllerSeat].some(
    (s) => s !== null && from.includes(s),
  );
}

function everyone(model: TableModel): TablePlayer[] {
  return [...(model.anchored ? [model.anchored] : []), ...model.opponents];
}

/** `${zone}:${id}` for every card, with battlefield cards also under their permanent's id. */
function zoneIndex(model: TableModel): Map<string, string> {
  const index = new Map<string, string>();
  for (const card of model.cards.values()) {
    index.set(`${card.zone}:${card.id}`, card.key);
    const permanent = card.located.permanent;
    if (permanent) index.set(`battlefield:${permanent.id}`, card.key);
  }
  return index;
}

const hasAttackers = (m: TableModel) =>
  m.combat.some((group) => group.attackers.length > 0);
const hasBlockers = (m: TableModel) =>
  m.combat.some((group) => group.blockers.length > 0);

export const deriveEvents: DeriveEvents = (prev, next, ctx) => {
  const snap = { baseline: true, events: [] };
  if (
    ctx.baseline ||
    ctx.hidden ||
    !prev ||
    prev.gameId !== next.gameId ||
    next.revision < prev.revision ||
    next.revision - prev.revision > MAX_GAP ||
    (prev.anchored?.seat ?? null) !== (next.anchored?.seat ?? null)
  )
    return snap;
  // The same revision drawn again (an answer in flight, say) changes nothing on the table.
  if (next.revision === prev.revision) return { baseline: false, events: [] };
  const vanished = [...prev.cards.values()].filter(
    (card) => onTable(card) && !next.cards.has(card.key),
  );
  const appeared = [...next.cards.values()].filter(
    (card) => onTable(card) && !prev.cards.has(card.key),
  );
  if (vanished.length + appeared.length > MAX_CHURN) return snap;

  const before = new Map(everyone(prev).map((p) => [p.seat, p.player]));
  const after = new Map(everyone(next).map((p) => [p.seat, p.player]));
  const grew = (seat: Seat | null, count: (p: PlayerView) => number) => {
    const a = seat === null ? undefined : before.get(seat);
    const b = seat === null ? undefined : after.get(seat);
    return a && b ? count(b) - count(a) : 0;
  };
  // How many cards each zone gained or lost that nothing else explains; pairs use them up.
  const budget = new Map<
    Seat,
    {
      graveyard: number;
      exile: number;
      hand: number;
      library: number;
      handDrop: number;
      libraryDrop: number;
    }
  >();
  for (const seat of after.keys())
    budget.set(seat, {
      graveyard: Math.max(
        0,
        grew(seat, (p) => p.graveyard.length),
      ),
      exile: Math.max(
        0,
        grew(seat, (p) => p.exile.length),
      ),
      hand: Math.max(
        0,
        grew(seat, (p) => p.hand_count),
      ),
      library: Math.max(
        0,
        grew(seat, (p) => p.library_count),
      ),
      handDrop: Math.max(0, -grew(seat, (p) => p.hand_count)),
      libraryDrop: Math.max(0, -grew(seat, (p) => p.library_count)),
    });
  const spend = (
    seat: Seat | null,
    what:
      "graveyard" | "exile" | "hand" | "library" | "handDrop" | "libraryDrop",
  ) => {
    const left = seat === null ? undefined : budget.get(seat);
    if (!left || left[what] <= 0) return false;
    left[what]--;
    return true;
  };

  /* ---------- pairing ---------- */
  const pairs = new Map<string, TableCard>(); // vanished key → the card it became
  const pairedFrom = new Map<string, TableCard>(); // appeared key → the card it was
  const pair = (a: TableCard, b: TableCard) => {
    pairs.set(a.key, b);
    pairedFrom.set(b.key, a);
    if (b.zone === "graveyard" || b.zone === "exile")
      spend(b.ownerSeat, b.zone);
    if (b.zone === "hand") spend(b.ownerSeat, "hand");
    if (a.zone === "hand") spend(a.ownerSeat, "handDrop");
  };
  const isVanished = new Set(vanished.map((card) => card.key));
  const isAppeared = new Set(appeared.map((card) => card.key));
  const anchoredSeat = next.anchored?.seat ?? null;
  // The seat whose hand this viewer sees: theirs, or the owner's for SysOp observing. A
  // spectator sees the anchored hand as backs, and as no backs at all once it is empty, so a
  // hand counts as seen only when it had no backs before and after: the last card a spectator's
  // anchored player casts still leaves face down.
  const handSeat =
    prev.handBacks === 0 && next.handBacks === 0 ? anchoredSeat : null;
  // The hands whose cards this viewer sees: that one, and a Two-Headed Giant teammate's shown
  // before and after (v0.5.1). Their cards fly face up; every other hand's go face down.
  const seenHands = new Set<Seat>(handSeat === null ? [] : [handSeat]);
  for (const player of next.opponents)
    if (
      player.hand &&
      prev.opponents.some((p) => p.seat === player.seat && p.hand)
    )
      seenHands.add(player.seat);

  // The commander link: the engine names each commander's object wherever it is public. One
  // that goes where this viewer cannot see is never followed there (§23.3).
  const prevIndex = zoneIndex(prev);
  const nextIndex = zoneIndex(next);
  const intoHiding = new Set<string>();
  const commandersBefore = new Map<
    string,
    { zone: string; id: ObjectId | null }
  >();
  for (const player of everyone(prev))
    for (const c of player.commanders)
      commandersBefore.set(`${player.seat}:${c.name}`, {
        zone: c.zone,
        id: c.objectId,
      });
  for (const player of everyone(next))
    for (const c of player.commanders) {
      const was = commandersBefore.get(`${player.seat}:${c.name}`);
      if (!was?.id) continue;
      const from = prevIndex.get(`${was.zone}:${was.id}`);
      if (!from || !isVanished.has(from)) continue;
      if (hiddenZones.has(c.zone)) {
        if (!(c.zone === "hand" && seenHands.has(player.seat)))
          intoHiding.add(from);
        continue;
      }
      const to = c.objectId
        ? nextIndex.get(`${c.zone}:${c.objectId}`)
        : undefined;
      if (to && isAppeared.has(to) && !pairedFrom.has(to))
        pair(prev.cards.get(from)!, next.cards.get(to)!);
    }

  // The same id in a new zone.
  for (const b of appeared) {
    if (pairedFrom.has(b.key)) continue;
    const a = vanished.find((v) => !pairs.has(v.key) && v.id === b.id);
    if (a && !intoHiding.has(a.key)) pair(a, b);
  }

  // By name, along the usual routes, then anywhere.
  const byName = (
    from: TableCard["zone"][] | null,
    to: TableCard["zone"][] | null,
  ) => {
    for (const b of appeared) {
      if (pairedFrom.has(b.key) || (to && !to.includes(b.zone))) continue;
      const name = pairableName(b);
      if (!name) continue;
      const a = vanished.find(
        (v) =>
          !pairs.has(v.key) &&
          !intoHiding.has(v.key) &&
          (!from || from.includes(v.zone)) &&
          pairableName(v) === name &&
          seatsMeet(v, b),
      );
      if (a) pair(a, b);
    }
  };
  for (const [from, to] of routes) byName([from], to);
  byName(null, null);

  /* ---------- where things came from and went ---------- */
  const nodeZone = (card: TableCard, model: TableModel) =>
    card.zone === "hand" ||
    card.zone === "battlefield" ||
    card.zone === "stack" ||
    (card.zone === "command" &&
      card.ownerSeat === (model.anchored?.seat ?? null));
  const anchorOf = (card: TableCard): Anchor =>
    card.zone === "graveyard" ||
    card.zone === "exile" ||
    card.zone === "command"
      ? card.zone
      : "band";

  const originOf = (a: TableCard): Origin =>
    nodeZone(a, prev)
      ? { kind: "node", key: a.key }
      : {
          kind: "anchor",
          anchor: anchorOf(a),
          seat: a.ownerSeat ?? a.controllerSeat ?? 0,
          faceDown: a.card.hidden,
        };
  const exitOf = (b: TableCard): Exit =>
    nodeZone(b, next)
      ? { kind: "node", key: b.key }
      : {
          kind: "anchor",
          anchor: anchorOf(b),
          seat: b.ownerSeat ?? b.controllerSeat ?? 0,
        };

  /** An arrival nothing explains: from a hand that shrank (face down unless it is the hand this
   * viewer sees), the band for a token, a library that shrank, or out of nowhere. */
  const arrival = (b: TableCard, enters: boolean): Origin => {
    const seat = b.controllerSeat ?? b.ownerSeat;
    if (seat === null) return { kind: "appear" };
    if (enters && isToken(b.card))
      return { kind: "anchor", anchor: "band", seat, faceDown: false };
    if (spend(seat, "handDrop"))
      return {
        kind: "anchor",
        anchor: "hand",
        seat,
        faceDown: !seenHands.has(seat),
      };
    if (enters && spend(seat, "libraryDrop"))
      return { kind: "anchor", anchor: "library", seat, faceDown: true };
    return { kind: "appear" };
  };
  /** A departure nothing explains: to a zone of its owner's that grew, or it fades. */
  const departure = (a: TableCard): Exit => {
    const seat = a.ownerSeat ?? a.controllerSeat;
    if (seat === null || intoHiding.has(a.key)) return { kind: "vanish" };
    if (spend(seat, "graveyard"))
      return { kind: "anchor", anchor: "graveyard", seat };
    if (spend(seat, "exile")) return { kind: "anchor", anchor: "exile", seat };
    if (!seenHands.has(seat) && spend(seat, "hand"))
      return { kind: "anchor", anchor: "hand", seat };
    if (spend(seat, "library"))
      return { kind: "anchor", anchor: "library", seat };
    return { kind: "vanish" };
  };

  /* ---------- the events, in the order they play ---------- */
  const events: TableEvent[] = [];
  const turned = next.turn !== prev.turn;
  // In Two-Headed Giant a teammate's turn is the viewer's too (805.4a).
  const viewer = next.observing ? null : next.viewSeat;
  if (turned)
    events.push({
      type: "turn",
      turn: next.turn,
      activeSeat: next.activeSeat,
      yours:
        viewer !== null &&
        next.activeSeat !== null &&
        (next.activeSeat === viewer || next.activeSeat === next.teammateSeat),
    });
  const sameTurn = !turned;
  const attackNow = next.step === "declare_attackers" && hasAttackers(next);
  const attackBefore =
    sameTurn && prev.step === "declare_attackers" && hasAttackers(prev);
  const blockNow = next.step === "declare_blockers" && hasBlockers(next);
  const blockBefore =
    sameTurn && prev.step === "declare_blockers" && hasBlockers(prev);
  const emblem = turned
    ? "turn"
    : attackNow && !attackBefore
      ? "attack"
      : blockNow && !blockBefore
        ? "block"
        : null;
  if (next.phase !== prev.phase || next.step !== prev.step || emblem)
    events.push({ type: "step", phase: next.phase, step: next.step, emblem });

  for (const a of vanished)
    if (a.zone === "stack")
      events.push({
        type: "resolve",
        key: a.key,
        to: pairs.has(a.key)
          ? exitOf(pairs.get(a.key)!)
          : a.located.stack?.kind === "ability"
            ? { kind: "vanish" }
            : departure(a),
      });
  for (const b of appeared)
    if (b.zone === "stack")
      events.push({
        type: "cast",
        key: b.key,
        controllerSeat: b.controllerSeat ?? 0,
        from: pairedFrom.has(b.key)
          ? originOf(pairedFrom.get(b.key)!)
          : b.located.stack?.kind === "ability"
            ? { kind: "appear" }
            : arrival(b, false),
      });
  for (const a of vanished)
    if (a.zone === "battlefield")
      events.push({
        type: "leave",
        key: a.key,
        to: pairs.has(a.key) ? exitOf(pairs.get(a.key)!) : departure(a),
        creature: isCreature(a.card),
      });
  for (const b of appeared)
    if (b.zone === "battlefield")
      events.push({
        type: "enter",
        key: b.key,
        from: pairedFrom.has(b.key)
          ? originOf(pairedFrom.get(b.key)!)
          : arrival(b, true),
        land: isLand(b.card),
        token: isToken(b.card),
      });

  // Draws: the cards this viewer sees arrive in their hand (theirs, or a teammate's); for other
  // seats, only how many.
  const drawn = appeared.filter(
    (b) => b.zone === "hand" && !pairedFrom.has(b.key),
  );
  for (const seat of seenHands) {
    const keys = drawn
      .filter((b) => (b.ownerSeat ?? handSeat) === seat)
      .map((b) => b.key);
    if (keys.length > 0)
      events.push({ type: "draw", seat, keys, count: keys.length });
  }
  for (const seat of after.keys()) {
    if (seenHands.has(seat)) continue;
    const left = budget.get(seat)!;
    const count = Math.min(left.hand, left.libraryDrop);
    if (count > 0) events.push({ type: "draw", seat, keys: [], count });
  }

  const attackers: string[] = [];
  const blockers: string[] = [];
  const counters: TableEvent[] = [];
  const damage: TableEvent[] = [];
  for (const b of next.cards.values()) {
    const now = b.located.permanent;
    if (!now) continue;
    const then = prev.cards.get(b.key)?.located.permanent;
    if (!then) {
      if (now.attacking) attackers.push(b.key);
      if (now.blocking) blockers.push(b.key);
      continue;
    }
    if (then.tapped !== now.tapped)
      events.push({ type: "tap", key: b.key, tapped: now.tapped });
    if (now.attacking && !then.attacking) attackers.push(b.key);
    if (now.blocking && !then.blocking) blockers.push(b.key);
    for (const counter of new Set([
      ...Object.keys(then.counters),
      ...Object.keys(now.counters),
    ])) {
      const delta =
        (now.counters[counter] ?? 0) - (then.counters[counter] ?? 0);
      if (delta !== 0)
        counters.push({
          type: "counters",
          key: b.key,
          seat: null,
          counter,
          delta,
        });
    }
    if (now.damage > then.damage)
      damage.push({
        type: "damage",
        key: b.key,
        amount: now.damage - then.damage,
      });
  }
  if (attackers.length > 0) events.push({ type: "attack", keys: attackers });
  if (blockers.length > 0) events.push({ type: "block", keys: blockers });
  events.push(...counters, ...damage);

  const players: TableEvent[] = [];
  const results: TableEvent[] = [];
  for (const [seat, now] of after) {
    const then = before.get(seat);
    if (!then) continue;
    if (now.life !== then.life)
      players.push({ type: "life", seat, delta: now.life - then.life });
    for (const counter of new Set([
      ...Object.keys(then.counters),
      ...Object.keys(now.counters),
    ])) {
      const delta =
        (now.counters[counter] ?? 0) - (then.counters[counter] ?? 0);
      if (delta !== 0)
        events.push({ type: "counters", key: null, seat, counter, delta });
    }
    for (const commander of now.commanders) {
      const earlier = then.commanders.find((c) => c.name === commander.name);
      for (const entry of commander.damage_dealt) {
        const was =
          earlier?.damage_dealt.find((e) => e.seat === entry.seat)?.damage ?? 0;
        if (entry.damage > was)
          players.push({
            type: "commanderDamage",
            seat: entry.seat,
            fromSeat: seat,
            delta: entry.damage - was,
          });
      }
    }
    if (now.lost && !then.lost) results.push({ type: "eliminated", seat });
    if (now.won && !then.won)
      results.push({ type: "result", outcome: outcomeOf(next, seat, false) });
  }
  events.push(...players, ...results);
  return { baseline: false, events };
};

type Outcome = Extract<TableEvent, { type: "result" }>["outcome"];

/** A game's end in the viewer's words, as resultText puts it: a draw, your win, your loss when
 * you hold a seat, and otherwise just over (SysOp observing, a spectator, or no winner). */
function outcomeOf(
  model: TableModel,
  winner: Seat | null,
  draw: boolean,
  winners: Seat[] = [],
): Outcome {
  if (draw) return "draw";
  const viewSeat = model.observing ? null : model.viewSeat;
  if (winner === null || viewSeat === null) return "over";
  // A team wins together (Two-Headed Giant, v0.5.0): your teammate's win is yours.
  return winner === viewSeat ||
    winner === model.teammateSeat ||
    winners.includes(viewSeat)
    ? "victory"
    : "defeat";
}

/** The diff with the end of the game told once, from the snapshot's result. `before` is the
 * result when the previous model was drawn and `after` the one with this model. The first diff
 * with a result says how the game ended, in place of anything the won flags said, so a draw or a
 * game that stops with no winner gets its event and a win is not told twice; after that, no
 * diff tells it again. A baseline stays a baseline: the table snaps to a finished game. */
export function withResult(
  diff: TableDiff,
  before: GameResultView | null,
  after: GameResultView | null,
  model: TableModel,
): TableDiff {
  if (diff.baseline || (!before && !after)) return diff;
  const events: TableEvent[] = diff.events.filter(
    (event) => event.type !== "result",
  );
  if (!before && after)
    events.push({
      type: "result",
      outcome: outcomeOf(
        model,
        after.winner_seat,
        after.draw,
        after.winner_seats,
      ),
    });
  return { baseline: false, events };
}
