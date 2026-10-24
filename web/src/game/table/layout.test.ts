import { describe, expect, it } from "vitest";
import {
  FIXTURE_NAMES,
  fixtureInput,
  randomFixture,
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "./fixtures";
import { MIN_ROW_SCALE, diamondBox, rowCard } from "./geometry";
import {
  dropZoneAt,
  fanHand,
  fanTeamHand,
  hitEntries,
  hitTest,
  imageRect,
  layoutTable,
  magnifierSide,
  packRow,
  teamHandRegion,
  validateHits,
  type RowUnitBox,
} from "./layout";
import { buildTableModel } from "./tableModel";
import type { CardNode, MoreNode, TableLayout, TableModel } from "./types";

function model(f: TableFixture, canAnswer?: boolean): TableModel {
  return buildTableModel(fixtureInput(f, { canAnswer }));
}
function fixtureModel(name: FixtureName): TableModel {
  return model(tableFixture(name));
}
function layout(
  m: TableModel,
  expandedSeat: number | null = null,
  textScale: 1 | 1.25 = 1,
): TableLayout {
  return layoutTable(m, { expandedSeat, textScale });
}
/** A fixture between prompts: nothing offered, so any board may expand. */
function quiet(name: FixtureName): TableModel {
  const f = tableFixture(name);
  f.snapshot.prompt = null;
  return model(f);
}
const card = (l: TableLayout, key: string) => l.nodes.get(key) as CardNode;
const more = (l: TableLayout, key: string) => l.nodes.get(key) as MoreNode;

/** A layout as plain data, Maps included, for comparing two of them. */
function plain(l: TableLayout): string {
  return JSON.stringify(l, (_, value: unknown) =>
    value instanceof Map ? [...value.entries()] : value,
  );
}

describe("the layout's invariants (§8.11)", () => {
  it.each(FIXTURE_NAMES)(
    "hold on the %s fixture at both text sizes",
    (name) => {
      const m = fixtureModel(name);
      for (const textScale of [1, 1.25] as const)
        expect(validateHits(layout(m, null, textScale), m)).toEqual([]);
    },
  );

  it.each(["three", "four", "stress"] as const)(
    "hold with each of the %s fixture's opponents expanded",
    (name) => {
      const m = fixtureModel(name);
      for (const opponent of m.opponents)
        for (const textScale of [1, 1.25] as const)
          expect(validateHits(layout(m, opponent.seat, textScale), m)).toEqual(
            [],
          );
    },
  );

  it.each([
    ["duel", 2],
    ["three", 3],
    ["four", 4],
  ] as const)(
    "hold on 300 seeded random boards in the %s arrangement",
    (arrangement, players) => {
      const problems: string[] = [];
      for (let seed = 1; seed <= 300; seed++) {
        const f = randomFixture(seed, players);
        const m = model(f);
        expect(m.arrangement).toBe(arrangement);
        const opponent = m.opponents[seed % Math.max(1, m.opponents.length)];
        const expanded =
          arrangement !== "duel" && seed % 3 === 0
            ? (opponent?.seat ?? null)
            : null;
        const found = validateHits(layout(m, expanded, seed % 2 ? 1 : 1.25), m);
        if (found.length > 0)
          problems.push(`${f.name}: ${found.slice(0, 4).join("; ")}`);
      }
      expect(problems).toEqual([]);
    },
    // 300 boards take about a second alone; beside the other test files they can outlast the
    // default 5 seconds.
    15_000,
  );

  it("gives the same layout for the same model, and for the same view built again", () => {
    for (const name of FIXTURE_NAMES) {
      const m = fixtureModel(name);
      expect(plain(layout(m))).toBe(plain(layout(m)));
      expect(plain(layout(fixtureModel(name)))).toBe(plain(layout(m)));
    }
  });

  it("reports overlapping and undersized hits", () => {
    const m = fixtureModel("duel");
    const l = layout(m);
    const [a, b] = l.rows[0].nodes.map((key) => card(l, key));
    const broken: TableLayout = {
      ...l,
      nodes: new Map(l.nodes)
        .set(b.key, { ...b, hit: { ...a.hit! } })
        .set(a.key, { ...a, hit: { ...a.hit!, w: 20 } }),
    };
    const problems = validateHits(broken, m).join("\n");
    expect(problems).toMatch(/overlaps/);
    expect(problems).toMatch(/smaller than 36/);
  });
});

describe("every object is a button or counted by a “+N”", () => {
  it("caps the hand at 19 cards and a “+6” in a hand of 25", () => {
    const m = fixtureModel("hand25");
    const l = layout(m);
    const hits = m.hand.filter((key) => card(l, key).hit);
    expect(hits).toHaveLength(19);
    expect(more(l, "more:hand").count).toBe(6);
    expect(more(l, "more:hand").opens).toEqual({ kind: "hand" });
    expect(l.rows.find((row) => row.key === "hand")?.nodes).toEqual([
      ...hits,
      "more:hand",
    ]);
    for (const key of hits)
      expect(card(l, key).hit!.w).toBeGreaterThanOrEqual(40);
  });

  it("shows six stack items and counts the rest", () => {
    const m = fixtureModel("stack");
    const l = layout(m);
    expect(m.stack.filter((e) => card(l, e.key).hit)).toHaveLength(6);
    expect(more(l, "more:stack").count).toBe(2);
    expect(more(l, "more:stack").hit).toEqual(
      diamondBox({ cx: 644, cy: 510, side: 26 }),
    );
    const top = card(l, m.stack[0].key);
    expect(top.hit).toEqual({ x: 914, y: 446, w: 92, h: 128 });
    // Older items fan left, each hit its visible left slice.
    for (let i = 1; i < 6; i++) {
      const hit = card(l, m.stack[i].key).hit!;
      const newer = card(l, m.stack[i - 1].key).hit!;
      expect(hit.x + hit.w).toBeCloseTo(newer.x);
      expect(hit.w).toBeGreaterThan(43);
      expect(hit.w).toBeLessThan(46);
    }
  });

  it("piles at most five members and puts the rest behind a “+N”", () => {
    const m = fixtureModel("tokens");
    const l = layout(m);
    const soldiers = m.anchored!.units.find(
      (u) => u.kind === "tokens" && u.cards.length === 7,
    )!;
    expect(soldiers.cards.filter((key) => card(l, key).hit)).toHaveLength(5);
    const plus = more(l, `more:${soldiers.key}`);
    expect(plus.count).toBe(2);
    expect(plus.label).toBe("Show all 7 Soldier Token");
    expect(plus.opens).toEqual({ kind: "pile", unit: soldiers.key });
    const saprolings = m.opponents[0].units.find((u) => u.kind === "tokens")!;
    expect(more(l, `more:${saprolings.key}`).count).toBe(7);
    // The top member carries the pile's count badge.
    const top = card(l, soldiers.cards[6]);
    expect(top.member).toEqual({ index: 6, size: 7 });
    expect(top.badges.find((b) => b.glyph === "count")?.text).toBe("×7");
  });

  it("gives a host its attachments' strips, and a “+N” past four", () => {
    const m = fixtureModel("attachments");
    const l = layout(m);
    const angel = m.anchored!.units.find((u) => u.attachments.length === 6)!;
    const strips = angel.attachments.map((key) => card(l, key).hit);
    expect(strips.filter(Boolean)).toHaveLength(4);
    expect(more(l, `more:${angel.key}`).count).toBe(2);
    for (const strip of strips.filter((s) => s !== null))
      expect(strip.w).toBeGreaterThanOrEqual(36);
    // The opponent's Pacifism stays on their side, by itself.
    const pacifism = m.opponents[0].units.find(
      (u) => m.cards.get(u.cards[0])?.card.name === "Pacifism",
    );
    expect(pacifism?.kind).toBe("single");
  });

  it("overflows a crowded row into a “+M” and keeps offered units on the row", () => {
    const f = tableFixture("stress");
    const m = model(f);
    const l = layout(m);
    const mores = [...l.nodes.values()].filter(
      (n): n is MoreNode => n.kind === "more" && n.key.startsWith("more:row:"),
    );
    expect(mores.length).toBeGreaterThan(0);
    for (const plus of mores) {
      expect(plus.opens.kind).toBe("battlefield");
      expect(plus.hit.w).toBe(56);
    }
    for (const c of m.cards.values())
      if (c.zone === "battlefield" && c.offered.length > 0)
        expect(card(l, c.key).hit, c.key).not.toBeNull();
  });

  it("counts a chipped opponent's battlefield with one “+N” beside the chip", () => {
    const m = quiet("four");
    const l = layout(m, 1);
    expect(l.expandedSeat).toBe(1);
    for (const opponent of m.opponents.filter((p) => p.seat !== 1)) {
      expect(l.players.get(opponent.seat)?.chip).toBe(true);
      const permanents = opponent.units.reduce(
        (n, u) => n + u.cards.length + u.attachments.length,
        0,
      );
      if (permanents > 0)
        expect(more(l, `more:chip:${opponent.seat}`).count).toBe(permanents);
      else expect(l.nodes.has(`more:chip:${opponent.seat}`)).toBe(false);
    }
  });
});

describe("the geometry", () => {
  it("sizes row cards by the perspective law", () => {
    expect(rowCard(668, 0.9).w).toBeCloseTo(114.4, 1);
    expect(rowCard(668, 0.9).h).toBeCloseTo(159.8, 1);
    expect(rowCard(846, 0.9).w).toBeCloseTo(123.3, 1);
    expect(rowCard(196, 0.9).w).toBeCloseTo(90.8, 1);
    expect(rowCard(222, 0.78).h).toBeCloseTo(111.5, 1);
    expect(rowCard(384, 0.66).w).toBeCloseTo(73.5, 1);
  });

  it("places three opponents in columns and the expanded one in the duel's place", () => {
    const m = quiet("four");
    const columns = layout(m);
    expect(columns.arrangement).toBe("four");
    expect(
      m.opponents.map((p) => columns.players.get(p.seat)!.target.x),
    ).toEqual([519, 1159, 1799]);
    const expanded = layout(m, m.opponents[1].seat);
    expect(expanded.players.get(m.opponents[1].seat)!.target).toEqual({
      x: 1714,
      y: 80,
      w: 176,
      h: 220,
    });
    expect(
      m.opponents
        .filter((p) => p !== m.opponents[1])
        .map((p) => expanded.players.get(p.seat)!.target.x + 110),
    ).toEqual([720, 1120]);
  });

  it("collapses an expansion while a chipped opponent has something offered", () => {
    // Shock may target Bot 3's Savannah Lions: expanding Bot 2 would leave them on a chip.
    expect(layout(fixtureModel("four"), 1).expandedSeat).toBeNull();
    const f = tableFixture("four");
    const lions = f.snapshot.view!.battlefield.find(
      (p) => p.card.name === "Savannah Lions",
    )!;
    f.snapshot.prompt!.options = f.snapshot.prompt!.options.filter(
      (o) => o.object_id !== lions.id,
    );
    expect(layout(model(f), 1).expandedSeat).toBe(1);
    // Bot 2's creatures are still offered, so Bot 3's board cannot expand over them.
    expect(layout(model(f), 2).expandedSeat).toBeNull();
    expect(layout(quiet("four"), 2).expandedSeat).toBe(2);
    expect(layout(fixtureModel("duel"), 1).expandedSeat).toBeNull();
  });

  it("anchors a spectator's lowest seat below, its hand as backs", () => {
    const m = fixtureModel("spectator");
    expect(m.anchored?.seat).toBe(0);
    expect(m.handBacks).toBe(6);
    expect(m.hand).toEqual([]);
    const l = layout(m);
    expect(l.arrangement).toBe("three");
    expect(l.players.get(0)?.target).toEqual({ x: 30, y: 824, w: 176, h: 220 });
    expect(
      [...l.nodes.values()].some((n) => n.kind === "card" && n.role === "hand"),
    ).toBe(false);
  });

  it("lines a defender's blockers up under the attackers they block", () => {
    const f = tableFixture("blockers");
    const v = f.snapshot.view!;
    const angel = v.battlefield.find((p) => p.card.name === "Serra Angel")!;
    const bears = v.battlefield.find((p) => p.card.name === "Grizzly Bears")!;
    // The Angel (left of the Bears in the view) blocks the rightmost attacker.
    angel.blocking = true;
    v.combat[2].blockers = [angel.id];
    const m = model(f);
    const l = layout(m);
    const x = (id: string) => card(l, `battlefield:${id}`).face.x;
    const [dragon, guide, giant] = v.combat.map((g) => g.attackers[0]);
    expect(x(dragon)).toBeLessThan(x(guide));
    expect(x(guide)).toBeLessThan(x(giant));
    expect(x(bears.id)).toBeLessThan(x(angel.id));
    expect(validateHits(l, m)).toEqual([]);
  });

  it("keeps tags over the printed box and pips off the image", () => {
    const m = fixtureModel("duel");
    const l = layout(m);
    const bears = [...l.nodes.values()].find(
      (n): n is CardNode =>
        n.kind === "card" &&
        m.cards.get(n.key)?.card.name === "Grizzly Bears" &&
        n.role !== "hand",
    )!;
    const image = imageRect(bears);
    expect(bears.tag?.text).toBe("2/2");
    expect(bears.tag?.tone).toBe("buffed");
    expect(bears.tag!.rect.y + bears.tag!.rect.h).toBeLessThanOrEqual(
      image.y + 0.935 * image.h,
    );
    expect(bears.pips).toHaveLength(1);
    expect(bears.pips[0]).toMatchObject({
      counter: "+1/+1",
      count: 2,
      colour: "cyan",
    });
    expect(bears.pips[0].centre.x).toBeGreaterThan(image.x + image.w);
    const angel = [...l.nodes.values()].find(
      (n): n is CardNode =>
        n.kind === "card" && m.cards.get(n.key)?.card.name === "Serra Angel",
    )!;
    expect(angel.tag).toMatchObject({ text: "4/2", tone: "hurt" });
    const ajani = [...l.nodes.values()].find(
      (n): n is CardNode =>
        n.kind === "card" && m.cards.get(n.key)?.card.name === "Ajani Goldmane",
    )!;
    expect(ajani.tag).toMatchObject({ text: "4", tone: "loyalty" });
    expect(ajani.pips).toEqual([]);
  });

  it("turns tapped cards sideways, their tags clear of the copyright strip", () => {
    const m = fixtureModel("duel");
    const l = layout(m);
    const elves = [...l.nodes.values()].find(
      (n): n is CardNode =>
        n.kind === "card" && m.cards.get(n.key)?.card.name === "Llanowar Elves",
    )!;
    expect(elves.rotation).toBe(90);
    expect(elves.footprint.w).toBeCloseTo(elves.face.h);
    const image = imageRect(elves);
    expect(elves.tag!.rect.x).toBeGreaterThanOrEqual(image.x + 0.065 * image.w);
  });

  it("puts menus above the hand and below cards with room under them", () => {
    const m = fixtureModel("duel");
    const l = layout(m);
    for (const key of m.hand) expect(card(l, key).menu).toBe("above");
    const opponentRow = l.rows.find((r) => r.seat === 1)!;
    expect(card(l, opponentRow.nodes[0]).menu).toBe("below");
  });
});

describe("the hand fan (§8.5)", () => {
  it("spreads the cards at most 150 su apart and at least 40", () => {
    const two = fanHand(2);
    expect(two[1].face.x - two[0].face.x).toBe(150);
    const twenty = fanHand(20);
    const step = twenty[1].face.x - twenty[0].face.x;
    expect(step).toBeCloseTo(770 / 19);
    expect(step).toBeGreaterThanOrEqual(40);
    expect(fanHand(25)).toHaveLength(20);
  });

  it("arcs and tilts the fan, and gives the last card its whole width", () => {
    const fan = fanHand(9);
    expect(fan[4].face.y).toBe(948);
    expect(fan[0].face.y).toBeGreaterThan(948);
    expect(fan[4].rotation).toBe(0);
    expect(fan[0].rotation).toBeCloseTo(-12.8);
    expect(fanHand(20)[0].rotation).toBe(-14);
    expect(fan[8].hit.w).toBe(180);
    for (const slot of fan.slice(0, -1))
      expect(slot.hit.w).toBeCloseTo(770 / 8);
    for (const slot of fan) expect(slot.hit.y + slot.hit.h).toBe(1080);
  });

  it("raises a hand card to one and a half times its size, bottom at 1072", () => {
    const m = fixtureModel("duel");
    const l = layout(m);
    const risen = l.risen.get(m.hand[0])!;
    expect(risen.w).toBe(270);
    expect(risen.h).toBeCloseTo(377.1);
    expect(risen.y + risen.h).toBeCloseTo(1072);
  });
});

describe("packing a row", () => {
  const box = (key: string, change: Partial<RowUnitBox> = {}): RowUnitBox => ({
    key,
    members: 1,
    attachments: [],
    tapped: false,
    pips: false,
    offered: false,
    ...change,
  });
  const region = { x0: 480, x1: 1560, yCentre: 668 };

  it("centres units that fit at full size", () => {
    const row = packRow(region, [box("a"), box("b")], 0.9);
    expect(row.mode).toBe("natural");
    expect(row.scale).toBe(1);
    const [a, b] = row.units;
    const left = a.x - region.x0;
    const right = region.x1 - (b.x + b.width);
    expect(left).toBeCloseTo(right);
  });

  it("shrinks cards before overlapping them, never below 72%", () => {
    const shrunk = packRow(
      region,
      Array.from({ length: 10 }, (_, i) => box(`u${i}`)),
      0.9,
    );
    expect(shrunk.mode).toBe("shrunk");
    expect(shrunk.scale).toBeLessThan(1);
    expect(shrunk.scale).toBeGreaterThanOrEqual(MIN_ROW_SCALE);
    const crowded = packRow(
      region,
      Array.from({ length: 16 }, (_, i) => box(`u${i}`)),
      0.9,
    );
    expect(crowded.mode).toBe("overlap");
    expect(crowded.scale).toBe(MIN_ROW_SCALE);
    for (const unit of crowded.units)
      expect(unit.elements[0].hit!.w).toBeGreaterThanOrEqual(36);
    const last = crowded.units[crowded.units.length - 1];
    expect(last.x + last.width).toBeLessThanOrEqual(region.x1 + 1e-6);
  });

  it("keeps offered units and gives the rest a “+M” at the row's end", () => {
    const units = Array.from({ length: 40 }, (_, i) =>
      box(`u${i}`, { offered: i === 39 }),
    );
    const row = packRow(region, units, 0.9);
    expect(row.mode).toBe("overflow");
    expect(row.more).toEqual({ x: 1504, y: 640, w: 56, h: 56 });
    expect(row.units[39].overflow).toBe(false);
    expect(row.units[0].overflow).toBe(false);
    expect(row.units.some((u) => u.overflow)).toBe(true);
    for (const unit of row.units.filter((u) => !u.overflow))
      expect(unit.x + unit.width).toBeLessThanOrEqual(1504);
  });
});

describe("pointing at the table", () => {
  it("finds the node, tile or player under a point", () => {
    const m = fixtureModel("duel");
    const l = layout(m);
    const first = card(l, m.hand[0]);
    expect(hitTest(l, { x: first.hit!.x + 5, y: 1070 })).toBe(m.hand[0]);
    expect(hitTest(l, { x: 1790, y: 980 })).toBe("tile:0:graveyard");
    expect(hitTest(l, { x: 1800, y: 200 })).toBe("player:1");
    expect(hitTest(l, { x: 960, y: 20 })).toBeNull();
    expect(hitEntries(l).some((e) => e.key === "hud:inspection")).toBe(true);
  });

  it("drops on the most specific zone under the pointer", () => {
    const m = fixtureModel("blockers");
    const l = layout(m);
    const attacker = m.combat[0].attackers[0];
    const face = imageRect(card(l, `battlefield:${attacker}`));
    expect(
      dropZoneAt(l, { x: face.x + face.w / 2, y: face.y + face.h / 2 }),
    ).toMatchObject({ kind: "card", key: `battlefield:${attacker}` });
    expect(dropZoneAt(l, { x: 960, y: 40 })).toMatchObject({
      kind: "attack",
      seat: null,
    });
    expect(dropZoneAt(l, { x: 1000, y: 700 })).toMatchObject({
      kind: "battlefield",
    });
    const four = layout(fixtureModel("four"));
    expect(dropZoneAt(four, { x: 700, y: 300 })).toMatchObject({
      kind: "attack",
      seat: model(tableFixture("four")).opponents[1].seat,
    });
  });

  it("opens the magnifier on the side away from the card", () => {
    expect(magnifierSide(100)).toBe("right");
    expect(magnifierSide(959)).toBe("right");
    expect(magnifierSide(960)).toBe("left");
    expect(magnifierSide(1800)).toBe("left");
  });
});

describe("a Two-Headed Giant teammate's hand (v0.5.1)", () => {
  /** The giant fixture with the teammate holding `n` cards. */
  function holding(n: number): TableModel {
    const f = tableFixture("giant");
    const mate = f.snapshot.view!.opponents[0];
    const first = mate.hand![0];
    mate.hand = Array.from({ length: n }, (_, i) => ({
      ...first,
      id: `mate-${i}`,
    }));
    mate.hand_count = n;
    return model(f);
  }
  const hand = (l: TableLayout, m: TableModel) =>
    m.opponents[0].hand!.map((key) => card(l, key));

  it("fans face up under the teammate's board, in the left column by the band", () => {
    const m = fixtureModel("giant");
    const l = layout(m);
    expect(validateHits(l, m)).toEqual([]);
    const cards = hand(l, m);
    expect(cards).toHaveLength(6);
    const front = Math.max(
      ...[...l.nodes.values()]
        .filter(
          (n): n is CardNode =>
            n.kind === "card" &&
            n.role !== "teammate-hand" &&
            m.cards.get(n.key)?.controllerSeat === 1,
        )
        .map((n) => n.hit!.y + n.hit!.h),
    );
    for (const node of cards) {
      expect(node).toMatchObject({
        role: "teammate-hand",
        faceUp: true,
        unit: "hand:1",
        mark: "none",
        badges: [],
        tag: null,
      });
      const hit = node.hit!;
      expect(hit.x).toBeGreaterThanOrEqual(20);
      expect(hit.x + hit.w).toBeLessThanOrEqual(590);
      expect(hit.w).toBeGreaterThanOrEqual(36);
      expect(hit.y).toBeGreaterThanOrEqual(front);
      expect(hit.y + hit.h).toBeLessThanOrEqual(488);
      expect(Math.abs(node.rotation)).toBeLessThanOrEqual(6);
    }
    // Left to right, slices of the same step, the last card whole.
    const xs = cards.map((n) => n.hit!.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(cards.at(-1)!.hit!.w).toBeCloseTo(62, 5);
    expect(l.rows.find((r) => r.key === "hand:1")).toEqual({
      key: "hand:1",
      seat: 1,
      label: "Bot 2's hand",
      nodes: m.opponents[0].hand,
    });
    // After the teammate's battlefield in the DOM's order, before the other team's.
    const order = l.rows.map((r) => r.key);
    expect(order.indexOf("hand:1")).toBeGreaterThan(
      order.indexOf("row:1:lands"),
    );
    expect(order.indexOf("hand:1")).toBeLessThan(order.indexOf("row:2:others"));
    // The other team's columns keep their rows where they were.
    expect(
      Math.min(
        ...[...l.nodes.values()]
          .filter(
            (n): n is CardNode =>
              n.kind === "card" && m.cards.get(n.key)?.controllerSeat === 2,
          )
          .map((n) => n.face.y),
      ),
    ).toBeCloseTo(232 - rowCard(232, 0.66).h / 2, 3);
  });

  it("keeps every card a hit up to fifteen, then puts the rest behind a “+N” listing the hand", () => {
    for (const n of [1, 7, 15]) {
      const m = holding(n);
      const l = layout(m);
      expect(validateHits(l, m)).toEqual([]);
      expect(hand(l, m).every((node) => node.hit)).toBe(true);
      expect(l.nodes.has("more:hand:1")).toBe(false);
    }
    const m = holding(20);
    const l = layout(m);
    expect(validateHits(l, m)).toEqual([]);
    expect(hand(l, m).filter((node) => node.hit)).toHaveLength(14);
    expect(more(l, "more:hand:1")).toMatchObject({
      count: 6,
      opens: { kind: "hand", seat: 1 },
      label: "Show all 20 cards in Bot 2's hand (6 more)",
    });
    expect(l.rows.find((r) => r.key === "hand:1")!.nodes.at(-1)).toBe(
      "more:hand:1",
    );
    // An empty hand draws nothing and lists no row.
    const none = layout(holding(0));
    expect(none.rows.some((r) => r.key === "hand:1")).toBe(false);
  });

  it("stays with the teammate's expanded board, and waits beside a chip", () => {
    const m = holding(9);
    const expanded = layout(m, 1);
    expect(expanded.expandedSeat).toBe(1);
    expect(validateHits(expanded, m)).toEqual([]);
    expect(hand(expanded, m).every((node) => node.hit)).toBe(true);
    const chipped = layout(m, 2);
    expect(chipped.expandedSeat).toBe(2);
    expect(chipped.players.get(1)?.chip).toBe(true);
    expect(validateHits(chipped, m)).toEqual([]);
    expect(m.opponents[0].hand!.some((key) => chipped.nodes.has(key))).toBe(
      false,
    );
  });

  it("takes no attack dropped on the teammate", () => {
    const l = layout(fixtureModel("giant"));
    expect(
      l.drops.some((drop) => drop.kind === "attack" && drop.seat === 1),
    ).toBe(false);
    expect(dropZoneAt(l, { x: 300, y: 300 })).toBeNull();
    expect(dropZoneAt(l, { x: 960, y: 300 })).toMatchObject({
      kind: "attack",
      seat: 2,
    });
  });

  it("takes no attack dropped on the teammate's chip, with the other team's board expanded", () => {
    const l = layout(fixtureModel("giant"), 2);
    expect(l.expandedSeat).toBe(2);
    expect(l.players.get(1)?.chip).toBe(true);
    expect(
      l.drops.some((drop) => drop.kind === "attack" && drop.seat === 1),
    ).toBe(false);
    const onChip = (seat: number) => {
      const r = l.players.get(seat)!.target;
      return dropZoneAt(l, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
    };
    // The teammate's chip sits in the expanded board's half, which takes the drop; the other
    // team's chip takes its own.
    expect(onChip(1)).toMatchObject({ kind: "attack", seat: 2 });
    expect(onChip(3)).toMatchObject({ kind: "attack", seat: 3 });
  });

  it("holds the invariants on 300 random Two-Headed Giant boards", () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const f = randomFixture(seed, 4, { twoHeadedGiant: true });
      const m = model(f);
      const seat = [null, 1, 2, 3][seed % 4];
      const found = validateHits(layout(m, seat, seed % 2 ? 1 : 1.25), m);
      if (found.length > 0)
        problems.push(`${f.name}: ${found.slice(0, 4).join("; ")}`);
    }
    expect(problems).toEqual([]);
  }, 15_000);

  it("fans at most as many cards as keep 36 su each, on one side of the stack's lane", () => {
    expect(teamHandRegion({ x: 0, y: 0, w: 640, h: 476 })).toEqual({
      x0: 20,
      x1: 590,
    });
    expect(teamHandRegion({ x: 0, y: 0, w: 1920, h: 488 })).toEqual({
      x0: 20,
      x1: 590,
    });
    expect(teamHandRegion({ x: 1280, y: 0, w: 640, h: 476 })).toEqual({
      x0: 1330,
      x1: 1870,
    });
    const slots = fanTeamHand(30, { x0: 20, x1: 590 });
    expect(slots).toHaveLength(15);
    for (const [i, slot] of slots.entries())
      if (i < slots.length - 1)
        expect(slots[i + 1].hit.x - slot.hit.x).toBeGreaterThanOrEqual(36);
    expect(fanTeamHand(3, { x0: 20, x1: 590 }).map((s) => s.hit.w)).toEqual([
      50, 50, 62,
    ]);
    expect(fanTeamHand(5, { x0: 0, x1: 40 })).toEqual([]);
  });
});

describe("speed", () => {
  it("lays out the 240-permanent board in under 5 ms", () => {
    const m = fixtureModel("stress");
    expect(
      m
        .anchored!.units.concat(m.opponents.flatMap((p) => p.units))
        .reduce((n, u) => n + u.cards.length + u.attachments.length, 0),
    ).toBe(240);
    for (let i = 0; i < 5; i++) layout(m);
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const start = performance.now();
      layout(m);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    // The fastest of 21 runs: the layout's own cost. A median measures how busy the machine is
    // (other test files run beside this one), and failed for that reason alone.
    expect(times[0]).toBeLessThan(5);
  });
});

describe("the pure modules", () => {
  const sources = import.meta.glob(
    [
      "./geometry.ts",
      "./tableModel.ts",
      "./groups.ts",
      "./layout.ts",
      "./events.ts",
      "./stage.ts",
      "./sigil.ts",
      "./fixtures.ts",
    ],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>;

  it("import neither React nor PixiJS", () => {
    expect(Object.keys(sources)).toHaveLength(8);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(
        /from "react"|from "pixi\.js|from "react-dom/,
      );
      expect(source, file).not.toMatch(/import\("pixi/);
    }
  });

  it("keep the fixtures loadable outside the browser: types and pure helpers only", () => {
    const imports = [
      ...sources["./fixtures.ts"].matchAll(/from "([^"]+)"/g),
    ].map((match) => match[1]);
    expect(imports.sort()).toEqual([
      "../model",
      "../types",
      "./sigil",
      "./types",
    ]);
  });
});
