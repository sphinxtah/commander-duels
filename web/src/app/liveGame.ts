import { useSyncExternalStore } from "react";
import type { LiveGameApi } from "../game/table/types";

// A live game's page is never reloaded by an update, nor taken away by a link (v0.3.0, PWA03).
// While a game is live, its tab holds a Web Lock named cd-live-game:<id>. The browser releases
// a lock when its tab closes or crashes, so a lost tab never blocks an update for good. The page's
// Update button and the service worker both check the locks; the worker cannot import this file,
// so src/pwa/swRules.ts repeats the prefix.

export const LIVE_GAME_LOCK = "cd-live-game:";
const GAME_HASH = /^#game\/([0-9a-f-]{36})$/i;
/** How long a markIntendedLeave() lets the next route change through. */
const INTENT_MS = 2000;
const NOTICE_MS = 8000;
export const STILL_ON =
  "Your game is still on. Leave it with Table in the game menu.";

/** Game id → holders in this tab (StrictMode and remounts can overlap). */
const holders = new Map<string, number>();
let intendedAt = Number.NEGATIVE_INFINITY;
let notice: string | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function locks(): LockManager | undefined {
  return (navigator as Partial<Navigator>).locks;
}

function setNotice(text: string | null) {
  clearTimeout(noticeTimer);
  notice = text;
  if (text) noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
  for (const listener of listeners) listener();
}

/** Holds the game's lock until the returned function is called. Shared: two tabs may both hold it. */
export const holdLiveGame: LiveGameApi["holdLiveGame"] = (gameId) => {
  const id = gameId.toLowerCase();
  holders.set(id, (holders.get(id) ?? 0) + 1);
  let released = false;
  let release: (() => void) | null = null;
  const abort = new AbortController();
  void locks()
    ?.request(
      LIVE_GAME_LOCK + id,
      { mode: "shared", signal: abort.signal },
      () =>
        new Promise<void>((resolve) => {
          if (released) resolve();
          else release = resolve;
        }),
    )
    // An abort before the lock was granted lands here, and so does a browser without the API.
    .catch(() => undefined);
  return () => {
    if (released) return;
    released = true;
    const left = (holders.get(id) ?? 1) - 1;
    if (left > 0) holders.set(id, left);
    else holders.delete(id);
    if (release) release();
    else abort.abort();
  };
};

/** In-game links ("Table", "Back to the table") call this just before they navigate. */
export const markIntendedLeave: LiveGameApi["markIntendedLeave"] = () => {
  intendedAt = Date.now();
  if (notice) setNotice(null);
};

export function isLiveHere(gameId: string): boolean {
  return holders.has(gameId.toLowerCase());
}

/** Whether any tab or window of this site holds a live game. Without Web Locks, assume one does. */
export async function anyLiveGame(): Promise<boolean> {
  const manager = locks();
  if (!manager) return true;
  try {
    const { held = [] } = await manager.query();
    return held.some((lock) => lock.name?.startsWith(LIVE_GAME_LOCK));
  } catch {
    return true;
  }
}

/**
 * App's hashchange handler asks this first. When the change left a game that is live in this tab
 * and no in-game link marked it, the game's address is put back (replaceState fires no
 * hashchange), the game screen says why, and this returns true: App then changes nothing. It
 * catches the browser's Back and the installed app's launch (navigate-existing to #home).
 */
export function guardLiveGame(oldURL: string): boolean {
  let hash: string;
  try {
    hash = new URL(oldURL).hash;
  } catch {
    return false;
  }
  const id = GAME_HASH.exec(hash)?.[1]?.toLowerCase();
  if (!id || !holders.has(id)) return false;
  if (GAME_HASH.exec(window.location.hash)?.[1]?.toLowerCase() === id)
    return false;
  if (Date.now() - intendedAt <= INTENT_MS) {
    intendedAt = Number.NEGATIVE_INFINITY;
    return false;
  }
  history.replaceState(history.state, "", hash);
  setNotice(STILL_ON);
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The status the game screen shows after the guard kept it, for a few seconds. */
export function useLiveGameNotice(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => notice,
    () => null,
  );
}
