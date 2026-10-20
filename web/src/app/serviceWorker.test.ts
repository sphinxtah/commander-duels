import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Updates that never reload a live game (design §18.3), with a made-up registration: the
// container, a waiting worker, and Web Locks whose held list the test sets. Each test loads the
// module afresh, as a new page would.
type Module = typeof import("./serviceWorker");

let held: { name: string }[] = [];
let worker: Module;
let container: EventTarget & { controller: object | null };
let register: ReturnType<typeof vi.fn>;
let postMessage: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;

async function start({ controlled = true } = {}) {
  vi.resetModules();
  worker = await import("./serviceWorker");
  reload = vi.fn();
  worker.page.reload = reload as () => void;
  postMessage = vi.fn();
  const registration = Object.assign(new EventTarget(), {
    waiting: { postMessage },
    installing: null,
    update: vi.fn(async () => undefined),
  });
  register = vi.fn(async () => registration);
  container = Object.assign(new EventTarget(), {
    controller: controlled ? {} : null,
    register,
  });
  await worker.watchServiceWorker(
    container as unknown as ServiceWorkerContainer,
  );
  const update = renderHook(() => worker.useAppUpdate());
  return { registration, update };
}

function controllerChange() {
  act(() => void container.dispatchEvent(new Event("controllerchange")));
}

beforeEach(() => {
  vi.useFakeTimers();
  held = [];
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { query: async () => ({ held: [...held] }) },
  });
  window.location.hash = "#play";
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "locks");
});

describe("an update", () => {
  it("registers /sw.js for the whole site and checks for a new one hourly", async () => {
    const { registration } = await start();
    expect(register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(registration.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("waits while any tab holds a live game, and applies once none does", async () => {
    const { update } = await start();
    expect(update.result.current.state).toBe("available");
    held = [{ name: "cd-live-game:abc" }];
    await act(() => update.result.current.apply());
    expect(update.result.current.state).toBe("deferred");
    expect(postMessage).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(postMessage).not.toHaveBeenCalled();
    held = [];
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(postMessage).toHaveBeenCalledWith({ type: "activate" });
    expect(update.result.current.state).toBe("applying");

    // The worker found a game started meanwhile: back to waiting.
    act(
      () =>
        void container.dispatchEvent(
          new MessageEvent("message", { data: { type: "deferred" } }),
        ),
    );
    expect(update.result.current.state).toBe("deferred");
  });

  it("reloads the shell tab that asked for it once the new version takes over", async () => {
    const { update } = await start();
    await act(() => update.result.current.apply());
    expect(postMessage).toHaveBeenCalledTimes(1);
    controllerChange();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("only tells other shell tabs, and never reloads a game tab by itself", async () => {
    const shell = await start();
    controllerChange();
    expect(reload).not.toHaveBeenCalled();
    expect(shell.update.result.current.state).toBe("applied");

    window.location.hash = "#game/00000000-0000-4000-8000-0000000000aa";
    const game = await start();
    controllerChange();
    await act(() => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
    expect(reload).not.toHaveBeenCalled();
    expect(game.update.result.current.state).toBe("applied");
    // The player's next intended leave loads the new version.
    window.location.hash = "#play";
    expect(worker.leaveTable()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("applies a waiting update when the player leaves the table, as the game screen said", async () => {
    window.location.hash = "#game/00000000-0000-4000-8000-0000000000aa";
    const { update } = await start();
    expect(update.result.current.state).toBe("available");
    // The game's own lock goes a moment after the route changes, when its screen unmounts.
    held = [{ name: "cd-live-game:00000000-0000-4000-8000-0000000000aa" }];
    window.location.hash = "#play";
    expect(worker.leaveTable()).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(postMessage).not.toHaveBeenCalled();
    held = [];
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(postMessage).toHaveBeenCalledWith({ type: "activate" });
    expect(update.result.current.state).toBe("applying");
    // This tab asked, on the way out: it reloads into the new version.
    controllerChange();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still waits for a game in another window after the player leaves this one's table", async () => {
    window.location.hash = "#game/00000000-0000-4000-8000-0000000000aa";
    const { update } = await start();
    held = [{ name: "cd-live-game:00000000-0000-4000-8000-0000000000bb" }];
    window.location.hash = "#play";
    expect(worker.leaveTable()).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(postMessage).not.toHaveBeenCalled();
    expect(update.result.current.state).toBe("deferred");
    // That game ends: the 30 s re-check applies it.
    held = [];
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(postMessage).toHaveBeenCalledWith({ type: "activate" });
  });

  it("treats the first install taking over the page as nothing new", async () => {
    const { update } = await start({ controlled: false });
    expect(update.result.current.state).toBe("none");
    controllerChange();
    expect(update.result.current.state).toBe("none");
    expect(worker.leaveTable()).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps focus on the notice when Update is pressed and its button goes", async () => {
    const { update } = await start();
    const { UpdateNotice } = await import("./UpdateNotice");
    render(createElement(UpdateNotice));
    held = [{ name: "cd-live-game:abc" }];
    const button = screen.getByRole("button", { name: "Update" });
    button.focus();
    fireEvent.click(button);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(update.result.current.state).toBe("deferred");
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(document.activeElement).toHaveTextContent(
      "A game is running in another window.",
    );
  });

  it("is never registered by the dev server or the tests", async () => {
    vi.resetModules();
    const fresh = await import("./serviceWorker");
    const spy = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: spy },
    });
    fresh.registerServiceWorker();
    expect(spy).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "serviceWorker");
  });
});
