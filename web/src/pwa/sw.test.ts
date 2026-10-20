import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The worker itself (web/sw/sw.ts), loaded into a fake worker scope. Its placeholders are not
// written in outside a build, so its cache is cd-shell-__CD_SW_VERSION__ here.
const CACHE = "cd-shell-__CD_SW_VERSION__";
const origin = "https://duels.example";

type Handler = (event: unknown) => void;
const handlers = new Map<string, Handler>();
const store = new Map<string, Map<string, Response>>();
let locks: { query(): Promise<{ held?: { name?: string }[] }> } | undefined;
const claim = vi.fn(async () => undefined);
const skipWaiting = vi.fn(async () => undefined);
const network = vi.fn<(request: unknown) => Promise<Response>>();

const scope = {
  location: { origin },
  get navigator() {
    return { locks };
  },
  clients: { claim },
  skipWaiting,
  addEventListener: (type: string, handler: Handler) =>
    handlers.set(type, handler),
};
const caches = {
  open: async (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const cache = store.get(name)!;
    return {
      addAll: async () => undefined,
      put: async (request: { url: string }, response: Response) =>
        void cache.set(request.url, response),
    };
  },
  keys: async () => [...store.keys()],
  delete: async (name: string) => store.delete(name),
  match: async (
    request: string | { url: string },
    options?: { cacheName?: string },
  ) => {
    const url = typeof request === "string" ? request : request.url;
    return options?.cacheName
      ? store.get(options.cacheName)?.get(url)
      : undefined;
  },
};

function fetchEvent(method: string, path: string, mode = "cors") {
  const url = path.startsWith("http") ? path : `${origin}${path}`;
  return {
    request: { method, url, mode },
    respondWith: vi.fn(),
    waitUntil: vi.fn(),
  };
}

beforeAll(async () => {
  vi.stubGlobal("self", scope);
  vi.stubGlobal("caches", caches);
  vi.stubGlobal("fetch", network);
  // A path the type check does not follow: the worker is checked on its own (tsc -p sw).
  const worker = "../../sw/sw.ts";
  await import(/* @vite-ignore */ worker);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  store.clear();
  locks = undefined;
  claim.mockClear();
  skipWaiting.mockClear();
  network.mockReset();
});

describe("the service worker", () => {
  it("never answers the API, other hosts or anything but a GET", () => {
    const fetch = handlers.get("fetch")!;
    for (const event of [
      fetchEvent("GET", "/api/v1/me"),
      fetchEvent("GET", "/api/v1/games/1/events"),
      fetchEvent("GET", "/api/v1/me", "navigate"),
      fetchEvent("POST", "/api/v1/practice-games"),
      fetchEvent("POST", "/", "navigate"),
      fetchEvent("PATCH", "/assets/index-abc.js"),
      fetchEvent("GET", "https://accounts.google.com/gsi/client"),
      fetchEvent("GET", "https://accounts.google.com/gsi/", "navigate"),
      fetchEvent("GET", "/sw.js"),
    ]) {
      fetch(event);
      expect(event.respondWith).not.toHaveBeenCalled();
      expect(event.waitUntil).not.toHaveBeenCalled();
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("loads pages from the network, and from the kept shell when offline", async () => {
    const fetch = handlers.get("fetch")!;
    const page = new Response("network page");
    network.mockResolvedValueOnce(page);
    const online = fetchEvent("GET", "/", "navigate");
    fetch(online);
    expect(await online.respondWith.mock.calls[0]![0]).toBe(page);

    const shell = new Response("kept shell");
    (await caches.open(CACHE)).put({ url: "/" }, shell);
    network.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const offline = fetchEvent("GET", "/", "navigate");
    fetch(offline);
    expect(await offline.respondWith.mock.calls[0]![0]).toBe(shell);
  });

  it("serves build files from any kept version before the network", async () => {
    const fetch = handlers.get("fetch")!;
    const chunk = new Response("chunk");
    (await caches.open("cd-shell-0.2.0+old")).put(
      { url: `${origin}/assets/scene-old.js` },
      chunk,
    );
    const event = fetchEvent("GET", "/assets/scene-old.js");
    fetch(event);
    expect(await event.respondWith.mock.calls[0]![0]).toBe(chunk);
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps the newest older version and claims pages only on its first install", async () => {
    const activate = handlers.get("activate")!;
    const run = async () => {
      const event = { waitUntil: vi.fn() };
      activate(event);
      await event.waitUntil.mock.calls[0]![0];
    };
    await run();
    expect(claim).toHaveBeenCalledTimes(1);

    claim.mockClear();
    for (const name of ["cd-shell-a", "cd-shell-b", CACHE])
      await caches.open(name);
    await run();
    expect([...store.keys()]).toEqual(["cd-shell-b", CACHE]);
    expect(claim).not.toHaveBeenCalled();
  });

  it("takes over when asked only if no game is live in any tab", async () => {
    const message = handlers.get("message")!;
    const ask = async () => {
      const event = {
        data: { type: "activate" },
        source: { postMessage: vi.fn() },
        waitUntil: vi.fn(),
      };
      message(event);
      await event.waitUntil.mock.calls[0]![0];
      return event.source.postMessage;
    };

    locks = {
      query: async () => ({ held: [{ name: "cd-live-game:abc" }] }),
    };
    expect(await ask()).toHaveBeenCalledWith({ type: "deferred" });
    expect(skipWaiting).not.toHaveBeenCalled();

    // Without Web Locks a game may be live, so the update still waits.
    locks = undefined;
    expect(await ask()).toHaveBeenCalledWith({ type: "deferred" });
    expect(skipWaiting).not.toHaveBeenCalled();

    locks = { query: async () => ({ held: [{ name: "other" }] }) };
    expect(await ask()).not.toHaveBeenCalled();
    expect(skipWaiting).toHaveBeenCalledTimes(1);

    // Anything else is ignored.
    const other = { data: "activate", waitUntil: vi.fn() };
    message(other);
    expect(other.waitUntil).not.toHaveBeenCalled();
  });
});
