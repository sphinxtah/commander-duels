import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Account, SignIn, Waiting } from "./Account";
import {
  ANSWER_MS,
  client,
  currentCsrfToken,
  setCsrfToken,
  type Me,
} from "./api";
import { progress, roster, starterDecks } from "./alliance/fixtures";
import { loadGoogle, type GoogleId } from "./google";

vi.mock("./google", () => ({ loadGoogle: vi.fn() }));

// The API, answered route by route. Each route takes its answers in order and keeps the last.
type Answer = (init?: { signal?: AbortSignal }) => unknown;
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
  return (async (path: string, init?: { signal?: AbortSignal }) => {
    const route = `${method} ${path}`;
    calls.push({ route, csrf: currentCsrfToken() });
    const queue = queues.get(route);
    if (!queue?.length) throw new Error(`No answer for ${route}`);
    return (queue.length > 1 ? queue.shift()! : queue[0])(init);
  }) as never;
}
/** A request the service holds on to, as a stalled proxy does, until the page gives up on it. */
const stall: Answer = (init) =>
  new Promise((_, fail) =>
    init?.signal?.addEventListener("abort", () =>
      fail(new DOMException("The operation was aborted.", "AbortError")),
    ),
  );

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

/**
 * The account's screens inside a page that keeps the account it is handed, as App does: the
 * sign-in when signed out, the wait until approval, and Profile once active.
 */
function Page({
  initial,
  auth,
  unavailable = false,
  onRetry = () => {},
  seen,
}: {
  initial: Me | null;
  auth: Parameters<typeof SignIn>[0]["auth"];
  unavailable?: boolean;
  onRetry?: () => void;
  seen?: (me: Me | null) => void;
}) {
  const [me, setMe] = useState<Me | null>(initial);
  const [notice, setNotice] = useState("");
  const change = (value: Me | null) => {
    seen?.(value);
    setMe(value);
    if (value) setNotice("");
  };
  const signedOut = (said: string) => {
    setNotice(said);
    change(null);
  };
  if (!me)
    return (
      <SignIn
        auth={auth}
        unavailable={unavailable}
        onRetry={onRetry}
        notice={notice}
        onSignedIn={change}
        heading={createRef()}
      />
    );
  if (me.status !== "active")
    return (
      <Waiting
        me={me}
        onChange={change}
        onSignedOut={signedOut}
        heading={createRef()}
      />
    );
  return (
    <Account
      me={me}
      onChange={change}
      onSignedOut={signedOut}
      heading={createRef()}
    />
  );
}

beforeEach(() => {
  calls = [];
  queues.clear();
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  on("GET /api/v1/me/sessions", () => reply(200, []));
  // Profile's progress and the roster (v0.3.1).
  on("GET /api/v1/me/progress", () => reply(200, progress()));
  on("GET /api/v1/planeswalkers", () => reply(200, roster));
  // Profile's tokens (v0.4.0).
  on("GET /api/v1/me/tokens", () =>
    reply(200, {
      balance: 1000,
      earned: 0,
      given: 1000,
      spent: 0,
      entries: [],
    }),
  );
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
    // Below the sign-in button, the one line the page has to say.
    expect(screen.getByText("You signed out.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.queryByText(/could not be ended/)).not.toBeInTheDocument();
    expect(currentCsrfToken()).toBeUndefined();
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

  it("keeps the sessions it shows when the network drops", async () => {
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
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    on(
      "GET /api/v1/me/sessions",
      () =>
        reply(200, [
          session("s1", true, "Firefox"),
          session("s2", false, "Safari"),
        ]),
      offline,
    );
    on("DELETE /api/v1/me/sessions/{session_id}", offline, () => reply(204));
    render(<Page initial={account()} auth={google} />);
    const other = await screen.findByRole("button", {
      name: /^End the session in Safari, signed in /,
    });
    // Ending it fails on the way out: the page says so instead of failing silently.
    fireEvent.click(other);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The application service is unavailable. Try again.",
    );
    // Ending it works, but the fresh list does not arrive: the list stays as it was.
    fireEvent.click(other);
    await waitFor(() => expect(count("GET /api/v1/me/sessions")).toBe(2));
    await act(() => new Promise((done) => setTimeout(done, 0)));
    expect(count("DELETE /api/v1/me/sessions/{session_id}")).toBe(2);
    expect(other).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Welcome back, Alice." }),
    ).toBeInTheDocument();
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

describe("the wait for approval", () => {
  const pending = () =>
    account({
      status: "pending",
      onboarding: "handle",
      handle: null,
      email: "new@example.com",
      permissions: [],
      roles: [],
    });
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  /** Lets every pending answer arrive (setTimeout stays real under the fake intervals). */
  async function settle() {
    await act(() => new Promise((done) => setTimeout(done, 0)));
  }
  async function later(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    await settle();
  }

  it("shows the account's state, its email and Sign out, and nothing more", async () => {
    render(<Page initial={pending()} auth={google} />);
    expect(
      screen.getByRole("heading", {
        name: "Your request to join the Commander Duels beta is in.",
      }),
    ).toBeInTheDocument();
    // Written for someone who has never heard of the site (v0.4.1): who decides, that there is
    // nothing to do, and whom to ask, with no promise of when.
    expect(
      screen.getByText("The site's owner reviews each request by hand."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "There is nothing else to do. This page checks every minute and opens the site once you are approved, so you can leave it open, or come back later and sign in with the same Google account.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("new@example.com").parentElement).toHaveTextContent(
      /^Signed in as new@example\.com$/,
    );
    expect(screen.getByText(/^Questions\?/)).toHaveTextContent(
      "Questions? info@thesphinx.co",
    );
    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual(["mailto:info@thesphinx.co"]);
    expect(document.body).not.toHaveTextContent(/\b(hours?|days?|soon)\b/i);
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Check again", "Sign out"]);
    // The handle comes after approval, and so does everything else.
    expect(screen.queryByLabelText("Handle")).toBeNull();
    await settle();
    expect(calls).toEqual([]);
  });

  it("asks again every minute while shown, and when the window comes back", async () => {
    on("GET /api/v1/me", () => reply(200, pending()));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render(<Page initial={pending()} auth={google} />);
    await later(59 * 1000);
    expect(count("GET /api/v1/me")).toBe(0);
    await later(1000);
    expect(count("GET /api/v1/me")).toBe(1);
    // A hidden page waits; being shown again asks at once.
    visibility = "hidden";
    await later(2 * 60 * 1000);
    expect(count("GET /api/v1/me")).toBe(1);
    visibility = "visible";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(count("GET /api/v1/me")).toBe(2);
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(count("GET /api/v1/me")).toBe(3);
    // Focus and visibility arriving together ask once.
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(count("GET /api/v1/me")).toBe(4);
  });

  it("says when Check again finds it still waiting, and an approval opens the account", async () => {
    on(
      "GET /api/v1/me",
      () => reply(200, pending()),
      () =>
        reply(200, account({ onboarding: "handle", handle: null, roles: [] })),
    );
    const seen = vi.fn();
    render(<Page initial={pending()} auth={google} seen={seen} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByText("Still waiting for approval."),
    ).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByRole("heading", { name: "Welcome to the table." }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Choose your handle" }),
    ).toBeInTheDocument();
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("keeps the account when the service does not answer", async () => {
    on("GET /api/v1/me", () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const seen = vi.fn();
    render(<Page initial={pending()} auth={google} seen={seen} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByText(
        "The application service is unavailable. Try again.",
      ),
    ).toBeInTheDocument();
    expect(seen).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        name: "Your request to join the Commander Duels beta is in.",
      }),
    ).toBeInTheDocument();
  });

  it("gives up on a check the service holds on to, so the next one can ask", async () => {
    on("GET /api/v1/me", stall, () =>
      reply(200, account({ onboarding: "handle", handle: null, roles: [] })),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<Page initial={pending()} auth={google} />);
    const check = screen.getByRole("button", { name: "Check again" });
    fireEvent.click(check);
    await act(() => vi.advanceTimersByTimeAsync(ANSWER_MS - 1));
    expect(check).toHaveAttribute("aria-disabled", "true");
    // Window focus asks nothing while a check is under way.
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(count("GET /api/v1/me")).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(
      screen.getByText("The application service is unavailable. Try again."),
    ).toBeInTheDocument();
    expect(check).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(check);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(
      screen.getByRole("heading", { name: "Welcome to the table." }),
    ).toBeInTheDocument();
  });

  it("leads to the sign-in when the session ended elsewhere", async () => {
    on("GET /api/v1/me", () =>
      reply(401, { code: "not_signed_in", message: "Sign in." }),
    );
    const seen = vi.fn();
    render(<Page initial={pending()} auth={google} seen={seen} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    expect(seen).toHaveBeenCalledWith(null);
    expect(screen.queryByText("You signed out.")).toBeNull();
    expect(currentCsrfToken()).toBeUndefined();
  });

  it("lets a sign-out win over a look that was under way", async () => {
    const look = deferred<unknown>();
    on("GET /api/v1/me", () => look.promise);
    on("POST /api/v1/auth/logout", () => reply(204));
    render(<Page initial={pending()} auth={google} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("You signed out.")).toBeInTheDocument();
    await act(async () => look.resolve(reply(200, pending())));
    await settle();
    expect(
      screen.getByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "Your request to join the Commander Duels beta is in.",
      }),
    ).toBeNull();
  });

  it("lets a sign-out win over a look that answers before the sign-in is drawn", async () => {
    const look = deferred<unknown>();
    const out = deferred<unknown>();
    on("GET /api/v1/me", () => look.promise);
    on("POST /api/v1/auth/logout", () => out.promise);
    render(<Page initial={pending()} auth={google} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    // Inside one act, nothing is drawn until its end: the sign-out has finished, but the waiting
    // page is still there, when the look's answer arrives.
    await act(async () => {
      out.resolve(reply(204));
      await new Promise((done) => setTimeout(done, 0));
      look.resolve(reply(200, pending()));
      await new Promise((done) => setTimeout(done, 0));
    });
    await settle();
    expect(screen.getByText("You signed out.")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    expect(count("GET /api/v1/me")).toBe(1);
  });

  it("tells a denied account so, and lets it only sign out", async () => {
    on("POST /api/v1/auth/logout", () => reply(204));
    render(<Page initial={account({ status: "denied" })} auth={google} />);
    expect(
      screen.getByRole("heading", {
        name: "Your request was not approved this time.",
      }),
    ).toBeInTheDocument();
    const note = screen.getByText(/^If you think this is a mistake/);
    expect(note).toHaveTextContent(
      "If you think this is a mistake, write to info@thesphinx.co. A request that is not approved is deleted 30 days after it was made.",
    );
    expect(
      within(note).getByRole("link", { name: "info@thesphinx.co" }),
    ).toHaveAttribute("href", "mailto:info@thesphinx.co");
    expect(
      screen.getByText("alice@example.com").parentElement,
    ).toHaveTextContent(/^Signed in as alice@example\.com$/);
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Sign out"]);
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(count("GET /api/v1/me")).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("You signed out.")).toBeInTheDocument();
  });
});

describe("the signed-out screen", () => {
  it("has nothing to read: its heading and its states are for screen readers", () => {
    render(<Page initial={null} auth={google} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Sign in",
    );
    // While Google's script loads, only the hidden heading and status are there: no privacy
    // note or sign-up policy any more (v0.3.0).
    expect(document.body).toHaveTextContent(
      /^Sign in\s*Preparing Google sign-in…$/,
    );
  });

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

describe("the starter decks at onboarding (v0.3.1)", () => {
  const choosing = () => account({ onboarding: "starters" });
  beforeEach(() => {
    on("GET /api/v1/decks/starters", () => reply(200, starterDecks));
  });

  it("follow the handle, with focus on their heading", async () => {
    on("PATCH /api/v1/me", () => reply(200, choosing()));
    render(
      <Page
        initial={account({ onboarding: "handle", handle: null })}
        auth={google}
      />,
    );
    fireEvent.change(screen.getByLabelText("Handle"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save handle" }));
    const heading = await screen.findByRole("heading", {
      name: "Choose two starter decks",
    });
    // The heading takes focus once the step has drawn, which a busy machine may finish a tick
    // after the heading appears.
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Welcome to the table.",
    );
    // The profile, the alliance and the progress wait until onboarding is done.
    expect(screen.queryByLabelText("Display name")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Your alliance" })).toBeNull();
  });

  it("show each deck's commander, colours, description, how to play it and what it teaches, and take exactly two", async () => {
    render(<Page initial={choosing()} auth={google} />);
    const skies = await screen.findByRole("checkbox", {
      name: "Stand-in Skies",
    });
    const item = skies.closest("li")!;
    expect(item.querySelector("img")).toHaveAttribute(
      "src",
      "/api/v1/card-images/printings/printing-starter_one?size=normal",
    );
    expect(item).toHaveTextContent("White / Blue · Azorius");
    expect(item).toHaveTextContent("Commander: Stand-in Skies Leader");
    expect(skies).toHaveAccessibleDescription(
      /^Stand-in Skies plays a stand-in game\.\s*How to play\. Play Stand-in Skies with care\.\s*Teaches\. Stand-in lessons\.$/,
    );
    // A commander with no printing shows its name in a frame instead.
    const embers = screen.getByRole("checkbox", { name: "Stand-in Embers" });
    expect(embers.closest("li")!.querySelector("img")).toBeNull();
    expect(embers.closest("li")).toHaveTextContent("Stand-in Embers Leader");

    const confirm = screen.getByRole("button", {
      name: "Confirm these two decks",
    });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("No deck chosen yet.")).toBeInTheDocument();
    fireEvent.click(skies);
    expect(
      screen.getByText("Chosen: Stand-in Skies. Choose one more."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Stand-in Graves" }));
    expect(
      screen.getByText("Chosen: Stand-in Skies and Stand-in Graves."),
    ).toBeInTheDocument();
    // Two are the most: the third waits until one of the two is let go.
    expect(embers).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(skies);
    expect(embers).toBeEnabled();
    expect(confirm).toHaveAttribute("aria-disabled", "true");
  });

  it("say so when Confirm is pressed before two are chosen", async () => {
    render(<Page initial={choosing()} auth={google} />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Stand-in Skies" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm these two decks" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose two starter decks first.",
    );
    expect(count("POST /api/v1/me/starters")).toBe(0);
  });

  it("are sent in the order chosen, then an alliance is offered, which can wait until later", async () => {
    on("POST /api/v1/me/starters", () =>
      reply(201, { decks: ["deck-1", "deck-2"] }),
    );
    on("GET /api/v1/me", () => reply(200, account()));
    const seen = vi.fn();
    render(<Page initial={choosing()} auth={google} seen={seen} />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Stand-in Graves" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Stand-in Skies" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm these two decks" }),
    );
    const offer = await screen.findByRole("heading", {
      name: "Choose an alliance",
    });
    expect(document.activeElement).toBe(offer);
    expect(client.POST).toHaveBeenCalledWith("/api/v1/me/starters", {
      body: { decks: ["starter_two", "starter_one"] },
    });
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({ onboarding: "complete" }),
    );
    // The roster by tier: open ones to ally with, locked ones not.
    expect(
      screen.getByRole("button", { name: "Ally with Rowan" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ally with Kaya" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    const alliance = await screen.findByRole("heading", {
      name: "Your alliance",
    });
    expect(document.activeElement).toBe(alliance);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Welcome back, Alice.",
    );
    expect(
      screen.getByText(
        "You are in no alliance yet, so your profile shows your avatar.",
      ),
    ).toBeInTheDocument();
    expect(count("PUT /api/v1/me/alliance")).toBe(0);
  });

  it("lead to an alliance chosen at once, which the profile then shows", async () => {
    on("POST /api/v1/me/starters", () =>
      reply(201, { decks: ["deck-1", "deck-2"] }),
    );
    on(
      "GET /api/v1/me",
      () => reply(200, account()),
      () => reply(200, account({ alliance: "rowan" })),
    );
    on("PUT /api/v1/me/alliance", () =>
      reply(
        200,
        progress({ alliance: "rowan", alliance_since: "2026-10-21T10:00:00Z" }),
      ),
    );
    render(<Page initial={choosing()} auth={google} />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Stand-in Skies" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Stand-in Graves" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm these two decks" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Ally with Rowan" }),
    );
    expect(
      await screen.findByText(
        "You are allied with Rowan. Their Planeswalker cards are in your library, four copies of each.",
      ),
    ).toBeInTheDocument();
    expect(client.PUT).toHaveBeenCalledWith("/api/v1/me/alliance", {
      body: { planeswalker: "rowan" },
    });
    expect(
      screen.getByRole("heading", { name: "Your alliance" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Account" })).toHaveTextContent(
      "Allied with Rowan",
    );
    expect(
      screen.getByRole("button", { name: "Leave the alliance with Rowan" }),
    ).toBeInTheDocument();
  });

  it("go on when another tab chose them first", async () => {
    on("POST /api/v1/me/starters", () =>
      reply(409, {
        code: "starters_chosen",
        message: "Your starter decks are already chosen.",
      }),
    );
    on("GET /api/v1/me", () => reply(200, account()));
    render(<Page initial={choosing()} auth={google} />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Stand-in Skies" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Stand-in Graves" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm these two decks" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Choose an alliance" }),
    ).toBeInTheDocument();
  });

  it("say why they could not be chosen, and stay", async () => {
    on("POST /api/v1/me/starters", () =>
      reply(503, {
        code: "starters_unavailable",
        message:
          "The card catalog is not ready for the starter decks yet. Try again later.",
      }),
    );
    render(<Page initial={choosing()} auth={google} />);
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Stand-in Skies" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Stand-in Graves" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm these two decks" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The card catalog is not ready for the starter decks yet.",
    );
    expect(
      screen.getByRole("heading", { name: "Choose two starter decks" }),
    ).toBeInTheDocument();
    expect(count("GET /api/v1/me")).toBe(0);
  });

  it("offer Try again when the list does not arrive", async () => {
    on(
      "GET /api/v1/decks/starters",
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => reply(200, starterDecks),
    );
    render(<Page initial={choosing()} auth={google} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The application service is unavailable. Try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("checkbox", { name: "Stand-in Skies" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("progress and the alliance on Profile (v0.3.1)", () => {
  it("shows the alliance's portrait with the tier's crest, the wins and the way to the next tier", async () => {
    on("GET /api/v1/me/progress", () =>
      reply(
        200,
        progress({
          wins: 120,
          counted_wins: 20,
          set_wins: 100,
          alliance: "rowan",
          alliance_since: "2026-10-20T10:00:00Z",
        }),
      ),
    );
    render(<Page initial={account({ alliance: "rowan" })} auth={google} />);
    const card = screen.getByRole("region", { name: "Account" });
    expect(
      await within(card).findByRole("img", { name: "Gold tier" }),
    ).toBeInTheDocument();
    const portrait = within(card).getByRole("img", {
      name: "Rowan, painted for the tests.",
    });
    expect(portrait).toHaveAttribute("src", "/portraits/rowan-256.webp");
    expect(portrait).toHaveAttribute(
      "srcset",
      "/portraits/rowan-128.webp 128w, /portraits/rowan-256.webp 256w, /portraits/rowan-512.webp 512w",
    );
    expect(card).toHaveTextContent("Allied with Rowan");
    const bar = screen.getByRole("progressbar", {
      name: "Progress to Platinum",
    });
    expect(bar).toHaveAttribute("aria-valuenow", "20");
    expect(bar).toHaveAttribute("aria-valuemax", "900");
    expect(bar).toHaveAttribute("aria-valuetext", "120 wins of 1,000 wins");
    expect(
      screen.getByText("880 more wins to reach Platinum at 1,000 wins."),
    ).toBeInTheDocument();
    // SysOp's settings are said apart from the games won.
    expect(
      screen.getByText("20 wins from games · +100 set by SysOp"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 cards playable here · allied since Oct 20, 2026"),
    ).toBeInTheDocument();
    // Only SysOp sets wins.
    expect(screen.queryByRole("form", { name: "Set your wins" })).toBeNull();
  });

  it("keeps the avatar with no alliance, and says when the tier is the highest", async () => {
    on("GET /api/v1/me/progress", () => reply(200, progress({ wins: 100000 })));
    render(<Page initial={account()} auth={google} />);
    const card = screen.getByRole("region", { name: "Account" });
    expect(
      await within(card).findByRole("img", { name: "Godlike tier" }),
    ).toBeInTheDocument();
    expect(card.querySelector("img")).toBeNull();
    expect(
      screen.getByText(
        "Godlike is the highest tier: every Planeswalker is open to you.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(
      screen.getByText(
        "You are in no alliance yet, so your profile shows your avatar.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the Godlike Planeswalker's portrait for its alliance (v0.4.1)", async () => {
    render(
      <Page initial={account({ alliance: "the-sphinx" })} auth={google} />,
    );
    const card = screen.getByRole("region", { name: "Account" });
    expect(
      await within(card).findByRole("img", {
        name: "The Sphinx, painted for the tests.",
      }),
    ).toHaveAttribute("src", "/portraits/the-sphinx-256.webp");
    expect(card.querySelector("svg[data-placeholder]")).toBeNull();
  });

  it("groups every Planeswalker by tier: open ones to ally with, locked ones with the wins that open them", async () => {
    on("PUT /api/v1/me/alliance", () =>
      reply(200, progress({ alliance: "abian" })),
    );
    on("GET /api/v1/me", () => reply(200, account({ alliance: "abian" })));
    const seen = vi.fn();
    render(<Page initial={account()} auth={google} seen={seen} />);
    const choose = await screen.findByRole("button", {
      name: "Choose an alliance",
    });
    expect(choose).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(choose);
    expect(
      screen.getByRole("button", { name: "Hide the Planeswalkers" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "BronzeOpen from the start",
      "SilverOpens at 10 wins",
      "MythicOpens at 10,000 wins",
      "GodlikeOpens at 100,000 wins",
    ]);
    const silver = screen.getByRole("region", { name: /^Silver/ });
    expect(within(silver).queryByRole("button")).toBeNull();
    expect(within(silver).getByRole("listitem")).toHaveTextContent(
      "KayaOpens at 10 wins1 card playable here",
    );
    // The Godlike tier's Planeswalker has its portrait since v0.4.1.
    const godlike = screen.getByRole("region", { name: /^Godlike/ });
    expect(godlike.querySelector("svg[data-placeholder]")).toBeNull();
    expect(godlike.querySelector("img")).toHaveAttribute(
      "src",
      "/portraits/the-sphinx-128.webp",
    );
    expect(godlike).toHaveTextContent("The Sphinx");

    const abian = screen.getByRole("button", { name: "Ally with Abian" });
    expect(abian).toHaveAccessibleDescription(
      "No cards playable here yet Abian, painted for the tests.",
    );
    expect(abian.querySelector("img")).toHaveAttribute(
      "src",
      "/portraits/abian-128.webp",
    );
    fireEvent.click(abian);
    expect(
      await screen.findByText(
        "You are allied with Abian. None of their cards can be played here yet.",
      ),
    ).toBeInTheDocument();
    expect(client.PUT).toHaveBeenCalledWith("/api/v1/me/alliance", {
      body: { planeswalker: "abian" },
    });
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({ alliance: "abian" }),
    );
    // The picker marks the alliance now, and offers the others.
    expect(
      screen.queryByRole("button", { name: "Ally with Abian" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Ally with Rowan" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: /^Bronze/ })).getByText(
        "Your alliance",
      ),
    ).toBeInTheDocument();
  });

  it("leaves the alliance", async () => {
    on("GET /api/v1/me/progress", () =>
      reply(200, progress({ alliance: "rowan" })),
    );
    on("DELETE /api/v1/me/alliance", () => reply(200, progress()));
    on("GET /api/v1/me", () => reply(200, account()));
    render(<Page initial={account({ alliance: "rowan" })} auth={google} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Leave the alliance with Rowan",
      }),
    );
    expect(
      await screen.findByText(
        "You left the alliance with Rowan. Their cards have left your library, except copies you own another way.",
      ),
    ).toBeInTheDocument();
    expect(count("DELETE /api/v1/me/alliance")).toBe(1);
    expect(
      screen.getByText(
        "You are in no alliance yet, so your profile shows your avatar.",
      ),
    ).toBeInTheDocument();
  });

  it("says why an alliance was refused, and keeps the one there was", async () => {
    on("PUT /api/v1/me/alliance", () =>
      reply(403, {
        code: "alliance_locked",
        message: "Rowan opens at 10 wins.",
      }),
    );
    const seen = vi.fn();
    render(<Page initial={account()} auth={google} seen={seen} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose an alliance" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Ally with Rowan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Rowan opens at 10 wins.",
    );
    expect(seen).not.toHaveBeenCalled();
    expect(count("GET /api/v1/me")).toBe(0);
  });

  it("offers Try again when the progress does not arrive", async () => {
    on(
      "GET /api/v1/me/progress",
      () => reply(502),
      () => reply(200, progress()),
    );
    render(<Page initial={account()} auth={google} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The application service is unavailable. Try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Your progress" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets SysOp set its own wins with a reason, and asks for the roster again", async () => {
    const sysop = account({
      kind: "sysop",
      handle: "sysop",
      display_name: "SysOp",
      email: null,
      roles: ["sysop"],
      permissions: ["progress.manage"],
    });
    on(
      "GET /api/v1/me/progress",
      () =>
        reply(
          200,
          progress({ wins: 100000, counted_wins: 0, set_wins: 100000 }),
        ),
      () =>
        reply(200, progress({ wins: 1000, counted_wins: 0, set_wins: 1000 })),
    );
    on("POST /api/v1/admin/users/{user_id}/wins", () =>
      reply(200, progress({ wins: 1000, counted_wins: 0, set_wins: 1000 })),
    );
    render(<Page initial={sysop} auth={google} />);
    const form = await screen.findByRole("form", { name: "Set your wins" });
    const wins = within(form).getByLabelText("Wins");
    await waitFor(() => expect(wins).toHaveValue(100000));
    // A reason is required.
    fireEvent.change(wins, { target: { value: "1000" } });
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Give a reason of 3 to 200 characters.",
    );
    expect(count("POST /api/v1/admin/users/{user_id}/wins")).toBe(0);
    fireEvent.change(within(form).getByLabelText(/^Reason/), {
      target: { value: "Testing Platinum" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save wins" }));
    expect(
      await within(form).findByText("Your wins are now 1,000: Platinum tier."),
    ).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admin/users/{user_id}/wins",
      {
        params: { path: { user_id: sysop.id } },
        body: { wins: 1000, reason: "Testing Platinum" },
      },
    );
    await waitFor(() => expect(count("GET /api/v1/planeswalkers")).toBe(2));
    expect(
      await screen.findByRole("img", { name: "Platinum tier" }),
    ).toBeInTheDocument();
  });
});
