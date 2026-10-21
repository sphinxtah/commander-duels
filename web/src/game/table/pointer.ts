import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
// tile's or a player's key); placed cards add `data-node` and `data-role`. Cards off the table
// (a drawer's, the prompt column's) have `data-hover` but no `data-node`.

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
const HAND_SLICE = '[data-role="hand"][data-node]';

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

export interface PointerAttachment {
  /** The layout and fit this user draws, and what to call when the hover clears. */
  bind(
    layout: TableLayout | null,
    fit: StageFit | null,
    onClear?: () => void,
  ): void;
  detach(): void;
}

export interface TablePointer {
  /** The layout and fit the pointer reads, and what to call when the hover clears. */
  bind(
    layout: TableLayout | null,
    fit: StageFit | null,
    onClear?: () => void,
  ): void;
  /** Another user of the same pointer (the table's layer, a drawer). The layout and fit are the
   * first user's that has them; every user's `onClear` is called; the timers stop when the
   * last user goes. */
  attach(): PointerAttachment;
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

/** The original event behind a sample: React hands its own wrapper of the native event. */
function nativeOf(sample: object): object {
  return (sample as { nativeEvent?: object }).nativeEvent ?? sample;
}

export function createTablePointer(
  ui: TableUiStore,
  clock: Clock = browserClock,
): TablePointer {
  // What the users draw (the pointer's own binding first, then each attachment in the order it
  // came), and the layout and fit read from them.
  interface Binding {
    layout: TableLayout | null;
    fit: StageFit | null;
    onClear?: () => void;
  }
  const own: Binding = { layout: null, fit: null };
  const bindings: Binding[] = [own];
  let attached = 0;
  let layout: TableLayout | null = null;
  let fit: StageFit | null = null;
  const rebind = () => {
    layout = bindings.find((b) => b.layout)?.layout ?? null;
    fit = bindings.find((b) => b.fit)?.fit ?? null;
  };
  // The control under the pointer now, and what hovering it would magnify.
  let candidate: string | null = null;
  let candidateMagnifies: Omit<Magnified, "level"> | null = null;
  let dwell: number | undefined;
  let clearing: number | undefined;
  let last: Point | null = null;
  let riseAt = 0;
  let riseMoves = 0;
  // The same event can arrive twice: from an element's handler and from the window's.
  const seen = new WeakSet<object>();
  const fresh = (sample: object) => {
    const event = nativeOf(sample);
    if (seen.has(event)) return false;
    seen.add(event);
    return true;
  };

  const stop = () => {
    clock.clearTimeout(dwell as number);
    clock.clearTimeout(clearing as number);
    dwell = undefined;
    clearing = undefined;
  };

  const reset = () => {
    stop();
    candidate = null;
    candidateMagnifies = null;
  };

  const side = (x: number | null) => magnifierSide(x ?? last?.x ?? 0);

  /** Where the card a control stands for is drawn, to open the magnifier away from it: a placed
   * card's face, or a hand card's risen picture. Off the table (a drawer's card, the column's)
   * there is none, and the pointer decides. */
  function drawnX(control: Element, key: string): number | null {
    if (!control.hasAttribute("data-node")) return null;
    if (control.getAttribute("data-role") === "hand") {
      const picture = layout?.risen.get(key);
      return picture ? centre(picture).x : null;
    }
    const node = layout?.nodes.get(key);
    return node?.kind === "card" ? centre(node.face).x : null;
  }

  /** What hovering a control shows in the side magnifier: a card off the hand, or a tile's top
   * card. Hand cards rise instead; "+N" buttons and players show nothing. */
  function magnifies(control: Element, key: string) {
    if (control.hasAttribute("data-card")) {
      if (control.getAttribute("data-role") === "hand") return null;
      return { key, side: side(drawnX(control, key)) };
    }
    const tile = layout?.zones.find((t) => t.key === key);
    return tile?.topKey
      ? { key: tile.topKey, side: side(centre(tile.card).x) }
      : null;
  }

  /** Whether what the pointer is over is the table itself: a table control or the bare table
   * between them, and, when `also` says so, a hand card's slice or a placed card's option menu.
   * Nothing on the table takes the pointer between its controls, so there the target is what
   * holds the table, with its placed controls inside. The prompt column, the HUD, a drawer or a
   * dialog is never the table. */
  function onTable(
    target: Element | null,
    also: { slices: boolean; menus: boolean },
  ): boolean {
    if (!target) return true;
    const menu = target.closest('[role="menu"]');
    // A placed card's menu sits in its slot, beside the card's button.
    if (menu)
      return also.menus && !!menu.parentElement?.querySelector("[data-node]");
    if (target.closest(REDIRECTABLE)) return true;
    if (also.slices && target.closest(HAND_SLICE)) return true;
    return (
      !target.closest(HOVERABLE) && target.querySelector("[data-node]") !== null
    );
  }

  /** The pointer-risen hand card whose picture is drawn at this client point over the table. */
  function risenOver(
    target: Element,
    clientX: number,
    clientY: number,
    slices: boolean,
  ): string | null {
    const risen = ui.get().risen;
    if (risen?.source !== "pointer" || !layout || !fit) return null;
    const grown = layout.risen.get(risen.key);
    if (!grown || !contains(grown, toDesign(fit, clientX, clientY)))
      return null;
    return onTable(target, { slices, menus: false }) ? risen.key : null;
  }

  function hover(key: string, shows: Omit<Magnified, "level"> | null) {
    const current = ui.get();
    // A drag started while the pointer rested: the carried card is all there is.
    if (current.drag) return;
    const patch: Partial<TableUiSnapshot> = { hover: key };
    // A card shows at level 1; one the wheel raised to level 2 stays until another replaces it.
    if (shows && current.magnified?.key !== shows.key)
      patch.magnified = { ...shows, level: 1 };
    else if (!shows && current.magnified?.level === 1) patch.magnified = null;
    ui.set(patch);
  }

  function clearHover() {
    const state = ui.get();
    const patch: Partial<TableUiSnapshot> = { hover: null };
    const keptByFocus =
      state.focusVisible && state.magnified?.key === state.focus;
    if (state.magnified?.level === 1 && !keptByFocus) patch.magnified = null;
    ui.set(patch);
    for (const binding of bindings) binding.onClear?.();
  }

  function settle(key: string | null, shows: typeof candidateMagnifies) {
    // Nothing to do when this control is already hovered, or about to be. (A drag clears the
    // hover without the pointer moving off its control: then it is hovered afresh.)
    const pending = key === null ? clearing !== undefined : dwell !== undefined;
    if (key === candidate && (pending || ui.get().hover === key)) return;
    candidate = key;
    candidateMagnifies = shows;
    stop();
    if (key === null)
      clearing = clock.setTimeout(() => {
        clearing = undefined;
        clearHover();
      }, HOVER_CLEAR_MS);
    else if (ui.get().hover !== key)
      dwell = clock.setTimeout(() => {
        dwell = undefined;
        hover(key, candidateMagnifies);
      }, HOVER_DWELL_MS);
  }

  return {
    bind(nextLayout, nextFit, nextOnClear) {
      own.layout = nextLayout;
      own.fit = nextFit;
      own.onClear = nextOnClear;
      rebind();
    },

    attach() {
      const binding: Binding = { layout: null, fit: null };
      bindings.push(binding);
      attached += 1;
      return {
        bind(nextLayout, nextFit, nextOnClear) {
          binding.layout = nextLayout;
          binding.fit = nextFit;
          binding.onClear = nextOnClear;
          rebind();
        },
        detach() {
          const at = bindings.indexOf(binding);
          if (at < 0) return;
          bindings.splice(at, 1);
          attached -= 1;
          rebind();
          if (attached === 0) reset();
        },
      };
    },

    move(sample) {
      if (!fresh(sample)) return;
      const target = elementOf(sample.target);
      const p = fit ? toDesign(fit, sample.clientX, sample.clientY) : null;
      const state = ui.get();
      // A carried card owns the pointer: nothing under it rises or is hovered (the captured
      // pointer's moves would all name the carried card) until it is let go.
      if (state.drag) {
        stop();
        last = p;
        ui.set({ pointer: p });
        return;
      }
      let risen = state.risen;
      const slice = target?.closest(HAND_SLICE);
      const handKey = slice?.getAttribute("data-node") ?? null;

      // A lifted card stays up while the pointer moves about its picture in small steps, over
      // the table: a drawer or the column drawn over the picture takes the pointer from it.
      let kept = false;
      if (risen?.source === "pointer") {
        const grown = layout?.risen.get(risen.key);
        kept =
          p && last && grown
            ? contains(grown, p) &&
              Math.hypot(p.x - last.x, p.y - last.y) <= RISE_JUMP &&
              onTable(target, { slices: true, menus: true })
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
      if (!fresh(event)) return false;
      if (event.detail === 0) return false;
      const target = elementOf(event.target);
      if (!target) return false;
      // A table control, or the bare table, inside the risen card's picture (C3).
      const key = risenOver(target, event.clientX, event.clientY, false);
      if (!key) return false;
      if (
        riseMoves < REDIRECT_MOVES &&
        clock.now() - riseAt < REDIRECT_DWELL_MS
      )
        return false;
      const card = Array.from(
        target.ownerDocument.querySelectorAll<HTMLElement>("[data-node]"),
      ).find((element) => element.dataset.node === key);
      if (!card) return false;
      event.preventDefault();
      event.stopPropagation();
      card.click();
      return true;
    },

    wheel(event) {
      if (!fresh(event)) return false;
      if (event.ctrlKey || event.deltaY === 0) return false;
      const target = elementOf(event.target);
      if (!target) return false;
      // Under the risen hand card's picture the wheel is the risen card's, as the hover is.
      const risen = risenOver(target, event.clientX, event.clientY, true);
      const control = risen ? null : target.closest("[data-card][data-hover]");
      const key = risen ?? control?.getAttribute("data-hover");
      if (!key) return false;
      const current = ui.get().magnified;
      if (event.deltaY < 0) {
        // Already as large as it goes: the wheel is left to scroll what it is over (a drawer).
        if (current?.key === key && current.level === 2) return false;
        const picture = risen ? layout?.risen.get(risen) : undefined;
        const x = picture
          ? centre(picture).x
          : control
            ? drawnX(control, key)
            : null;
        const pointer = fit
          ? toDesign(fit, event.clientX, event.clientY).x
          : null;
        ui.set({ magnified: { key, side: side(x ?? pointer), level: 2 } });
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
      reset();
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

interface WindowListeners {
  users: number;
  stop(): void;
}
const listening = new WeakMap<TablePointer, WindowListeners>();

function startListening(pointer: TablePointer): WindowListeners {
  const move = (event: PointerEvent) => pointer.move(event);
  // Leaving the window, or the window losing focus, leaves every control.
  const out = (event: PointerEvent) => {
    if (event.relatedTarget === null) pointer.leave();
  };
  const blur = () => pointer.leave();
  // Clicks on the bare table, which no element of the table's layer takes, and the wheel over
  // cards off the table (a drawer's, the column's). Only a wheel that changed the magnifier is
  // kept from scrolling.
  const click = (event: MouseEvent) => {
    pointer.click(event);
  };
  const wheel = (event: WheelEvent) => {
    if (pointer.wheel(event)) event.preventDefault();
  };
  window.addEventListener("pointermove", move, { capture: true });
  window.addEventListener("pointerout", out);
  window.addEventListener("blur", blur);
  window.addEventListener("click", click, { capture: true });
  window.addEventListener("wheel", wheel, { capture: true, passive: false });
  const listeners: WindowListeners = {
    users: 0,
    stop() {
      window.removeEventListener("pointermove", move, { capture: true });
      window.removeEventListener("pointerout", out);
      window.removeEventListener("blur", blur);
      window.removeEventListener("click", click, { capture: true });
      window.removeEventListener("wheel", wheel, { capture: true });
      listening.delete(pointer);
    },
  };
  listening.set(pointer, listeners);
  return listeners;
}

/** The window's listeners for one pointer, however many users it has: added for the first,
 * removed after the last. */
function listenOnWindow(pointer: TablePointer): () => void {
  const listeners = listening.get(pointer) ?? startListening(pointer);
  listeners.users += 1;
  return () => {
    listeners.users -= 1;
    if (listeners.users === 0) listeners.stop();
  };
}

/** The table's pointer handlers. Moves, clicks and the wheel are followed on the window, so the
 * pointer is known over the bare table between cards, where no control takes it, and over cards
 * off the table; an element's own handler and the window's see the same event only once.
 * Leaving is the window's to tell as well (the pointer leaving it, or its focus going), so an
 * element's own leave changes nothing. Any number of components may use it for the same store:
 * they share one pointer. */
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
  const attachment = useRef<PointerAttachment | null>(null);
  useLayoutEffect(() => {
    const own = pointer.attach();
    attachment.current = own;
    const unlisten = listenOnWindow(pointer);
    return () => {
      unlisten();
      own.detach();
      attachment.current = null;
    };
  }, [pointer]);
  useLayoutEffect(() => attachment.current?.bind(layout, fit, onClear));
  useEffect(() => pointer.layoutChanged(), [pointer, layout]);
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
