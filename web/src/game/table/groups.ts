import { isCreature, isLand } from "../model";
import type { CardView, ObjectId, PermanentView, PromptOption } from "../types";
import { fnv1a } from "./sigil";
import type { TableUnit } from "./types";

// Token groups and land piles (UI02, design §15). Magic Duels stacks identical lands into one
// fanned pile; tokens get the same treatment. Two permanents share a pile only when nothing a
// player could want to tell apart differs: anything selected, attached, fighting or commanding
// stays on its own, and every member keeps its own button and options.

export function isToken(card: CardView): boolean {
  if (card.hidden || !card.name) return false;
  if (/\bToken$/.test(card.name)) return true;
  return !card.mana_cost && !isLand(card) && isCreature(card);
}

function sortedActions(offered: PromptOption[]): string[] {
  return offered.map((option) => option.action).sort();
}

/** The pile a land joins, or null when it must stand alone. */
export function landKey(
  p: PermanentView,
  offered: PromptOption[],
): string | null {
  const card = p.card;
  if (card.hidden || !card.name || !isLand(card) || isCreature(card))
    return null;
  if (
    p.attached_to ||
    p.attacking ||
    p.blocking ||
    p.damage > 0 ||
    Object.keys(p.counters).length > 0 ||
    offered.some((option) => option.selected)
  )
    return null;
  return JSON.stringify([
    "lands",
    p.controller_seat,
    p.owner_seat,
    card.name,
    p.tapped,
    sortedActions(offered),
  ]);
}

/** The group a token joins, or null when it must stand alone. */
export function tokenKey(
  p: PermanentView,
  offered: PromptOption[],
): string | null {
  const card = p.card;
  if (!isToken(card)) return null;
  if (
    p.attached_to ||
    p.attacking ||
    p.blocking ||
    offered.some((option) => option.selected)
  )
    return null;
  return JSON.stringify([
    "tokens",
    p.controller_seat,
    p.owner_seat,
    card.name,
    card.mana_cost,
    card.type_line,
    card.power,
    card.toughness,
    card.rules.join("\n"),
    p.tapped,
    p.summoning_sick,
    p.damage,
    Object.entries(p.counters).sort(([a], [b]) => a.localeCompare(b)),
    offered
      .map((option) => [option.action, option.label ?? ""])
      .sort((a, b) => (a.join("\u0000") < b.join("\u0000") ? -1 : 1)),
  ]);
}

/** Which row a permanent sits on: creatures and their kin nearest the band, lands behind. */
export function rowOf(card: CardView): TableUnit["row"] {
  if (card.hidden || !card.name) return "front";
  const type = card.type_line ?? "";
  if (isCreature(card) || /\b(Planeswalker|Battle)\b/.test(type))
    return "front";
  return isLand(card) ? "back-lands" : "back-other";
}

export interface GroupContext {
  /** The TableCard key of a permanent. */
  keyOf(p: PermanentView): string;
  offered(p: PermanentView): PromptOption[];
  /** Objects in a combat group, by either of their ids. */
  combat: Set<ObjectId>;
  /** Commanders' object ids. */
  commanders: Set<ObjectId>;
}

/** One controller's permanents as table units, in row order: front, then lands, then the rest.
 * Attachments join the permanent they are attached to when the same player controls both (B1);
 * a chain (an Aura on an Equipment on a creature) joins the creature at its root. */
export function groupUnits(
  permanents: PermanentView[],
  ctx: GroupContext,
): TableUnit[] {
  const byId = new Map<ObjectId, PermanentView>();
  const order = new Map<PermanentView, number>();
  permanents.forEach((p, i) => {
    byId.set(p.id, p);
    byId.set(p.card.id, p);
    order.set(p, i);
  });
  // A loop of attachments (which the rules never make, but a view could) roots at its member
  // that appears first, whichever member the walk starts from.
  const rootOf = (p: PermanentView): PermanentView => {
    const path = [p];
    let at = p;
    while (at.attached_to) {
      const next = byId.get(at.attached_to);
      if (!next) break;
      const loop = path.indexOf(next);
      if (loop >= 0)
        return path
          .slice(loop)
          .reduce((a, b) => (order.get(a)! <= order.get(b)! ? a : b));
      path.push(next);
      at = next;
    }
    return at;
  };
  const attachments = new Map<PermanentView, PermanentView[]>();
  const roots: PermanentView[] = [];
  for (const p of permanents) {
    const root = rootOf(p);
    if (root === p) roots.push(p);
    else {
      const list = attachments.get(root) ?? [];
      list.push(p);
      attachments.set(root, list);
    }
  }

  const piles = new Map<string, PermanentView[]>();
  const groupKey = new Map<PermanentView, string>();
  for (const p of roots) {
    if (attachments.has(p)) continue;
    if (
      ctx.combat.has(p.id) ||
      ctx.combat.has(p.card.id) ||
      ctx.commanders.has(p.id) ||
      ctx.commanders.has(p.card.id)
    )
      continue;
    const offered = ctx.offered(p);
    const key = landKey(p, offered) ?? tokenKey(p, offered);
    if (!key) continue;
    groupKey.set(p, key);
    const list = piles.get(key) ?? [];
    list.push(p);
    piles.set(key, list);
  }

  const units: TableUnit[] = [];
  const usedKeys = new Set<string>();
  const emitted = new Set<string>();
  for (const p of roots) {
    const hosted = attachments.get(p);
    const key = groupKey.get(p);
    const pile = key ? piles.get(key) : undefined;
    if (hosted) {
      units.push({
        key: ctx.keyOf(p),
        kind: "host",
        cards: [ctx.keyOf(p)],
        attachments: hosted.map(ctx.keyOf),
        row: rowOf(p.card),
        tapped: p.tapped,
      });
    } else if (key && pile && pile.length >= 2) {
      // A pile sits where its first member appears in the view.
      if (emitted.has(key)) continue;
      emitted.add(key);
      const kind = isLand(p.card) ? "lands" : "tokens";
      let unitKey = `${kind}:${p.controller_seat}:${fnv1a(key).toString(36)}`;
      while (usedKeys.has(unitKey)) unitKey += "~";
      usedKeys.add(unitKey);
      units.push({
        key: unitKey,
        kind,
        cards: pile.map(ctx.keyOf),
        attachments: [],
        row: rowOf(p.card),
        tapped: p.tapped,
      });
    } else {
      units.push({
        key: ctx.keyOf(p),
        kind: "single",
        cards: [ctx.keyOf(p)],
        attachments: [],
        row: rowOf(p.card),
        tapped: p.tapped,
      });
    }
  }
  const rows: TableUnit["row"][] = ["front", "back-lands", "back-other"];
  return rows.flatMap((row) => units.filter((unit) => unit.row === row));
}
