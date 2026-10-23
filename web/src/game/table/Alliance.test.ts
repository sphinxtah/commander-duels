import { describe, expect, it } from "vitest";
import { allianceBox } from "./Alliance";
import { fixtureInput, tableFixture } from "./fixtures";
import { diamondBox, overlaps } from "./geometry";
import { layoutTable } from "./layout";
import { buildTableModel } from "./tableModel";

// Where a plate's Alliance button sits (v0.4.4): clear of every control, and since v0.5.1 of the
// plate's count diamonds too, which a four-player table sets beside the player button.

describe("the Alliance button's place", () => {
  it("covers neither a control nor a count diamond, in every arrangement", () => {
    for (const name of ["duel", "three", "four"] as const) {
      const model = buildTableModel(fixtureInput(tableFixture(name)));
      const layout = layoutTable(model, { expandedSeat: null, textScale: 1 });
      for (const player of model.opponents) {
        const node = layout.players.get(player.seat)!;
        if (node.chip) continue;
        const box = allianceBox(node);
        const covered = [
          node.target,
          node.expand && diamondBox(node.expand),
          ...Object.values(node.counts).map(diamondBox),
          ...layout.zones.flatMap((tile) => (tile.hit ? [tile.hit] : [])),
          ...[...layout.nodes.values()].flatMap((n) => (n.hit ? [n.hit] : [])),
        ];
        for (const other of covered)
          expect(
            overlaps(box, other),
            `${name}: seat ${player.seat}'s Alliance button`,
          ).toBe(false);
        expect(box.x).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
