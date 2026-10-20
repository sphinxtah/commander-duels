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
  client,
  setCsrfToken,
  type Bootstrap,
  type Format,
  type Me,
} from "./api";
import { exitTableFullscreen } from "./app/fullscreen";
import { holdLiveGame, markIntendedLeave } from "./app/liveGame";
import { leaveTable } from "./app/serviceWorker";

// The game screen and the practice table have their own tests; here they only take up room.
vi.mock("./game/GameScreen", async () => {
  const { createElement } = await import("react");
  return {
    GameScreen: () =>
      createElement("a", { href: "#play" }, "Back to the table"),
  };
});
vi.mock("./game/PracticeTable", () => ({ PracticeTable: () => null }));
vi.mock("./google", () => ({ loadGoogle: () => new Promise(() => {}) }));
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
type Answer = () => unknown;
const queues = new Map<string, Answer[]>();
let calls: string[] = [];
function on(route: string, ...answers: Answer[]) {
  queues.set(route, answers);
}
function reply(status: number, body?: unknown) {
  const response = new Response(null, { status });
  return response.ok ? { data: body, response } : { error: body, response };
}
function serve(method: string) {
  return (async (path: string) => {
    const route = `${method} ${path}`;
    calls.push(route);
    const queue = queues.get(route);
    if (!queue?.length) throw new Error(`No answer for ${route}`);
    return (queue.length > 1 ? queue.shift()! : queue[0])();
  }) as never;
}
/** Lets every pending answer arrive. */
async function settle() {
  await act(() => new Promise((done) => setTimeout(done, 20)));
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
const signedOut = { code: "not_signed_in", message: "Sign in to continue." };

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
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  on("GET /api/v1/bootstrap", () => reply(200, bootstrap));
  on("GET /api/v1/formats", () => reply(200, formats));
  on("GET /api/v1/me", () => reply(401, signedOut));
  on("GET /api/v1/me/sessions", () => reply(200, []));
});
afterEach(() => {
  vi.restoreAllMocks();
  setCsrfToken(undefined);
});

describe("navigation", () => {
  it("the skip link focuses the content without leaving the page", async () => {
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
    window.location.hash = "#game/00000000-0000-4000-8000-0000000000aa";
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
    const id = "00000000-0000-4000-8000-0000000000aa";
    window.location.hash = `#game/${id}`;
    render(<App />);
    const back = await screen.findByRole("link", { name: "Back to the table" });
    expect(document.documentElement.dataset.route).toBe("game");
    const release = holdLiveGame(id);

    // The browser's Back, or the installed app opening #play in this window.
    window.location.hash = "#play";
    await waitFor(() => expect(window.location.hash).toBe(`#game/${id}`));
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

  it("leaving the table for a version that took over reloads instead of drawing the page", async () => {
    on("GET /api/v1/me", () => reply(200, alice));
    vi.mocked(leaveTable).mockClear();
    vi.mocked(leaveTable).mockReturnValueOnce(true);
    window.location.hash = "#game/00000000-0000-4000-8000-0000000000aa";
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
    await waitFor(() =>
      expect(calls.filter((call) => call === "GET /api/v1/me")).toHaveLength(2),
    );
    await settle();
    expect(
      screen.getByRole("heading", { name: "Welcome back, Alice." }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toHaveValue("Alice the Bold");
    expect(screen.getByText("Signed in")).toBeInTheDocument();

    act(() => void window.dispatchEvent(new Event("online")));
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
  });

  it("Profile offers a retry when the service did not answer", async () => {
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
    expect(screen.queryByText(/not set up/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("Preparing Google sign-in…"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not set up/)).toBeNull();
  });
});

describe("release status", () => {
  it("Settings shows each capability's own availability", async () => {
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
  it("drops down above the top bar for a signed-in player once the browser offers", async () => {
    on("GET /api/v1/me", () => reply(200, alice));
    render(<App />);
    await screen.findByText("Signed in");
    expect(
      screen.queryByRole("region", { name: "Install the app" }),
    ).toBeNull();

    const offer = Object.assign(
      new Event("beforeinstallprompt", { cancelable: true }),
      { prompt: vi.fn(), userChoice: new Promise(() => {}) },
    );
    act(() => void window.dispatchEvent(offer));
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
