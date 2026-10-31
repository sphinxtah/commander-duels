import { describe, expect, it } from "vitest";
import { fixtureInput, tableFixture } from "../../table/fixtures";
import { buildTableModel } from "../../table/tableModel";
import type { EffectsLevel, TableEvent, TableModel } from "../../table/types";
import { planEffects, type Fx } from "./plan";

// Which effects a diff plays, from its events alone (v0.7.0).

const model = buildTableModel(fixtureInput(tableFixture("blockers")));
const graveyard = { kind: "anchor", anchor: "graveyard", seat: 1 } as const;
const appear = { kind: "appear" } as const;
const dragon = [...model.cards.values()].find(
  (c) => c.card.name === "Shivan Dragon",
)!;
const bears = [...model.cards.values()].find(
  (c) => c.card.name === "Grizzly Bears",
)!;

const events = {
  slain: {
    type: "leave",
    key: bears.key,
    to: graveyard,
    creature: true,
    combat: true,
  },
  died: {
    type: "leave",
    key: bears.key,
    to: graveyard,
    creature: true,
    combat: false,
  },
  tokenSlain: {
    type: "leave",
    key: bears.key,
    to: { kind: "vanish" },
    creature: true,
    combat: true,
  },
  exiled: {
    type: "leave",
    key: bears.key,
    to: { kind: "anchor", anchor: "exile", seat: 1 },
    creature: true,
    combat: true,
  },
  artifactGone: {
    type: "leave",
    key: bears.key,
    to: graveyard,
    creature: false,
    combat: false,
  },
  cast: {
    type: "cast",
    key: "stack:s1",
    controllerSeat: 0,
    from: appear,
    commander: false,
  },
  commander: {
    type: "cast",
    key: "stack:s1",
    controllerSeat: 0,
    from: { kind: "node", key: "command:k1" },
    commander: true,
  },
  resolve: {
    type: "resolve",
    key: "stack:s1",
    to: { kind: "node", key: dragon.key },
    big: false,
    colours: [],
  },
  bigSpell: {
    type: "resolve",
    key: "stack:s1",
    to: { kind: "node", key: dragon.key },
    big: true,
    colours: ["R"],
  },
  bigInstant: {
    type: "resolve",
    key: "stack:s1",
    to: graveyard,
    big: true,
    colours: ["U", "R"],
  },
  dragonEnters: {
    type: "enter",
    key: dragon.key,
    from: { kind: "node", key: "stack:s1" },
    land: false,
    token: false,
  },
  bearsEnter: {
    type: "enter",
    key: bears.key,
    from: appear,
    land: false,
    token: false,
  },
  attack: { type: "attack", keys: [dragon.key, bears.key] },
  block: { type: "block", keys: [bears.key] },
  scratch: { type: "life", seat: 0, delta: -2 },
  blow: { type: "life", seat: 0, delta: -5 },
  theirBlow: { type: "life", seat: 1, delta: -6 },
  heavy: { type: "life", seat: 0, delta: -12 },
  gain: { type: "life", seat: 0, delta: 3 },
  bigGain: { type: "life", seat: 0, delta: 7 },
  eliminated: { type: "eliminated", seat: 1 },
  victory: { type: "result", outcome: "victory" },
  defeat: { type: "result", outcome: "defeat" },
  drawn: { type: "result", outcome: "draw" },
  yourTurn: { type: "turn", turn: 11, activeSeat: 0 },
  theirTurn: { type: "turn", turn: 12, activeSeat: 1 },
  teamTurn: { type: "turn", turn: 13, activeSeat: 1, yours: true },
} satisfies Record<string, TableEvent>;

function plan(
  event: TableEvent,
  level: EffectsLevel = "full",
  m: TableModel = model,
): Fx[] {
  return planEffects({ baseline: false, events: [event] }, m, level);
}

describe("the special effects of a diff", () => {
  it.each<[string, TableEvent, Fx["kind"] | null]>([
    ["a creature slain in combat", events.slain, "slash"],
    ["a creature token slain in combat", events.tokenSlain, "slash"],
    ["a creature that died another way", events.died, "ash"],
    ["a creature exiled from combat", events.exiled, null],
    ["an artifact destroyed", events.artifactGone, null],
    ["a plain cast", events.cast, null],
    ["a commander cast", events.commander, "burst"],
    ["a small spell resolving", events.resolve, null],
    ["a big spell resolving", events.bigSpell, "burst"],
    ["a big instant resolving", events.bigInstant, "burst"],
    ["a big creature entering", events.dragonEnters, "stomp"],
    ["a small creature entering", events.bearsEnter, null],
    ["an attack", events.attack, "embers"],
    ["a block", events.block, "shield"],
    ["a scratch", events.scratch, null],
    ["a heavy blow", events.blow, "impact"],
    ["a little life gained", events.gain, null],
    ["a lot of life gained", events.bigGain, "glitter"],
    ["an elimination", events.eliminated, "shatter"],
    ["a victory", events.victory, "confetti"],
    ["a defeat", events.defeat, "ashfall"],
    ["a drawn game", events.drawn, null],
    ["the viewer's turn", events.yourTurn, "shine"],
    ["another player's turn", events.theirTurn, null],
    ["the viewer's team's turn", events.teamTurn, "shine"],
  ])("%s", (_, event, kind) => {
    expect(plan(event).map((fx) => fx.kind)).toEqual(kind ? [kind] : []);
  });

  it("plays nothing when off, or for a baseline", () => {
    expect(plan(events.slain, "off")).toEqual([]);
    expect(
      planEffects({ baseline: true, events: [events.slain] }, model, "full"),
    ).toEqual([]);
  });

  it("keeps the marks and rings when subtle, and leaves out the particles", () => {
    const kinds = (event: TableEvent) =>
      plan(event, "subtle").map((fx) => fx.kind);
    expect(kinds(events.slain)).toEqual(["slash"]);
    expect(kinds(events.died)).toEqual([]);
    expect(kinds(events.bigSpell)).toEqual(["burst"]);
    expect(kinds(events.dragonEnters)).toEqual(["stomp"]);
    expect(kinds(events.attack)).toEqual([]);
    expect(kinds(events.block)).toEqual(["shield"]);
    expect(kinds(events.blow)).toEqual(["impact"]);
    expect(kinds(events.bigGain)).toEqual([]);
    expect(kinds(events.eliminated)).toEqual(["shatter"]);
    expect(kinds(events.victory)).toEqual([]);
    expect(kinds(events.defeat)).toEqual([]);
    expect(kinds(events.yourTurn)).toEqual(["shine"]);
  });

  it("tells a heavy blow from a blow, and the viewer's from another player's", () => {
    expect(plan(events.blow)).toEqual([
      { kind: "impact", seat: 0, heavy: false, yours: true },
    ]);
    expect(plan(events.heavy)).toEqual([
      { kind: "impact", seat: 0, heavy: true, yours: true },
    ]);
    expect(plan(events.theirBlow)).toEqual([
      { kind: "impact", seat: 1, heavy: false, yours: false },
    ]);
    // An observer has no life of their own.
    const observing = buildTableModel(fixtureInput(tableFixture("spectator")));
    expect(
      plan({ type: "life", seat: 0, delta: -9 }, "full", observing),
    ).toEqual([{ kind: "impact", seat: 0, heavy: false, yours: false }]);
  });

  it("colours a burst by the spell, gold for a commander, and waits for the flight", () => {
    expect(plan(events.bigSpell)).toEqual([
      {
        kind: "burst",
        at: { kind: "node", key: dragon.key },
        colours: ["R"],
        commander: false,
        afterFlight: true,
      },
    ]);
    expect(plan(events.bigInstant)).toEqual([
      {
        kind: "burst",
        at: { kind: "exit", to: graveyard },
        colours: ["U", "R"],
        commander: false,
        afterFlight: true,
      },
    ]);
    expect(plan(events.commander)).toEqual([
      {
        kind: "burst",
        at: { kind: "node", key: "stack:s1" },
        colours: [],
        commander: true,
        afterFlight: true,
      },
    ]);
    expect(plan(events.dragonEnters)).toEqual([
      { kind: "stomp", key: dragon.key, afterFlight: true },
    ]);
  });

  it("marks at most six attackers or blockers", () => {
    const keys = Array.from({ length: 9 }, (_, i) => `battlefield:x${i}`);
    expect(plan({ type: "attack", keys })).toEqual([
      { kind: "embers", keys: keys.slice(0, 6) },
    ]);
    expect(plan({ type: "block", keys })).toEqual([
      { kind: "shield", keys: keys.slice(0, 6) },
    ]);
  });
});
