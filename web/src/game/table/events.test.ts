import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GameState } from "../connection";
import type { CardView, GameView, PermanentView, StackItem } from "../types";
import {
  CARDS,
  fixtureInput,
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "./fixtures";
import { deriveEvents } from "./events";
import { buildTableModel } from "./tableModel";
import type { TableEvent, TableModel } from "./types";
import { useTableEvents, useTableModel } from "./useTable";

const live = { baseline: false, hidden: false };

function model(f: TableFixture): TableModel {
  return buildTableModel(fixtureInput(f));
}
/** The next snapshot of a fixture: one revision on, with `change` applied to a copy. */
function next(
  f: TableFixture,
  change: (view: GameView, f: TableFixture) => void,
  revisions = 1,
): TableFixture {
  const copy = JSON.parse(JSON.stringify(f)) as TableFixture;
  copy.snapshot.revision += revisions;
  change(copy.snapshot.view!, copy);
  return copy;
}
function events(a: TableFixture, b: TableFixture): TableEvent[] {
  const diff = deriveEvents(model(a), model(b), live);
  expect(diff.baseline).toBe(false);
  return diff.events;
}
const of = <T extends TableEvent["type"]>(list: TableEvent[], type: T) =>
  list.filter((e): e is Extract<TableEvent, { type: T }> => e.type === type);

let ids = 0;
const card = (face: Omit<CardView, "id" | "hidden">): CardView => ({
  id: `new${++ids}`,
  hidden: false,
  ...face,
});
const permanent = (
  seat: number,
  face: Omit<CardView, "id" | "hidden">,
  change: Partial<PermanentView> = {},
): PermanentView => {
  const c = card(face);
  return {
    id: c.id,
    controller_seat: seat,
    owner_seat: seat,
    card: c,
    tapped: false,
    summoning_sick: false,
    damage: 0,
    counters: {},
    attacking: false,
    blocking: false,
    attached_to: null,
    ...change,
  };
};
const spell = (
  seat: number,
  face: Omit<CardView, "id" | "hidden">,
): StackItem => ({
  id: `new${++ids}`,
  kind: "spell",
  controller_seat: seat,
  name: face.name,
  text: null,
  hidden: false,
  targets: [],
});
const byName = (v: GameView, name: string) =>
  v.battlefield.find((p) => p.card.name === name)!;
const fx = (name: FixtureName) => tableFixture(name);

describe("baselines (§14)", () => {
  it("snap on the first model, a reconnect, a hidden tab, another game and a resync", () => {
    const a = fx("duel");
    const m = model(a);
    expect(deriveEvents(null, m, live)).toEqual({ baseline: true, events: [] });
    const b = model(next(a, (v) => v.you!.life--));
    expect(deriveEvents(m, b, { baseline: true, hidden: false }).baseline).toBe(
      true,
    );
    expect(deriveEvents(m, b, { baseline: false, hidden: true }).baseline).toBe(
      true,
    );
    const other = next(a, () => undefined);
    other.snapshot.game_id = "another";
    expect(deriveEvents(m, model(other), live).baseline).toBe(true);
    expect(deriveEvents(b, m, live).baseline).toBe(true);
    expect(
      deriveEvents(m, model(next(a, () => undefined, 9)), live).baseline,
    ).toBe(true);
    expect(
      deriveEvents(m, model(next(a, () => undefined, 8)), live).baseline,
    ).toBe(false);
  });

  it("snap when more than 40 objects change at once", () => {
    const a = fx("duel");
    const b = next(a, (v) =>
      v.battlefield.push(
        ...Array.from({ length: 41 }, () => permanent(0, CARDS.soldier)),
      ),
    );
    expect(deriveEvents(model(a), model(b), live).baseline).toBe(true);
  });

  it("find nothing new when the same revision is drawn again", () => {
    const m = model(fx("duel"));
    const waiting = buildTableModel(
      fixtureInput(fx("duel"), { canAnswer: false }),
    );
    expect(deriveEvents(m, waiting, live)).toEqual({
      baseline: false,
      events: [],
    });
  });
});

describe("moving cards", () => {
  it("draws your card from the library, by key, and counts an opponent's", () => {
    const a = fx("duel");
    const drawn = card(CARDS.island);
    const b = next(a, (v) => {
      v.hand.push(drawn);
      v.you!.hand_count++;
      v.you!.library_count--;
      v.opponents[0].hand_count += 2;
      v.opponents[0].library_count -= 2;
    });
    expect(of(events(a, b), "draw")).toEqual([
      { type: "draw", seat: 0, keys: [`hand:${drawn.id}`], count: 1 },
      { type: "draw", seat: 1, keys: [], count: 2 },
    ]);
  });

  it("casts your spell from its card in your hand", () => {
    const a = fx("duel");
    const bolt = a.snapshot.view!.hand.find(
      (c) => c.name === "Lightning Bolt",
    )!;
    const item = spell(0, CARDS.lightningBolt);
    const b = next(a, (v) => {
      v.hand = v.hand.filter((c) => c.id !== bolt.id);
      v.you!.hand_count--;
      v.stack.push(item);
    });
    const list = events(a, b);
    expect(of(list, "cast")).toEqual([
      {
        type: "cast",
        key: `stack:${item.id}`,
        controllerSeat: 0,
        from: { kind: "node", key: `hand:${bolt.id}` },
      },
    ]);
    expect(of(list, "draw")).toEqual([]);
  });

  it("casts an opponent's spell from their hand face down", () => {
    const a = fx("duel");
    const item = spell(1, CARDS.counterspell);
    const b = next(a, (v) => {
      v.opponents[0].hand_count--;
      v.stack.push(item);
    });
    expect(of(events(a, b), "cast")[0].from).toEqual({
      kind: "anchor",
      anchor: "hand",
      seat: 1,
      faceDown: true,
    });
  });

  it("resolves a spell onto the battlefield", () => {
    const item = spell(0, CARDS.grizzlyBears);
    const a = next(fx("duel"), (v) => v.stack.push(item));
    const bears = permanent(0, CARDS.grizzlyBears);
    const b = next(a, (v) => {
      v.stack = [];
      v.battlefield.push(bears);
    });
    const list = events(a, b);
    expect(of(list, "resolve")).toEqual([
      {
        type: "resolve",
        key: `stack:${item.id}`,
        to: { kind: "node", key: `battlefield:${bears.id}` },
      },
    ]);
    expect(of(list, "enter")).toEqual([
      {
        type: "enter",
        key: `battlefield:${bears.id}`,
        from: { kind: "node", key: `stack:${item.id}` },
        land: false,
        token: false,
      },
    ]);
  });

  it("sends a dying creature to its owner's graveyard, and a token out of existence", () => {
    const a = next(fx("tokens"), () => undefined);
    const b = next(fx("duel"), () => undefined);
    const air = byName(b.snapshot.view!, "Air Elemental");
    const dies = next(b, (v) => {
      v.battlefield = v.battlefield.filter((p) => p.id !== air.id);
      v.opponents[0].graveyard.push(card(CARDS.airElemental));
    });
    expect(of(events(b, dies), "leave")).toEqual([
      {
        type: "leave",
        key: `battlefield:${air.id}`,
        to: { kind: "anchor", anchor: "graveyard", seat: 1 },
        creature: true,
      },
    ]);
    const soldier = byName(a.snapshot.view!, "Soldier Token");
    const gone = next(a, (v) => {
      v.battlefield = v.battlefield.filter((p) => p.id !== soldier.id);
    });
    expect(of(events(a, gone), "leave")[0].to).toEqual({ kind: "vanish" });
  });

  it("returns a creature to your hand without calling it a draw", () => {
    const a = fx("duel");
    const bears = byName(a.snapshot.view!, "Grizzly Bears");
    const back = card(CARDS.grizzlyBears);
    const b = next(a, (v) => {
      v.battlefield = v.battlefield.filter(
        (p) => p.id !== bears.id && p.attached_to !== bears.id,
      );
      v.hand.push(back);
      v.you!.hand_count++;
    });
    const list = events(a, b);
    expect(
      of(list, "leave").find((e) => e.key === `battlefield:${bears.id}`)?.to,
    ).toEqual({
      kind: "node",
      key: `hand:${back.id}`,
    });
    expect(of(list, "draw")).toEqual([]);
  });

  it("brings tokens in from the band and an opponent's land from their hand", () => {
    const a = fx("duel");
    const soldier = permanent(0, CARDS.soldier);
    const island = permanent(1, CARDS.island);
    const b = next(a, (v) => {
      v.battlefield.push(soldier, island);
      v.opponents[0].hand_count--;
    });
    const enters = of(events(a, b), "enter");
    expect(enters).toEqual([
      {
        type: "enter",
        key: `battlefield:${soldier.id}`,
        from: { kind: "anchor", anchor: "band", seat: 0, faceDown: false },
        land: false,
        token: true,
      },
      {
        type: "enter",
        key: `battlefield:${island.id}`,
        from: { kind: "anchor", anchor: "hand", seat: 1, faceDown: true },
        land: true,
        token: false,
      },
    ]);
  });

  it("follows a commander from the command zone to the stack", () => {
    const a = fx("three");
    const krenko = a.snapshot.view!.you!.command_zone[0];
    const item = spell(0, CARDS.krenko);
    const b = next(a, (v) => {
      v.you!.command_zone = [];
      v.you!.commanders[0].zone = "stack";
      v.you!.commanders[0].object_id = item.id;
      v.stack.push(item);
    });
    expect(of(events(a, b), "cast")[0].from).toEqual({
      kind: "node",
      key: `command:${krenko.id}`,
    });
  });

  it("never follows a commander into a hand this viewer cannot see", () => {
    const a = fx("three");
    const isamaru = byName(a.snapshot.view!, "Isamaru, Hound of Konda");
    const b = next(a, (v) => {
      v.battlefield = v.battlefield.filter((p) => p.id !== isamaru.id);
      v.opponents[0].commanders[0] = {
        ...v.opponents[0].commanders[0],
        zone: "hidden",
        object_id: null,
      };
      v.opponents[0].hand_count++;
    });
    expect(of(events(a, b), "leave")).toEqual([
      {
        type: "leave",
        key: `battlefield:${isamaru.id}`,
        to: { kind: "vanish" },
        creature: true,
      },
    ]);
  });
});

describe("changes in place", () => {
  it("reports taps, counters, damage, life and commander damage", () => {
    const a = fx("three");
    const giant = byName(a.snapshot.view!, "Hill Giant");
    const angel = byName(a.snapshot.view!, "Serra Angel");
    const b = next(a, (v) => {
      byName(v, "Hill Giant").tapped = true;
      byName(v, "Hill Giant").counters = { "+1/+1": 1 };
      byName(v, "Serra Angel").damage = 3;
      v.opponents[0].life -= 3;
      v.opponents[1].counters = { poison: 1 };
      v.you!.commanders[0].damage_dealt = [{ seat: 1, damage: 9 }];
    });
    const list = events(a, b);
    expect(of(list, "tap")).toEqual([
      { type: "tap", key: `battlefield:${giant.id}`, tapped: true },
    ]);
    expect(of(list, "counters")).toEqual([
      {
        type: "counters",
        key: `battlefield:${giant.id}`,
        seat: null,
        counter: "+1/+1",
        delta: 1,
      },
      { type: "counters", key: null, seat: 2, counter: "poison", delta: 1 },
    ]);
    expect(of(list, "damage")).toEqual([
      { type: "damage", key: `battlefield:${angel.id}`, amount: 3 },
    ]);
    expect(of(list, "life")).toEqual([{ type: "life", seat: 1, delta: -3 }]);
    expect(of(list, "commanderDamage")).toEqual([
      { type: "commanderDamage", seat: 1, fromSeat: 0, delta: 3 },
    ]);
  });

  it("marks new attackers and blockers", () => {
    const a = fx("three");
    const giant = byName(a.snapshot.view!, "Hill Giant");
    const b = next(a, (v) => {
      byName(v, "Hill Giant").attacking = true;
    });
    expect(of(events(a, b), "attack")).toEqual([
      { type: "attack", keys: [`battlefield:${giant.id}`] },
    ]);
    const c = fx("blockers");
    const angel = byName(c.snapshot.view!, "Serra Angel");
    const d = next(c, (v) => {
      byName(v, "Serra Angel").blocking = true;
    });
    expect(of(events(c, d), "block")).toEqual([
      { type: "block", keys: [`battlefield:${angel.id}`] },
    ]);
  });

  it("puts up the turn's emblem, and Attack! and Block! when they first happen", () => {
    const a = fx("duel");
    const b = next(a, (v) => {
      v.turn = 8;
      v.active_seat = 1;
      v.step = "upkeep";
      v.phase = "beginning";
    });
    expect(events(a, b).slice(0, 2)).toEqual([
      { type: "turn", turn: 8, activeSeat: 1 },
      { type: "step", phase: "beginning", step: "upkeep", emblem: "turn" },
    ]);
    const before = next(fx("three"), (v) => {
      v.combat = [];
      byName(v, "Goblin Guide").attacking = false;
    });
    const attack = next(before, (v) => {
      v.combat = fx("three").snapshot.view!.combat;
      byName(v, "Goblin Guide").attacking = true;
    });
    expect(of(events(before, attack), "step")).toEqual([
      {
        type: "step",
        phase: "combat",
        step: "declare_attackers",
        emblem: "attack",
      },
    ]);
    // A second attacker in the same step is not a second "Attack!".
    const more = next(attack, (v) => {
      byName(v, "Hill Giant").attacking = true;
    });
    expect(of(events(attack, more), "step")).toEqual([]);
    const unblocked = next(fx("blockers"), (v) => {
      v.combat[1].blockers = [];
      byName(v, "Grizzly Bears").blocking = false;
    });
    const blocked = next(unblocked, (v) => {
      v.combat = fx("blockers").snapshot.view!.combat;
      byName(v, "Grizzly Bears").blocking = true;
    });
    expect(of(events(unblocked, blocked), "step")[0].emblem).toBe("block");
  });

  it("reports eliminations and the result in the viewer's words", () => {
    const a = fx("four");
    const b = next(a, (v) => {
      v.opponents[1].lost = true;
      v.you!.won = true;
    });
    const list = events(a, b);
    expect(of(list, "eliminated")).toEqual([{ type: "eliminated", seat: 2 }]);
    expect(of(list, "result")).toEqual([
      { type: "result", outcome: "victory" },
    ]);
    const c = fx("sysop");
    const d = next(c, (v) => {
      v.opponents[0].won = true;
    });
    expect(of(events(c, d), "result")).toEqual([
      { type: "result", outcome: "over" },
    ]);
    const e = next(fx("duel"), (v) => {
      v.opponents[0].won = true;
    });
    expect(of(events(fx("duel"), e), "result")).toEqual([
      { type: "result", outcome: "defeat" },
    ]);
  });
});

describe("hidden information (§23)", () => {
  it("never takes a name from the log", () => {
    const a = fx("duel");
    const draws = (log: boolean) =>
      next(a, (v, f) => {
        v.opponents[0].hand_count++;
        v.opponents[0].library_count--;
        if (log)
          f.snapshot.log.push({
            index: 9,
            turn: 7,
            active_seat: 1,
            step: "draw",
            text: "Bot 2 draws Baneslayer Angel.",
          });
      });
    const withLog = events(a, draws(true));
    expect(withLog).toEqual(events(a, draws(false)));
    expect(JSON.stringify(withLog)).not.toContain("Baneslayer");
    expect(withLog).toEqual([{ type: "draw", seat: 1, keys: [], count: 1 }]);
  });

  it("names only cards the view shows: every key is a card of one of the two models", () => {
    const a = fx("stack");
    const b = next(a, (v) => {
      v.stack = v.stack.slice(1);
      v.opponents[0].graveyard.push(card(CARDS.counterspell));
    });
    const [ma, mb] = [model(a), model(b)];
    for (const event of events(a, b)) {
      const keys = [
        ...("key" in event && typeof event.key === "string" ? [event.key] : []),
        ...("keys" in event ? event.keys : []),
      ];
      for (const key of keys)
        expect(ma.cards.has(key) || mb.cards.has(key)).toBe(true);
    }
  });
});

describe("the hooks", () => {
  it("snap to the first model and the first after a reconnect, and play the rest (NET10)", () => {
    const a = fx("duel");
    const drawn = card(CARDS.island);
    const b = next(a, (v) => {
      v.hand.push(drawn);
      v.you!.hand_count++;
      v.you!.library_count--;
    });
    const c = next(b, (v) => {
      v.you!.life--;
    });
    const [ma, mb, mc] = [a, b, c].map(model);
    const { result, rerender } = renderHook(
      ({ m, phase }: { m: TableModel; phase: GameState["phase"] }) =>
        useTableEvents(m, phase),
      { initialProps: { m: ma, phase: "open" as GameState["phase"] } },
    );
    expect(result.current?.baseline).toBe(true);
    rerender({ m: mb, phase: "open" });
    expect(result.current?.events).toEqual([
      { type: "draw", seat: 0, keys: [`hand:${drawn.id}`], count: 1 },
    ]);
    const same = result.current;
    rerender({ m: mb, phase: "open" });
    expect(result.current).toBe(same);
    // The connection drops and opens again; the model after that is a baseline.
    act(() => rerender({ m: mb, phase: "reconnecting" }));
    act(() => rerender({ m: mb, phase: "open" }));
    rerender({ m: mc, phase: "open" });
    expect(result.current).toEqual({ baseline: true, events: [] });
  });

  it("build the model once for the same parts, however the input is wrapped", () => {
    const f = fx("duel");
    const input = fixtureInput(f);
    const { result, rerender } = renderHook(
      ({ wrapped }) =>
        useTableModel({ input: wrapped, expandedSeat: null, textScale: 1 }),
      { initialProps: { wrapped: input } },
    );
    const first = result.current;
    expect(first.model?.cards.size).toBeGreaterThan(0);
    rerender({ wrapped: { ...input, context: { ...input.context } } });
    expect(result.current.model).toBe(first.model);
    expect(result.current.layout).toBe(first.layout);
    rerender({
      wrapped: { ...input, context: { ...input.context, canAnswer: false } },
    });
    expect(result.current.model).not.toBe(first.model);
  });
});
