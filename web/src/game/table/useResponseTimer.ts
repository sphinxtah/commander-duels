import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  TIMER_IDLE,
  TIMER_TICK_MS,
  timerLive,
  timerReducer,
  timerView,
  type TimerAction,
  type TimerState,
} from "./timer";
import type { TableUiSnapshot, TimerView, UseResponseTimer } from "./types";

// The response timer's hook (design §12). The state lives in a ref and runs through timerReducer;
// React state changes only when the phase or the key does, and the countdown's progress goes to the
// table's store ten times a second, where the bar and the Continue ring read it without
// re-rendering the screen. Anything the player does while the timer is live stops it for that
// moment, so nobody is passed for while acting: a key, a press on a control, a menu, a drawer, a
// dialog or a drag. T and Space are the timer's own keys, handled by the screen's key map (keys.ts),
// which calls stop().

/** Controls a press on which counts as acting. The Stop Timer button is left out: its own click
 * stops the timer, and engaging on the press would remove the button before that click lands. */
const CONTROLS = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "[contenteditable=true]",
  ...[
    "button",
    "checkbox",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "slider",
    "switch",
    "tab",
  ].map((role) => `[role=${role}]`),
].join(", ");
const STOP_BUTTON = "[data-timer-stop]";

const MODIFIERS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
  "Unidentified",
]);

/** Whether a key press is the player acting. Escape belongs to the screen's Escape chain (closing a
 * layer, stopping a pass) and modifiers alone do nothing. T and Space are left to keys.ts: if this
 * listener stopped the timer first, that one would find no running timer and let Space press the
 * focused Continue. Keys on the Stop Timer button reach its own click. */
export function keyEngages(event: KeyboardEvent): boolean {
  // Browsers' autofill sends keydown events without a key.
  if (typeof event.key !== "string") return false;
  if (event.key === "Escape" || MODIFIERS.has(event.key)) return false;
  if (event.target instanceof Element && event.target.closest(STOP_BUTTON))
    return false;
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
  const own =
    event.key === " " ||
    event.key === "Spacebar" ||
    event.key.toLowerCase() === "t";
  return !(plain && own);
}

/** Whether a press is on a control (hovering never counts, nor a press on the bare table). */
export function pointerEngages(event: Event): boolean {
  const target = event.target;
  return (
    target instanceof Element &&
    target.closest(CONTROLS) !== null &&
    target.closest(STOP_BUTTON) === null
  );
}

/** A menu, a drawer or a drag that opened or started since the last look. One already open when the
 * moment arrives does not count: a drawer can stay open for a whole game. */
function opened(before: TableUiSnapshot, after: TableUiSnapshot): boolean {
  return (
    (after.menu !== null && after.menu !== before.menu) ||
    (after.drawer !== null && after.drawer !== before.drawer) ||
    (after.drag !== null && before.drag === null)
  );
}

export const useResponseTimer: UseResponseTimer = (input, ui, onExpire) => {
  const state = useRef<TimerState>(TIMER_IDLE);
  const [view, setView] = useState<TimerView | null>(null);
  const store = useRef(ui);
  const expire = useRef(onExpire);
  useLayoutEffect(() => {
    store.current = ui;
    expire.current = onExpire;
  });

  const apply = useCallback((action: TimerAction) => {
    const before = state.current;
    const after = timerReducer(before, action);
    if (after === before) return;
    state.current = after;
    const next = timerView(after);
    if (after.key !== before.key || after.phase !== before.phase) setView(next);
    // Written after the React state, so anything the write sets off (an engagement) lands later.
    store.current.set({ timer: next });
    // Only a tick expires a running timer, so this fires once per key, outside rendering.
    if (before.phase === "running" && after.phase === "expired" && after.key)
      expire.current(after.key);
  }, []);

  // Every render hands the reducer the latest input, before anything can tick: a new prompt or a
  // command sent is applied as it is drawn, so the old key can never expire after it.
  useLayoutEffect(() => {
    apply({ type: "input", input, now: Date.now() });
  });

  // Publish on mount (StrictMode mounts twice) and clear on unmount, so the store never shows a
  // timer that nothing runs.
  useEffect(() => {
    ui.set({ timer: timerView(state.current) });
    return () => ui.set({ timer: null });
  }, [ui]);

  const phase = view?.phase ?? "idle";
  useEffect(() => {
    if (phase !== "arming" && phase !== "running") return;
    const id = window.setInterval(() => {
      // A dialog (the zoom, Concede, the stops) opened while the timer is live is the player acting,
      // and a modal one hides the countdown besides.
      if (document.querySelector("dialog[open]")) apply({ type: "engage" });
      else apply({ type: "tick", now: Date.now() });
    }, TIMER_TICK_MS);
    return () => window.clearInterval(id);
  }, [phase, apply]);

  const live = timerLive(phase);
  useEffect(() => {
    if (!live) return;
    const engage = () => apply({ type: "engage" });
    const onKey = (event: KeyboardEvent) => {
      if (keyEngages(event)) engage();
    };
    const onPointer = (event: PointerEvent) => {
      if (pointerEngages(event)) engage();
    };
    let seen = ui.get();
    const unsubscribe = ui.subscribe(() => {
      const now = ui.get();
      const acted = opened(seen, now);
      seen = now;
      if (acted) engage();
    });
    // Capture phase: a control that stops its own events still counts.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [live, ui, apply]);

  const stop = useCallback(() => apply({ type: "stop" }), [apply]);
  const engage = useCallback(() => apply({ type: "engage" }), [apply]);
  return useMemo(() => ({ view, stop, engage }), [view, stop, engage]);
};

/** Whether the tab is hidden or the window unfocused, for the timer input's hidden and blurred.
 * Focus is followed by its events alone: a page that never hears a blur counts as focused, so a
 * browser or test page that never reports focus cannot hold the timer for ever. */
export function useWindowAttention(): { hidden: boolean; blurred: boolean } {
  const [hidden, setHidden] = useState(
    () => document.visibilityState === "hidden",
  );
  const [blurred, setBlurred] = useState(false);
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    const onBlur = () => setBlurred(true);
    const onFocus = () => setBlurred(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return useMemo(() => ({ hidden, blurred }), [hidden, blurred]);
}
