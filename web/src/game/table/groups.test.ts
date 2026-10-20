import { describe, expect, it } from "vitest";
import type { CardView, PermanentView, PromptOption } from "../types";
import { CARDS } from "./fixtures";
import {
  groupUnits,
  isToken,
  landKey,
  rowOf,
  tokenKey,
  type GroupContext,
} from "./groups";

let n = 0;
function card(face: Omit<CardView, "id" | "hidden">): CardView {
  n += 1;
  return { id: `c${n}`, hidden: false, ...face };
}
function permanent(
  face: Omit<CardView, "id" | "hidden"> | CardView,
  change: Partial<PermanentView> = {},
): PermanentView {
  const c = "id" in face ? face : card(face);
  return {
    id: c.id,
    controller_seat: 0,
    owner_seat: 0,
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
}
const hidden: CardView = {
  id: "h",
  hidden: true,
  name: null,
  mana_cost: null,
  type_line: null,
  power: null,
  toughness: null,
  rules: [],
};
function offer(
  action: PromptOption["action"],
  change: Partial<PromptOption> = {},
): PromptOption {
  return {
    id: String(++n),
    action,
    label: null,
    object_id: null,
    seat: null,
    selected: false,
    ...change,
  };
}

function context(
  offers: Map<PermanentView, PromptOption[]> = new Map(),
  change: Partial<GroupContext> = {},
): GroupContext {
  return {
    keyOf: (p) => `battlefield:${p.card.id}`,
    offered: (p) => offers.get(p) ?? [],
    combat: new Set(),
    commanders: new Set(),
    ...change,
  };
}

describe("tokens", () => {
  it("are named as tokens, or are creatures with no mana cost that are not lands", () => {
    expect(isToken(card(CARDS.soldier))).toBe(true);
    expect(isToken(card(CARDS.treasure))).toBe(true);
    expect(isToken(card(CARDS.grizzlyBears))).toBe(false);
    expect(
      isToken(
        card({
          name: "Avatar",
          mana_cost: null,
          type_line: "Creature — Avatar",
          power: "4",
          toughness: "4",
          rules: [],
        }),
      ),
    ).toBe(true);
    expect(
      isToken(
        card({
          name: "Dryad Arbor",
          mana_cost: null,
          type_line: "Land Creature — Forest Dryad",
          power: "1",
          toughness: "1",
          rules: [],
        }),
      ),
    ).toBe(false);
    expect(isToken(hidden)).toBe(false);
  });
});

describe("pile keys (§15)", () => {
  it("match identical untouched lands and split on what differs", () => {
    const a = permanent(CARDS.forest);
    const b = permanent(CARDS.forest);
    expect(landKey(a, [])).toBe(landKey(b, []));
    expect(landKey(a, [])).not.toBe(
      landKey(permanent(CARDS.forest, { tapped: true }), []),
    );
    expect(landKey(a, [])).not.toBe(landKey(permanent(CARDS.island), []));
    expect(landKey(a, [offer("activate_mana")])).not.toBe(landKey(b, []));
    expect(landKey(a, [offer("activate_mana")])).toBe(
      landKey(b, [offer("activate_mana")]),
    );
    expect(landKey(a, [])).not.toBe(
      landKey(
        permanent(CARDS.forest, { controller_seat: 1, owner_seat: 1 }),
        [],
      ),
    );
    expect(
      landKey(permanent(CARDS.forest, { counters: { charge: 1 } }), []),
    ).toBeNull();
    expect(landKey(permanent(CARDS.forest, { damage: 1 }), [])).toBeNull();
    expect(
      landKey(permanent(CARDS.forest, { attached_to: "x" }), []),
    ).toBeNull();
    expect(landKey(a, [offer("activate_mana", { selected: true })])).toBeNull();
    expect(landKey(permanent(CARDS.grizzlyBears), [])).toBeNull();
  });

  it("match identical tokens and split on tapped, sickness, counters, damage and offers", () => {
    const a = permanent(CARDS.soldier);
    const key = tokenKey(a, []);
    expect(key).toBe(tokenKey(permanent(CARDS.soldier), []));
    for (const change of [
      { tapped: true },
      { summoning_sick: true },
      { counters: { "+1/+1": 1 } },
      { damage: 1 },
      { controller_seat: 1 },
    ])
      expect(tokenKey(permanent(CARDS.soldier, change), [])).not.toBe(key);
    expect(tokenKey(a, [offer("toggle_attacker")])).not.toBe(key);
    expect(tokenKey(a, [offer("activate", { label: "Sacrifice" })])).not.toBe(
      tokenKey(a, [offer("activate", { label: "Tap" })]),
    );
    expect(
      tokenKey(permanent(CARDS.soldier, { attacking: true }), []),
    ).toBeNull();
    expect(tokenKey(a, [offer("choose", { selected: true })])).toBeNull();
    expect(tokenKey(permanent(CARDS.grizzlyBears), [])).toBeNull();
  });
});

describe("rows", () => {
  it("put creatures, planeswalkers and face-down cards near the band, lands behind", () => {
    expect(rowOf(card(CARDS.grizzlyBears))).toBe("front");
    expect(rowOf(card(CARDS.ajani))).toBe("front");
    expect(rowOf(hidden)).toBe("front");
    expect(rowOf(card(CARDS.forest))).toBe("back-lands");
    expect(rowOf(card(CARDS.solRing))).toBe("back-other");
  });
});

describe("grouping a battlefield", () => {
  it("piles two or more at the first one's place, and leaves one alone", () => {
    const forests = [permanent(CARDS.forest), permanent(CARDS.forest)];
    const island = permanent(CARDS.island);
    const soldiers = [permanent(CARDS.soldier), permanent(CARDS.soldier)];
    const bears = permanent(CARDS.grizzlyBears);
    const units = groupUnits(
      [soldiers[0], forests[0], island, bears, forests[1], soldiers[1]],
      context(),
    );
    expect(units.map((u) => [u.kind, u.row, u.cards.length])).toEqual([
      ["tokens", "front", 2],
      ["single", "front", 1],
      ["lands", "back-lands", 2],
      ["single", "back-lands", 1],
    ]);
    expect(units[2].cards).toEqual(
      forests.map((p) => `battlefield:${p.card.id}`),
    );
  });

  it("never piles attackers, blockers, commanders or selected cards", () => {
    const soldiers = [0, 1, 2, 3].map(() => permanent(CARDS.soldier));
    const offers = new Map([
      [soldiers[2], [offer("toggle_attacker", { selected: true })]],
    ]);
    const units = groupUnits(
      soldiers,
      context(offers, {
        combat: new Set([soldiers[0].id]),
        commanders: new Set([soldiers[1].id]),
      }),
    );
    expect(units.map((u) => u.kind)).toEqual([
      "single",
      "single",
      "single",
      "single",
    ]);
  });

  it("hangs attachments on their host, down a chain to its root", () => {
    const bears = permanent(CARDS.grizzlyBears);
    const splitter = permanent(CARDS.bonesplitter, { attached_to: bears.id });
    const rancor = permanent(CARDS.rancor, { attached_to: splitter.id });
    const forest = permanent(CARDS.forest);
    const units = groupUnits([splitter, bears, rancor, forest], context());
    expect(units[0]).toEqual({
      key: `battlefield:${bears.card.id}`,
      kind: "host",
      cards: [`battlefield:${bears.card.id}`],
      attachments: [splitter, rancor].map((p) => `battlefield:${p.card.id}`),
      row: "front",
      tapped: false,
    });
    expect(units).toHaveLength(2);
  });

  it("leaves another player's Aura on its own controller's side", () => {
    // The host is not among this controller's permanents, so the Aura stands alone (B1).
    const pacifism = permanent(CARDS.pacifism, {
      controller_seat: 1,
      owner_seat: 1,
      attached_to: "someone-elses",
    });
    expect(groupUnits([pacifism], context())).toEqual([
      expect.objectContaining({ kind: "single", row: "back-other" }),
    ]);
  });

  it("roots a loop of attachments at its first member", () => {
    const a = permanent(CARDS.bonesplitter);
    const b = permanent(CARDS.rancor, { attached_to: a.id });
    a.attached_to = b.id;
    const units = groupUnits([a, b], context());
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      kind: "host",
      cards: [`battlefield:${a.card.id}`],
      attachments: [`battlefield:${b.card.id}`],
    });
  });
});
