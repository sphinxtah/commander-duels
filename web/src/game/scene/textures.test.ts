import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardFace } from "../Card";
import {
  RETRIES,
  knownMissing,
  rememberMissing,
  type TryAgain,
} from "../images";
import type { CardImageSize } from "../table/types";
import {
  LazyTextures,
  TextureCache,
  sourceFor,
  textureBudget,
  tierFor,
  type Decoded,
  type TextureAdapter,
} from "./textures";

const MB = 1024 * 1024;

interface Request {
  name: string;
  size: CardImageSize;
  signal: AbortSignal;
  resolve(value: Blob | "missing" | TryAgain): void;
  reject(error: unknown): void;
}

/** An adapter whose fetches wait until the test answers them. */
function fakeAdapter() {
  const requests: Request[] = [];
  const destroyed: string[] = [];
  const closed: string[] = [];
  const adapter: TextureAdapter<{ id: string }, Decoded & { id: string }> = {
    fetch: (name, size, o) =>
      new Promise((resolve, reject) =>
        requests.push({ name, size, signal: o.signal!, resolve, reject }),
      ),
    decode: async (_blob, width) => {
      const id = `${width}`;
      return {
        id,
        width,
        height: Math.round(width * 1.4),
        close: () => closed.push(id),
      };
    },
    create: (bitmap) => ({ id: bitmap.id }),
    destroy: (texture) => destroyed.push(texture.id),
  };
  return { adapter, requests, destroyed, closed };
}

const blob = () => new Blob(["image"]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Lets promise chains run without timers (for tests on fake timers). */
async function ticks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tiers and budget", () => {
  it("pick the smallest tier that covers the drawn width, never above large on the board", () => {
    expect(tierFor(10)).toBe(128);
    expect(tierFor(129)).toBe(192);
    expect(tierFor(488)).toBe(488);
    expect(tierFor(500)).toBe(672);
    expect(tierFor(2000)).toBe(672);
    expect(tierFor(2000, 745)).toBe(745);
  });

  it("decode each tier from the smallest Scryfall size that holds it", () => {
    expect(sourceFor(128)).toBe("normal");
    expect(sourceFor(488)).toBe("normal");
    expect(sourceFor(672)).toBe("large");
    expect(sourceFor(745)).toBe("png");
  });

  it("scale the budget with device memory, within 128 and 384 MB", () => {
    expect(textureBudget()).toBe(192 * MB);
    expect(textureBudget(1)).toBe(128 * MB);
    expect(textureBudget(8)).toBe(384 * MB);
  });
});

describe("the texture cache", () => {
  it("shares one texture by name and tier and counts who holds it", async () => {
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter);
    const a = cache.acquire("Forest", 256, 1);
    const b = cache.acquire("Forest", 256, 1);
    const other = cache.acquire("Forest", 384, 1);
    expect(requests.map((r) => `${r.name} ${r.size}`)).toEqual([
      "Forest normal",
      "Forest normal",
    ]);
    requests[0].resolve(blob());
    await settle();
    expect(cache.pump()).toBe(0);
    expect(a.state).toBe("ready");
    expect(b.texture).toBe(a.texture);
    expect(other.state).toBe("loading");
    a.release();
    expect(cache.stats.textures).toBe(1);
  });

  it("asks for at most six images at once, the hand before the board", async () => {
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter);
    for (let i = 0; i < 6; i++) cache.acquire(`Opponent ${i}`, 192, 3);
    cache.acquire("Tile", 128, 4);
    cache.acquire("Your land", 192, 1);
    cache.acquire("Hand card", 488, 0);
    expect(requests).toHaveLength(6);
    requests[0].resolve(blob());
    await settle();
    expect(requests.map((r) => r.name).slice(6)).toEqual(["Hand card"]);
    requests[1].resolve(blob());
    await settle();
    expect(requests.map((r) => r.name).slice(7)).toEqual(["Your land"]);
    expect(cache.stats.inFlight).toBe(6);
  });

  it("hands at most eight textures to the GPU a frame", async () => {
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter, { maxInFlight: 20 });
    const handles = Array.from({ length: 11 }, (_, i) =>
      cache.acquire(`Card ${i}`, 192, 1),
    );
    requests.forEach((r) => r.resolve(blob()));
    await settle();
    expect(cache.pump()).toBe(3);
    expect(handles.filter((h) => h.state === "ready")).toHaveLength(8);
    expect(cache.pump()).toBe(0);
    expect(handles.every((h) => h.state === "ready")).toBe(true);
  });

  it("tells a waiting card once its texture is ready", async () => {
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter);
    const handle = cache.acquire("Llanowar Elves", 256, 1);
    const listener = vi.fn();
    handle.onSettle(listener);
    requests[0].resolve(blob());
    await settle();
    expect(listener).not.toHaveBeenCalled();
    cache.pump();
    expect(listener).toHaveBeenCalledWith("ready");
  });

  it("stops asking when the last card lets go before the image arrives", async () => {
    const { adapter, requests, closed } = fakeAdapter();
    const cache = new TextureCache(adapter);
    const handle = cache.acquire("Shivan Dragon", 256, 1);
    handle.release();
    expect(requests[0].signal.aborted).toBe(true);
    // A late answer is thrown away, never decoded into a texture nobody holds.
    requests[0].resolve(blob());
    await settle();
    expect(cache.pump()).toBe(0);
    expect(cache.stats).toMatchObject({ textures: 0, pending: 0 });
    expect(closed).toEqual([]);
  });

  it("keeps unused textures within the budget, letting go of the oldest first", async () => {
    let now = 0;
    const { adapter, requests, destroyed } = fakeAdapter();
    // 256 × 358 × 4 bytes is about 0.35 MB a texture; the budget holds two.
    const cache = new TextureCache(adapter, {
      budget: 0.8 * MB,
      now: () => now,
    });
    const names = ["One", "Two", "Three"];
    const handles = names.map((name) => cache.acquire(name, 256, 1));
    requests.forEach((r) => r.resolve(blob()));
    await settle();
    cache.pump();
    now = 10;
    handles[1].release();
    now = 20;
    handles[0].release();
    now = 30;
    // Over budget with three: the oldest unused (Two) goes; One stays, Three is in use.
    cache.sweep();
    expect(destroyed).toEqual(["256"]);
    expect(cache.stats.textures).toBe(2);
    const again = cache.acquire("One", 256, 1);
    expect(again.state).toBe("ready");
  });

  it("lets go of a texture unused for a minute even within the budget", async () => {
    let now = 0;
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter, { now: () => now });
    const handle = cache.acquire("Island", 192, 1);
    requests[0].resolve(blob());
    await settle();
    cache.pump();
    handle.release();
    now = 59_000;
    cache.sweep();
    expect(cache.stats.textures).toBe(1);
    now = 60_000;
    cache.sweep();
    expect(cache.stats.textures).toBe(0);
  });

  it("never asks for a name images.ts remembers as missing", () => {
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter);
    rememberMissing("Treasure Token");
    const handle = cache.acquire("Treasure Token", 192, 1);
    expect(handle.state).toBe("missing");
    expect(requests).toHaveLength(0);
  });

  it("remembers a missing name where CardFace looks, and asks again after a failure", async () => {
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter);
    const missing = cache.acquire("Clue Token", 192, 1);
    const failing = cache.acquire("Mox Pearl", 192, 1);
    requests[0].resolve("missing");
    requests[1].reject(new Error("No image after 6 tries."));
    await settle();
    expect(missing.state).toBe("missing");
    expect(failing.state).toBe("failed");
    failing.release();
    cache.acquire("Mox Pearl", 192, 1);
    expect(requests).toHaveLength(3);
  });

  it("shares the missing memory with the DOM's card faces through images.ts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: async () => ({ code: "card_image_missing" }),
      })),
    );
    const { adapter } = fakeAdapter();
    const cache = new TextureCache({ ...adapter, fetch: undefined });
    const handle = cache.acquire("Spirit Token", 192, 1);
    await settle();
    await settle();
    expect(handle.state).toBe("missing");
    expect(knownMissing("Spirit Token")).toBe(true);
    const face = render(
      createElement(CardFace, {
        card: {
          id: "s",
          hidden: false,
          name: "Spirit Token",
          mana_cost: null,
          type_line: "Token Creature — Spirit",
          power: "1",
          toughness: "1",
          rules: ["Flying"],
        },
      }),
    );
    expect(face.container.querySelector("img")).toBeNull();
  });

  it("destroys everything it made and stops every fetch when disposed", async () => {
    const { adapter, requests, destroyed } = fakeAdapter();
    const cache = new TextureCache(adapter);
    cache.acquire("Plains", 192, 1);
    cache.acquire("Swamp", 192, 1);
    requests[0].resolve(blob());
    await settle();
    cache.pump();
    cache.dispose();
    expect(destroyed).toEqual(["192"]);
    expect(requests[1].signal.aborted).toBe(true);
  });

  it("never lets go of a texture a card still holds while it waits for the next tier", async () => {
    let now = 0;
    const { adapter, requests, destroyed } = fakeAdapter();
    const cache = new TextureCache(adapter, { now: () => now });
    const shown = cache.acquire("Forest", 192, 1);
    requests[0].resolve(blob());
    await settle();
    cache.pump();
    // The card wants a larger tier and keeps the one it shows until that one settles.
    const next = cache.acquire("Forest", 384, 1);
    now = 61_000;
    cache.sweep();
    expect(destroyed).toEqual([]);
    expect(shown.texture).not.toBeNull();
    requests[1].resolve(blob());
    await settle();
    cache.pump();
    expect(next.state).toBe("ready");
    shown.release();
    now = 122_000;
    cache.sweep();
    expect(destroyed).toEqual(["192"]);
  });

  it("counts bytes held elsewhere against its budget", async () => {
    const { adapter, requests, destroyed } = fakeAdapter();
    let other = 0;
    // One texture of about 0.35 MB fits alone; with 0.6 MB of frames it does not.
    const cache = new TextureCache(adapter, {
      budget: 0.8 * MB,
      otherBytes: () => other,
    });
    const unused = cache.acquire("Plains", 256, 1);
    requests[0].resolve(blob());
    await settle();
    cache.pump();
    unused.release();
    cache.sweep();
    expect(destroyed).toEqual([]);
    other = 0.6 * MB;
    cache.sweep();
    expect(destroyed).toEqual(["256"]);
  });
});

describe("trying a failed image again", () => {
  it("waits outside the six in flight, so other cards are asked for meanwhile", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter, { now: () => Date.now() });
    for (let i = 0; i < 6; i++) cache.acquire(`Busy ${i}`, 192, 3);
    for (const r of requests) r.resolve({ retryAfter: 0 });
    await ticks();
    expect(cache.stats).toMatchObject({ inFlight: 0, pending: 6 });
    // A card drawn into the hand now is asked for at once.
    cache.acquire("Hand card", 488, 0);
    expect(requests.map((r) => r.name).slice(6)).toEqual(["Hand card"]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(requests).toHaveLength(7);
    // CardFace's first backoff later, the waiting cards try again, as many as fit.
    await vi.advanceTimersByTimeAsync(1);
    expect(requests.map((r) => r.name).slice(7)).toEqual([
      "Busy 0",
      "Busy 1",
      "Busy 2",
      "Busy 3",
      "Busy 4",
    ]);
    expect(cache.stats.inFlight).toBe(6);
  });

  it("waits at least as long as the server asks", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter, { now: () => Date.now() });
    cache.acquire("Mox Ruby", 192, 1);
    requests[0].resolve({ retryAfter: 30 });
    await ticks();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(2);
  });

  it("gives up after as many tries as CardFace", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter, { now: () => Date.now() });
    const handle = cache.acquire("Time Walk", 192, 1);
    for (let i = 0; i <= RETRIES; i++) {
      requests[i].resolve({ retryAfter: 0 });
      await ticks();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(requests).toHaveLength(RETRIES + 1);
    expect(handle.state).toBe("failed");
    expect(cache.stats.pending).toBe(0);
  });

  it("stops waiting when the last card lets go", async () => {
    vi.useFakeTimers();
    const { adapter, requests } = fakeAdapter();
    const cache = new TextureCache(adapter, { now: () => Date.now() });
    const handle = cache.acquire("Ancestral Recall", 192, 1);
    requests[0].resolve({ retryAfter: 0 });
    await ticks();
    handle.release();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests).toHaveLength(1);
    expect(cache.stats.pending).toBe(0);
  });
});

describe("lazily made textures", () => {
  function lazyTextures(o: { budget?: number; other?: () => number } = {}) {
    const clock = { now: 0 };
    const made: string[] = [];
    const destroyed: string[] = [];
    const lazy = new LazyTextures<string>({
      destroy: (texture) => destroyed.push(texture),
      bytes: () => 100,
      now: () => clock.now,
      budget: o.budget ?? 10_000,
      otherBytes: o.other,
    });
    const make = (key: string) => () => {
      clock.now += 3;
      made.push(key);
      return key;
    };
    return { lazy, clock, made, destroyed, make };
  }

  it("make a few a frame within a time budget, at least one", () => {
    const { lazy, made, make } = lazyTextures();
    const handles = ["a", "b", "c"].map((key) => lazy.acquire(key, make(key)));
    expect(handles.map((h) => h.texture)).toEqual([null, null, null]);
    expect(lazy.pump(5)).toBe(1);
    expect(made).toEqual(["a", "b"]);
    expect(handles[0].texture).toBe("a");
    expect(lazy.acquire("a", make("again")).texture).toBe("a");
    expect(lazy.pump(1)).toBe(0);
    expect(made).toEqual(["a", "b", "c"]);
    expect(lazy.bytesHeld).toBe(300);
  });

  it("let go of one no card has shown for a minute", () => {
    const { lazy, clock, destroyed, make } = lazyTextures();
    const a = lazy.acquire("a", make("a"));
    const b = lazy.acquire("b", make("b"));
    lazy.pump(10);
    a.release();
    clock.now += 59_000;
    lazy.sweep();
    expect(destroyed).toEqual([]);
    clock.now += 1_000;
    lazy.sweep();
    expect(destroyed).toEqual(["a"]);
    expect(b.texture).toBe("b");
    expect(lazy).toMatchObject({ size: 1, bytesHeld: 100 });
  });

  it("let go of the oldest unused while a budget shared with the images is spent", () => {
    let other = 0;
    const { lazy, clock, destroyed, make } = lazyTextures({
      budget: 250,
      other: () => other,
    });
    const [a, b, c] = ["a", "b", "c"].map((key) =>
      lazy.acquire(key, make(key)),
    );
    lazy.pump(100);
    // Over the budget, but every one is in use.
    expect(destroyed).toEqual([]);
    clock.now = 100;
    b.release();
    clock.now = 200;
    a.release();
    lazy.sweep();
    expect(destroyed).toEqual(["b"]);
    other = 100;
    lazy.sweep();
    expect(destroyed).toEqual(["b", "a"]);
    expect(c.texture).toBe("c");
  });

  it("never make one nobody wants any more", () => {
    const { lazy, made, make } = lazyTextures();
    lazy.acquire("x", make("x")).release();
    expect(lazy.pending).toBe(0);
    lazy.pump(10);
    expect(made).toEqual([]);
  });
});
