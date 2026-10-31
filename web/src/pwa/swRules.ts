// What the service worker does with each request (v0.3.0, PWA03). Pure, so its tests need no
// worker. Only the worker (web/sw/sw.ts) and the tests import this file: if the app imported it
// too, the bundler would split it into a chunk both share, and the worker must be one file with no
// imports (web/plugins/pwa.ts fails the build otherwise).

/**
 * "pass": the worker leaves the request to the browser and never calls respondWith. "shell": a
 * page load, network first. "asset": a hashed build file, cache first. "brand": an image under
 * /brand/ or the manifest, from the cache while it refreshes.
 */
export type SwRoute = "pass" | "shell" | "asset" | "brand";

/** Every cache of the site's files; the rest of the name is the build's version. */
export const SHELL_CACHE_PREFIX = "cd-shell-";
/** One entry in its own cache: the name of the shell cache whose version is active. */
export const ACTIVE_CACHE = "cd-meta";
export const ACTIVE_KEY = "/cd-active-version";
/** app/liveGame.ts holds a Web Lock under this prefix while a game is live; it cannot be imported here. */
export const LIVE_GAME_LOCK_PREFIX = "cd-live-game:";
/**
 * The public pages (v0.4.1), plain HTML that nginx serves at these addresses from public/pages/.
 * They are not the app, so the worker never answers for them, not even with the kept shell when
 * offline, and the build leaves their folder out of the precache (plugins/pwa.ts).
 */
export const PUBLIC_PAGES = ["/about", "/privacy", "/terms"];
export const PUBLIC_PAGES_FOLDER = "/pages/";

export function routeRequest(
  r: { method: string; url: string; mode: string },
  origin: string,
): SwRoute {
  // Commands, sign-in posts and anything else that changes state go to the server untouched.
  if (r.method !== "GET") return "pass";
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    return "pass";
  }
  // Google's sign-in script and frames, and any other host.
  if (url.origin !== origin) return "pass";
  const path = url.pathname;
  // The API answers for itself, offline included, so nothing under it is ever cached or faked.
  if (path === "/api" || path.startsWith("/api/")) return "pass";
  // The browser checks the worker's own script for updates; nginx serves it with no-cache.
  if (path === "/sw.js") return "pass";
  // The public pages and their stylesheet come from the server as they are, like any other site.
  if (PUBLIC_PAGES.includes(path) || path.startsWith(PUBLIC_PAGES_FOLDER))
    return "pass";
  if (r.mode === "navigate") return "shell";
  if (path.startsWith("/assets/")) return "asset";
  if (path.startsWith("/brand/") || path === "/manifest.webmanifest")
    return "brand";
  // Everything else, the pictures the HTTP cache keeps and the gameplay music (v0.7.2, a stream of
  // tens of megabytes that no cache should hold) among it.
  return "pass";
}

/**
 * The caches to delete when a version activates: every other shell but the one of the version it
 * replaces (`previous`, null on the first install), which pages still running that version may
 * need for their lazy chunks. Not the newest older cache: a version that installed and was
 * superseded while it waited made one too, and no page ever ran it.
 */
export function cachesToDelete(
  keys: string[],
  current: string,
  previous: string | null,
): string[] {
  return keys.filter(
    (key) =>
      key.startsWith(SHELL_CACHE_PREFIX) && key !== current && key !== previous,
  );
}

/** True when any tab holds a live game's lock (navigator.locks.query()'s held list). */
export function liveGameHeld(held: { name?: string }[]): boolean {
  return held.some((lock) => lock.name?.startsWith(LIVE_GAME_LOCK_PREFIX));
}
