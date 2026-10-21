import { describe, expect, it } from "vitest";
import { cardLabel } from "./Card";
import type { Located } from "./model";
import type { CardView, PermanentView } from "./types";

// cardLabel's ownership clause (design §3.2): Card.test stays as it is, so the new case lives
// here.

const bears: CardView = {
  id: "c1",
  hidden: false,
  name: "Grizzly Bears",
  mana_cost: "{1}{G}",
  type_line: "Creature — Bear",
  power: "2",
  toughness: "2",
  rules: [],
};

function onTheBattlefield(controller: number, owner: number): Located {
  const permanent: PermanentView = {
    id: "p1",
    controller_seat: controller,
    owner_seat: owner,
    card: bears,
    tapped: true,
    summoning_sick: false,
    damage: 0,
    counters: {},
    attacking: false,
    blocking: false,
    attached_to: null,
  };
  return { id: "p1", zone: "battlefield", seat: controller, permanent };
}

describe("a card's accessible name", () => {
  it("says whose a permanent is when someone else controls it", () => {
    expect(cardLabel(bears, onTheBattlefield(0, 1), "Bot 2")).toBe(
      "Grizzly Bears, Creature — Bear, 2/2, Tapped, owned by Bot 2",
    );
  });

  it("says nothing of ownership when the owner controls it, or no owner is named", () => {
    expect(cardLabel(bears, onTheBattlefield(1, 1), "Bot 2")).toBe(
      "Grizzly Bears, Creature — Bear, 2/2, Tapped",
    );
    expect(cardLabel(bears, onTheBattlefield(0, 1))).toBe(
      "Grizzly Bears, Creature — Bear, 2/2, Tapped",
    );
    expect(cardLabel(bears, undefined, "Bot 2")).toBe(
      "Grizzly Bears, Creature — Bear, 2/2",
    );
  });
});
