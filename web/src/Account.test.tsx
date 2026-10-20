import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Account } from "./Account";
import { client, currentCsrfToken, setCsrfToken, type Me } from "./api";
import { loadGoogle, type GoogleId } from "./google";

vi.mock("./google", () => ({ loadGoogle: vi.fn() }));

// The API, answered route by route. Each route takes its answers in order and keeps the last.
type Answer = () => unknown;
const queues = new Map<string, Answer[]>();
let calls: { route: string; csrf?: string }[] = [];
function on(route: string, ...answers: Answer[]) {
  queues.set(route, answers);
}
function reply(status: number, body?: unknown) {
  const response = new Response(null, { status });
  if (status === 204) return { data: undefined, response };
  return response.ok ? { data: body, response } : { error: body, response };
}
function count(route: string) {
  return calls.filter((call) => call.route === route).length;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function serve(method: string) {
  return (async (path: string) => {
    const route = `${method} ${path}`;
    calls.push({ route, csrf: currentCsrfToken() });
    const queue = queues.get(route);
    if (!queue?.length) throw new Error(`No answer for ${route}`);
    return (queue.length > 1 ? queue.shift()! : queue[0])();
  }) as never;
}

function account(overrides: Partial<Me> = {}): Me {
  return {
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
    ...overrides,
  };
}
const google = { google_client_id: "client", signup_policy: "open" } as const;

/** Account inside a page that keeps the account it is handed, as App does. */
function Page({
  initial,
  auth,
  unavailable = false,
  onRetry = () => {},
  seen,
}: {
  initial: Me | null;
  auth: Parameters<typeof Account>[0]["auth"];
  unavailable?: boolean;
  onRetry?: () => void;
  seen?: (me: Me | null) => void;
}) {
  const [me, setMe] = useState<Me | null>(initial);
  return (
    <Account
      me={me}
      auth={auth}
      unavailable={unavailable}
      onRetry={onRetry}
      onChange={(value) => {
        seen?.(value);
        setMe(value);
      }}
      heading={createRef()}
    />
  );
}

beforeEach(() => {
  calls = [];
  queues.clear();
  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  on("GET /api/v1/me/sessions", () => reply(200, []));
  setCsrfToken("token-1");
  // Google's script stays away unless a test brings its own.
  vi.mocked(loadGoogle).mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setCsrfToken(undefined);
});

describe("signing out", () => {
  it("keeps the account when the server refuses, and says why", async () => {
    // A 502 from the proxy while the API restarts: nothing was signed out.
    on("POST /api/v1/auth/logout-all", () => reply(502));
    const seen = vi.fn();
    render(<Page initial={account()} auth={google} seen={seen} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out everywhere" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The application service is unavailable. Try again.",
    );
    expect(seen).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Welcome back, Alice." }),
    ).toBeInTheDocument();
    expect(currentCsrfToken()).toBe("token-1");
  });

  it("keeps the account when the network fails", async () => {
    on("POST /api/v1/auth/logout", () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    render(<Page initial={account()} auth={google} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The application service is unavailable. Try again.",
    );
    expect(
      screen.getByRole("heading", { name: "Welcome back, Alice." }),
    ).toBeInTheDocument();
  });

  it("refreshes a stale token once and signs out", async () => {
    // Another tab signed this browser in again, so this page's token is stale.
    on(
      "POST /api/v1/auth/logout",
      () => reply(403, { code: "csrf_failed", message: "Refused." }),
      () => reply(204),
    );
    on("GET /api/v1/me", () => reply(200, account({ csrf_token: "token-2" })));
    const seen = vi.fn();
    render(<Page initial={account()} auth={google} seen={seen} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    const posts = calls.filter(
      (call) => call.route === "POST /api/v1/auth/logout",
    );
    expect(posts.map((call) => call.csrf)).toEqual(["token-1", "token-2"]);
    expect(seen).toHaveBeenCalledWith(null);
  });

  it("shows the account the browser holds now instead of signing it out", async () => {
    on("POST /api/v1/auth/logout-all", () =>
      reply(403, { code: "csrf_failed", message: "Refused." }),
    );
    const bob = account({
      id: "00000000-0000-4000-8000-000000000002",
      handle: "bob",
      display_name: "Bob",
      csrf_token: "token-3",
    });
    on("GET /api/v1/me", () => reply(200, bob));
    const seen = vi.fn();
    render(<Page initial={account()} auth={google} seen={seen} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out everywhere" }),
    );
    expect(
      await screen.findByText(/Another tab signed this browser in as bob/),
    ).toBeInTheDocument();
    // Alice asked for all her sessions to end: say plainly that they did not.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "so alice's sessions were not ended",
    );
    expect(seen).toHaveBeenCalledWith(bob);
    expect(seen).not.toHaveBeenCalledWith(null);
    expect(count("POST /api/v1/auth/logout-all")).toBe(1);
    // The profile form shows Bob's values, not Alice's.
    expect(screen.getByLabelText("Display name")).toHaveValue("Bob");
  });

  it("says the other sessions live on when this one had already ended", async () => {
    on("POST /api/v1/auth/logout-all", () =>
      reply(401, { code: "not_signed_in", message: "Sign in." }),
    );
    render(<Page initial={account()} auth={google} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out everywhere" }),
    );
    expect(
      await screen.findByText(/your other sessions could not be ended/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    expect(currentCsrfToken()).toBeUndefined();
  });

  it("signs out when the server confirms", async () => {
    on("POST /api/v1/auth/logout-all", () => reply(204));
    render(<Page initial={account()} auth={google} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out everywhere" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not be ended/)).not.toBeInTheDocument();
  });

  it("names each other session's button by its browser, apart from this browser's", async () => {
    const session = (id: string, current: boolean, agent: string) => ({
      id,
      kind: "google",
      current,
      created_at: "2026-10-19T10:00:00Z",
      last_seen_at: "2026-10-19T10:00:00Z",
      idle_expires_at: "2026-10-26T10:00:00Z",
      absolute_expires_at: "2026-11-02T10:00:00Z",
      source_address: null,
      user_agent: agent,
    });
    on(
      "GET /api/v1/me/sessions",
      () =>
        reply(200, [
          session("s1", true, "Firefox"),
          session("s2", false, "Safari"),
        ]),
      () => reply(200, [session("s1", true, "Firefox")]),
    );
    on("DELETE /api/v1/me/sessions/{session_id}", () => reply(204));
    render(<Page initial={account()} auth={google} />);
    const other = await screen.findByRole("button", {
      name: /^End the session in Safari, signed in /,
    });
    // Only this browser's button is "Sign out".
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
    fireEvent.click(other);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^End the session/ }),
      ).not.toBeInTheDocument(),
    );
    expect(count("DELETE /api/v1/me/sessions/{session_id}")).toBe(1);
  });

  it("sends one sign-out when the button is pressed twice", async () => {
    // Were a second request sent, the first would end every session and the second find
    // this one gone.
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    on(
      "POST /api/v1/auth/logout-all",
      () => first.promise,
      () => second.promise,
    );
    render(<Page initial={account()} auth={google} />);
    const button = screen.getByRole("button", { name: "Sign out everywhere" });
    // A double click: the second arrives before the page has drawn the first's answer.
    act(() => {
      button.click();
      button.click();
    });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await act(async () => first.resolve(reply(204)));
    await act(async () =>
      second.resolve(
        reply(401, { code: "not_signed_in", message: "Sign in." }),
      ),
    );
    expect(
      screen.getByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    expect(count("POST /api/v1/auth/logout-all")).toBe(1);
    expect(screen.queryByText(/could not be ended/)).not.toBeInTheDocument();
  });
});

describe("the signed-out screen", () => {
  it("does not claim sign-in is unconfigured before the bootstrap loads", () => {
    render(<Page initial={null} auth={undefined} />);
    expect(screen.getByText("Preparing sign-in…")).toBeInTheDocument();
    expect(screen.queryByText(/not set up/)).not.toBeInTheDocument();
  });

  it("offers a retry when the service did not answer", () => {
    const retry = vi.fn();
    render(
      <Page initial={null} auth={undefined} unavailable onRetry={retry} />,
    );
    expect(screen.getByText(/did not answer/)).toBeInTheDocument();
    expect(screen.queryByText(/not set up/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("says sign-in is not set up only when the server says so", () => {
    render(
      <Page
        initial={null}
        auth={{ google_client_id: null, signup_policy: "open" }}
      />,
    );
    expect(screen.getByText(/not set up on this server/)).toBeInTheDocument();
  });
});

describe("the Google button", () => {
  let configs: Parameters<GoogleId["initialize"]>[0][];
  let options: Parameters<GoogleId["renderButton"]>[1][];
  let issued: number;
  let visibility: DocumentVisibilityState;
  let focused: boolean;

  beforeEach(() => {
    configs = [];
    options = [];
    issued = 0;
    visibility = "visible";
    focused = true;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    const fake: GoogleId = {
      initialize: (config) => void configs.push(config),
      renderButton: (parent, settings) => {
        options.push(settings);
        const button = document.createElement("button");
        button.textContent = "Sign in with Google";
        button.dataset.nonce = configs.at(-1)!.nonce;
        parent.replaceChildren(button);
      },
      disableAutoSelect: () => {},
    };
    vi.mocked(loadGoogle).mockResolvedValue(fake);
    on("POST /api/v1/auth/google/start", () =>
      reply(200, { client_id: "client", nonce: `nonce-${++issued}` }),
    );
    // Timers stop while a device sleeps; the wall clock does not. Both are under test here.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  async function ready(nonce: string) {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sign in with Google" }),
      ).toHaveAttribute("data-nonce", nonce),
    );
  }
  async function later(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("renews an idle challenge before its 10 minutes lapse", async () => {
    render(<Page initial={null} auth={google} />);
    await ready("nonce-1");
    await later(8 * 60 * 1000);
    expect(count("POST /api/v1/auth/google/start")).toBe(1);
    await later(60 * 1000);
    await ready("nonce-2");
    expect(configs.map((config) => config.nonce)).toEqual([
      "nonce-1",
      "nonce-2",
    ]);
  });

  it("keeps the challenge while a sign-in with it is under way", async () => {
    render(<Page initial={null} auth={google} />);
    await ready("nonce-1");
    // Pressed at 8½ minutes: Google's window is open with this challenge's nonce.
    await later(8.5 * 60 * 1000);
    act(() => (options[0]!.click_listener as () => void)());
    await later(60 * 1000);
    expect(count("POST /api/v1/auth/google/start")).toBe(1);
    expect(screen.queryByText("Preparing Google sign-in…")).toBeNull();
    // Past its lifetime the challenge is dead anyway, so it is replaced.
    await later(30 * 1000);
    await ready("nonce-2");
  });

  it("keeps the challenge while the server checks Google's answer", async () => {
    const answer = deferred<unknown>();
    on("POST /api/v1/auth/google", () => answer.promise);
    render(<Page initial={null} auth={google} />);
    await ready("nonce-1");
    await later(8 * 60 * 1000);
    act(() => {
      void configs[0]!.callback({ credential: "header.payload.signature" });
    });
    // A new challenge now would replace the cookie the answer is checked against.
    await later(3 * 60 * 1000);
    expect(count("POST /api/v1/auth/google/start")).toBe(1);
    expect(screen.getByText("Signing you in…")).toBeInTheDocument();
    await act(async () => answer.resolve(reply(200, account())));
    expect(
      await screen.findByRole("heading", { name: "Welcome back, Alice." }),
    ).toBeInTheDocument();
  });

  it("renews early after a press that Google's window was closed on", async () => {
    render(<Page initial={null} auth={google} />);
    await ready("nonce-1");
    // Pressed, then closed without signing in: Google says nothing, and the page has focus.
    await later(60 * 1000);
    act(() => (options[0]!.click_listener as () => void)());
    await later(8 * 60 * 1000);
    await ready("nonce-2");
  });

  it("keeps the challenge while Google's pop-up holds focus", async () => {
    render(<Page initial={null} auth={google} />);
    await ready("nonce-1");
    await later(6 * 60 * 1000);
    act(() => (options[0]!.click_listener as () => void)());
    focused = false;
    await later(3.5 * 60 * 1000);
    expect(count("POST /api/v1/auth/google/start")).toBe(1);
    await later(30 * 1000);
    await ready("nonce-2");
  });

  it("waits until a hidden tab is shown again", async () => {
    render(<Page initial={null} auth={google} />);
    await ready("nonce-1");
    visibility = "hidden";
    await later(25 * 60 * 1000);
    expect(count("POST /api/v1/auth/google/start")).toBe(1);
    visibility = "visible";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await ready("nonce-2");
  });

  it("checks the challenge's age by the wall clock after the device sleeps", async () => {
    render(<Page initial={null} auth={google} />);
    await ready("nonce-1");
    // An hour asleep: no timer ran, but the challenge and its cookie expired.
    vi.setSystemTime(Date.now() + 65 * 60 * 1000);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await ready("nonce-2");
  });

  it("does not leave 'Signing you in…' when the network fails", async () => {
    on("POST /api/v1/auth/google", () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    render(<Page initial={null} auth={google} />);
    await ready("nonce-1");
    await act(async () => {
      await configs[0]!.callback({ credential: "header.payload.signature" });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The application service is unavailable. Try again.",
    );
    expect(screen.queryByText("Signing you in…")).toBeNull();
    // Google's answer is spent: the button comes back with a new challenge.
    await ready("nonce-2");
  });
});
