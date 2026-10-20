import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client, type Me } from "../api";
import { PracticeTable } from "../game/PracticeTable";
import {
  DEFAULT_TABLE_SETTINGS,
  TABLE_SETTINGS_KEY,
} from "../game/table/types";
import {
  canFullscreen,
  enterTableFullscreen,
  exitTableFullscreen,
  useFullscreen,
} from "./fullscreen";

// jsdom has no Fullscreen API or Keyboard Lock: these stand in for Chrome's.
let element: Element | null = null;
let pending: (() => void) | null = null;
const changed = () => document.dispatchEvent(new Event("fullscreenchange"));
const requestFullscreen = vi.fn(
  (_options?: FullscreenOptions) =>
    new Promise<void>((resolve) => {
      pending = () => {
        element = document.documentElement;
        changed();
        resolve();
      };
    }),
);
const exitFullscreen = vi.fn(async () => {
  element = null;
  changed();
});
const keyboard = { lock: vi.fn(async () => undefined), unlock: vi.fn() };

/** Lets the browser grant the request it was given, and the lock that follows settle. */
async function grant() {
  await act(async () => {
    pending?.();
    pending = null;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  element = null;
  pending = null;
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => element,
  });
  document.documentElement.requestFullscreen = requestFullscreen;
  document.exitFullscreen = exitFullscreen;
  Object.defineProperty(navigator, "keyboard", {
    configurable: true,
    value: keyboard,
  });
});
afterEach(async () => {
  await exitTableFullscreen();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const alice: Me = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "player",
  status: "active",
  onboarding: "complete",
  handle: "alice",
  display_name: "Alice",
  email: "alice@example.com",
  avatar: "sigil",
  locale: "en",
  csrf_token: "token-1",
  permissions: ["profile.edit", "games.play"],
  roles: ["player"],
  preferences: { large_text: false, reduced_motion: false },
  session: {
    id: "session-1",
    kind: "google",
    authenticated_at: "2026-10-19T10:00:00Z",
    idle_expires_at: "2026-11-02T10:00:00Z",
    absolute_expires_at: "2026-11-18T10:00:00Z",
  },
};
const active = {
  id: "00000000-0000-4000-8000-0000000000aa",
  format: "legacy",
  status: "active",
  bot_skill: 4,
  turn_cap: 60,
  created_at: "2026-10-20T10:00:00Z",
  finished_at: null,
  result: null,
  your_seat: 0,
  seats: [
    { seat: 0, player: "human", handle: "alice", deck: "legacy-mono-red-burn" },
    { seat: 1, player: "bot", handle: null, deck: null },
  ],
};

/** The practice table with its options and games answered; POST answers as given. */
function practice(post: () => Promise<unknown>) {
  const ok = (data: unknown) =>
    Promise.resolve({ data, response: new Response(null) });
  vi.spyOn(client, "GET").mockImplementation(((path: string) => {
    if (path === "/api/v1/practice-games/options")
      return ok({
        deck_lists: false,
        own_decks: false,
        formats: [
          {
            id: "legacy",
            name: "Legacy",
            bots: [1],
            default_bots: 1,
            decks: ["legacy-mono-red-burn"],
          },
        ],
      });
    if (path === "/api/v1/games") return ok([active]);
    return ok(undefined);
  }) as never);
  const sent = vi.spyOn(client, "POST").mockImplementation(post as never);
  render(createElement(PracticeTable, { me: alice }));
  return sent;
}

describe("full screen when a game starts", () => {
  it("is asked for inside the click, before the start request, which need never answer", async () => {
    const post = practice(() => new Promise(() => {}));
    const start = await screen.findByRole("button", { name: "Start the game" });
    await vi.waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    // Synchronously: nothing was awaited between the click and the request.
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: "hide" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(requestFullscreen.mock.invocationCallOrder[0]!).toBeLessThan(
      post.mock.invocationCallOrder[0]!,
    );
    // Escape is locked only once full screen was granted.
    expect(keyboard.lock).not.toHaveBeenCalled();
    await grant();
    await vi.waitFor(() =>
      expect(keyboard.lock).toHaveBeenCalledWith(["Escape"]),
    );
  });

  it("leaves full screen when the game did not start", async () => {
    practice(() =>
      Promise.resolve({
        error: { code: "games_busy", message: "Busy." },
        response: new Response(null, { status: 503 }),
      }),
    );
    const start = await screen.findByRole("button", { name: "Start the game" });
    await vi.waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await grant();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Every table is busy",
    );
    await vi.waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(1));
  });

  it("leaves full screen when the start request throws, and the button comes back", async () => {
    // The network dropped: openapi-fetch rethrows fetch's TypeError.
    practice(() => Promise.reject(new TypeError("Failed to fetch")));
    const start = await screen.findByRole("button", { name: "Start the game" });
    await vi.waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    await grant();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The application service is unavailable. Try again.",
    );
    await vi.waitFor(() => expect(exitFullscreen).toHaveBeenCalledTimes(1));
    expect(document.fullscreenElement).toBeNull();
    expect(keyboard.unlock).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Start the game" }),
    ).toBeEnabled();
  });

  it("is not asked for by a click that opens the game in another tab or window", async () => {
    practice(() => new Promise(() => {}));
    const resume = await screen.findByRole("link", { name: "Resume" });
    resume.addEventListener("click", (event) => event.preventDefault());
    for (const modifier of [
      { ctrlKey: true },
      { shiftKey: true },
      { metaKey: true },
      { altKey: true },
      { button: 1 },
    ])
      fireEvent.click(resume, modifier);
    expect(requestFullscreen).not.toHaveBeenCalled();
    fireEvent.click(resume);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("is asked for by Resume, and not at all when the setting is off", async () => {
    practice(() => new Promise(() => {}));
    const resume = await screen.findByRole("link", { name: "Resume" });
    resume.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(resume);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    await grant();

    await act(() => exitTableFullscreen());
    requestFullscreen.mockClear();
    localStorage.setItem(
      TABLE_SETTINGS_KEY,
      JSON.stringify({ ...DEFAULT_TABLE_SETTINGS, fullscreenOnStart: false }),
    );
    fireEvent.click(resume);
    fireEvent.click(screen.getByRole("button", { name: "Start the game" }));
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
});

describe("the table's full screen", () => {
  it("leaves only a full screen it entered", async () => {
    // The player's own full screen (another element, or before the game) is theirs to leave.
    element = document.body;
    await exitTableFullscreen();
    expect(exitFullscreen).not.toHaveBeenCalled();

    element = null;
    const entered = enterTableFullscreen();
    await grant();
    expect(await entered).toBe(true);
    await exitTableFullscreen();
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(keyboard.unlock).toHaveBeenCalled();
  });

  it("forgets its claim when the browser leaves full screen (a held Escape)", async () => {
    const entered = enterTableFullscreen();
    await grant();
    await entered;
    act(() => {
      element = null;
      changed();
    });
    expect(keyboard.unlock).toHaveBeenCalled();
    await exitTableFullscreen();
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it("resolves false when the browser refuses or has no full screen", async () => {
    requestFullscreen.mockImplementationOnce(() =>
      Promise.reject(new TypeError("Permissions check failed")),
    );
    expect(await enterTableFullscreen()).toBe(false);
    Object.defineProperty(document, "fullscreenEnabled", {
      configurable: true,
      get: () => false,
    });
    expect(canFullscreen()).toBe(false);
    expect(await enterTableFullscreen()).toBe(false);
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("toggles from the HUD and reports Escape locked while full screen", async () => {
    const { result } = renderHook(() => useFullscreen());
    expect(result.current).toMatchObject({
      available: true,
      active: false,
      escapeLocked: false,
    });
    act(() => result.current.toggle());
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    await grant();
    await vi.waitFor(() =>
      expect(result.current).toMatchObject({
        active: true,
        enteredByUs: true,
        escapeLocked: true,
      }),
    );
    await act(async () => result.current.toggle());
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({
      active: false,
      escapeLocked: false,
    });
  });
});
