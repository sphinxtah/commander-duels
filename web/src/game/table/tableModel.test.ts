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

  it("show a human's allied Planeswalker's portrait, never a bot's (v0.3.1)", () => {
    expect(fixtureModel("duel").anchored!.portrait).toBeNull();
    const f = tableFixture("duel");
    f.summarySeats = [
      { ...f.summarySeats[0], portrait: "rowan" },
      { seat: 1, player: "bot", handle: null, deck: null, portrait: "jace" },
    ];
    let m = model(f);
    expect(m.anchored!.portrait).toBe("rowan");
    expect(m.opponents[0].portrait).toBeNull();
    f.summarySeats[1] = {
      seat: 1,
      player: "human",
      handle: "bob",
      deck: null,
      portrait: "chandra",
    };
    m = model(f);
    expect(m.opponents[0].portrait).toBe("chandra");
    // The portrait is the player's picture only: the sigil stays their fallback, grey for an
    // opponent, and their life is still their own.
    expect(m.opponents[0].sigil).toEqual({ seed: "handle:bob", grey: true });
    expect(m.opponents[0].targetLabel).toContain(
      `${m.opponents[0].player.life} life`,
    );
    expect(m.opponents[0].targetLabel).not.toMatch(/chandra|loyalty/i);
  });

  it("take your own portrait from your account until the summary arrives", () => {
    const f = tableFixture("duel");
    const input = { ...fixtureInput(f), selfPortrait: "rowan" };
    input.summarySeats = null;
    let m = buildTableModel(input);
    expect(m.anchored!.portrait).toBe("rowan");
    expect(m.opponents[0].portrait).toBeNull();
    // Once it has, the summary says: here, no alliance.
    input.summarySeats = f.summarySeats;
    m = buildTableModel(input);
    expect(m.anchored!.portrait).toBeNull();
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

  it("keeps revealed and looked-at cards under their own keys, one in your hand as well", () => {
    const f = tableFixture("revealed");
    const v = f.snapshot.view!;
    const m = model(f);
    const [theirs, mine] = v.revealed;
    const dragon = mine.cards[0];
    expect(v.hand.map((c) => c.id)).toContain(dragon.id);
    expect([...m.cards.keys()].slice(-6)).toEqual([
      ...theirs.cards.map((c) => `revealed:${c.id}`),
      `revealed:${dragon.id}`,
      ...v.looked_at[0].cards.map((c) => `looked_at:${c.id}`),
    ]);
    // The same card twice: in your hand and in the revealed row, each its own button.
    const inHand = m.cards.get(`hand:${dragon.id}`)!;
    const shown = m.cards.get(`revealed:${dragon.id}`)!;
    expect(shown).toMatchObject({
      id: dragon.id,
      zone: "revealed",
      ownerSeat: null,
      controllerSeat: null,
      located: { id: dragon.id, zone: "revealed", seat: null },
      mark: "none",
      drag: null,
      label: inHand.label,
    });
    expect(m.hand).toContain(inHand.key);
    expect(m.cards.get(`revealed:${theirs.cards[0].id}`)).toMatchObject({
      mark: "offered",
      label: "Counterspell, Instant. Options: Choose Counterspell",
      drag: null,
    });
    expect(m.cards.get(`revealed:${theirs.cards[1].id}`)?.mark).toBe("none");
    expect(
      m.cards.get(`looked_at:${v.looked_at[0].cards[0].id}`),
    ).toMatchObject({
      zone: "looked_at",
      label: "Serra Angel, Creature — Angel, 4/4",
      mark: "none",
    });
    // They are listed beside the prompt, so the table draws none of them.
    const l = layoutTable(m, { expandedSeat: null, textScale: 1 });
    for (const key of m.cards.keys())
      if (key.startsWith("revealed:") || key.startsWith("looked_at:"))
        expect(l.nodes.has(key), key).toBe(false);
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

describe("Two-Headed Giant (v0.5.0)", () => {
  /** The four-seat table as Two-Headed Giant: seats 0 and 1 against 2 and 3, one life a team. */
  function giant(): TableFixture {
    const f = tableFixture("four");
    f.snapshot.settings.format = "two_headed_giant";
    const view = f.snapshot.view!;
    for (const p of [view.you!, ...view.opponents]) {
      p.team = Math.floor(p.seat / 2);
      p.life = p.seat < 2 ? 24 : 17;
    }
    return f;
  }

  it("marks the teammate and speaks of the team's life", () => {
    const m = model(giant());
    expect(m.teammateSeat).toBe(1);
    const [mate, ...others] = m.opponents;
    expect(mate).toMatchObject({
      seat: 1,
      team: 0,
      teammate: true,
      title: "Your teammate",
      articleLabel: "Bot 2, seat 2, your teammate",
    });
    expect(mate.targetLabel).toMatch(/^Bot 2: 24 team life\. /);
    expect(m.anchored!.targetLabel).toMatch(/^You: 24 team life\. /);
    for (const other of others) {
      expect(other.teammate).toBe(false);
      expect(other.team).toBe(1);
      expect(other.articleLabel).toMatch(/, the other team$/);
    }
    // The layout seats four as at any four-player table.
    const l = layoutTable(m, { expandedSeat: null, textScale: 1 });
    expect(validateHits(l, m)).toEqual([]);
  });

  it("has no teams at other tables", () => {
    const m = fixtureModel("four");
    expect(m.teammateSeat).toBeNull();
    expect(
      m.opponents.every(
        (p) =>
          !p.teammate &&
          p.team === null &&
          p.teamPill === null &&
          p.teamPoison === null &&
          p.hand === null,
      ),
    ).toBe(true);
    expect(m.opponents[0].title).not.toBe("Your teammate");
  });
});

describe("Two-Headed Giant at the table (v0.5.1)", () => {
  /** The giant fixture from another seat's view: what the engine sends that seat, its
   * teammate's hand included and every other hand a count. */
  function fromSeat(seat: number): TableFixture {
    const f = tableFixture("giant");
    const v = f.snapshot.view!;
    const everyone: PlayerView[] = [v.you!, ...v.opponents].map((p) => ({
      ...p,
      hand: null,
    }));
    const mate = everyone.find(
      (p) => p.team === Math.floor(seat / 2) && p.seat !== seat,
    )!;
    mate.hand = Array.from({ length: mate.hand_count }, (_, i) => ({
      ...CARD,
      id: `mate-${seat}-${i}`,
    }));
    const you = everyone.find((p) => p.seat === seat)!;
    f.snapshot = {
      ...f.snapshot,
      prompt: null,
      view: {
        ...v,
        seat,
        you,
        opponents: everyone.filter((p) => p !== you),
        hand: [],
      },
    };
    f.seat = seat;
    return f;
  }
  const CARD = {
    hidden: false,
    name: "Lightning Bolt",
    mana_cost: "{R}",
    type_line: "Instant",
    power: null,
    toughness: null,
    rules: ["Lightning Bolt deals 3 damage to any target."],
  };

  it("shows the teammate's hand card for card, face up and never playable", () => {
    const f = tableFixture("giant");
    const theirs = f.snapshot.view!.opponents[0].hand!;
    // Even a prompt naming the teammate's cards gives them no options on the table.
    f.snapshot.prompt!.options.push(
      {
        id: "99",
        action: "cast",
        label: null,
        object_id: theirs[0].id,
        seat: null,
        selected: false,
      },
      {
        id: "98",
        action: "choose",
        label: null,
        object_id: theirs[1].id,
        seat: null,
        selected: false,
      },
    );
    const m = model(f);
    const mate = m.opponents[0];
    expect(mate.seat).toBe(1);
    expect(mate.hand).toEqual(theirs.map((card) => `hand:${card.id}`));
    for (const [i, key] of mate.hand!.entries()) {
      const card = m.cards.get(key)!;
      expect(card).toMatchObject({
        zone: "hand",
        ownerSeat: 1,
        controllerSeat: 1,
        offered: [],
        mark: "none",
        drag: null,
        located: { id: theirs[i].id, zone: "hand", seat: 1 },
      });
      expect(card.card).toEqual(theirs[i]);
      expect(card.label).toBe(cardLabel(card.card, card.located));
    }
    expect(m.cards.get(mate.hand![0])!.label).toBe("Lightning Bolt, Instant");
    // Your own hand stays yours alone.
    expect(m.hand).toHaveLength(5);
    expect(m.hand.some((key) => mate.hand!.includes(key))).toBe(false);
    expect(m.anchored!.hand).toBeNull();
    expect(m.opponents.slice(1).every((p) => p.hand === null)).toBe(true);
  });

  it("sits each viewer's teammate first and the other team beside it", () => {
    expect(fixtureModel("giant").opponents.map((p) => p.seat)).toEqual([
      1, 2, 3,
    ]);
    for (const [seat, order] of [
      [0, [1, 2, 3]],
      [1, [0, 2, 3]],
      [2, [3, 0, 1]],
      [3, [2, 0, 1]],
    ] as const) {
      const m = model(fromSeat(seat));
      expect(
        m.opponents.map((p) => p.seat),
        `seat ${seat}`,
      ).toEqual(order);
      expect(m.teammateSeat).toBe(order[0]);
      expect(m.opponents[0]).toMatchObject({ teammate: true });
      expect(m.opponents[0].hand).toHaveLength(
        m.opponents[0].player.hand_count,
      );
      const l = layoutTable(m, { expandedSeat: null, textScale: 1 });
      expect(validateHits(l, m), `seat ${seat}`).toEqual([]);
    }
  });

  it("marks every plate's team: to a player the teammate and the other team, to SysOp each team's number", () => {
    const m = fixtureModel("giant");
    expect(m.anchored!.teamPill).toBeNull();
    expect(m.opponents.map((p) => p.teamPill)).toEqual([
      { text: "Teammate", tone: "team" },
      { text: "Other team", tone: "foe" },
      { text: "Other team", tone: "foe" },
    ]);
    const sysop = fixtureModel("giantSysop");
    expect(sysop.teammateSeat).toBeNull();
    expect(
      [sysop.anchored!, ...sysop.opponents].map((p) => [
        p.seat,
        p.teamPill?.text,
        p.articleLabel,
      ]),
    ).toEqual([
      [0, "Team 1", null],
      [1, "Team 1", "Bot 2, seat 2, team 1"],
      [2, "Team 2", "Bot 3, seat 3, team 2"],
      [3, "Team 2", "Bot 4, seat 4, team 2"],
    ]);
    // SysOp sees what the watched seat sees: its teammate's hand too.
    expect(sysop.opponents[0].hand).toHaveLength(6);
    expect(sysop.opponents[0].title).toBe("Mono Red Burn");
  });

  it("shows a spectator every team by its number, and no hand", () => {
    const f = tableFixture("giant");
    const v = f.snapshot.view!;
    f.snapshot = {
      ...f.snapshot,
      prompt: null,
      view: {
        ...v,
        seat: null,
        you: null,
        opponents: [v.you!, ...v.opponents].map((p) => ({
          ...p,
          hand: null,
        })),
        hand: [],
        priority: null,
      },
    };
    f.seat = null;
    f.role = "observer";
    const m = model(f);
    expect(m.anchored!.seat).toBe(0);
    expect(m.opponents.map((p) => [p.seat, p.teamPill?.text, p.hand])).toEqual([
      [1, "Team 1", null],
      [2, "Team 2", null],
      [3, "Team 2", null],
    ]);
    expect([...m.cards.values()].some((c) => c.zone === "hand")).toBe(false);
  });

  it("counts poison for the team and colours your team's portraits", () => {
    const m = fixtureModel("giant");
    expect(m.anchored!.teamPoison).toBe(0);
    expect(m.opponents.map((p) => [p.teamPoison, p.sigil.grey])).toEqual([
      [0, false],
      [7, true],
      [7, true],
    ]);
    const sysop = fixtureModel("giantSysop");
    expect(sysop.opponents.map((p) => p.sigil.grey)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("draws a teammate's casts and attacks as the viewer's own", () => {
    const f = tableFixture("giant");
    const v = f.snapshot.view!;
    const guide = v.battlefield.find(
      (p) => p.controller_seat === 1 && p.card.name === "Goblin Guide",
    )!;
    guide.attacking = true;
    const lions = v.battlefield.find((p) => p.card.name === "Savannah Lions")!;
    v.stack = [
      {
        id: "s1",
        kind: "spell",
        controller_seat: 1,
        name: "Lightning Bolt",
        text: null,
        hidden: false,
        targets: [{ kind: "player", seat: 2, object_id: null, label: null }],
      },
      {
        id: "s2",
        kind: "spell",
        controller_seat: 2,
        name: "Shock",
        text: null,
        hidden: false,
        targets: [],
      },
    ];
    v.combat = [
      {
        attackers: [guide.id],
        defender: { kind: "player", seat: 2, object_id: null, label: null },
        blockers: [lions.id],
        blocked: true,
      },
    ];
    const m = model(f);
    const owner = (key: string) => m.lines.find((l) => l.key === key)?.owner;
    expect(owner("cast:s1")).toBe("viewer");
    expect(owner("target:s1:0")).toBe("viewer");
    expect(owner("cast:s2")).toBe("opponent");
    expect(owner(`attack:battlefield:${guide.id}`)).toBe("viewer");
    expect(owner(`block:battlefield:${lions.id}:0`)).toBe("opponent");
  });
});

describe("turn control (rule 723, v0.5.1)", () => {
  it("lets you play the hand of the player whose turn you control, by a press, never a drag", () => {
    const m = fixtureModel("controlling");
    const bot = m.opponents[0];
    expect(bot).toMatchObject({
      seat: 1,
      controlledBy: 0,
      controlPill: { text: "Controlled by you", tone: "control" },
      articleLabel: "Bot 2, seat 2, whose turn you control",
    });
    expect(m.anchored).toMatchObject({ controlledBy: null, controlPill: null });
    const theirs = tableFixture("controlling").snapshot.view!.opponents[0]
      .hand!;
    expect(bot.hand).toEqual(theirs.map((card) => `hand:${card.id}`));
    const brainstorm = named(m, "Brainstorm", "hand");
    expect(brainstorm).toMatchObject({
      ownerSeat: 1,
      mark: "playable",
      drag: null,
    });
    expect(brainstorm.offered.map((o) => o.action)).toEqual(["cast"]);
    expect(named(m, "Island", "hand").offered.map((o) => o.action)).toEqual([
      "play_land",
    ]);
    expect(named(m, "Counterspell", "hand")).toMatchObject({
      offered: [],
      mark: "none",
    });
    // Your own hand has nothing to do in Bot 2's turn.
    expect(
      m.hand.every((key) => m.cards.get(key)!.offered.length === 0),
    ).toBe(true);
    // Its cards are laid out face up by its plate, every one in reach.
    const layout = layoutTable(m, { expandedSeat: null, textScale: 1 });
    expect(validateHits(layout, m)).toEqual([]);
    expect(layout.rows.find((r) => r.key === "hand:1")?.nodes).toHaveLength(
      theirs.length,
    );
  });

  it("tells the controlled player, and everyone else, who controls the turn", () => {
    const m = fixtureModel("controlled");
    expect(m.anchored).toMatchObject({
      controlledBy: 1,
      controlPill: { text: "Controlled by Bot 2", tone: "control" },
    });
    expect(m.opponents[0]).toMatchObject({
      controlledBy: null,
      controlPill: null,
      hand: null,
    });
    // SysOp observing the controller: names, and the hand's marks without answering.
    const f = tableFixture("controlling");
    f.seat = null;
    f.role = "observer";
    f.sysop = true;
    const sysop = model(f);
    expect(sysop.opponents[0].controlPill?.text).toBe("Controlled by Alice");
    expect(sysop.opponents[0].articleLabel).toBe(
      "Bot 2, seat 2, turn controlled by Alice",
    );
    expect(named(sysop, "Brainstorm", "hand")).toMatchObject({
      mark: "playable",
      drag: null,
    });
    expect(sysop.canAnswer).toBe(false);
  });

  it("keeps a hand shown without control shown only", () => {
    // A hand in the view of a player nobody controls (a teammate's) never carries options.
    const f = tableFixture("controlling");
    f.snapshot.view!.opponents[0].controlled_by = null;
    const m = model(f);
    expect(named(m, "Brainstorm", "hand")).toMatchObject({
      offered: [],
      mark: "none",
    });
    expect(m.opponents[0].controlPill).toBeNull();
  });
});
