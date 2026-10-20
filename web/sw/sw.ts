// The service worker (v0.3.0, PWA01 and PWA03), built to /sw.js by web/plugins/pwa.ts. It keeps
// the shell for the installed app and for offline page loads; it never answers for the API, other
// hosts or anything but a GET (src/pwa/swRules.ts), and the game's WebSocket never reaches it.
// A new version waits: it takes over only when a page asks and no game is live in any tab.
import {
  SHELL_CACHE_PREFIX,
  cachesToDelete,
  liveGameHeld,
  routeRequest,
} from "../src/pwa/swRules";

declare const self: ServiceWorkerGlobalScope;

// The build writes in the version and the list of files to keep, and fails if either is missing.
const VERSION: string = "__CD_SW_VERSION__";
const PRECACHE = "__CD_PRECACHE__" as unknown as string[];
const CACHE = `${SHELL_CACHE_PREFIX}${VERSION}`;
/** A page load waits this long for the network before the cached shell answers. */
const SHELL_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  // no-cache: the precache must be this build's files, not whatever the HTTP cache kept. Never
  // skipWaiting here: a live game's page keeps the version it started with.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(
          PRECACHE.map((url) => new Request(url, { cache: "no-cache" })),
        ),
      ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const first = !keys.some(
        (key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== CACHE,
      );
      await Promise.all(
        cachesToDelete(keys, CACHE).map((key) => caches.delete(key)),
      );
      // The first install has no older version to disturb, so it controls the open pages at once.
      // Later versions only ever take over through skipWaiting below, which a page asks for.
      if (first) await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { type?: unknown }).type !== "activate"
  )
    return;
  event.waitUntil(
    (async () => {
      // The page checked already; a game may have started since, in this or another window.
      if (await anyLiveGame()) event.source?.postMessage({ type: "deferred" });
      else await self.skipWaiting();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const route = routeRequest(request, self.location.origin);
  if (route === "pass") return;
  if (route === "shell") event.respondWith(shell(request));
  else if (route === "asset") event.respondWith(asset(event, request));
  else event.respondWith(brand(event, request));
});

/** Without Web Locks, a game counts as live: the update then waits for every page to close. */
async function anyLiveGame(): Promise<boolean> {
  const locks = (self.navigator as Partial<WorkerNavigator>).locks;
  if (!locks) return true;
  try {
    const { held = [] } = await locks.query();
    return liveGameHeld(held);
  } catch {
    return true;
  }
}

/** Looks in this version's cache first, then in the previous one that is still kept. */
async function cached(
  request: Request | string,
): Promise<Response | undefined> {
  const own = await caches.match(request, { cacheName: CACHE });
  if (own) return own;
  for (const key of await caches.keys()) {
    if (!key.startsWith(SHELL_CACHE_PREFIX) || key === CACHE) continue;
    const found = await caches.match(request, { cacheName: key });
    if (found) return found;
  }
  return undefined;
}

async function shell(request: Request): Promise<Response> {
  const network = fetch(request);
  // A late failure after the timeout has nobody waiting for it.
  network.catch(() => undefined);
  const timeout = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), SHELL_TIMEOUT_MS),
  );
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch {
    // Offline: the cached shell below.
  }
  // Every route is a hash on "/", so the cached "/" is the whole shell. Without one, the slow
  // network is still the only answer.
  return (await cached("/")) ?? network;
}

async function asset(event: FetchEvent, request: Request): Promise<Response> {
  const hit = await cached(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Build files are named by their hash, so a fetched one can join this version's cache.
  if (response.ok) {
    const copy = response.clone();
    event.waitUntil(
      caches.open(CACHE).then((cache) => cache.put(request, copy)),
    );
  }
  return response;
}

async function brand(event: FetchEvent, request: Request): Promise<Response> {
  const refresh = fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(
        caches.open(CACHE).then((cache) => cache.put(request, copy)),
      );
    }
    return response;
  });
  // The page gets the kept copy at once; the refreshed one is for its next load.
  event.waitUntil(refresh.catch(() => undefined));
  return (await cached(request)) ?? refresh;
}
