import {
  useEffect,
  useLayoutEffect,
  useMemo,
  type MouseEventHandler,
  type PointerEventHandler,
  type WheelEventHandler,
} from "react";
import { centre, contains } from "./geometry";
import { magnifierSide } from "./layout";
import { toDesign } from "./stage";
import type {
  Point,
  StageFit,
  TableLayout,
  TableUiSnapshot,
  TableUiStore,
} from "./types";

// The pointer on the table (design §6.3): which control it rests on (after a short dwell, so a
// pointer crossing the table does not flash the magnifier), the hand card it lifts, the click
// that belongs to that lifted card rather than to the land drawn under it, and the wheel that
// magnifies. All of it goes to the table's interface store, never to React state, so moving the
// pointer re-renders nothing but what reads the store.
//
// Controls name themselves for this with `data-hover` (the store key: a card's table key, a
// tile's or a player's key); placed cards add `data-node` and `data-role`.

/** How long the pointer rests on a control before it counts as hovered. */
export const HOVER_DWELL_MS = 80;
/** How long the pointer may be off every control before the hover clears. */
export const HOVER_CLEAR_MS = 150;
/** A move longer than this (in stage units) is a jump: the risen card is chosen afresh. */
export const RISE_JUMP = 64;
/** Moves inside the risen picture, or time since it rose, before a click there is the risen
 * card's. Playwright's single move before its click never gets there. */
export const REDIRECT_MOVES = 3;
export const REDIRECT_DWELL_MS = 150;

const HOVERABLE = "[data-hover]";
/** Table controls a click on which may belong to the risen hand card drawn over them. "+N"
 * buttons, menus, the prompt column, the HUD and the drawers are never redirected. */
const REDIRECTABLE =
  '[data-card][data-node]:not([data-role="hand"]), [data-player], [data-zone]';

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const browserClock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export interface PointerSample {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}
export interface ClickSample extends PointerSample {
  /** 0 for a click from the keyboard (Enter or Space): those are never redirected. */
  detail: number;
  currentTarget: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}
export interface WheelSample extends PointerSample {
  deltaY: number;
  ctrlKey: boolean;
}

export interface TablePointer {
  /** The layout and fit the pointer reads, and what to call when the hover clears. */
  bind(
    layout: TableLayout | null,
    fit: StageFit | null,
    onClear?: () => void,
  ): void;
  move(sample: PointerSample): void;
  leave(): void;
  /** A capture-phase click: true when it went to the risen hand card instead. */
  click(event: ClickSample): boolean;
  /** True when the wheel was over a card and changed the magnifier. */
  wheel(event: WheelSample): boolean;
  /** The layout changed: a risen card that has left the hand falls. */
  layoutChanged(): void;
  dispose(): void;
}

type Magnified = NonNullable<TableUiSnapshot["magnified"]>;

function elementOf(target: EventTarget | null): Element | null {
  return typeof Element !== "undefined" && target instanceof Element
    ? target
    : null;
}

export function createTablePointer(
  ui: TableUiStore,
  clock: Clock = browserClock,
): TablePointer {
  let layout: TableLayout | null = null;
  let fit: StageFit | null = null;
  let onClear: (() => void) | undefined;
  // The control under the pointer now, and what hovering it would magnify.
  let candidate: string | null = null;
  let candidateMagnifies: Omit<Magnified, "level"> | null = null;
  let dwell: number | undefined;
  let clearing: number | undefined;
  let last: Point | null = null;
  let riseAt = 0;
  let riseMoves = 0;
  let lastEvent: unknown = null;

  const stop = () => {
    clock.clearTimeout(dwell as number);
    clock.clearTimeout(clearing as number);
    dwell = undefined;
    clearing = undefined;
  };

  const side = (x: number | null) => magnifierSide(x ?? last?.x ?? 0);

  /** What hovering a control shows in the side magnifier: a card off the hand, or a tile's top
   * card. Hand cards rise instead; "+N" buttons and players show nothing. */
  function magnifies(control: Element, key: string) {
    if (control.hasAttribute("data-card")) {
      if (control.getAttribute("data-role") === "hand") return null;
      const node = layout?.nodes.get(key);
      return {
        key,
        side: side(node?.kind === "card" ? centre(node.face).x : null),
      };
    }
    const tile = layout?.zones.find((t) => t.key === key);
    return tile?.topKey
      ? { key: tile.topKey, side: side(centre(tile.card).x) }
      : null;
  }

  function hover(key: string, shows: Omit<Magnified, "level"> | null) {
    const current = ui.get().magnified;
    const patch: Partial<TableUiSnapshot> = { hover: key };
    // A card shows at level 1; one the wheel raised to level 2 stays until another replaces it.
    if (shows && current?.key !== shows.key)
      patch.magnified = { ...shows, level: 1 };
    else if (!shows && current?.level === 1) patch.magnified = null;
    ui.set(patch);
  }

  function clearHover() {
    const state = ui.get();
    const patch: Partial<TableUiSnapshot> = { hover: null };
    const keptByFocus =
      state.focusVisible && state.magnified?.key === state.focus;
    if (state.magnified?.level === 1 && !keptByFocus) patch.magnified = null;
    ui.set(patch);
    onClear?.();
  }

  function settle(key: string | null, shows: typeof candidateMagnifies) {
    if (key === candidate) return;
    candidate = key;
    candidateMagnifies = shows;
    stop();
    if (key === null) clearing = clock.setTimeout(clearHover, HOVER_CLEAR_MS);
    else if (ui.get().hover !== key)
      dwell = clock.setTimeout(
        () => hover(key, candidateMagnifies),
        HOVER_DWELL_MS,
      );
  }

  return {
    bind(nextLayout, nextFit, nextOnClear) {
      layout = nextLayout;
      fit = nextFit;
      onClear = nextOnClear;
    },

    move(sample) {
      // The same event can arrive twice: from an element's handler and from the window's.
      if (sample === lastEvent) return;
      lastEvent = sample;
      const target = elementOf(sample.target);
      const p = fit ? toDesign(fit, sample.clientX, sample.clientY) : null;
      const state = ui.get();
      let risen = state.risen;
      const slice = target?.closest('[data-role="hand"][data-node]');
      const handKey = slice?.getAttribute("data-node") ?? null;

      // A lifted card stays up while the pointer moves about its picture in small steps.
      let kept = false;
      if (risen?.source === "pointer") {
        const grown = layout?.risen.get(risen.key);
        kept =
          p && last && grown
            ? contains(grown, p) &&
              Math.hypot(p.x - last.x, p.y - last.y) <= RISE_JUMP
            : handKey === risen.key;
      }
      if (kept) riseMoves += 1;
      else {
        const next: TableUiSnapshot["risen"] = handKey
          ? { key: handKey, source: "pointer" }
          : risen?.source === "focus"
            ? risen
            : null;
        if (next?.source === "pointer") {
          riseAt = clock.now();
          riseMoves = 0;
        }
        risen = next;
      }
      last = p;
      ui.set({ pointer: p, risen });

      // While a card is lifted, what lies under its picture is the card itself.
      if (risen?.source === "pointer") {
        settle(risen.key, null);
        return;
      }
      const control = target?.closest(HOVERABLE) ?? null;
      const key = control?.getAttribute("data-hover") ?? null;
      settle(key, control && key ? magnifies(control, key) : null);
    },

    leave() {
      last = null;
      const risen = ui.get().risen;
      ui.set({
        pointer: null,
        ...(risen?.source === "pointer" ? { risen: null } : {}),
      });
      settle(null, null);
    },

    click(event) {
      if (event.detail === 0) return false;
      const target = elementOf(event.target);
      if (!target || target.closest('[role="menu"]')) return false;
      if (!target.closest(REDIRECTABLE)) return false;
      const risen = ui.get().risen;
      if (risen?.source !== "pointer" || !layout || !fit) return false;
      const grown = layout.risen.get(risen.key);
      if (
        !grown ||
        !contains(grown, toDesign(fit, event.clientX, event.clientY))
      )
        return false;
      if (
        riseMoves < REDIRECT_MOVES &&
        clock.now() - riseAt < REDIRECT_DWELL_MS
      )
        return false;
      const root = elementOf(event.currentTarget) ?? document;
      const card = Array.from(
        root.querySelectorAll<HTMLElement>("[data-node]"),
      ).find((element) => element.dataset.node === risen.key);
      if (!card) return false;
      event.preventDefault();
      event.stopPropagation();
      card.click();
      return true;
    },

    wheel(event) {
      if (event.ctrlKey || event.deltaY === 0) return false;
      const control = elementOf(event.target)?.closest(
        "[data-card][data-hover]",
      );
      const key = control?.getAttribute("data-hover");
      if (!control || !key) return false;
      const current = ui.get().magnified;
      if (event.deltaY < 0) {
        const hand = control.getAttribute("data-role") === "hand";
        const picture = hand ? layout?.risen.get(key) : undefined;
        const node = layout?.nodes.get(key);
        const x = picture
          ? centre(picture).x
          : node?.kind === "card"
            ? centre(node.face).x
            : fit
              ? toDesign(fit, event.clientX, event.clientY).x
              : null;
        ui.set({ magnified: { key, side: side(x), level: 2 } });
      } else if (current?.key === key)
        ui.set({
          magnified: current.level === 2 ? { ...current, level: 1 } : null,
        });
      else return false;
      return true;
    },

    layoutChanged() {
      const risen = ui.get().risen;
      if (risen && layout && !layout.risen.has(risen.key))
        ui.set({ risen: null });
    },

    dispose() {
      stop();
      candidate = null;
    },
  };
}

// One pointer per store: the table's layer and anything else that reports moves share its state.
const pointers = new WeakMap<TableUiStore, TablePointer>();
function pointerFor(ui: TableUiStore): TablePointer {
  let pointer = pointers.get(ui);
  if (!pointer) {
    pointer = createTablePointer(ui);
    pointers.set(ui, pointer);
  }
  return pointer;
}

/** The table's pointer handlers. Moves are also followed on the window, so the pointer is known
 * over the bare table between cards, where no control takes it; an element's own handler and
 * the window's see the same event only once. Leaving is the window's to tell as well (the
 * pointer leaving it, or its focus going), so an element's own leave changes nothing. */
export function useTablePointer(
  ui: TableUiStore,
  layout: TableLayout | null,
  fit: StageFit | null,
  options: { onClear?: () => void } = {},
): {
  onPointerMove: PointerEventHandler;
  onPointerLeave(): void;
  onClickCapture: MouseEventHandler;
  onWheel: WheelEventHandler;
} {
  const pointer = pointerFor(ui);
  const onClear = options.onClear;
  useLayoutEffect(() => pointer.bind(layout, fit, onClear));
  useEffect(() => pointer.layoutChanged(), [pointer, layout]);
  useEffect(() => {
    const move = (event: PointerEvent) => pointer.move(event);
    // Leaving the window, or the window losing focus, leaves every control.
    const out = (event: PointerEvent) => {
      if (event.relatedTarget === null) pointer.leave();
    };
    const blur = () => pointer.leave();
    window.addEventListener("pointermove", move, { capture: true });
    window.addEventListener("pointerout", out);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move, { capture: true });
      window.removeEventListener("pointerout", out);
      window.removeEventListener("blur", blur);
      pointer.dispose();
    };
  }, [pointer]);
  return useMemo(
    () => ({
      onPointerMove: (event) => pointer.move(event.nativeEvent),
      onPointerLeave: () => undefined,
      onClickCapture: (event) => {
        pointer.click(event);
      },
      onWheel: (event) => {
        pointer.wheel(event);
      },
    }),
    [pointer],
  );
}

/* ---------- keyboard focus ---------- */

// Whether focus came from the keyboard, for browsers (and jsdom) without :focus-visible.
let keyboardLast = false;
let modalityTracked = false;
function trackModality() {
  if (modalityTracked || typeof document === "undefined") return;
  modalityTracked = true;
  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey)
        keyboardLast = true;
    },
    true,
  );
  document.addEventListener("pointerdown", () => (keyboardLast = false), true);
}

/** Whether focus on this element shows its ring: it came from the keyboard. */
export function isFocusVisible(element: Element): boolean {
  trackModality();
  try {
    return element.matches(":focus-visible");
  } catch {
    // An engine that does not know the selector: the last input decides.
    return keyboardLast;
  }
}

/** A table control took focus. Keyboard focus lifts a hand card, as the pointer does, and shows
 * the card a control stands for (`shows`: a card's own key, a tile's top card) in the side
 * magnifier at once, on the side away from it. */
export function noteFocus(
  ui: TableUiStore,
  key: string,
  element: Element,
  where: { hand: boolean; shows: string | null; anchorX: number | null },
) {
  const visible = isFocusVisible(element);
  const state = ui.get();
  const patch: Partial<TableUiSnapshot> = { focus: key, focusVisible: visible };
  if (where.hand && visible) patch.risen = { key, source: "focus" };
  else if (state.risen?.source === "focus") patch.risen = null;
  const shows = where.hand ? null : where.shows;
  if (visible && shows && state.magnified?.key !== shows)
    patch.magnified = {
      key: shows,
      side: magnifierSide(where.anchorX ?? 0),
      level: 1,
    };
  ui.set(patch);
}

/** Focus left a table control: what it lifted or showed goes, unless the pointer holds it. */
export function noteBlur(
  ui: TableUiStore,
  key: string,
  shows: string | null = key,
) {
  const state = ui.get();
  if (state.focus !== key) return;
  const patch: Partial<TableUiSnapshot> = { focus: null, focusVisible: false };
  if (state.risen?.source === "focus" && state.risen.key === key)
    patch.risen = null;
  if (
    shows !== null &&
    state.magnified?.key === shows &&
    state.magnified.level === 1 &&
    state.hover !== key
  )
    patch.magnified = null;
  ui.set(patch);
}
