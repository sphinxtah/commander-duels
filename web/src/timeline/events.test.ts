import { describe as suite, expect, it } from "vitest";
import {
  describe,
  GROUPS,
  LARGE,
  largeChanges,
  plainText,
  RULES,
  stepWords,
  turnOwners,
  typesFor,
  whatChanged,
  type GameEvent,
  type Line,
  type Thing,
} from "./events";

// The timeline's words (v1.0.0): each kind of event as a sentence, what explains it and by which
// rule, the honest fallback where the events carry no reason, and "What changed?".

const NAMES = ["Ada", "Bea", "Cy", "Dee"];
const seatName = (seat: number) => NAMES[seat] ?? `Player ${seat + 1}`;

let seq = 0;
function event(type: string, rest: Partial<GameEvent> = {}): GameEvent {
  seq += 1;
  return {
    v: 2,
    seq,
    epoch: 0,
    turn: 3,
    step: "precombat_main",
    type,
    ...rest,
  };
}
function card(name: string, ref: string, owner = 0, more: object = {}): Thing {
  return { ref, name, owner, ...more };
}
const text = (line: Line) => plainText(line.text, seatName);
const notes = (line: Line) =>
  line.notes.map((note) => plainText(note.text, seatName));

suite("the timeline's sentences", () => {
  it("says what a cast cost, and what raised it", () => {
    const [line] = describe([
      event("cast", {
        player: 1,
        object: card("Grizzly Bears", "o1", 1, { mana_cost: "{1}{G}" }),
        cost: {
          paid: "{5}{G}",
          changes: [
            { how: "more", tax: true, amount: 2 },
            { how: "more", by: card("Sphere of Resistance", "o2") },
            { how: "less", by: { hidden: true, owner: 2 } },
          ],
        },
      }),
    ]);
    expect(text(line)).toBe("Bea cast Grizzly Bears for {5}{G}.");
    expect(line.group).toBe("spells");
    expect(notes(line)).toEqual([
      "Its printed cost is {1}{G}.",
      `Commander tax: {2} more, {2} for each time it was cast from the command zone before. (rule ${RULES.commanderTax})`,
      `Its cost was raised by Sphere of Resistance. (rule ${RULES.totalCost})`,
      `Its cost was reduced by a hidden card. (rule ${RULES.totalCost})`,
    ]);
    expect(line.notes.some((note) => note.unknown)).toBe(false);
  });

  it("says nothing of a cost that is the printed one, and so of X", () => {
    const [plain, x] = describe([
      event("cast", {
        player: 0,
        object: card("Lightning Bolt", "o1", 0, { mana_cost: "{R}" }),
        cost: { paid: "{R}" },
      }),
      event("cast", {
        player: 0,
        object: card("Fireball", "o2", 0, { mana_cost: "{X}{R}" }),
        cost: { paid: "{3}{R}", x: 3 },
      }),
    ]);
    expect(notes(plain)).toEqual([]);
    expect(notes(x)).toEqual(["Its printed cost is {X}{R}.", "X was 3."]);
  });

  it("says that the game recorded no reason for a cost it cannot explain", () => {
    const [line] = describe([
      event("cast", {
        player: 0,
        object: card("Grizzly Bears", "o1", 0, { mana_cost: "{1}{G}" }),
        cost: { paid: "{0}" },
      }),
    ]);
    expect(line.notes).toHaveLength(1);
    expect(line.notes[0].unknown).toBe(true);
    expect(notes(line)[0]).toContain("The game recorded no reason");
  });

  it("tells a spell cast face down by what was paid alone", () => {
    const [line] = describe([
      event("cast", {
        player: 2,
        object: { hidden: true, owner: 2 },
        cost: { paid: "{3}" },
      }),
    ]);
    expect(text(line)).toBe("Cy cast a hidden card for {3}.");
    expect(notes(line)).toEqual([]);
  });

  it("explains a death by lethal damage with the damage before it", () => {
    const bears = card("Grizzly Bears", "o10", 1);
    const lines = describe([
      event("damage", {
        target: bears,
        amount: 3,
        cause: card("Lightning Bolt", "o11"),
      }),
      event("zone_change", {
        from: "battlefield",
        to: "graveyard",
        player: 1,
        object: card("Grizzly Bears", "o12", 1, { was: "o10" }),
        why: "lethal_damage",
      }),
    ]);
    expect(text(lines[0])).toBe(
      "Lightning Bolt dealt 3 damage to Grizzly Bears.",
    );
    expect(text(lines[1])).toBe("Grizzly Bears died.");
    expect(notes(lines[1])).toEqual([
      `Lethal damage: the damage on it was at least its toughness, so the rules destroyed it. (rule ${RULES.lethalDamage})`,
      "It had been dealt 3 damage this turn, by Lightning Bolt.",
    ]);
  });

  it.each([
    ["toughness", "Grizzly Bears died.", RULES.toughness],
    ["deathtouch", "Grizzly Bears died.", RULES.deathtouch],
    ["legend_rule", "Grizzly Bears left the battlefield.", RULES.legendRule],
    ["loyalty", "Grizzly Bears left the battlefield.", RULES.loyalty],
    ["unattached", "Grizzly Bears left the battlefield.", RULES.unattached],
    ["sacrificed", "Grizzly Bears was sacrificed.", RULES.sacrificed],
    ["destroyed", "Grizzly Bears was destroyed.", RULES.destroyed],
  ])("names why a permanent left: %s", (why, sentence, rule) => {
    const [line] = describe([
      event("zone_change", {
        from: "battlefield",
        to: "graveyard",
        player: 1,
        object: card("Grizzly Bears", "o12", 1, { was: "o10" }),
        cause:
          why === "destroyed" || why === "sacrificed"
            ? card("Doom Blade", "o13")
            : undefined,
        why,
      }),
    ]);
    expect(text(line)).toBe(sentence);
    expect(notes(line).join(" ")).toContain(`(rule ${rule})`);
    expect(line.notes.some((note) => note.unknown)).toBe(false);
  });

  it("says a destroyed commander went to the command zone, and never that it died", () => {
    const [line] = describe([
      event("zone_change", {
        from: "battlefield",
        to: "command",
        player: 1,
        object: card("Isamaru, Hound of Konda", "o12", 1, { was: "o10" }),
        why: "lethal_damage",
      }),
    ]);
    expect(text(line)).toBe(
      "Isamaru, Hound of Konda left the battlefield: to the command zone.",
    );
  });

  it("says so when the events carry no reason for a death", () => {
    const lines = describe([
      event("damage", {
        target: card("Grizzly Bears", "o10", 1),
        amount: 2,
        combat: true,
        cause: card("Runeclaw Bear", "o11"),
      }),
      // Version 1: no `why`.
      event("zone_change", {
        v: 1,
        from: "battlefield",
        to: "graveyard",
        player: 1,
        object: card("Grizzly Bears", "o12", 1, { was: "o10" }),
      }),
      event("zone_change", {
        v: 1,
        from: "battlefield",
        to: "graveyard",
        player: 0,
        object: card("Savannah Lions", "o22", 0, { was: "o20" }),
      }),
    ]);
    expect(text(lines[0])).toBe(
      "Runeclaw Bear dealt 2 combat damage to Grizzly Bears.",
    );
    expect(text(lines[1])).toBe(
      "Grizzly Bears left the battlefield: to Bea’s graveyard.",
    );
    expect(notes(lines[1])).toEqual([
      "It had been dealt 2 damage this turn, by Runeclaw Bear.",
      "The game recorded no reason beyond that damage.",
    ]);
    expect(lines[1].notes[1].unknown).toBe(true);
    expect(notes(lines[2])).toEqual(["The game recorded no reason."]);
    expect(lines[2].notes[0].unknown).toBe(true);
  });

  it("owes a reason only to a death: an exile or a return says where it went", () => {
    const [exiled, returned] = describe([
      event("zone_change", {
        from: "battlefield",
        to: "exiled",
        player: 1,
        object: card("Grizzly Bears", "o12", 1),
        cause: card("Swords to Plowshares", "o13"),
      }),
      event("zone_change", {
        from: "battlefield",
        to: "hand",
        player: 1,
        object: card("Runeclaw Bear", "o14", 1),
      }),
    ]);
    expect(text(exiled)).toBe(
      "Grizzly Bears left the battlefield: it was exiled, by Swords to Plowshares.",
    );
    expect(text(returned)).toBe(
      "Runeclaw Bear left the battlefield: to Bea’s hand.",
    );
    expect(returned.notes).toEqual([]);
  });

  it("explains a spell or an ability that did not resolve", () => {
    const [spell, ability, countered] = describe([
      event("fizzled", {
        of: "spell",
        player: 0,
        object: card("Lightning Bolt", "o1"),
        why: "targets",
      }),
      event("fizzled", {
        of: "ability",
        player: 0,
        object: card("Prodigal Pyromancer", "o2"),
        why: "condition",
      }),
      event("countered", {
        object: card("Grizzly Bears", "o3", 1),
        cause: card("Counterspell", "o4"),
      }),
    ]);
    expect(text(spell)).toBe("Lightning Bolt did not resolve.");
    expect(notes(spell)[0]).toContain(`(rule ${RULES.illegalTargets})`);
    expect(text(ability)).toBe(
      "An ability of Prodigal Pyromancer did not resolve.",
    );
    expect(notes(ability)[0]).toContain(`(rule ${RULES.interveningIf})`);
    expect(text(countered)).toBe(
      "Grizzly Bears was countered, by Counterspell.",
    );
    expect(notes(countered)[0]).toContain(`(rule ${RULES.countered})`);
  });

  it("keeps bookkeeping quiet: a card put onto the stack, a land tapped, a resolved spell's card", () => {
    const lines = describe([
      event("zone_change", {
        from: "hand",
        to: "stack",
        player: 0,
        object: card("Lightning Bolt", "o2", 0, { was: "o1" }),
      }),
      event("cast", { player: 0, object: card("Lightning Bolt", "o2") }),
      event("resolve", {
        player: 0,
        object: card("Mountain", "o5"),
        immediate: true,
      }),
      event("resolve", { player: 0, object: card("Lightning Bolt", "o2") }),
      event("zone_change", {
        from: "stack",
        to: "graveyard",
        player: 0,
        object: card("Lightning Bolt", "o3", 0, { was: "o2" }),
      }),
    ]);
    expect(lines.map((line) => line.quiet)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(text(lines[3])).toBe("Lightning Bolt resolved.");
    expect(lines[3].resolution).toBe(true);
    expect(lines[2].resolution).toBe(false);
  });

  it("says that a spell left the stack with no resolution on record", () => {
    // Version 1 knew no "fizzled": the card's way to the graveyard is all there is.
    const [line] = describe([
      event("zone_change", {
        v: 1,
        from: "stack",
        to: "graveyard",
        player: 0,
        object: card("Lightning Bolt", "o3", 0, { was: "o2" }),
      }),
    ]);
    expect(line.quiet).toBe(false);
    expect(text(line)).toBe(
      "Lightning Bolt left the stack for Ada’s graveyard.",
    );
    expect(line.notes[0].unknown).toBe(true);
  });

  it("names nothing it was not shown", () => {
    const lines = describe([
      event("zone_change", {
        from: "library",
        to: "hand",
        player: 1,
        object: { hidden: true, owner: 1 },
      }),
      event("damage", {
        target: { seat: 0 },
        amount: 2,
        combat: true,
        cause: { hidden: true, owner: 2 },
      }),
      event("attack", {
        player: 2,
        object: { hidden: true, owner: 2 },
        target: { seat: 0 },
      }),
    ]);
    expect(lines.map(text)).toEqual([
      "Bea drew a hidden card.",
      "A hidden card dealt 2 combat damage to Ada.",
      "A hidden card attacked Ada.",
    ]);
  });

  it("puts the other events into words", () => {
    const bears = card("Grizzly Bears", "o1", 1);
    const lines = describe([
      event("zone_change", {
        from: "hand",
        to: "battlefield",
        player: 0,
        object: card("Forest", "o9"),
      }),
      event("activate", { player: 0, object: card("Viscera Seer", "o8") }),
      event("trigger", { player: 1, object: bears }),
      event("target", { player: 0, cause: card("Shock", "o7"), target: bears }),
      event("block", { player: 1, object: bears, target: card("Elf", "o6") }),
      event("life_lost", { player: 0, amount: 2 }),
      event("life_gained", {
        player: 1,
        amount: 3,
        cause: card("Healing Salve", "o5"),
      }),
      event("counters_added", { target: bears, counter: "+1/+1", amount: 2 }),
      event("token_created", { player: 0, object: card("Soldier", "o4") }),
      event("zone_change", {
        from: "stack",
        to: "battlefield",
        player: 1,
        object: bears,
      }),
      event("zone_change", {
        from: "hand",
        to: "graveyard",
        player: 0,
        object: card("Shock", "o3"),
      }),
      event("eliminated", { player: 0 }),
      event("won", { player: 1 }),
    ]);
    expect(lines.map(text)).toEqual([
      "Ada played Forest.",
      "Ada activated an ability of Viscera Seer.",
      "An ability of Grizzly Bears triggered, for Bea.",
      "Shock targets Grizzly Bears.",
      "Grizzly Bears blocked Elf.",
      "Ada lost 2 life.",
      "Bea gained 3 life, by Healing Salve.",
      "2 +1/+1 counters were put on Grizzly Bears.",
      "Ada created Soldier, a token.",
      "Grizzly Bears resolved and entered the battlefield.",
      "Ada discarded Shock.",
      "Ada lost the game.",
      "Bea won the game.",
    ]);
    expect(lines[9].resolution).toBe(true);
  });

  it("heads turns and steps, and asks the server for the kinds chosen", () => {
    const events = [
      event("step", { turn: 4, step: "upkeep", active: 2 }),
      event("step", { turn: 5, step: "draw", active: 3 }),
    ];
    expect(describe(events)).toEqual([]);
    expect([...turnOwners(events)]).toEqual([
      [4, 2],
      [5, 3],
    ]);
    expect(stepWords("declare_attackers")).toBe("Declare attackers");
    expect(stepWords("some_new_step")).toBe("some new step");
    expect(typesFor(new Set())).toEqual([]);
    expect(typesFor(new Set(["combat"]))).toEqual(["attack", "block"]);
    // Every type the engine makes belongs to one kind, steps apart.
    const all = GROUPS.flatMap((group) => group.types);
    expect(new Set(all).size).toBe(all.length);
    for (const type of [
      "zone_change",
      "cast",
      "activate",
      "trigger",
      "target",
      "resolve",
      "countered",
      "fizzled",
      "attack",
      "block",
      "damage",
      "life_gained",
      "life_lost",
      "counters_added",
      "counters_removed",
      "token_created",
      "eliminated",
      "won",
    ])
      expect(all).toContain(type);
  });
});

suite("What changed?", () => {
  function wipe(): GameEvent[] {
    seq = 0;
    return [
      event("cast", { player: 0, object: card("Wrath of God", "o1") }),
      event("resolve", { player: 0, object: card("Wrath of God", "o1") }),
      ...["Grizzly Bears", "Runeclaw Bear", "Savannah Lions"].map((name, at) =>
        event("zone_change", {
          from: "battlefield",
          to: "graveyard",
          player: 1,
          object: card(name, `o2${at}`, 1),
          why: "destroyed",
          cause: card("Wrath of God", "o1"),
        }),
      ),
      event("zone_change", {
        from: "battlefield",
        to: "command",
        player: 0,
        object: card("Isamaru, Hound of Konda", "o30"),
        why: "destroyed",
      }),
      event("trigger", { player: 1, object: card("Blood Artist", "o40", 1) }),
      event("life_lost", { player: 0, amount: 1 }),
      event("life_lost", { player: 0, amount: 1 }),
      event("zone_change", {
        from: "stack",
        to: "graveyard",
        player: 0,
        object: card("Wrath of God", "o2", 0, { was: "o1" }),
      }),
      // The next thing a player does ends what the resolution changed.
      event("cast", { player: 1, object: card("Shock", "o50", 1) }),
      event("life_lost", { player: 0, amount: 2 }),
    ];
  }

  it("sums up what a large resolution did, up to the next action", () => {
    const events = wipe();
    const summary = whatChanged(events, 1)!;
    expect(summary.seq).toBe(2);
    expect(summary.until).toBe(10);
    expect(plainText([summary.source], seatName)).toBe("Wrath of God");
    expect(
      summary.changes.map((change) => plainText(change.text, seatName)),
    ).toEqual([
      "3 permanents went to the graveyard: Grizzly Bears, Runeclaw Bear, Savannah Lions.",
      "1 permanent went to the command zone: Isamaru, Hound of Konda.",
      "Ada lost 2 life.",
      "1 ability triggered.",
    ]);
    expect(summary.size).toBe(5);
    expect(summary.size).toBeGreaterThanOrEqual(LARGE);
    expect([...largeChanges(events).keys()]).toEqual([2]);
  });

  it("offers nothing for a small resolution", () => {
    seq = 0;
    const events = [
      event("resolve", { player: 0, object: card("Lightning Bolt", "o1") }),
      event("damage", {
        target: { seat: 1 },
        amount: 3,
        cause: card("Lightning Bolt", "o1"),
      }),
      event("life_lost", { player: 1, amount: 3 }),
      // A land tapped for mana ends nothing and changes nothing.
      event("resolve", {
        player: 0,
        object: card("Mountain", "o2"),
        immediate: true,
      }),
    ];
    const summary = whatChanged(events, 0)!;
    expect(
      summary.changes.map((change) => plainText(change.text, seatName)),
    ).toEqual(["Bea was dealt 3 damage.", "Bea lost 3 life."]);
    expect(summary.size).toBe(2);
    expect(largeChanges(events).size).toBe(0);
  });

  it("counts cards it may not name without naming them", () => {
    seq = 0;
    const events = [
      event("resolve", { player: 0, object: card("Wheel of Fortune", "o1") }),
      ...[0, 0, 1, 1, 1].map((player) =>
        event("zone_change", {
          from: "hand",
          to: "graveyard",
          player,
          object: card("A card", `o9${seq}`, player),
        }),
      ),
      ...[0, 1, 1].map((player) =>
        event("zone_change", {
          from: "library",
          to: "hand",
          player,
          object: { hidden: true, owner: player },
        }),
      ),
      event("token_created", { player: 0, object: card("Treasure", "o70") }),
      event("zone_change", {
        from: "stack",
        to: "battlefield",
        player: 0,
        object: card("Next Spell", "o80"),
      }),
    ];
    const summary = whatChanged(events, 0)!;
    expect(
      summary.changes.map((change) => plainText(change.text, seatName)),
    ).toEqual([
      "1 token was created: Treasure.",
      "Ada drew 1 card.",
      "Bea drew 2 cards.",
      "Ada discarded 2 cards.",
      "Bea discarded 3 cards.",
    ]);
    expect(summary.size).toBe(5);
  });
});
