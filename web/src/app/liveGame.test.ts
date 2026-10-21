import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STILL_ON,
  anyLiveGame,
  guardLiveGame,
  holdLiveGame,
  isLiveHere,
  markIntendedLeave,
  useLiveGameNotice,
} from "./liveGame";

// Web Locks as the browser keeps them: each request waits until the test grants it, and a held
// lock is listed until its callback's promise settles.
interface Request {
  name: string;
  mode?: string;
  grant(): Promise<void>;
}
let requests: Request[] = [];
let held: { name: string; mode: string }[] = [];
const locks = {
  request: vi.fn(
    (
      name: string,
      options: { mode?: string; signal?: AbortSignal },
      callback: () => Promise<void>,
    ) =>
      new Promise<void>((resolve, reject) => {
        options.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
        requests.push({
          name,
          mode: options.mode,
          async grant() {
            if (options.signal?.aborted) return;
            const lock = { name, mode: options.mode ?? "exclusive" };
            held.push(lock);
            await callback();
            held = held.filter((other) => other !== lock);
            resolve();
          },
        });
      }),
  ),
  query: vi.fn(async () => ({ held: [...held], pending: [] })),
};

const ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";

// The module keeps its holders for the whole file: every hold a test takes is let go after it,
// even when the test fails midway, so no game stays live for the tests after it.
let holds: (() => void)[] = [];
function hold(gameId: string) {
  const release = holdLiveGame(gameId);
  holds.push(release);
  return release;
}

beforeEach(() => {
  requests = [];
  held = [];
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
});
afterEach(() => {
  for (const release of holds.splice(0)) release();
  vi.clearAllMocks();
  Reflect.deleteProperty(navigator, "locks");
});

describe("a live game's lock", () => {
  it("is held, shared, while the game is live and released after", async () => {
    const release = hold(ID.toUpperCase());
    expect(locks.request).toHaveBeenCalledTimes(1);
    expect(requests[0]).toMatchObject({
      name: `cd-live-game:${ID}`,
      mode: "shared",
    });
    expect(isLiveHere(ID)).toBe(true);
    const granted = requests[0]!.grant();
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(await anyLiveGame()).toBe(true);

    release();
    await granted;
    expect(held).toEqual([]);
    expect(isLiveHere(ID)).toBe(false);
    expect(await anyLiveGame()).toBe(false);
    // Releasing twice changes nothing.
    release();
    expect(isLiveHere(ID)).toBe(false);
  });

  it("is never taken when the game ends before the browser grants it", async () => {
    const release = hold(ID);
    release();
    await requests[0]!.grant();
    expect(held).toEqual([]);
  });

  it("counts overlapping holders, as StrictMode's double mount makes", () => {
    const first = hold(ID);
    const second = hold(ID);
    first();
    expect(isLiveHere(ID)).toBe(true);
    second();
    expect(isLiveHere(ID)).toBe(false);
  });

  it("without Web Locks, every check assumes a game is live", async () => {
    Reflect.deleteProperty(navigator, "locks");
    expect(await anyLiveGame()).toBe(true);
    const release = hold(ID);
    expect(isLiveHere(ID)).toBe(true);
    release();
    locks.query.mockRejectedValueOnce(new Error("SecurityError"));
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: locks,
    });
    expect(await anyLiveGame()).toBe(true);
  });
});

describe("the route guard", () => {
  /** Moves from a game's address to another, as a link or Back would, and asks the guard. */
  function leave(from: string, to: string): boolean {
    window.location.hash = from;
    const oldURL = window.location.href;
    window.location.hash = to;
    return guardLiveGame(oldURL);
  }

  it("keeps a live game's address when nothing meant to leave it", () => {
    const release = hold(ID);
    const { result } = renderHook(() => useLiveGameNotice());
    let kept = false;
    act(() => {
      kept = leave(`#game/${ID}`, "#play");
    });
    expect(kept).toBe(true);
    expect(window.location.hash).toBe(`#game/${ID}`);
    expect(result.current).toBe(STILL_ON);
    // Another game's address is a way out too.
    expect(leave(`#game/${ID}`, `#game/${OTHER}`)).toBe(true);
    release();
  });

  it("lets an in-game link leave, once", () => {
    const release = hold(ID);
    markIntendedLeave();
    expect(leave(`#game/${ID}`, "#play")).toBe(false);
    expect(window.location.hash).toBe("#play");
    expect(leave(`#game/${ID}`, "#play")).toBe(true);
    release();
  });

  it("lets go of a game that is not live here, and of other pages", () => {
    expect(leave(`#game/${ID}`, "#play")).toBe(false);
    const release = hold(ID);
    expect(leave(`#game/${OTHER}`, "#play")).toBe(false);
    expect(leave("#settings", "#play")).toBe(false);
    release();
    expect(leave(`#game/${ID}`, "#decks")).toBe(false);
    expect(guardLiveGame("not a url")).toBe(false);
  });

  it("clears its notice after a while, or on an intended leave", () => {
    vi.useFakeTimers();
    try {
      const release = hold(ID);
      const { result } = renderHook(() => useLiveGameNotice());
      act(() => void leave(`#game/${ID}`, "#play"));
      expect(result.current).toBe(STILL_ON);
      act(() => void vi.advanceTimersByTime(8000));
      expect(result.current).toBeNull();
      act(() => void leave(`#game/${ID}`, "#play"));
      act(() => markIntendedLeave());
      expect(result.current).toBeNull();
      // The leave it marked goes through. Left unused, it would let the next tests' leaves
      // through too: marked on this fake clock, 8 seconds ahead, it stays "just now" for them.
      expect(leave(`#game/${ID}`, "#play")).toBe(false);
      release();
    } finally {
      vi.useRealTimers();
    }
  });
});
