import { describe, expect, it } from "vitest";
import type { PermanentView } from "../types";
import { fixtureInput, tableFixture } from "./fixtures";
import { layoutTable, validateHits } from "./layout";
import { buildTableModel } from "./tableModel";

// The table's performance fixture for large boards (v0.9.12, the specification's section 14):
// the same board the engine's fixture measures (engine LargeBoardsTest), 300 tokens a seat, as
// the table groups it and lays it out. The numbers it prints are recorded in
// docs/engine/large-boards.md; the ceiling is several times what any machine measured, so only
// a real regression fails it.

/** The tokens fixture with each seat's board grown to `each` tokens: mostly a few kinds that
 * pile, and one in ten different from every other (a counter of its own), which cannot. */
function large(each: number) {
  const fixture = tableFixture("tokens");
  const view = fixture.snapshot.view!;
  const seats = [...new Set(view.battlefield.map((p) => p.controller_seat))];
  const grown: PermanentView[] = [];
  let made = 0;
  for (const seat of seats) {
    const kinds = view.battlefield.filter(
      (p) => p.controller_seat === seat && !p.attached_to,
    );
    for (let index = 0; index < each; index++) {
      const like = kinds[index % kinds.length];
      made += 1;
      const id = `large-${made}`;
      grown.push({
        ...like,
        id,
        card: { ...like.card, id },
        attacking: false,
        blocking: false,
        counters: index % 10 === 9 ? { "+1/+1": index } : like.counters,
      });
    }
  }
  view.battlefield = grown;
  view.combat = [];
  fixture.snapshot.prompt = null;
  return fixture;
}

describe("a board of hundreds of tokens", () => {
  it("is grouped and laid out within budget, every object a button or counted", () => {
    const each = 300;
    const fixture = large(each);
    const total = fixture.snapshot.view!.battlefield.length;
    expect(total).toBeGreaterThanOrEqual(2 * each);
    const times: number[] = [];
    let units = 0;
    let nodes = 0;
    for (let run = 0; run < 7; run++) {
      const started = performance.now();
      const model = buildTableModel(fixtureInput(fixture));
      const layout = layoutTable(model, { expandedSeat: null, textScale: 1 });
      times.push(performance.now() - started);
      units =
        (model.anchored?.units.length ?? 0) +
        model.opponents.reduce((sum, seat) => sum + seat.units.length, 0);
      nodes = layout.nodes.size;
      if (run === 0) expect(validateHits(layout, model)).toEqual([]);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(
      `Large board (table): ${total} permanents in ${units} units and ${nodes} nodes, ` +
        `model and layout median ${median.toFixed(1)} ms, worst ${times[times.length - 1].toFixed(1)} ms`,
    );
    // Piles keep the table readable: far fewer units than permanents.
    expect(units).toBeLessThan(total / 2);
    expect(median).toBeLessThan(1500);
  });
});
