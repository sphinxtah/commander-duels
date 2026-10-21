import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { App } from "./App";
import {
  ANSWER_MS,
  client,
  setCsrfToken,
  type Bootstrap,
  type Format,
  type Me,
} from "./api";
import { progress, roster, starterDecks } from "./alliance/fixtures";
import { exitTableFullscreen } from "./app/fullscreen";
import { initInstall } from "./app/install";
import { holdLiveGame, markIntendedLeave } from "./app/liveGame";
import { leaveTable } from "./app/serviceWorker";
import { GameScreen } from "./game/GameScreen";
import { loadGoogle, type GoogleId } from "./google";

// The game screen and the practice table have their own tests; here they only take up room.
vi.mock("./game/GameScreen", async () => {
  const { createElement } = await import("react");
  return {
    GameScreen: vi.fn(() =>
      createElement("a", { href: "#play" }, "Back to the table"),
    ),
  };
});
vi.mock("./game/PracticeTable", () => ({ PracticeTable: () => null }));
// Google's script stays away unless a test brings its own.
vi.mock("./google", () => ({ loadGoogle: vi.fn(() => new Promise(() => {})) }));
// Whether leaving the table leaves full screen and applies a waiting update; fullscreen.test.ts
// and serviceWorker.test.ts test the rest.
vi.mock("./app/fullscreen", () => ({
  exitTableFullscreen: vi.fn(async () => undefined),
}));
vi.mock("./app/serviceWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app/serviceWorker")>()),
  leaveTable: vi.fn(() => false),
}));

// The API, answered route by route. Each route takes its answers in order and keeps the last.
type Answer = (init?: { signal?: AbortSignal }) => unknown;
const queues = new Map<string, Answer[]>();
let calls: string[] = [];
function on(route: string, ...answers: Answer[]) {
  queues.set(route, answers);
}
function reply(status: number, body?: unknown) {
  const response = new Response(null, { status });
  return response.ok ? { data: body, response } : { error: body, response };
}
/** A request the service holds on to, as a stalled proxy does, until the page gives up on it. */
const stall: Answer = (init) =>
  new Promise((_, fail) =>
    init?.signal?.addEventListener("abort", () =>
      fail(new DOMException("The operation was aborted.", "AbortError")),
    ),
  );
function serve(method: string) {
  return (async (path: string, init?: { signal?: AbortSignal }) => {
    const route = `${method} ${path}`;
    calls.push(route);
    const queue = queues.get(route);
    if (!queue?.length) throw new Error(`No answer for ${route}`);
    return (queue.length > 1 ? queue.shift()! : queue[0])(init);
  }) as never;
}
function count(route: string) {
  return calls.filter((call) => call === route).length;
}
/** Lets every pending answer arrive. */
async function settle() {
  await act(() => new Promise((done) => setTimeout(done, 20)));
}
/** Under fake timeouts: lets the page's clock run on, and every answer due by then arrive. */
async function later(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

const bootstrap: Bootstrap = {
  name: "Commander Duels",
  version: "0.1.1",
  protocol_version: 1,
  collection_policy: "open_collection",
  capabilities: [
    {
      id: "authentication",
      name: "Google sign-in",
      available: true,
      milestone: "M1",
      reason: "Google sign-in is available.",
    },
    {
      id: "decks",
      name: "Deck builder",
      available: false,
      milestone: "M1",
      reason: "Requires catalog identities and construction validation.",
    },
  ],
  auth: { google_client_id: "client", signup_policy: "open" },
};
const formats: Format[] = [
  {
    id: "commander",
    name: "Commander",
    seats: [2, 3, 4],
    default_seats: 4,
    description: "Build around your commander.",
    available: false,
  },
  {
    id: "legacy",
    name: "Legacy",
    seats: [2],
    default_seats: 2,
    description: "Two players.",
    available: false,
  },
  {
    id: "two_headed_giant",
    name: "Two-Headed Giant",
    seats: [4],
    default_seats: 4,
    description: "Two teams of two.",
    available: false,
  },
];
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
// A new account in approval mode: no handle yet, and nothing it may do.
const waiting: Me = {
  ...alice,
  status: "pending",
  onboarding: "handle",
  handle: null,
  permissions: [],
  roles: [],
};
const signedOut = { code: "not_signed_in", message: "Sign in to continue." };
const gameId = "00000000-0000-4000-8000-0000000000aa";
// All a page may ask the API before its account is active: the foundation and the account.
const gated = new Set([
  "GET /api/v1/bootstrap",
  "GET /api/v1/formats",
  "GET /api/v1/me",
]);
function insideCalls() {
  return calls.filter((call) => !gated.has(call));
}

/** The landing page and nothing else: the owner's mark, and none of the app's shell. */
function expectLanding() {
  const images = document.querySelectorAll("img");
  expect(images).toHaveLength(1);
  expect(images[0]).toHaveAttribute("src", "/brand/mark.webp");
  // Shown large and alone, it stays sharp on high-density screens.
  expect(images[0]).toHaveAttribute(
    "srcset",
    "/brand/mark.webp 1x, /brand/mark-256.webp 2x, /brand/mark-384.webp 3x",
  );
  expect(images[0]).toHaveAttribute("alt", "");
  expect(screen.getByRole("main")).toContainElement(images[0]!);
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(screen.queryByRole("banner")).toBeNull();
  expect(screen.queryByRole("link", { name: "Skip to content" })).toBeNull();
  expect(document.body).not.toHaveTextContent(
    /COMMANDER DUELS|Testing preview|Fan Content/i,
  );
  expect(document.body).not.toHaveTextContent(`v${__APP_VERSION__}`);
}

// Edge on a PC, so the page's install offer (made on its first render) can come; until the
// browser offers, nothing shows.
Object.defineProperty(navigator, "userAgentData", {
  configurable: true,
  value: { brands: [{ brand: "Microsoft Edge" }], mobile: false },
});
beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
});
beforeEach(() => {
  calls = [];
  queues.clear();
  vi.mocked(GameScreen).mockClear();
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  on("GET /api/v1/bootstrap", () => reply(200, bootstrap));
  on("GET /api/v1/formats", () => reply(200, formats));
  on("GET /api/v1/me", () => reply(401, signedOut));
  on("GET /api/v1/me/sessions", () => reply(200, []));
  // Profile's progress and the roster (v0.3.1).
  on("GET /api/v1/me/progress", () => reply(200, progress()));
  on("GET /api/v1/planeswalkers", () => reply(200, roster));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setCsrfToken(undefined);
});

describe("the landing page", () => {
  it("is all a signed-out visitor sees, at every address, which it keeps", async () => {
    for (const route of [
      "#play",
      "#cards",
      "#decks",
      `#deck/${gameId}`,
      "#shared/abcd1234",
      `#game/${gameId}`,
      "#admin",
      "#profile",
      "#settings",
      "#nowhere",
    ]) {
      calls = [];
      window.location.hash = route;
      const { unmount } = render(<App />);
      await screen.findByText("Preparing Google sign-in…");
      expectLanding();
      // Nothing to read: the heading and the status are for screen readers only.
      expect(screen.getByRole("main")).toHaveTextContent(
        /^Sign in\s*Preparing Google sign-in…$/,
      );
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Sign in",
      );
      expect(window.location.hash).toBe(route);
      // A game's address does not take over the window either.
      expect(document.documentElement.dataset.route).toBe("shell");
      expect(insideCalls()).toEqual([]);
      // The page as it first settles leaves focus where the browser put it.
      expect(document.activeElement).toBe(document.body);
      unmount();
    }
    expect(GameScreen).not.toHaveBeenCalled();
  });

  it("shows only the mark while the sign-in is checked, even at a game's address", async () => {
    on("GET /api/v1/me", () => new Promise(() => {}));
    window.location.hash = `#game/${gameId}`;
    render(<App />);
    await settle();
    expectLanding();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your sign-in…",
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(GameScreen).not.toHaveBeenCalled();
    expect(insideCalls()).toEqual([]);
  });

  it("offers a retry when the service did not answer", async () => {
    on(
      "GET /api/v1/bootstrap",
      () => reply(503, { code: "unavailable", message: "Down." }),
      () => reply(200, bootstrap),
    );
    on(
      "GET /api/v1/me",
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => reply(401, signedOut),
    );
    window.location.hash = "#profile";
    render(<App />);
    expect(await screen.findByText(/did not answer/)).toBeInTheDocument();
    expectLanding();
    expect(screen.queryByText(/not set up/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("Preparing Google sign-in…"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not set up/)).toBeNull();
  });

  it("offers a retry when the service holds every answer, instead of the mark alone", async () => {
    // A proxy may hold a stalled request for an hour.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(exitTableFullscreen).mockClear();
    vi.mocked(leaveTable).mockClear();
    on("GET /api/v1/bootstrap", stall, () => reply(200, bootstrap));
    on("GET /api/v1/formats", stall, () => reply(200, formats));
    on("GET /api/v1/me", stall, () => reply(401, signedOut));
    window.location.hash = `#game/${gameId}`;
    render(<App />);
    await later(ANSWER_MS - 1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your sign-in…",
    );
    await later(1);
    expect(screen.getByText(/did not answer/)).toBeInTheDocument();
    expectLanding();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await later(0);
    expect(screen.getByText("Preparing Google sign-in…")).toBeInTheDocument();
    expect(window.location.hash).toBe(`#game/${gameId}`);
    expect(GameScreen).not.toHaveBeenCalled();
    // No table was shown, so there was none to leave.
    expect(exitTableFullscreen).not.toHaveBeenCalled();
    expect(leaveTable).not.toHaveBeenCalled();
  });

  it("shows the sign-in when only the account check stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    on("GET /api/v1/me", stall);
    window.location.hash = "#play";
    render(<App />);
    await later(ANSWER_MS - 1);
    expect(screen.queryByRole("heading")).toBeNull();
    // The foundation answered long ago; the account check gives up and settles on signed out.
    await later(1);
    expect(screen.getByText("Preparing Google sign-in…")).toBeInTheDocument();
    expectLanding();
    expect(insideCalls()).toEqual([]);
  });

  it("signing in opens the address the visitor came to", async () => {
    const configs: Parameters<GoogleId["initialize"]>[0][] = [];
    vi.mocked(loadGoogle).mockResolvedValueOnce({
      initialize: (config) => void configs.push(config),
      renderButton: (parent) => {
        const button = document.createElement("button");
        button.textContent = "Sign in with Google";
        parent.replaceChildren(button);
      },
      disableAutoSelect: () => {},
    });
    on("POST /api/v1/auth/google/start", () =>
      reply(200, { client_id: "client", nonce: "nonce-1" }),
    );
    on("POST /api/v1/auth/google", () => reply(200, alice));
    window.location.hash = "#settings";
    render(<App />);
    await screen.findByRole("button", { name: "Sign in with Google" });
    expectLanding();
    await act(async () => {
      await configs[0]!.callback({ credential: "header.payload.signature" });
    });
    const heading = await screen.findByRole("heading", {
      name: "Make yourself at home.",
    });
    expect(window.location.hash).toBe("#settings");
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    // Focus lands on the page's heading, as after following a link.
    expect(document.activeElement).toBe(heading);
  });

  it("a sign-in that must wait moves focus to the wait, and signing out back to the sign-in", async () => {
    const configs: Parameters<GoogleId["initialize"]>[0][] = [];
    vi.mocked(loadGoogle).mockResolvedValueOnce({
      initialize: (config) => void configs.push(config),
      renderButton: (parent) => {
        const button = document.createElement("button");
        button.textContent = "Sign in with Google";
        parent.replaceChildren(button);
      },
      disableAutoSelect: () => {},
    });
    on("POST /api/v1/auth/google/start", () =>
      reply(200, { client_id: "client", nonce: "nonce-1" }),
    );
    on("POST /api/v1/auth/google", () => reply(200, waiting));
    on("POST /api/v1/auth/logout", () => reply(204));
    window.location.hash = "#decks";
    render(<App />);
    const button = await screen.findByRole("button", {
      name: "Sign in with Google",
    });
    button.focus();
    await act(async () => {
      await configs[0]!.callback({ credential: "header.payload.signature" });
    });
    // The button went with the sign-in: a screen reader hears where it led instead of nothing.
    expect(document.activeElement).toBe(
      screen.getByRole("heading", {
        name: "Your account is waiting for approval.",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("You signed out.")).toBeInTheDocument();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Sign in" }),
    );
    expectLanding();
    expect(window.location.hash).toBe("#decks");
  });

  it("opens SysOp's entrance under the mark on SysOp's network, and the app after it", async () => {
    const sysop: Me = {
      ...alice,
      kind: "sysop",
      handle: "sysop",
      display_name: "SysOp",
      email: null,
      avatar: "tower",
      roles: ["sysop"],
      permissions: ["admin.users.read"],
      session: { ...alice.session, kind: "sysop" },
    };
    const fetches = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input) === "/api/v1/sysop/entrance"
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(sysop), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
      );
    on("GET /api/v1/admin/users", () =>
      reply(200, { items: [], next_cursor: null }),
    );
    window.location.hash = "#sysop";
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "SysOp sign-in" }),
    ).toBeInTheDocument();
    expectLanding();
    expect(screen.queryByText("Preparing Google sign-in…")).toBeNull();
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "a long enough password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("heading", { name: "Keep the table running." }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe("#admin");
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(fetches).toHaveBeenCalledWith(
      "/api/v1/sysop/login",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("treats #sysop off SysOp's network as any other address", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    window.location.hash = "#sysop";
    render(<App />);
    await screen.findByText("Preparing Google sign-in…");
    expectLanding();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(document.body).not.toHaveTextContent(/sysop/i);
    expect(window.location.hash).toBe("#sysop");
  });

  it("treats #sysop as any other address when its check does not answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        stall({ signal: init?.signal ?? undefined }) as Promise<Response>,
    );
    window.location.hash = "#sysop";
    render(<App />);
    await later(ANSWER_MS - 1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your sign-in…",
    );
    await later(1);
    expect(screen.getByText("Preparing Google sign-in…")).toBeInTheDocument();
    expectLanding();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(window.location.hash).toBe("#sysop");
  });
});

describe("an account that is not active", () => {
  it("waits for approval alone, asks again, and opens the app where it was once approved", async () => {
    // Approved after the second look: Check again finds it, with its handle still to choose.
    on(
      "GET /api/v1/me",
      () => reply(200, waiting),
      () => reply(200, waiting),
      () => reply(200, { ...waiting, status: "active", roles: ["player"] }),
    );
    window.location.hash = "#profile";
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "Your account is waiting for approval.",
      }),
    ).toBeInTheDocument();
    expectLanding();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    // The handle comes after approval.
    expect(screen.queryByLabelText("Handle")).toBeNull();

    // Coming back to the window asks again. The wait listens for that from an effect, which can
    // run a moment after the wait is drawn: the window comes back once it has.
    await settle();
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(count("GET /api/v1/me")).toBe(2));
    await settle();
    expect(
      screen.getByRole("heading", {
        name: "Your account is waiting for approval.",
      }),
    ).toBeInTheDocument();
    expect(insideCalls()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    const heading = await screen.findByRole("heading", {
      name: "Welcome to the table.",
    });
    expect(window.location.hash).toBe("#profile");
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Handle")).toBeInTheDocument();
    expect(document.activeElement).toBe(heading);
  });

  it("asks the API for nothing of the app at any address", async () => {
    on("GET /api/v1/me", () => reply(200, waiting));
    for (const route of [
      "#play",
      "#decks",
      "#cards",
      `#deck/${gameId}`,
      "#shared/abcd1234",
      `#game/${gameId}`,
      "#admin",
      "#profile",
    ]) {
      calls = [];
      window.location.hash = route;
      const { unmount } = render(<App />);
      await screen.findByRole("heading", {
        name: "Your account is waiting for approval.",
      });
      await settle();
      expectLanding();
      expect(insideCalls()).toEqual([]);
      expect(window.location.hash).toBe(route);
      unmount();
    }
    expect(GameScreen).not.toHaveBeenCalled();
  });

  it("tells a denied account so, and signing out leads back to the sign-in", async () => {
    on("GET /api/v1/me", () => reply(200, { ...alice, status: "denied" }));
    on("POST /api/v1/auth/logout", () => reply(204));
    window.location.hash = "#play";
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "Your account was not approved.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Contact the operator of this server if you think this is a mistake.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expectLanding();
    // Only a pending account asks again.
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(count("GET /api/v1/me")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("You signed out.")).toBeInTheDocument();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Sign in" }),
    );
    expectLanding();
    expect(window.location.hash).toBe("#play");
  });

  it("a check that finds the account refused says so, with focus on it", async () => {
    on(
      "GET /api/v1/me",
      () => reply(200, waiting),
      () => reply(200, { ...waiting, status: "denied" }),
    );
    window.location.hash = "#play";
    render(<App />);
    const check = await screen.findByRole("button", { name: "Check again" });
    check.focus();
    fireEvent.click(check);
    const heading = await screen.findByRole("heading", {
      name: "Your account was not approved.",
    });
    // Check again went with the wait.
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(document.activeElement).toBe(heading);
    expectLanding();
  });
});

describe("navigation", () => {
  it("the skip link focuses the content without leaving the page", async () => {
    on("GET /api/v1/me", () => reply(200, alice));
    window.location.hash = "#settings";
    render(<App />);
    await screen.findByRole("heading", { name: "Make yourself at home." });
    fireEvent.click(screen.getByRole("link", { name: "Skip to content" }));
    await settle();
    expect(window.location.hash).toBe("#settings");
    expect(
      screen.getByRole("heading", { name: "Make yourself at home." }),
    ).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("leaving a game focuses the page's heading", async () => {
    on("GET /api/v1/me", () => reply(200, alice));
    window.location.hash = `#game/${gameId}`;
    render(<App />);
    fireEvent.click(
      await screen.findByRole("link", { name: "Back to the table" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1 }),
      ),
    );
    expect(document.activeElement).toHaveTextContent("Gather your cards.");
    // Between pages, as before.
    window.location.hash = "#settings";
    await waitFor(() =>
      expect(document.activeElement).toHaveTextContent(
        "Make yourself at home.",
      ),
    );
  });

  it("a live game keeps its address until an in-game link leaves it, and leaving ends full screen", async () => {
    on("GET /api/v1/me", () => reply(200, alice));
    vi.mocked(exitTableFullscreen).mockClear();
    vi.mocked(leaveTable).mockClear();
    window.location.hash = `#game/${gameId}`;
    render(<App />);
    const back = await screen.findByRole("link", { name: "Back to the table" });
    expect(document.documentElement.dataset.route).toBe("game");
    const release = holdLiveGame(gameId);

    // The browser's Back, or the installed app opening #play in this window.
    window.location.hash = "#play";
    await waitFor(() => expect(window.location.hash).toBe(`#game/${gameId}`));
    await settle();
    expect(back).toBeInTheDocument();
    expect(exitTableFullscreen).not.toHaveBeenCalled();
    expect(leaveTable).not.toHaveBeenCalled();

    markIntendedLeave();
    fireEvent.click(back);
    await waitFor(() =>
      expect(document.activeElement).toHaveTextContent("Gather your cards."),
    );
    expect(exitTableFullscreen).toHaveBeenCalledTimes(1);
    // The update the game screen said was ready applies now.
    expect(leaveTable).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.route).toBe("shell");
    release();

    // Moving between shell pages leaves full screen and updates alone.
    window.location.hash = "#settings";
    await screen.findByRole("heading", { name: "Make yourself at home." });
    expect(exitTableFullscreen).toHaveBeenCalledTimes(1);
    expect(leaveTable).toHaveBeenCalledTimes(1);
  });

  it("a session that ends at the table leaves its full screen and applies a waiting update", async () => {
    on(
      "GET /api/v1/me",
      () => reply(200, alice),
      () => reply(401, signedOut),
    );
    vi.mocked(exitTableFullscreen).mockClear();
    vi.mocked(leaveTable).mockClear();
    window.location.hash = `#game/${gameId}`;
    render(<App />);
    await screen.findByRole("link", { name: "Back to the table" });
    expect(document.documentElement.dataset.route).toBe("game");
    // Back online, the page finds the session over (its time ran out, or Sign out everywhere
    // ended it from another browser): the landing page replaces the table at the same address.
    act(() => void window.dispatchEvent(new Event("online")));
    const signIn = await screen.findByRole("heading", { name: "Sign in" });
    expectLanding();
    expect(window.location.hash).toBe(`#game/${gameId}`);
    expect(document.documentElement.dataset.route).toBe("shell");
    expect(exitTableFullscreen).toHaveBeenCalledTimes(1);
    expect(leaveTable).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(signIn);
  });

  it("leaving the table for a version that took over reloads instead of drawing the page", async () => {
    on("GET /api/v1/me", () => reply(200, alice));
    vi.mocked(leaveTable).mockClear();
    vi.mocked(leaveTable).mockReturnValueOnce(true);
    window.location.hash = `#game/${gameId}`;
    render(<App />);
    const back = await screen.findByRole("link", { name: "Back to the table" });
    fireEvent.click(back);
    await waitFor(() => expect(leaveTable).toHaveBeenCalledTimes(1));
    await settle();
    // The reload is under way: the old code draws nothing new.
    expect(back).toBeInTheDocument();
    expect(document.documentElement.dataset.route).toBe("game");
  });
});

describe("the account", () => {
  it("survives a network failure, and a 401 still signs it out", async () => {
    on(
      "GET /api/v1/me",
      () => reply(200, alice),
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => reply(401, signedOut),
    );
    window.location.hash = "#profile";
    render(<App />);
    await screen.findByRole("heading", { name: "Welcome back, Alice." });
    const name = screen.getByLabelText("Display name");
    fireEvent.change(name, { target: { value: "Alice the Bold" } });

    act(() => void window.dispatchEvent(new Event("offline")));
    await waitFor(() => expect(count("GET /api/v1/me")).toBe(2));
    await settle();
    expect(
      screen.getByRole("heading", { name: "Welcome back, Alice." }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toHaveValue("Alice the Bold");
    expect(screen.getByText("Signed in")).toBeInTheDocument();

    act(() => void window.dispatchEvent(new Event("online")));
    const signIn = await screen.findByRole("heading", { name: "Sign in" });
    expectLanding();
    expect(window.location.hash).toBe("#profile");
    // Profile went with the session: focus moves to the sign-in, not to <body>.
    expect(document.activeElement).toBe(signIn);
  });

  it("signing out on Profile moves focus to the sign-in", async () => {
    on("GET /api/v1/me", () => reply(200, alice));
    on("POST /api/v1/auth/logout", () => reply(204));
    window.location.hash = "#profile";
    render(<App />);
    const signOut = await screen.findByRole("button", { name: "Sign out" });
    signOut.focus();
    fireEvent.click(signOut);
    expect(await screen.findByText("You signed out.")).toBeInTheDocument();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Sign in" }),
    );
    expectLanding();
  });

  it("keeps the sign-in when an account check sent before the sign-out answers after it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    on(
      "GET /api/v1/me",
      () => reply(200, alice),
      // The look that coming back online starts: answered before the sign-out ended the session,
      // but slow on its way back.
      () => held.then(() => reply(200, alice)),
    );
    on("POST /api/v1/auth/logout", () => reply(204));
    window.location.hash = "#profile";
    render(<App />);
    await screen.findByRole("button", { name: "Sign out" });
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(count("GET /api/v1/me")).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("You signed out.")).toBeInTheDocument();
    await act(async () => release());
    await settle();
    expect(
      screen.getByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    expectLanding();
  });
});

describe("a new account's handle", () => {
  it("every page but Profile points there until the account has one", async () => {
    const fresh: Me = { ...alice, onboarding: "handle", handle: null };
    on("GET /api/v1/me", () => reply(200, fresh));
    on("PATCH /api/v1/me", () =>
      reply(200, { ...fresh, onboarding: "complete", handle: "alice" }),
    );
    // The landing page kept the address, so the first page is rarely Profile.
    window.location.hash = "#play";
    render(<App />);
    const link = await screen.findByRole("link", {
      name: "Choose yours on Profile",
    });
    expect(link).toHaveAttribute("href", "#profile");
    expect(screen.getByRole("main")).toHaveTextContent(
      "Other players know you by your handle.",
    );
    // So does the sidebar, where the handle would be.
    expect(
      screen.getByRole("link", { name: /Alice\s*Choose your handle/ }),
    ).toHaveAttribute("href", "#profile");

    window.location.hash = "#profile";
    await screen.findByRole("heading", { name: "Welcome to the table." });
    expect(
      screen.queryByRole("link", { name: "Choose yours on Profile" }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("Handle"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save handle" }));
    await screen.findByText("Signed in");

    window.location.hash = "#play";
    await screen.findByRole("heading", { name: /Gather your cards/ });
    expect(
      screen.queryByText("Other players know you by your handle."),
    ).toBeNull();
  });

  it("then every page but Profile points to the starter decks until they are chosen (v0.3.1)", async () => {
    on("GET /api/v1/me", () =>
      reply(200, { ...alice, onboarding: "starters" }),
    );
    on("GET /api/v1/decks/starters", () => reply(200, starterDecks));
    window.location.hash = "#settings";
    render(<App />);
    const link = await screen.findByRole("link", {
      name: "Choose them on Profile",
    });
    expect(link).toHaveAttribute("href", "#profile");
    expect(screen.getByRole("main")).toHaveTextContent(
      "Two starter decks of your choice begin your card library.",
    );
    expect(
      screen.queryByText("Other players know you by your handle."),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: /alice\s*Choose your starter decks/ }),
    ).toHaveAttribute("href", "#profile");

    window.location.hash = "#profile";
    expect(
      await screen.findByRole("heading", { name: "Choose two starter decks" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Choose them on Profile" }),
    ).toBeNull();
  });
});

describe("the sidebar's picture (v0.3.1)", () => {
  it("is the alliance's portrait, never cropped, and the avatar without one", async () => {
    on(
      "GET /api/v1/me",
      () => reply(200, { ...alice, alliance: "rowan" }),
      () => reply(200, alice),
    );
    window.location.hash = "#settings";
    const { unmount } = render(<App />);
    const allied = await screen.findByRole("link", {
      name: /^alice\s*Signed in$/,
    });
    // A thumbnail: the 128 px file alone, decorative beside the handle.
    const portrait = allied.querySelector("img")!;
    expect(portrait).toHaveAttribute("src", "/portraits/rowan-128.webp");
    expect(portrait).toHaveAttribute("alt", "");
    expect(portrait).not.toHaveAttribute("srcset");
    unmount();

    render(<App />);
    const plain = await screen.findByRole("link", {
      name: /^alice\s*Signed in$/,
    });
    expect(plain.querySelector("img")).toBeNull();
    expect(plain).toHaveTextContent("◇");
  });
});

describe("release status", () => {
  it("Settings shows each capability's own availability", async () => {
    on("GET /api/v1/me", () => reply(200, alice));
    window.location.hash = "#settings";
    render(<App />);
    const google = (await screen.findByText("Google sign-in")).closest("li")!;
    expect(google).toHaveTextContent("Available");
    expect(google).not.toHaveTextContent("M1");
    const decks = screen.getByText("Deck builder").closest("li")!;
    expect(decks).toHaveTextContent("M1");
    expect(decks).not.toHaveTextContent("Available");
    expect(screen.getByText(/TESTING PREVIEW/)).toBeInTheDocument();
    expect(screen.queryByText(/remain unavailable/)).toBeNull();
    expect(screen.queryByText(/FRAMEWORK/)).toBeNull();
  });

  it("the Play page says practice games are playable; only Two-Headed Giant is planned", async () => {
    on("GET /api/v1/me", () => reply(200, alice));
    render(<App />);
    await screen.findByRole("heading", { name: "Commander" });
    expect(screen.getByText("TESTING PREVIEW")).toBeInTheDocument();
    expect(screen.queryByText("IN DEVELOPMENT")).toBeNull();
    expect(screen.queryByText(/gameplay will arrive/)).toBeNull();

    const dialog = document.querySelector("dialog")!;
    const about = (id: Format["id"]) =>
      within(
        document.querySelector<HTMLElement>(`[data-format="${id}"]`)!,
      ).getByRole("button");
    fireEvent.click(about("commander"));
    await waitFor(() => expect(dialog).toHaveTextContent("Commander"));
    expect(dialog).toHaveTextContent("OPEN FOR PRACTICE");
    expect(dialog).not.toHaveTextContent(/planned/i);
    fireEvent.click(about("legacy"));
    await waitFor(() => expect(dialog).toHaveTextContent("Legacy"));
    expect(dialog).not.toHaveTextContent(/planned/i);
    fireEvent.click(about("two_headed_giant"));
    await waitFor(() => expect(dialog).toHaveTextContent("PLANNED FORMAT"));
    expect(dialog).toHaveTextContent("4 seats supported in the planned format");
  });
});

// Last in the file: the install offer is one per page, so it stays for any test after this one.
describe("the install banner", () => {
  it("drops down above the top bar for a signed-in player once the browser offers, and never on the landing page", async () => {
    // As main.tsx does: the offer can come before any banner is drawn.
    initInstall();
    on("GET /api/v1/me", () => reply(200, alice));
    let shown = render(<App />);
    await screen.findByText("Signed in");
    expect(
      screen.queryByRole("region", { name: "Install the app" }),
    ).toBeNull();
    shown.unmount();

    // A signed-out visitor never sees it, offer or not.
    on("GET /api/v1/me", () => reply(401, signedOut));
    shown = render(<App />);
    await screen.findByText("Preparing Google sign-in…");
    const offer = Object.assign(
      new Event("beforeinstallprompt", { cancelable: true }),
      { prompt: vi.fn(), userChoice: new Promise(() => {}) },
    );
    act(() => void window.dispatchEvent(offer));
    await settle();
    expect(
      screen.queryByRole("region", { name: "Install the app" }),
    ).toBeNull();
    shown.unmount();

    on("GET /api/v1/me", () => reply(200, alice));
    render(<App />);
    const banner = await screen.findByRole("region", {
      name: "Install the app",
    });
    expect(banner).toHaveTextContent(
      "Play Commander Duels in its own window, with a desktop icon.",
    );
    // The workspace's first child, before the top bar.
    expect(banner.nextElementSibling?.tagName).toBe("HEADER");
    // The owner's art on the page stays the sidebar mark and the banner image.
    expect(document.querySelectorAll('img[src^="/brand/"]')).toHaveLength(2);
    // The banner listens to the install offer from an effect, which can run a moment after the
    // banner is drawn: pressed before then, Not now would change an offer nobody listens to yet.
    await settle();

    // The button goes with the banner: keyboard focus moves on to the content, not to <body>.
    const notNow = within(banner).getByRole("button", { name: "Not now" });
    notNow.focus();
    fireEvent.click(notNow);
    expect(
      screen.queryByRole("region", { name: "Install the app" }),
    ).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});
