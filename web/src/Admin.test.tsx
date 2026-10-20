import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin, SysopSignIn } from "./Admin";
import { client, type AdminUser, type AuditEntry, type Me } from "./api";

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
function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const administrator: Me = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "sysop",
  status: "active",
  onboarding: "complete",
  handle: "sysop",
  display_name: "SysOp",
  email: null,
  avatar: "tower",
  locale: "en",
  csrf_token: "token",
  permissions: [
    "admin.users.read",
    "admin.users.manage",
    "admin.roles.manage",
    "admin.audit.read",
  ],
  roles: ["sysop"],
  preferences: { large_text: false, reduced_motion: false },
  session: {
    id: "session-1",
    kind: "sysop",
    authenticated_at: "2026-10-19T10:00:00Z",
    idle_expires_at: "2026-10-19T11:00:00Z",
    absolute_expires_at: "2026-10-19T22:00:00Z",
  },
};
function user(handle: string, status: AdminUser["status"]): AdminUser {
  return {
    id: `id-${handle}`,
    handle,
    display_name: handle.toUpperCase(),
    email: `${handle}@example.com`,
    created_at: "2026-10-19T10:00:00Z",
    last_seen_at: null,
    roles: ["player"],
    status,
  };
}
function page(items: AdminUser[], next_cursor: string | null = null) {
  return reply(200, { items, next_cursor });
}
function event(id: string, action: string): AuditEntry {
  return {
    id,
    action,
    actor: { id: null, label: "SysOp" },
    target: null,
    details: {},
    occurred_at: "2026-10-19T10:00:00Z",
    source_address: null,
  };
}
const unavailable = "The application service is unavailable. Try again.";
const USERS = "GET /api/v1/admin/users";
const AUDIT = "GET /api/v1/admin/audit";

beforeEach(() => {
  calls = [];
  queues.clear();
  for (const method of ["GET", "POST", "PUT", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function names() {
  return screen
    .queryAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label"))
    .filter(Boolean);
}

describe("the accounts list", () => {
  it("applies only the newest load when filters change quickly", async () => {
    const pending = later<unknown>();
    const active = later<unknown>();
    on(
      USERS,
      () => page([user("first", "active")]),
      () => pending.promise,
      () => active.promise,
    );
    render(<Admin me={administrator} heading={createRef()} />);
    await screen.findByRole("listitem", { name: "first" });
    const show = screen.getByRole("combobox", { name: "Show" });
    fireEvent.change(show, { target: { value: "pending" } });
    fireEvent.change(show, { target: { value: "active" } });
    // The newer filter answers first; the older answer arrives last and must not win.
    await act(async () => active.resolve(page([user("ann", "active")])));
    await act(async () => pending.resolve(page([user("pat", "pending")])));
    expect(names()).toEqual(["ann"]);
  });

  it("adds a page once when 'Show more' is pressed twice", async () => {
    const second = later<unknown>();
    const third = later<unknown>();
    on(
      USERS,
      () => page([user("ann", "active")], "cursor-1"),
      () => second.promise,
      () => third.promise,
    );
    render(<Admin me={administrator} heading={createRef()} />);
    const more = await screen.findByRole("button", {
      name: "Show more accounts",
    });
    fireEvent.click(more);
    fireEvent.click(more);
    await act(async () => second.resolve(page([user("bob", "active")])));
    await act(async () => third.resolve(page([user("bob", "active")])));
    expect(names()).toEqual(["ann", "bob"]);
  });

  it("offers no 'Show more' for the old list while a new filter loads", async () => {
    const pending = later<unknown>();
    on(
      USERS,
      () => page([user("ann", "active")], "cursor-1"),
      () => pending.promise,
    );
    render(<Admin me={administrator} heading={createRef()} />);
    await screen.findByRole("button", { name: "Show more accounts" });
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), {
      target: { value: "pending" },
    });
    // The old list's cursor would page the old filter into the new list.
    expect(
      screen.queryByRole("button", { name: "Show more accounts" }),
    ).toBeNull();
    await act(async () =>
      pending.resolve(page([user("pat", "pending")], "cursor-2")),
    );
    expect(names()).toEqual(["pat"]);
    expect(
      screen.getByRole("button", { name: "Show more accounts" }),
    ).toBeInTheDocument();
  });

  it("says so when the request fails outright", async () => {
    on(USERS, () => Promise.reject(new TypeError("Failed to fetch")));
    render(<Admin me={administrator} heading={createRef()} />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(unavailable),
    );
  });

  it("reloads when the same search is submitted again", async () => {
    on(
      USERS,
      () => page([user("ann", "active")]),
      () => page([user("ann", "active"), user("new", "pending")]),
    );
    render(<Admin me={administrator} heading={createRef()} />);
    await screen.findByRole("listitem", { name: "ann" });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("listitem", { name: "new" });
    expect(calls.filter((call) => call === USERS)).toHaveLength(2);
  });

  it("clears a failed load's message once a load works, but keeps an action's", async () => {
    on(
      USERS,
      () => reply(502),
      () => page([user("pat", "pending")]),
    );
    render(<Admin me={administrator} heading={createRef()} />);
    const status = screen.getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(unavailable));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("listitem", { name: "pat" });
    expect(status).toHaveTextContent("");

    on("POST /api/v1/admin/users/{user_id}/status", () =>
      reply(200, user("pat", "active")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve pat" }));
    await waitFor(() => expect(status).toHaveTextContent("pat: Active."));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(calls.filter((call) => call === USERS)).toHaveLength(3),
    );
    await act(async () => {});
    expect(status).toHaveTextContent("pat: Active.");
  });
});

describe("email addresses", () => {
  it("are neither offered nor missed for a moderator, whom the API sends none", async () => {
    const moderator: Me = {
      ...administrator,
      kind: "player",
      permissions: ["admin.users.read"],
      roles: ["player", "moderator"],
    };
    on(USERS, () => page([{ ...user("ann", "active"), email: null }]));
    render(<Admin me={moderator} heading={createRef()} />);
    const ann = await screen.findByRole("listitem", { name: "ann" });
    expect(ann).toHaveTextContent(/Joined/);
    expect(ann).not.toHaveTextContent(/email/i);
    expect(screen.getByLabelText("Search handle or name")).toBeInTheDocument();
  });

  it("are shown to an administrator, and their absence named", async () => {
    on(USERS, () =>
      page([user("ann", "active"), { ...user("bob", "active"), email: null }]),
    );
    render(<Admin me={administrator} heading={createRef()} />);
    expect(
      await screen.findByRole("listitem", { name: "ann" }),
    ).toHaveTextContent("ann@example.com · joined");
    expect(screen.getByRole("listitem", { name: "bob" })).toHaveTextContent(
      "No email · joined",
    );
    expect(
      screen.getByLabelText("Search handle, name or email"),
    ).toBeInTheDocument();
  });
});

describe("the audit log", () => {
  it("clears the error when filtering again succeeds", async () => {
    on(
      AUDIT,
      () => reply(502),
      () =>
        reply(200, { items: [event("e1", "auth.login")], next_cursor: null }),
    );
    on(USERS, () => page([]));
    render(<Admin me={administrator} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Audit log" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(unavailable);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const table = await screen.findByRole("table");
    await within(table).findByText("auth.login");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the request fails outright", async () => {
    on(AUDIT, () => Promise.reject(new TypeError("Failed to fetch")));
    on(USERS, () => page([]));
    render(<Admin me={administrator} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Audit log" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(unavailable);
  });
});

describe("SysOp sign-in", () => {
  async function submit() {
    render(<SysopSignIn onSignedIn={vi.fn()} heading={createRef()} />);
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    return screen.findByRole("alert");
  }

  it("stays usable when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    expect(await submit()).toHaveTextContent(unavailable);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("says the service is unavailable when the proxy answers with a page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<h1>502 Bad Gateway</h1>", { status: 502 }),
      ),
    );
    expect(await submit()).toHaveTextContent(unavailable);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});
