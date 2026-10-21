import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Prompt, PromptOption } from "../types";
import {
  CHAIN_MS,
  CLICK_SWALLOW_MS,
  DRAG_THRESHOLD,
  DROP_REFUSED,
  DROP_STALE,
  createDragController,
  dropOptions,
  useDragController,
  type DragDeps,
} from "./dnd";
import {
  fixtureInput,
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "./fixtures";
import { centre, rect } from "./geometry";
import { layoutTable } from "./layout";
import { stageFit } from "./stage";
import { buildTableModel } from "./tableModel";
import type { DropZone, Point, TableCard, TableModel } from "./types";
import { createTableUi } from "./uiStore";

// Drag and drop (design §16) on the fixtures' layouts, with the stage at scale 1: client pixels
// are stage units.

const fit = stageFit(1920, 1080, 1);
const YOUR_SIDE: Point = { x: 1000, y: 700 };
const THEIR_HALF: Point = { x: 1000, y: 200 };

function modelOf(f: TableFixture, canAnswer?: boolean): TableModel {
  return buildTableModel(fixtureInput(f, { canAnswer }));
}
const promptOf = (
  id: string,
  kind: Prompt["kind"],
  options: PromptOption[],
): Prompt => ({
  id,
  kind,
  message: "",
  detail: null,
  options,
  amounts: null,
  piles: null,
  xmage_query: null,
});
const choice = (
  id: string,
  change: Partial<Omit<PromptOption, "id">>,
): PromptOption => ({
  id,
  action: "choose",
  label: null,
  object_id: null,
  seat: null,
  selected: false,
  ...change,
});

/** The next snapshot of a fixture: the same board at the next revision, with another prompt. */
function next(
  name: FixtureName,
  prompt: Prompt | null,
  canAnswer?: boolean,
): TableModel {
  const f = tableFixture(name);
  f.snapshot.prompt = prompt;
  f.snapshot.revision += 1;
  return modelOf(f, canAnswer);
}

function setup(name: FixtureName, change?: (f: TableFixture) => void) {
  const f = tableFixture(name);
  change?.(f);
  const model = modelOf(f);
  const layout = layoutTable(model, { expandedSeat: null, textScale: 1 });
  const ui = createTableUi();
  let now = 0;
  const events = new EventTarget();
  const deps: DragDeps = {
    layout,
    fit,
    ui,
    promptKey: `${model.promptId}|${model.revision}`,
    choose: vi.fn(),
    openMenu: vi.fn(),
    status: vi.fn(),
    model,
  };
  const controller = createDragController(
    () => deps,
    { now: () => now },
    events as unknown as Window,
  );
  const card = (named: string, zone = "hand") =>
    [...model.cards.values()].find(
      (c) => c.card.name === named && c.zone === zone,
    )!;
  const pointer = (
    type: "pointermove" | "pointerup" | "pointercancel",
    p: Point,
  ) =>
    events.dispatchEvent(
      new PointerEvent(type, {
        clientX: p.x,
        clientY: p.y,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
      }),
    );
  const press = (
    held: TableCard,
    p: Point,
    change: Partial<PointerEventInit> = {},
  ) =>
    controller.onPointerDown(
      new PointerEvent("pointerdown", {
        clientX: p.x,
        clientY: p.y,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        ...change,
      }),
      held,
    );
  /** Presses a card where it lies, carries it to `to` and lets go there. */
  const drag = (held: TableCard, to: Point) => {
    const from = { x: to.x, y: to.y + 300 };
    press(held, from);
    pointer("pointermove", { x: from.x, y: from.y - 20 });
    pointer("pointermove", to);
    pointer("pointerup", to);
  };
  return {
    deps,
    controller,
    model,
    layout,
    ui,
    card,
    press,
    pointer,
    drag,
    tick: (ms: number) => (now += ms),
  };
}

describe("what a drop answers", () => {
  it("plays a hand card dropped on your side, and nothing elsewhere", () => {
    const { card, layout, model } = setup("duel");
    const forest = card("Forest");
    const yours = layout.drops.find((z) => z.kind === "battlefield")!;
    const theirs = layout.drops.find((z) => z.kind === "attack")!;
    expect(dropOptions(forest, yours, model)).toEqual([
      expect.objectContaining({ action: "play_land", object_id: forest.id }),
    ]);
    expect(dropOptions(forest, theirs, model)).toEqual([]);
    expect(dropOptions(card("Counterspell"), yours, model)).toEqual([]);
  });

  it("attacks with a creature dropped on an opponent, once only", () => {
    const { card, layout, model } = setup("three");
    const giant = card("Hill Giant", "battlefield");
    const column = layout.drops.find(
      (z) => z.kind === "attack" && z.seat === 1,
    )!;
    expect(dropOptions(giant, column, model)).toEqual([
      expect.objectContaining({ action: "toggle_attacker" }),
    ]);
    // Already attacking: dropping it again declares nothing.
    expect(
      dropOptions(card("Goblin Guide", "battlefield"), column, model),
    ).toEqual([]);
  });

  it("blocks with a creature dropped on an attacker, and only on one", () => {
    const { card, layout, model } = setup("blockers");
    const angel = card("Serra Angel", "battlefield");
    const dragon = card("Shivan Dragon", "battlefield");
    const onDragon = layout.drops.find(
      (z) => z.kind === "card" && z.key === dragon.key,
    )!;
    expect(dropOptions(angel, onDragon, model)).toEqual([
      expect.objectContaining({ action: "toggle_blocker" }),
    ]);
    const onElves: DropZone = {
      kind: "card",
      key: card("Llanowar Elves", "battlefield").key,
      rect: rect(0, 0, 10, 10),
    };
    expect(dropOptions(angel, onElves, model)).toEqual([]);
  });
});

describe("dragging", () => {
  it("leaves a press that moves 8 pixels or less to be a click", () => {
    const { card, press, pointer, controller, ui, deps } = setup("duel");
    const forest = card("Forest");
    press(forest, { x: 600, y: 1000 });
    pointer("pointermove", { x: 600 + DRAG_THRESHOLD, y: 1000 });
    expect(controller.active).toBe(false);
    expect(ui.get().drag).toBeNull();
    pointer("pointerup", { x: 600 + DRAG_THRESHOLD, y: 1000 });
    expect(deps.choose).not.toHaveBeenCalled();
    expect(controller.consumeClick(forest.id)).toBe(false);
  });

  it("holds a card past 8 pixels, lights the drops that answer, and plays it where it lands", () => {
    const { card, press, pointer, controller, ui, deps } = setup("duel");
    const forest = card("Forest");
    press(forest, { x: 600, y: 1000 });
    pointer("pointermove", { x: 600, y: 1000 - DRAG_THRESHOLD - 1 });
    expect(controller.active).toBe(true);
    pointer("pointermove", YOUR_SIDE);
    const drag = ui.get().drag!;
    expect(drag.key).toBe(forest.key);
    expect(drag.point).toEqual(YOUR_SIDE);
    expect(drag.over?.kind).toBe("battlefield");
    expect(drag.valid.map((z) => z.kind)).toEqual([
      "battlefield",
      "battlefield",
    ]);
    pointer("pointerup", YOUR_SIDE);
    expect(ui.get().drag).toBeNull();
    expect(deps.choose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "play_land", object_id: forest.id }),
    );
    // The release's click is swallowed, once.
    expect(controller.consumeClick(forest.id)).toBe(true);
    expect(controller.consumeClick(forest.id)).toBe(false);
  });

  it("opens the card's menu when the drop could mean several answers", () => {
    const { card, drag, deps } = setup("duel", (f) => {
      const bolt = f.snapshot.view!.hand[1];
      f.snapshot.prompt!.options.push({
        ...choice("70", { object_id: bolt.id, label: "Cast it another way" }),
        action: "cast",
      });
    });
    const bolt = card("Lightning Bolt");
    drag(bolt, YOUR_SIDE);
    expect(deps.choose).not.toHaveBeenCalled();
    expect(deps.openMenu).toHaveBeenCalledWith(bolt.key, [
      expect.objectContaining({ action: "cast" }),
      expect.objectContaining({ id: "70" }),
    ]);
  });

  it("says so when the card cannot go where it was dropped", () => {
    const { card, drag, deps, ui } = setup("duel");
    drag(card("Forest"), THEIR_HALF);
    expect(deps.choose).not.toHaveBeenCalled();
    expect(deps.status).toHaveBeenCalledWith(DROP_REFUSED);
    expect(ui.get().drag).toBeNull();
  });

  it("refuses a drop when the prompt changed while the card was held", () => {
    const { card, press, pointer, deps } = setup("duel");
    press(card("Forest"), { x: 600, y: 1000 });
    pointer("pointermove", YOUR_SIDE);
    deps.promptKey = "p-duel|13";
    pointer("pointerup", YOUR_SIDE);
    expect(deps.choose).not.toHaveBeenCalled();
    expect(deps.status).toHaveBeenCalledWith(DROP_STALE);
  });

  it("lets go of the card when the prompt changes or the lease goes", () => {
    const { card, press, pointer, controller, deps, ui } = setup("duel");
    const forest = card("Forest");
    press(forest, { x: 600, y: 1000 });
    pointer("pointermove", YOUR_SIDE);
    deps.promptKey = null;
    controller.promptChanged();
    expect(controller.active).toBe(false);
    expect(ui.get().drag).toBeNull();
    expect(deps.status).toHaveBeenCalledWith(DROP_STALE);
    pointer("pointerup", YOUR_SIDE);
    expect(deps.choose).not.toHaveBeenCalled();
    expect(controller.consumeClick(forest.id)).toBe(true);
  });

  it("is cancelled by Escape, and the release's click swallowed", () => {
    const { card, press, pointer, controller, deps, ui } = setup("duel");
    const forest = card("Forest");
    press(forest, { x: 600, y: 1000 });
    pointer("pointermove", YOUR_SIDE);
    controller.cancel();
    expect(ui.get().drag).toBeNull();
    pointer("pointerup", YOUR_SIDE);
    expect(deps.choose).not.toHaveBeenCalled();
    expect(controller.consumeClick(forest.id)).toBe(true);
  });

  it("forgets the swallowed click when it never comes", () => {
    const { card, drag, controller, tick } = setup("duel");
    const forest = card("Forest");
    drag(forest, THEIR_HALF);
    tick(CLICK_SWALLOW_MS + 1);
    expect(controller.consumeClick(forest.id)).toBe(false);
  });

  it("drags only with the mouse's main button, and only what a drop could answer", () => {
    const { card, press, pointer, controller } = setup("duel");
    const forest = card("Forest");
    for (const change of [
      { pointerType: "touch" },
      { pointerType: "pen" },
      { button: 2 },
    ]) {
      press(forest, { x: 600, y: 1000 }, change);
      pointer("pointermove", YOUR_SIDE);
      expect(controller.active).toBe(false);
    }
    press(card("Air Elemental", "battlefield"), { x: 600, y: 300 });
    pointer("pointermove", YOUR_SIDE);
    expect(controller.active).toBe(false);
  });
});

describe("chained choices (C12)", () => {
  function attackBot2() {
    const s = setup("three");
    const giant = s.card("Hill Giant", "battlefield");
    const column = s.layout.drops.find(
      (z) => z.kind === "attack" && z.seat === 1 && z.rect.w > 400,
    )!;
    s.drag(giant, {
      x: column.rect.x + 40,
      y: column.rect.y + column.rect.h - 20,
    });
    expect(s.deps.choose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "toggle_attacker" }),
    );
    return s;
  }
  const defenders = (...seats: number[]) =>
    promptOf(
      "p-defender",
      "choose_defender",
      seats.map((seat, i) => choice(`d${i}`, { seat })),
    );
  function show(s: ReturnType<typeof setup>, model: TableModel) {
    s.deps.model = model;
    s.deps.promptKey = `${model.promptId}|${model.revision}`;
    s.controller.promptChanged();
  }

  it("names the defender an attacker was dropped on", () => {
    const s = attackBot2();
    show(s, next("three", defenders(1, 2)));
    expect(s.deps.choose).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "d0", seat: 1 }),
    );
    expect(s.deps.choose).toHaveBeenCalledTimes(2);
  });

  it("waits while the prompt it answered is still on screen", () => {
    const s = attackBot2();
    s.deps.promptKey = null; // the answer is in flight
    s.controller.promptChanged();
    show(s, next("three", defenders(1, 2)));
    expect(s.deps.choose).toHaveBeenCalledTimes(2);
  });

  it("chooses nothing when the drop does not name exactly one option", () => {
    const s = attackBot2();
    show(s, next("three", defenders(1, 1, 2)));
    expect(s.deps.choose).toHaveBeenCalledTimes(1);
  });

  it("is only for the next prompt, within two seconds, and only one that can be answered", () => {
    const late = attackBot2();
    late.tick(CHAIN_MS + 1);
    show(late, next("three", defenders(1, 2)));
    expect(late.deps.choose).toHaveBeenCalledTimes(1);

    const other = attackBot2();
    show(other, next("three", promptOf("p-other", "priority", [])));
    show(other, next("three", defenders(1, 2)));
    expect(other.deps.choose).toHaveBeenCalledTimes(1);

    const watching = attackBot2();
    show(watching, next("three", defenders(1, 2), false));
    expect(watching.deps.choose).toHaveBeenCalledTimes(1);
  });

  it("names the attacker a blocker was dropped on", () => {
    const s = setup("blockers");
    const angel = s.card("Serra Angel", "battlefield");
    const dragon = s.card("Shivan Dragon", "battlefield");
    const guide = s.card("Goblin Guide", "battlefield");
    const onDragon = s.layout.drops.find(
      (z) => z.kind === "card" && z.key === dragon.key,
    )!;
    s.drag(angel, centre(onDragon.rect));
    expect(s.deps.choose).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "toggle_blocker",
        object_id: angel.id,
      }),
    );
    show(
      s,
      next(
        "blockers",
        promptOf("p-attacker", "choose_target", [
          choice("a1", { object_id: guide.id }),
          choice("a2", { object_id: dragon.id }),
        ]),
      ),
    );
    expect(s.deps.choose).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "a2" }),
    );
  });
});

describe("useDragController", () => {
  it("answers a chained choice with the choose of the render that drew it", () => {
    const f = tableFixture("three");
    const model = modelOf(f);
    const layout = layoutTable(model, { expandedSeat: null, textScale: 1 });
    const ui = createTableUi();
    const first = vi.fn();
    const later = vi.fn();
    const props = (m: TableModel, choose: DragDeps["choose"]): DragDeps => ({
      layout,
      fit,
      ui,
      promptKey: `${m.promptId}|${m.revision}`,
      choose,
      openMenu: vi.fn(),
      status: vi.fn(),
      model: m,
    });
    const { result, rerender } = renderHook(
      (p: DragDeps) => useDragController(p),
      {
        initialProps: props(model, first),
      },
    );
    const giant = [...model.cards.values()].find(
      (c) => c.card.name === "Hill Giant",
    )!;
    const column = layout.drops.find(
      (z) => z.kind === "attack" && z.seat === 1 && z.rect.w > 400,
    )!;
    const to = { x: column.rect.x + 40, y: column.rect.y + 400 };
    const event = (type: string, p: Point) =>
      new PointerEvent(type, {
        clientX: p.x,
        clientY: p.y,
        pointerId: 7,
        pointerType: "mouse",
        button: 0,
      });
    act(() => {
      result.current.onPointerDown(
        event("pointerdown", { x: 300, y: 700 }),
        giant,
      );
      window.dispatchEvent(event("pointermove", to));
      window.dispatchEvent(event("pointerup", to));
    });
    expect(first).toHaveBeenCalledWith(
      expect.objectContaining({ action: "toggle_attacker" }),
    );
    rerender(
      props(
        next(
          "three",
          promptOf("p-defender", "choose_defender", [
            choice("d1", { seat: 1 }),
            choice("d2", { seat: 2 }),
          ]),
        ),
        later,
      ),
    );
    expect(later).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" }));
    expect(first).toHaveBeenCalledTimes(1);
  });
});
