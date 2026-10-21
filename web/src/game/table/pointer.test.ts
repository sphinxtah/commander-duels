import { renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { fixtureInput, tableFixture } from "./fixtures";
import { centre, contains } from "./geometry";
import { layoutTable } from "./layout";
import {
  HOVER_CLEAR_MS,
  HOVER_DWELL_MS,
  REDIRECT_DWELL_MS,
  createTablePointer,
  noteBlur,
  noteFocus,
  useTablePointer,
  type ClickSample,
  type Clock,
  type TablePointer,
} from "./pointer";
import { stageFit } from "./stage";
import { buildTableModel } from "./tableModel";
import type { CardNode, Point, TableLayout } from "./types";
import { createTableUi } from "./uiStore";

// The pointer rules of design §6.3 on the duel's layout, with the stage at scale 1 (client
// pixels are stage units) and a clock the tests move by hand.

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout(run, ms) {
      next += 1;
      timers.set(next, { at: now + ms, run });
      return next;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

let layout: TableLayout;
let root: HTMLElement;
let clock: ReturnType<typeof manualClock>;
let ui: ReturnType<typeof createTableUi>;
let pointer: TablePointer;
let onClear: Mock<() => void>;
const fit = stageFit(1920, 1080, 1);

/** The controls the DOM layer puts at each hit, with the attributes the pointer reads. */
function controls() {
  const element = document.createElement("div");
  for (const node of layout.nodes.values()) {
    if (!node.hit) continue;
    const button = document.createElement("button");
    button.dataset.node = node.key;
    button.dataset.hover = node.key;
    if (node.kind === "card") {
      button.dataset.card = node.id;
      button.dataset.role = node.role;
    } else button.dataset.more = node.opens.kind;
    element.append(button);
  }
  for (const tile of layout.zones) {
    if (!tile.hit) continue;
    const button = document.createElement("button");
    button.dataset.zone = tile.zone;
    button.dataset.hover = tile.key;
    element.append(button);
  }
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.append(document.createElement("button"));
  element.append(menu);
  document.body.append(element);
  return element;
}

const button = (key: string) =>
  Array.from(
    root.querySelectorAll<HTMLElement>("[data-node],[data-hover]"),
  ).find((b) => b.dataset.node === key || b.dataset.hover === key)!;
const cardNode = (key: string) => layout.nodes.get(key) as CardNode;
const move = (key: string | null, p: Point) =>
  pointer.move({
    clientX: p.x,
    clientY: p.y,
    target: key ? button(key) : document.body,
  });
/** Moves from one point to another over the land, in equal steps. */
function walk(from: Point, to: Point, steps: number) {
  for (let i = 1; i <= steps; i++)
    move(land, {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    });
}
/** Focus by the keyboard: a key press, then the focus it moves. */
function tabTo(key: string) {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
  );
  button(key).focus();
}
function click(key: string, p: Point, detail = 1) {
  const sample: ClickSample = {
    clientX: p.x,
    clientY: p.y,
    target: button(key),
    detail,
    currentTarget: root,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  return { redirected: pointer.click(sample), sample };
}

// The first hand card, its risen picture, and a land of yours drawn under that picture.
let hand: string;
let risen: { x: number; y: number; w: number; h: number };
let land: string;
let handPoint: Point;
let landPoint: Point;

beforeEach(() => {
  const model = buildTableModel(fixtureInput(tableFixture("duel")));
  layout = layoutTable(model, { expandedSeat: null, textScale: 1 });
  root = controls();
  clock = manualClock();
  ui = createTableUi();
  pointer = createTablePointer(ui, clock);
  onClear = vi.fn<() => void>();
  pointer.bind(layout, fit, onClear);
  hand = model.hand[0];
  risen = layout.risen.get(hand)!;
  const under = [...layout.nodes.values()].find(
    (node): node is CardNode =>
      node.kind === "card" &&
      node.role !== "hand" &&
      node.hit !== null &&
      contains(risen, centre(node.hit)),
  )!;
  land = under.key;
  const slice = cardNode(hand).hit!;
  handPoint = { x: slice.x + slice.w / 2, y: slice.y + 40 };
  landPoint = centre(under.hit!);
});
afterEach(() => {
  pointer.dispose();
  root.remove();
});

describe("hovering", () => {
  it("waits for the pointer to rest before a card counts as hovered", () => {
    const angel = [...layout.nodes.values()].find(
      (node) =>
        node.kind === "card" &&
        node.hit !== null &&
        node.key.startsWith("battlefield:") &&
        centre(node.face).y < 480,
    ) as CardNode;
    move(angel.key, centre(angel.hit!));
    clock.advance(HOVER_DWELL_MS - 1);
    expect(ui.get().hover).toBeNull();
    clock.advance(1);
    expect(ui.get().hover).toBe(angel.key);
    // An opponent's card at the top right shows on the left; one at the left, on the right.
    expect(ui.get().magnified).toEqual({
      key: angel.key,
      side: centre(angel.face).x < 960 ? "right" : "left",
      level: 1,
    });
  });

  it("clears a moment after the pointer leaves every control, preview included (V4)", () => {
    move(land, landPoint);
    clock.advance(HOVER_DWELL_MS);
    expect(ui.get().hover).toBe(land);
    move(null, { x: 960, y: 300 });
    clock.advance(HOVER_CLEAR_MS - 1);
    // Coming back in time keeps it.
    move(land, landPoint);
    clock.advance(HOVER_CLEAR_MS);
    expect(ui.get().hover).toBe(land);
    expect(onClear).not.toHaveBeenCalled();
    move(null, { x: 960, y: 300 });
    clock.advance(HOVER_CLEAR_MS);
    expect(ui.get().hover).toBeNull();
    expect(ui.get().magnified).toBeNull();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("opens the magnifier away from the pointer for a card off the table, not from where it lies", () => {
    // A battlefield card drawn left of the middle, listed again in a drawer at the stage's right.
    const left = [...layout.nodes.values()].find(
      (node): node is CardNode =>
        node.kind === "card" &&
        node.role === "battlefield" &&
        node.hit !== null &&
        centre(node.face).x < 960,
    )!;
    const listed = document.createElement("button");
    listed.dataset.card = left.id;
    listed.dataset.hover = left.key;
    document.body.append(listed);
    const there = { clientX: 1600, clientY: 500, target: listed };
    pointer.move(there);
    clock.advance(HOVER_DWELL_MS);
    expect(ui.get().magnified).toEqual({
      key: left.key,
      side: "left",
      level: 1,
    });
    pointer.wheel({ ...there, deltaY: -100, ctrlKey: false });
    expect(ui.get().magnified).toEqual({
      key: left.key,
      side: "left",
      level: 2,
    });
    // On the table, the same card opens it on the side away from its face.
    pointer.wheel({ ...there, deltaY: 100, ctrlKey: false });
    pointer.wheel({ ...there, deltaY: 100, ctrlKey: false });
    pointer.wheel({
      clientX: 1600,
      clientY: 500,
      target: button(left.key),
      deltaY: -100,
      ctrlKey: false,
    });
    expect(ui.get().magnified?.side).toBe("right");
    listed.remove();
  });

  it("hovers the control again after a drag that started on it, and nothing during the drag", () => {
    move(land, landPoint);
    clock.advance(HOVER_DWELL_MS);
    expect(ui.get().hover).toBe(land);
    // A drag starts from the land: the drag controller clears the hover.
    ui.set({
      drag: { key: land, point: landPoint, over: null, valid: [] },
      hover: null,
    });
    move(hand, handPoint);
    clock.advance(HOVER_DWELL_MS);
    expect(ui.get()).toMatchObject({ hover: null, risen: null });
    ui.set({ drag: null });
    move(land, landPoint);
    clock.advance(HOVER_DWELL_MS);
    expect(ui.get().hover).toBe(land);
  });

  it("shows a graveyard's top card from its tile", () => {
    const tile = layout.zones.find((t) => t.zone === "graveyard" && t.topKey)!;
    pointer.move({
      clientX: centre(tile.hit!).x,
      clientY: centre(tile.hit!).y,
      target: button(tile.key),
    });
    clock.advance(HOVER_DWELL_MS);
    expect(ui.get().hover).toBe(tile.key);
    expect(ui.get().magnified?.key).toBe(tile.topKey);
  });
});

describe("the risen hand card", () => {
  it("rises under the pointer and stays up while the pointer moves about its picture", () => {
    move(hand, handPoint);
    expect(ui.get().risen).toEqual({ key: hand, source: "pointer" });
    // Small steps up over the land drawn under the picture keep it up.
    walk(handPoint, landPoint, 6);
    expect(ui.get().risen).toEqual({ key: hand, source: "pointer" });
    clock.advance(HOVER_DWELL_MS);
    // What the pointer rests on is the risen card, not the land under it.
    expect(ui.get().hover).toBe(hand);
  });

  it("falls when the pointer jumps, leaves its picture or leaves the table", () => {
    move(hand, handPoint);
    move(land, landPoint); // one jump of more than 64 su
    expect(ui.get().risen).toBeNull();
    move(hand, handPoint);
    move(null, { x: risen.x - 10, y: risen.y + 100 });
    expect(ui.get().risen).toBeNull();
    move(hand, handPoint);
    pointer.leave();
    expect(ui.get().risen).toBeNull();
  });

  it("falls when the pointer moves onto something drawn over its picture off the table", () => {
    // The prompt column or a drawer, which hold no table controls.
    const column = document.createElement("div");
    const item = document.createElement("button");
    column.append(item);
    document.body.append(column);
    move(hand, handPoint);
    pointer.move({
      clientX: handPoint.x,
      clientY: handPoint.y - 30,
      target: item,
    });
    expect(ui.get().risen).toBeNull();
    // A card's own menu on the table keeps it up.
    move(hand, handPoint);
    pointer.move({
      clientX: handPoint.x,
      clientY: handPoint.y - 30,
      target: root.querySelector('[role="menu"] button'),
    });
    expect(ui.get().risen).toEqual({ key: hand, source: "pointer" });
    column.remove();
  });

  it("falls when its card leaves the hand", () => {
    move(hand, handPoint);
    const next = buildTableModel(
      fixtureInput(
        (() => {
          const f = tableFixture("duel");
          f.snapshot.view!.hand.shift();
          return f;
        })(),
      ),
    );
    pointer.bind(
      layoutTable(next, { expandedSeat: null, textScale: 1 }),
      fit,
      onClear,
    );
    pointer.layoutChanged();
    expect(ui.get().risen).toBeNull();
  });
});

describe("a click under the risen card", () => {
  /** Rises the hand card and walks up to the land in small steps. */
  function walkUp(steps: number) {
    move(hand, handPoint);
    walk(handPoint, landPoint, steps);
  }

  it("goes to the risen card after the pointer has dwelt on it", () => {
    const risenClick = vi.fn();
    button(hand).addEventListener("click", risenClick);
    walkUp(4);
    const { redirected, sample } = click(land, landPoint);
    expect(redirected).toBe(true);
    expect(sample.preventDefault).toHaveBeenCalled();
    expect(sample.stopPropagation).toHaveBeenCalled();
    expect(risenClick).toHaveBeenCalledTimes(1);
  });

  it("stays the land's straight after the rise, and goes to the risen card once it has been up long enough", () => {
    const above = { x: handPoint.x, y: handPoint.y - 50 };
    move(hand, handPoint);
    move(land, above);
    move(land, { x: above.x + 10, y: above.y });
    // Two moves inside its picture, a moment after it rose: the land's.
    expect(click(land, above).redirected).toBe(false);
    clock.advance(REDIRECT_DWELL_MS);
    expect(click(land, above).redirected).toBe(true);
  });

  it("stays the land's for a single move and click, as Playwright makes", () => {
    // A hand card hovered a while ago does not catch a later click elsewhere.
    move(hand, handPoint);
    clock.advance(1000);
    move(land, landPoint);
    expect(ui.get().risen).toBeNull();
    expect(click(land, landPoint).redirected).toBe(false);
  });

  it("goes to the risen card from the bare table under its picture, never from off the table", () => {
    const risenClick = vi.fn();
    button(hand).addEventListener("click", risenClick);
    const bare = (target: Element, p: Point) =>
      pointer.click({
        clientX: p.x,
        clientY: p.y,
        target,
        detail: 1,
        currentTarget: window,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
    // Between the lands, nothing takes the pointer: the click lands on what holds the table.
    const between = { x: handPoint.x, y: risen.y + 20 };
    move(hand, handPoint);
    walk(handPoint, between, 6);
    expect(ui.get().risen).toEqual({ key: hand, source: "pointer" });
    expect(bare(document.body, between)).toBe(true);
    expect(risenClick).toHaveBeenCalledTimes(1);
    // Outside the picture, or on the column drawn over it, it stays where it fell.
    expect(bare(document.body, { x: risen.x - 10, y: between.y })).toBe(false);
    const column = document.createElement("div");
    document.body.append(column);
    expect(bare(column, between)).toBe(false);
    column.remove();
    expect(risenClick).toHaveBeenCalledTimes(1);
  });

  it("is never redirected from the keyboard or a menu", () => {
    walkUp(6);
    clock.advance(REDIRECT_DWELL_MS);
    expect(click(land, landPoint, 0).redirected).toBe(false);
    const item = root.querySelector<HTMLElement>('[role="menu"] button')!;
    expect(
      pointer.click({
        clientX: landPoint.x,
        clientY: landPoint.y,
        target: item,
        detail: 1,
        currentTarget: root,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }),
    ).toBe(false);
  });
});

describe("the wheel", () => {
  const wheel = (key: string, deltaY: number, ctrlKey = false) =>
    pointer.wheel({
      clientX: landPoint.x,
      clientY: landPoint.y,
      target: button(key),
      deltaY,
      ctrlKey,
    });

  it("magnifies a card further, then less, then not at all", () => {
    expect(wheel(land, -100)).toBe(true);
    expect(ui.get().magnified).toMatchObject({ key: land, level: 2 });
    expect(wheel(land, 100)).toBe(true);
    expect(ui.get().magnified).toMatchObject({ key: land, level: 1 });
    expect(wheel(land, 100)).toBe(true);
    expect(ui.get().magnified).toBeNull();
    expect(wheel(land, 100)).toBe(false);
  });

  it("opens the side magnifier for a hand card, away from its risen picture", () => {
    expect(wheel(hand, -100)).toBe(true);
    expect(ui.get().magnified).toEqual({
      key: hand,
      side: centre(risen).x < 960 ? "right" : "left",
      level: 2,
    });
  });

  it("magnifies the risen hand card, not the land under its picture", () => {
    move(hand, handPoint);
    walk(handPoint, landPoint, 6);
    expect(ui.get().risen).toEqual({ key: hand, source: "pointer" });
    expect(wheel(land, -100)).toBe(true);
    expect(ui.get().magnified).toEqual({
      key: hand,
      side: centre(risen).x < 960 ? "right" : "left",
      level: 2,
    });
    // As large as it goes: the next turn of the wheel is left to scroll.
    expect(wheel(land, -100)).toBe(false);
  });

  it("leaves the browser's zoom alone, and anything that is not a card", () => {
    expect(wheel(land, -100, true)).toBe(false);
    const more = [...layout.nodes.values()].find((n) => n.kind === "more");
    if (more) expect(wheel(more.key, -100)).toBe(false);
    expect(ui.get().magnified).toBeNull();
  });
});

describe("several users of one pointer", () => {
  it("reads the first user's layout, calls every user's onClear, and stops when the last goes", () => {
    const shared = createTablePointer(ui, clock);
    const layerClear = vi.fn();
    const layer = shared.attach();
    layer.bind(layout, fit, layerClear);
    // A drawer drawn without the table's layout, with nothing of its own to clear.
    const drawer = shared.attach();
    drawer.bind(null, null);
    const at = (target: Element, p: Point) =>
      shared.move({ clientX: p.x, clientY: p.y, target });
    at(button(land), landPoint);
    clock.advance(HOVER_DWELL_MS);
    expect(ui.get().magnified).toEqual({
      key: land,
      side: centre(cardNode(land).face).x < 960 ? "right" : "left",
      level: 1,
    });
    at(document.body, { x: 960, y: 300 });
    // The drawer closes while the hover clears: the layer still hears of it (V4).
    drawer.detach();
    clock.advance(HOVER_CLEAR_MS);
    expect(ui.get().hover).toBeNull();
    expect(layerClear).toHaveBeenCalledTimes(1);
    // The last user going stops what was pending.
    at(button(land), landPoint);
    layer.detach();
    clock.advance(HOVER_DWELL_MS);
    expect(ui.get().hover).toBeNull();
  });

  it("listens on the window once for every component using it, until the last unmounts", () => {
    vi.useFakeTimers();
    try {
      const store = createTableUi();
      const cleared = vi.fn();
      const layer = renderHook(() =>
        useTablePointer(store, layout, fit, { onClear: cleared }),
      );
      const drawer = renderHook(() => useTablePointer(store, null, null));
      // A later render of the other user changes nothing of the layer's.
      drawer.rerender();
      const moveOn = (target: Element, p: Point) =>
        target.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: p.x,
            clientY: p.y,
          }),
        );
      moveOn(button(land), landPoint);
      vi.advanceTimersByTime(HOVER_DWELL_MS);
      expect(store.get().hover).toBe(land);
      moveOn(document.body, { x: 960, y: 300 });
      drawer.unmount();
      vi.advanceTimersByTime(HOVER_CLEAR_MS);
      expect(store.get().hover).toBeNull();
      expect(cleared).toHaveBeenCalledTimes(1);
      // The wheel over a card anywhere on the page, the column's included, reaches it.
      const wheel = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -100,
        clientX: 200,
        clientY: 600,
      });
      const listed = document.createElement("button");
      listed.dataset.card = cardNode(land).id;
      listed.dataset.hover = land;
      document.body.append(listed);
      listed.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
      expect(store.get().magnified).toEqual({
        key: land,
        side: "right",
        level: 2,
      });
      listed.remove();
      layer.unmount();
      moveOn(button(land), landPoint);
      vi.advanceTimersByTime(HOVER_DWELL_MS);
      expect(store.get().hover).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("keyboard focus", () => {
  it("lifts a hand card and shows any other card at once", () => {
    tabTo(hand);
    noteFocus(ui, hand, button(hand), {
      hand: true,
      shows: hand,
      anchorX: centre(risen).x,
    });
    expect(ui.get()).toMatchObject({
      focus: hand,
      focusVisible: true,
      risen: { key: hand, source: "focus" },
      magnified: null,
    });
    tabTo(land);
    noteFocus(ui, land, button(land), {
      hand: false,
      shows: land,
      anchorX: landPoint.x,
    });
    expect(ui.get().risen).toBeNull();
    expect(ui.get().magnified).toEqual({
      key: land,
      side: landPoint.x < 960 ? "right" : "left",
      level: 1,
    });
    noteBlur(ui, land);
    expect(ui.get()).toMatchObject({
      focus: null,
      focusVisible: false,
      magnified: null,
    });
  });

  it("keeps a focus rise while the pointer moves elsewhere", () => {
    tabTo(hand);
    noteFocus(ui, hand, button(hand), { hand: true, shows: hand, anchorX: 0 });
    move(null, { x: 960, y: 300 });
    expect(ui.get().risen).toEqual({ key: hand, source: "focus" });
  });

  it("lifts nothing for focus a press gave", () => {
    button(hand).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    button(hand).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    button(hand).focus();
    noteFocus(ui, hand, button(hand), { hand: true, shows: hand, anchorX: 0 });
    expect(ui.get()).toMatchObject({
      focus: hand,
      focusVisible: false,
      risen: null,
    });
  });
});
