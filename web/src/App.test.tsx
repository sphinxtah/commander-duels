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
