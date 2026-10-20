import { useMemo, useSyncExternalStore } from "react";
import type { FullscreenState } from "../game/table/types";

// Full screen for the table (v0.3.0). Browsers grant requestFullscreen only inside the click or
// key press that asked for it, so every entry point calls it synchronously, before anything is
// awaited. The whole page goes full screen (the root element, not the table), so dialogs and
// notices stay visible. Keyboard Lock (Chrome and Edge) hands Escape to the game: it then closes
// the game's own menus, and holding it for two seconds still leaves full screen.

interface KeyboardLock {
  lock?(keys?: string[]): Promise<void>;
  unlock?(): void;
}

let enteredByUs = false;
let escapeLocked = false;
let watching = false;
const listeners = new Set<() => void>();

function keyboard(): KeyboardLock | undefined {
  return (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
}

function active(): boolean {
  return Boolean(document.fullscreenElement);
}

function notify() {
  for (const listener of listeners) listener();
}

function lockEscape() {
  const request = keyboard()?.lock?.(["Escape"]);
  if (!request) return;
  request.then(
    () => {
      escapeLocked = active();
      notify();
    },
    () => undefined,
  );
}

function unlockEscape() {
  try {
    keyboard()?.unlock?.();
  } catch {
    // Nothing was locked.
  }
  escapeLocked = false;
}

/** Leaving full screen by any way (held Escape, the browser's own controls) ends our claim on it. */
function onChange() {
  if (active()) {
    if (enteredByUs) lockEscape();
  } else {
    enteredByUs = false;
    unlockEscape();
  }
  notify();
}

function watch() {
  if (watching) return;
  watching = true;
  document.addEventListener("fullscreenchange", onChange);
}

export function canFullscreen(): boolean {
  return (
    document.fullscreenEnabled === true &&
    typeof document.documentElement.requestFullscreen === "function"
  );
}

/**
 * Asks for full screen at once (requestFullscreen is called before this returns), then locks
 * Escape. Resolves false when the browser refuses; the table then plays in the window.
 */
export function enterTableFullscreen(): Promise<boolean> {
  if (!canFullscreen()) return Promise.resolve(false);
  watch();
  if (active()) return Promise.resolve(true);
  let request: Promise<void> | undefined;
  try {
    request = document.documentElement.requestFullscreen({
      navigationUI: "hide",
    });
  } catch {
    return Promise.resolve(false);
  }
  return Promise.resolve(request).then(
    () => {
      enteredByUs = true;
      lockEscape();
      notify();
      return true;
    },
    () => false,
  );
}

/** Leaves full screen only if the table entered it; a player's own full screen stays. */
export async function exitTableFullscreen(): Promise<void> {
  if (!enteredByUs) return;
  enteredByUs = false;
  await leave();
}

async function leave() {
  unlockEscape();
  if (active() && typeof document.exitFullscreen === "function")
    await document.exitFullscreen().catch(() => undefined);
  notify();
}

function toggle() {
  if (active()) {
    enteredByUs = false;
    void leave();
  } else void enterTableFullscreen();
}

type Snapshot = Omit<FullscreenState, "toggle">;
let snapshot: Snapshot = {
  available: false,
  active: false,
  escapeLocked: false,
  enteredByUs: false,
};

function read(): Snapshot {
  const next: Snapshot = {
    available: canFullscreen(),
    active: active(),
    escapeLocked: escapeLocked && active(),
    enteredByUs,
  };
  if (
    next.available !== snapshot.available ||
    next.active !== snapshot.active ||
    next.escapeLocked !== snapshot.escapeLocked ||
    next.enteredByUs !== snapshot.enteredByUs
  )
    snapshot = next;
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  watch();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The state for the HUD button, the Game menu and the F key; toggle works whatever the setting. */
export function useFullscreen(): FullscreenState {
  const state = useSyncExternalStore(subscribe, read, () => snapshot);
  return useMemo(() => ({ ...state, toggle }), [state]);
}
