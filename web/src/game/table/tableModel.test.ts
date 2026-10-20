import { describe, expect, it } from "vitest";
import { cardLabel } from "../Card";
import { optionText } from "../model";
import type { GameView, PlayerView } from "../types";
import {
  FIXTURE_NAMES,
  fixtureInput,
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "./fixtures";
import { layoutTable, validateHits } from "./layout";
import { buildTableModel } from "./tableModel";
import type { TableModel } from "./types";

function model(f: TableFixture, canAnswer?: boolean): TableModel {
  return buildTableModel(fixtureInput(f, { canAnswer }));
}
const fixtureModel = (name: FixtureName, canAnswer?: boolean) =>
  model(tableFixture(name), canAnswer);
const named = (m: TableModel, name: string, zone = "battlefield") =>
  [...m.cards.values()].find((c) => c.card.name === name && c.zone === zone)!;

describe("marks (C2)", () => {
  it("follow what is offered, whether or not this tab can answer", () => {
    for (const name of FIXTURE_NAMES) {
      const answering = fixtureModel(name, true);
      const waiting = fixtureModel(name, false);
      for (const [key, card] of answering.cards)
        expect(waiting.cards.get(key)?.mark, key).toBe(card.mark);
      expect(waiting.opponents.map((p) => p.mark)).toEqual(
        answering.opponents.map((p) => p.mark),
      );
    }
  });

  it("are pink for a playable hand card, purple for other offers, teal when selected", () => {
    const duel = fixtureModel("duel");
    expect(named(duel, "Lightning Bolt", "hand").mark).toBe("playable");
    expect(named(duel, "Forest", "hand").mark).toBe("playable");
    expect(named(duel, "Shivan Dragon", "hand").mark).toBe("none");
    expect(named(duel, "Forest").mark).toBe("offered");
    expect(named(duel, "Air Elemental").mark).toBe("none");
    const three = fixtureModel("three");
    expect(named(three, "Goblin Guide").mark).toBe("selected");
    expect(named(three, "Hill Giant").mark).toBe("offered");
    const four = fixtureModel("four");
    expect(four.opponents.map((p) => p.mark)).toEqual([
      "offered",
      "offered",
      "none",
    ]);
  });
});

describe("labels (C3)", () => {
  it("are cardLabel plus the options, and say where a pile member stands", () => {
    for (const name of FIXTURE_NAMES) {
      const f = tableFixture(name);
      const input = fixtureInput(f);
      const m = buildTableModel(input);
      const { index, view, observing } = input.context;
      const grouped = new Map<string, string>();
      for (const player of [m.anchored, ...m.opponents])
        for (const unit of player?.units ?? [])
          if (unit.kind === "lands" || unit.kind === "tokens")
            unit.cards.forEach((key, i) =>
              grouped.set(key, `, ${i + 1} of ${unit.cards.length} grouped`),
            );
      for (const card of m.cards.values()) {
        if (card.zone === "stack") continue;
        const options = card.offered
          .map((o) => optionText(o, index, view, observing))
          .join("; ");
        expect(card.label, card.key).toBe(
          cardLabel(card.card, card.located) +
            (grouped.get(card.key) ?? "") +
            (options ? `. Options: ${options}` : ""),
        );
      }
    }
  });

  it("name a hidden card as a face-down card and nothing more", () => {
    const f = tableFixture("duel");
    f.snapshot.view!.battlefield.push({
      id: "secret",
      controller_seat: 1,
      owner_seat: 1,
      card: {
        id: "secret",
        hidden: true,
        name: null,
        mana_cost: null,
        type_line: null,
        power: null,
        toughness: null,
        rules: [],
      },
      tapped: false,
      summoning_sick: false,
      damage: 0,
      counters: {},
      attacking: false,
      blocking: false,
      attached_to: null,
    });
    const m = model(f);
    const card = m.cards.get("battlefield:secret")!;
    expect(card.label).toBe("A face-down card");
    expect(card.card.name).toBeNull();
    const node = layoutTable(m, { expandedSeat: null, textScale: 1 }).nodes.get(
      "battlefield:secret",
    );
    expect(node).toMatchObject({ kind: "card", faceUp: false, tag: null });
  });

  it("read a stack item as the stack panel does", () => {
    const m = fixtureModel("stack");
    expect(m.stack.map((e) => e.label)).toEqual([
      "Next: Counterspell, spell, controlled by Bot 2. Counter target spell. Targets: Lightning Bolt. Options: Choose Counterspell",
      "2: Lightning Bolt, spell, controlled by You. Lightning Bolt deals 3 damage to any target. Targets: Air Elemental",
      "3: A hidden spell, spell, controlled by Bot 2. Options: Choose A hidden spell",
      "4: Ajani Goldmane, ability, controlled by You. +1: You gain 2 life",
      "5: Giant Growth, spell, controlled by You. Target creature gets +3/+3 until end of turn. Targets: Grizzly Bears",
      "6: Shock, spell, controlled by Bot 2. Shock deals 2 damage to any target. Targets: You",
      "7: Brainstorm, spell, controlled by Bot 2. Draw three cards, then put two cards from your hand on top of your library in any order. Options: Choose Brainstorm",
      "8: Dark Ritual, spell, controlled by You. Add {B}{B}{B}",
    ]);
    const [counter, bolt] = m.stack;
    expect(counter.targets).toEqual([
      { kind: "object", key: bolt.key, label: "Lightning Bolt" },
    ]);
    expect(bolt.targets[0]).toMatchObject({
      kind: "object",
      key: named(m, "Air Elemental").key,
    });
    expect(m.stack[5].targets).toEqual([{ kind: "player", seat: 0 }]);
    // The hidden spell is a card with no name, so nothing can draw or request its face.
    expect(m.cards.get(m.stack[2].key)?.card).toMatchObject({
      hidden: true,
      name: null,
      rules: [],
    });
  });
});

describe("drags", () => {
  it("are set only where a drop could answer now", () => {
    const duel = fixtureModel("duel");
    expect(named(duel, "Lightning Bolt", "hand").drag).toBe("play");
    expect(named(duel, "Forest", "hand").drag).toBe("play");
    expect(named(duel, "Shivan Dragon", "hand").drag).toBeNull();
    expect(named(duel, "Forest").drag).toBeNull();
    expect(
      named(fixtureModel("duel", false), "Lightning Bolt", "hand").drag,
    ).toBeNull();
    const three = fixtureModel("three");
    expect(named(three, "Hill Giant").drag).toBe("attack");
    // Already attacking: dropping it again would take it out of the attack.
    expect(named(three, "Goblin Guide").drag).toBeNull();
    const blockers = fixtureModel("blockers");
    expect(named(blockers, "Serra Angel").drag).toBe("block");
    expect(named(blockers, "Shivan Dragon").drag).toBeNull();
    expect(
      named(fixtureModel("sysop"), "Lightning Bolt", "hand").drag,
    ).toBeNull();
  });
});

describe("players", () => {
  it("say You for the viewer, and names for SysOp observing and spectators (L7)", () => {
    const duel = fixtureModel("duel");
    expect(duel.anchored).toMatchObject({
      name: "You",
      sideLabel: "Your side of the table",
      battlefieldLabel: "Your battlefield",
      articleLabel: null,
    });
    expect(duel.handTitle).toBe("Your hand");
    expect(duel.opponents[0]).toMatchObject({
      name: "Bot 2",
      articleLabel: "Bot 2, seat 2",
      battlefieldLabel: "Bot 2's battlefield",
      sideLabel: null,
      targetLabel: "14 life",
    });
    const sysop = fixtureModel("sysop");
    expect(sysop.observing).toBe(true);
    expect(sysop.anchored).toMatchObject({
      name: "Alice",
      sideLabel: "Alice's side of the table",
      battlefieldLabel: "Alice's battlefield",
    });
    expect(sysop.handTitle).toBe("Alice's hand");
    expect(sysop.hand).toHaveLength(7);
    const spectator = fixtureModel("spectator");
    expect(spectator.anchored).toMatchObject({
      name: "Bot 1",
      sideLabel: "Bot 1's side of the table",
    });
    expect(spectator.handTitle).toBe("Bot 1's hand");
  });

  it("name what a seat's portrait answers", () => {
    const four = fixtureModel("four");
    expect(four.anchored!.targetLabel).toBe("You: 27 life. Choose You");
    expect(four.opponents[0].targetLabel).toBe("Bot 2: 31 life. Choose Bot 2");
    expect(four.opponents[2]).toMatchObject({
      lost: true,
      targetLabel: "0 life",
    });
  });

  it("sit left to right in turn order after the anchored seat", () => {
    const f = tableFixture("four");
    const v = f.snapshot.view!;
    const everyone = [v.you!, ...v.opponents];
    const seat2 = everyone.find((p) => p.seat === 2)!;
    const changed: GameView = {
      ...v,
      seat: 2,
      you: seat2,
      opponents: everyone.filter((p) => p !== seat2) as PlayerView[],
      hand: [],
    };
    f.snapshot = { ...f.snapshot, view: changed, prompt: null };
    f.seat = 2;
    expect(model(f).opponents.map((p) => p.seat)).toEqual([3, 0, 1]);
    expect(fixtureModel("spectator").opponents.map((p) => p.seat)).toEqual([
      1, 2,
    ]);
  });

  it("seed sigils from handles, bots from their seat, and grey every opponent", () => {
    const duel = fixtureModel("duel");
    expect(duel.anchored!.sigil).toEqual({ seed: "handle:alice", grey: false });
    expect(duel.opponents[0].sigil).toEqual({ seed: "bot:1", grey: true });
    const f = tableFixture("duel");
    f.summarySeats = [
      f.summarySeats[0],
      { seat: 1, player: "human", handle: "bob", deck: null },
    ];
    expect(model(f).opponents[0].sigil.seed).toBe("handle:bob");
    expect(model(f).opponents[0].kind).toBe("human");
    f.summarySeats = [];
    expect(model(f).opponents[0].sigil.seed).toBe("seat:1");
    // Without the summary, your own handle still seeds your sigil.
    expect(model(f).anchored!.sigil.seed).toBe("handle:alice");
  });

  it("title you with your deck, others Bot or Player, and deck names only for SysOp", () => {
    const f = tableFixture("duel");
    // Even if a summary named another seat's deck, only SysOp may see it (§23.4).
    f.summarySeats = [
      f.summarySeats[0],
      { seat: 1, player: "bot", handle: null, deck: "legacy-mono-red-burn" },
    ];
    const m = model(f);
    expect(m.anchored!.title).toBe("Mono Green Creatures");
    expect(m.opponents[0].title).toBe("Bot");
    const sysop = fixtureModel("sysop");
    expect(sysop.opponents[0].title).toBe("Mono Red Burn");
    expect(sysop.anchored!.title).toBe("Mono Green Creatures");
  });

  it("carry commanders, their tax and the commander damage each seat has taken", () => {
    const m = fixtureModel("three");
    expect(m.commander).toBe(true);
    expect(m.anchored!.commanders).toEqual([
      {
        name: "Krenko, Mob Boss",
        zone: "command",
        objectId: m.anchored!.command[0].slice("command:".length),
        tax: 2,
        damageDealt: [{ seat: 1, damage: 6 }],
      },
    ]);
    expect(m.opponents[0].commanderDamageTaken).toEqual([
      { fromSeat: 0, commander: "Krenko, Mob Boss", damage: 6 },
    ]);
    expect(m.opponents[1].commanderDamageTaken).toEqual([]);
  });
});

describe("the table model", () => {
  it("knows the arrangement from the number of players", () => {
    expect(fixtureModel("duel").arrangement).toBe("duel");
    expect(fixtureModel("three").arrangement).toBe("three");
    expect(fixtureModel("four").arrangement).toBe("four");
    expect(fixtureModel("spectator").arrangement).toBe("three");
  });

  it("draws curves for casts, targets, attacks and blocks", () => {
    const stack = fixtureModel("stack");
    const casts = stack.lines.filter((l) => l.kind === "cast");
    expect(casts).toHaveLength(8);
    expect(casts.map((l) => l.emphasis)).toEqual([
      "always",
      ...Array(7).fill("hover"),
    ]);
    expect(casts[0]).toMatchObject({
      from: { seat: 1 },
      to: { key: stack.stack[0].key },
      owner: "opponent",
    });
    expect(casts[1].owner).toBe("viewer");
    expect(stack.lines.filter((l) => l.kind === "target")).toHaveLength(4);
    const blockers = fixtureModel("blockers");
    const attacks = blockers.lines.filter((l) => l.kind === "attack");
    expect(attacks.map((l) => l.to)).toEqual([
      { seat: 0 },
      { seat: 0 },
      { key: named(blockers, "Ajani Goldmane").key },
    ]);
    expect(blockers.lines.filter((l) => l.kind === "block")).toEqual([
      {
        key: `block:${named(blockers, "Grizzly Bears").key}:1`,
        kind: "block",
        from: { key: named(blockers, "Grizzly Bears").key },
        to: { key: named(blockers, "Goblin Guide").key },
        owner: "viewer",
        emphasis: "always",
      },
    ]);
  });

  it("is empty but valid before the first view", () => {
    const m = fixtureModel("starting");
    expect(m.anchored).toBeNull();
    expect(m.cards.size).toBe(0);
    const l = layoutTable(m, { expandedSeat: null, textScale: 1 });
    expect(l.players.size).toBe(0);
    expect(validateHits(l, m)).toEqual([]);
  });

  it("keeps each zone's cards in view order, top last", () => {
    const m = fixtureModel("duel");
    const f = tableFixture("duel");
    expect(m.hand).toEqual(f.snapshot.view!.hand.map((c) => `hand:${c.id}`));
    expect(m.opponents[0].graveyard).toEqual(
      f.snapshot.view!.opponents[0].graveyard.map((c) => `graveyard:${c.id}`),
    );
  });
});
