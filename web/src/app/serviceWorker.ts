import { useSyncExternalStore } from "react";
import type { UpdateState } from "../game/table/types";
import { anyLiveGame } from "./liveGame";

// The service worker's registration and updates (v0.3.0, PWA03). A new version waits until a
// player asks for it in a shell tab, or leaves a game's table, and no game is live anywhere; the
// worker checks the live-game locks again before it takes over. A game tab never reloads by
// itself: it shows that an update is ready, and loads it on the player's next intended leave.

const CHECK_MS = 60 * 60 * 1000;
const RECHECK_MS = 30 * 1000;
/** After a leave, how long the game's own lock may take to go, and how often to look. */
const LEAVE_WAIT_MS = 1000;
const LEAVE_STEP_MS = 100;

let state: UpdateState = "none";
let registration: ServiceWorkerRegistration | null = null;
let worker: ServiceWorkerContainer | null = null;
/** A page already had a worker: a later controllerchange is an update, not the first install. */
let controlled = false;
/** This tab asked for the update, so it may reload when the new version takes over. */
let asked = false;
let recheck: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  if (next === state) return;
  state = next;
  if (next !== "deferred" && recheck !== undefined) {
    clearInterval(recheck);
    recheck = undefined;
  }
  for (const listener of listeners) listener();
}

function onGame(): boolean {
  return window.location.hash.startsWith("#game/");
}

/** Navigations and reloads go through here, so tests can watch them. */
export const page = {
  reload: () => window.location.reload(),
};

/** Only a production build on HTTPS (or localhost) has a worker; Vite's dev server has none. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !window.isSecureContext) return;
  if (!("serviceWorker" in navigator)) return;
  void watchServiceWorker(navigator.serviceWorker);
}

export async function watchServiceWorker(
  container: ServiceWorkerContainer,
): Promise<void> {
  if (worker) return;
  worker = container;
  controlled = container.controller !== null;
  container.addEventListener("controllerchange", onControllerChange);
  container.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { type?: unknown }).type === "deferred"
    )
      defer();
  });
  let found: ServiceWorkerRegistration;
  try {
    found = await container.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
  } catch {
    return;
  }
  registration = found;
  const waiting = () => {
    if (found.waiting && container.controller && state === "none")
      set("available");
  };
  waiting();
  found.addEventListener("updatefound", () => {
    const installing = found.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed") waiting();
    });
  });
  const check = () => void found.update().catch(() => undefined);
  check();
  setInterval(check, CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    check();
    if (state === "deferred") void apply();
  });
}

function onControllerChange() {
  if (!controlled) {
    // The first install took over the open pages: nothing was replaced.
    controlled = true;
    return;
  }
  // A game tab keeps the old code until the player leaves the table (leaveTable below).
  if (asked && !onGame()) page.reload();
  else set("applied");
}

function defer() {
  set("deferred");
  recheck ??= setInterval(() => void apply(), RECHECK_MS);
}

/** Update: waits while a game is live in any tab; otherwise the waiting worker takes over. */
async function apply(): Promise<void> {
  const waiting = registration?.waiting;
  if (!waiting || state === "applying" || state === "applied") return;
  asked = true;
  if (await anyLiveGame()) {
    defer();
    return;
  }
  set("applying");
  waiting.postMessage({ type: "activate" });
}

/**
 * App calls this on an intended leave from a game, which is when the game screen's "Update ready:
 * it applies when you leave the table." comes true. True when a new version already took over:
 * the page reloads into it instead of drawing the next page with the old code. A version still
 * waiting is applied as if Update was pressed, so this tab reloads once it takes over.
 */
export function leaveTable(): boolean {
  if (state === "applied") {
    page.reload();
    return true;
  }
  if (state === "available" || state === "deferred") void applyAfterLeave();
  return false;
}

async function applyAfterLeave(): Promise<void> {
  // The game's own lock goes when its screen unmounts, a moment after the route changed. One
  // still held after that is another window's game, and apply() waits for it as ever.
  for (
    let waited = 0;
    waited < LEAVE_WAIT_MS && (await anyLiveGame());
    waited += LEAVE_STEP_MS
  )
    await new Promise((resolve) => setTimeout(resolve, LEAVE_STEP_MS));
  await apply();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppUpdate(): { state: UpdateState; apply(): Promise<void> } {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => "none" as const,
  );
  return { state: current, apply };
}
