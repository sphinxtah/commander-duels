import { useSyncExternalStore } from "react";
import type { UpdateState } from "../game/table/types";
import { anyLiveGame } from "./liveGame";

// The service worker's registration and updates (v0.3.0, PWA03). A new version waits until a
// player asks for it in a shell tab and no game is live anywhere; the worker checks the live-game
// locks again before it takes over. A game tab never reloads by itself: it shows that an update
// is ready, and reloads on the player's next intended leave.

const CHECK_MS = 60 * 60 * 1000;
const RECHECK_MS = 30 * 1000;

let state: UpdateState = "none";
let registration: ServiceWorkerRegistration | null = null;
let worker: ServiceWorkerContainer | null = null;
/** A page already had a worker: a later controllerchange is an update, not the first install. */
let controlled = false;
/** This tab asked for the update, so it may reload when the new version takes over. */
let asked = false;
let reloadOnLeave = false;
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
  if (onGame()) {
    reloadOnLeave = true;
    set("applied");
  } else if (asked) page.reload();
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
 * App calls this on an intended leave from a game. True when a new version took over during the
 * game: the page reloads into it instead of drawing the next page with the old code.
 */
export function reloadIfUpdated(): boolean {
  if (!reloadOnLeave) return false;
  page.reload();
  return true;
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
