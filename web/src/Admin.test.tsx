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
import { CardImageError, fitCardImage } from "./admin/cardImage";
import { customCard, progress, roster } from "./alliance/fixtures";
import {
  client,
  type AdminUser,
  type AuditEntry,
  type Me,
  type ReportDetail,
  type ReportSummary,
} from "./api";
import { card } from "./decks/fixtures";

// The canvas work is cardImage.test.ts's; here the fitted image is handed over as it would be.
vi.mock("./admin/cardImage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin/cardImage")>()),
  fitCardImage: vi.fn(),
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
function user(
  handle: string,
  status: AdminUser["status"],
  fields: Partial<AdminUser> = {},
): AdminUser {
  return {
    id: `id-${handle}`,
    handle,
    display_name: handle.toUpperCase(),
    email: `${handle}@example.com`,
    created_at: "2026-10-19T10:00:00Z",
    last_seen_at: null,
    roles: ["player"],
    status,
    wins: 0,
    tier: "bronze",
    alliance: null,
    tokens: 0,
    ...fields,
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
  // The roster names each account's alliance (v0.3.1).
  on("GET /api/v1/planeswalkers", () => reply(200, roster));
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

describe("the card catalog", () => {
  const catalogAdministrator: Me = {
    ...administrator,
    permissions: ["catalog.manage"],
  };
  const run = {
    id: "run-1",
    trigger: "schedule",
    status: "succeeded",
    started_at: "2026-10-20T10:00:00Z",
    finished_at: "2026-10-20T10:02:03Z",
    error_code: null,
    error_message: null,
    next_attempt_at: null,
    revision_id: 3,
    stats: { downloaded: ["oracle_cards"], reused: ["rulings"] },
  };
  const status = {
    revision: {
      id: 3,
      created_at: "2026-10-20T10:02:03Z",
      engine_build: "1.4.62V1-eb69d05b",
      counts: {},
      changes: {},
    },
    last_run: run,
    next_run_at: "2026-10-21T10:12:00Z",
    stale: false,
    format_versions: { legacy: 2, commander: 1 },
    playable: 32089,
    cards: 33500,
  };
  const changed = card("Changed Card");
  const suspended = card("Held Card", {
    status: "suspended",
    status_reason: "suspended_by_staff",
    playable: false,
  });

  function serveCatalog() {
    on("GET /api/v1/catalog", () => reply(200, status));
    on("GET /api/v1/admin/catalog/runs", () => reply(200, [run]));
    on("GET /api/v1/catalog/coverage", () =>
      reply(200, {
        revision: 3,
        engine_build: "1.4.62V1-eb69d05b",
        formats: {
          legacy: [
            { status: "certified", reason: null, cards: 31711 },
            { status: "catalog_only", reason: "not_implemented", cards: 351 },
          ],
          commander: [],
        },
      }),
    );
    on("GET /api/v1/admin/catalog/reviews", () =>
      reply(200, [
        {
          card: changed,
          changed: [
            {
              revision: 3,
              before: { oracle_text: "Draw a card." },
              after: { oracle_text: "Draw two cards." },
            },
          ],
        },
        { card: suspended, changed: [] },
      ]),
    );
    on("GET /api/v1/cards", () =>
      reply(200, { items: [], total: 0, page: 1, page_size: 6 }),
    );
  }

  it("shows the sync, the engine's coverage and the cards to review", async () => {
    serveCatalog();
    render(<Admin me={catalogAdministrator} heading={createRef()} />);
    // The only section this account may open is shown at once.
    expect(screen.getByRole("tab", { name: "Card catalog" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await screen.findByText(/32,089 playable here · catalog revision 3/),
    ).toBeInTheDocument();
    const runs = screen.getByRole("table", { name: "Recent catalog runs" });
    expect(within(runs).getByText("New revision")).toBeInTheDocument();
    expect(
      within(runs).getByText("downloaded oracle_cards · reused rulings"),
    ).toBeInTheDocument();
    const legacy = screen.getByRole("table", { name: "Legacy coverage" });
    expect(
      within(legacy).getByText("Not supported by the game engine yet"),
    ).toBeInTheDocument();
    const review = screen.getByRole("listitem", { name: "Changed Card" });
    expect(review).toHaveTextContent("“Draw a card.” → “Draw two cards.”");
    expect(
      screen.getByRole("button", { name: "Restore Held Card" }),
    ).toBeInTheDocument();
  });

  it("queues a run and accepts a review", async () => {
    serveCatalog();
    on("POST /api/v1/admin/catalog/sync", () =>
      reply(202, { job_id: "job-1", due_at: "2026-10-20T11:00:00Z" }),
    );
    on("POST /api/v1/admin/catalog/cards/{card_id}/review", () =>
      reply(200, changed),
    );
    render(<Admin me={catalogAdministrator} heading={createRef()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Run the catalog sync now" }),
    );
    expect(await screen.findByText(/sync is queued/)).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "Accept Changed Card" }),
    );
    expect(
      await screen.findByText(/Changed Card: the engine's version is accepted/),
    ).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admin/catalog/cards/{card_id}/review",
      {
        params: { path: { card_id: changed.id } },
        body: { action: "accept", reason: "" },
      },
    );
  });

  it("says why a run cannot start", async () => {
    serveCatalog();
    on("POST /api/v1/admin/catalog/sync", () =>
      reply(409, {
        code: "sync_busy",
        message: "A catalog run is already queued or running.",
      }),
    );
    render(<Admin me={catalogAdministrator} heading={createRef()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Run the catalog sync now" }),
    );
    expect(
      await screen.findByText("A catalog run is already queued or running."),
    ).toBeInTheDocument();
  });
});

describe("wins, tiers and alliances (v0.3.1)", () => {
  const sysop: Me = {
    ...administrator,
    permissions: [...administrator.permissions, "progress.manage"],
  };

  it("are shown for each account, the tier's crest and the alliance's portrait beside their names", async () => {
    on(USERS, () =>
      page([
        user("ann", "active", {
          wins: 1234,
          tier: "platinum",
          alliance: "rowan",
        }),
        user("bob", "pending"),
      ]),
    );
    render(<Admin me={administrator} heading={createRef()} />);
    const ann = await screen.findByRole("listitem", { name: "ann" });
    expect(ann).toHaveTextContent("Wins1,234");
    expect(ann).toHaveTextContent("TierPlatinum");
    await waitFor(() => expect(ann).toHaveTextContent("AllianceRowan"));
    expect(ann.querySelector('svg[data-tier="platinum"]')).not.toBeNull();
    expect(
      ann.querySelector('img[src="/portraits/rowan-128.webp"]'),
    ).not.toBeNull();
    const bob = screen.getByRole("listitem", { name: "bob" });
    expect(bob).toHaveTextContent("Wins0");
    expect(bob).toHaveTextContent("TierBronze");
    expect(bob).toHaveTextContent("AllianceNone");
    // Administrators see them; only SysOp sets wins.
    expect(screen.queryByRole("button", { name: /^Set wins for/ })).toBeNull();
    expect(names()).toEqual(["ann", "bob"]);
  });

  it("show an alliance by its ID when the roster does not arrive", async () => {
    on("GET /api/v1/planeswalkers", () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    on(USERS, () => page([user("ann", "active", { alliance: "rowan" })]));
    render(<Admin me={administrator} heading={createRef()} />);
    expect(
      await screen.findByRole("listitem", { name: "ann" }),
    ).toHaveTextContent("Alliancerowan");
  });

  it("are set by SysOp with a reason, and the list follows", async () => {
    on(USERS, () => page([user("ann", "active", { wins: 3 })]));
    on("POST /api/v1/admin/users/{user_id}/wins", () =>
      reply(200, progress({ wins: 1000, counted_wins: 3, set_wins: 997 })),
    );
    render(<Admin me={sysop} heading={createRef()} />);
    const open = await screen.findByRole("button", {
      name: "Set wins for ann",
    });
    fireEvent.click(open);
    const form = screen.getByRole("form", { name: "Set wins for ann" });
    const wins = within(form).getByLabelText("Wins");
    expect(wins).toHaveValue(3);
    fireEvent.change(wins, { target: { value: "1000" } });
    fireEvent.change(within(form).getByLabelText(/^Reason/), {
      target: { value: "Testing Platinum" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save wins" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "ann: 1,000 wins, Platinum tier.",
      ),
    );
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admin/users/{user_id}/wins",
      {
        params: { path: { user_id: "id-ann" } },
        body: { wins: 1000, reason: "Testing Platinum" },
      },
    );
    const ann = screen.getByRole("listitem", { name: "ann" });
    expect(ann).toHaveTextContent("Wins1,000");
    expect(ann).toHaveTextContent("TierPlatinum");
    expect(screen.queryByRole("form", { name: "Set wins for ann" })).toBeNull();
  });

  it("are checked before they are sent, and a refusal says why", async () => {
    on(USERS, () => page([user("ann", "active")]));
    on("POST /api/v1/admin/users/{user_id}/wins", () =>
      reply(422, { code: "invalid_request", message: "Not today." }),
    );
    render(<Admin me={sysop} heading={createRef()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Set wins for ann" }),
    );
    const form = screen.getByRole("form", { name: "Set wins for ann" });
    const wins = within(form).getByLabelText("Wins");
    fireEvent.change(wins, { target: { value: "-5" } });
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Wins are a whole number from 0 to 10,000,000.",
    );
    fireEvent.change(wins, { target: { value: "10" } });
    fireEvent.change(within(form).getByLabelText(/^Reason/), {
      target: { value: "ok" },
    });
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Give a reason of 3 to 200 characters.",
    );
    expect(calls).not.toContain("POST /api/v1/admin/users/{user_id}/wins");
    fireEvent.change(within(form).getByLabelText(/^Reason/), {
      target: { value: "Testing Silver" },
    });
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Not today.",
    );
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Set wins for ann" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Set wins for ann" }),
    ).toBeInTheDocument();
  });
});

describe("tokens (v0.4.0)", () => {
  const sysop: Me = {
    ...administrator,
    permissions: [...administrator.permissions, "economy.manage"],
  };
  const balance = (amount: number) => ({
    balance: amount,
    earned: 0,
    given: amount,
    spent: 0,
    entries: [],
  });

  it("show each account's balance; only SysOp gives tokens, with a reason", async () => {
    on(USERS, () => page([user("ann", "active", { tokens: 1000 })]));
    const view = render(<Admin me={administrator} heading={createRef()} />);
    const ann = await screen.findByRole("listitem", { name: "ann" });
    expect(ann).toHaveTextContent("Tokens1,000");
    expect(
      screen.queryByRole("button", { name: /^Give tokens to/ }),
    ).toBeNull();
    view.unmount();

    on("POST /api/v1/admin/users/{user_id}/tokens", () =>
      reply(200, balance(1500)),
    );
    render(<Admin me={sysop} heading={createRef()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Give tokens to ann" }),
    );
    const form = screen.getByRole("form", { name: "Give tokens to ann" });
    const amount = within(form).getByLabelText(/^Tokens/);
    fireEvent.change(amount, { target: { value: "0" } });
    fireEvent.submit(form);
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Give a whole number of tokens",
    );
    fireEvent.change(amount, { target: { value: "500" } });
    fireEvent.change(within(form).getByLabelText(/^Reason/), {
      target: { value: "Testing the shop" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Give tokens" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "ann: 1,500 tokens.",
      ),
    );
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/admin/users/{user_id}/tokens",
      {
        params: { path: { user_id: "id-ann" } },
        body: { amount: 500, reason: "Testing the shop" },
      },
    );
    expect(screen.getByRole("listitem", { name: "ann" })).toHaveTextContent(
      "Tokens1,500",
    );
  });

  it("have their rules and SysOp's daily cap on bots in their own section", async () => {
    on(USERS, () => page([]));
    on("GET /api/v1/admin/economy", () => reply(200, { bot_daily_cap: null }));
    on("PUT /api/v1/admin/economy", () => reply(200, { bot_daily_cap: 200 }));
    const view = render(<Admin me={administrator} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tokens" }));
    expect(
      await screen.findByText("Bots pay without a daily cap."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    view.unmount();

    render(<Admin me={sysop} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tokens" }));
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Cap the tokens bots pay each account in a day",
      }),
    );
    fireEvent.change(screen.getByLabelText("Daily cap in tokens"), {
      target: { value: "200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(
        "Bots now pay each account at most 200 tokens a day.",
      ),
    ).toBeInTheDocument();
    expect(client.PUT).toHaveBeenCalledWith("/api/v1/admin/economy", {
      body: { bot_daily_cap: 200 },
    });
  });
});

describe("the custom cards (v0.3.1)", () => {
  const sysop: Me = {
    ...administrator,
    permissions: [...administrator.permissions, "custom_cards.manage"],
  };
  const CARDS = "GET /api/v1/admin/custom-cards";
  beforeEach(() => {
    on(USERS, () => page([]));
    vi.mocked(fitCardImage).mockReset();
    // jsdom has no object URLs.
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });
  async function open(me: Me = sysop) {
    render(<Admin me={me} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Custom cards" }));
    return screen.findByRole("form", { name: "Upload a custom card" });
  }

  it("are SysOp's alone", () => {
    render(<Admin me={administrator} heading={createRef()} />);
    expect(screen.queryByRole("tab", { name: "Custom cards" })).toBeNull();
  });

  it("are listed with their images, and one is removed only once confirmed", async () => {
    on(
      CARDS,
      () => reply(200, [customCard("Stand-in Sigil")]),
      () => reply(200, []),
    );
    on("DELETE /api/v1/admin/custom-cards/{card_id}", () => reply(204));
    await open();
    const sigil = await screen.findByRole("listitem", {
      name: "Stand-in Sigil",
    });
    expect(
      within(sigil).getByRole("img", { name: "Stand-in Sigil" }),
    ).toHaveAttribute(
      "src",
      "/api/v1/custom-cards/custom-stand-in-sigil/image?v=1",
    );
    expect(sigil).toHaveTextContent(
      "{1}{U} · Artifact — Stand-in · mythic · tst",
    );
    fireEvent.click(
      within(sigil).getByRole("button", { name: "Remove Stand-in Sigil" }),
    );
    expect(calls).not.toContain("DELETE /api/v1/admin/custom-cards/{card_id}");
    fireEvent.click(within(sigil).getByRole("button", { name: "Keep it" }));
    fireEvent.click(
      within(sigil).getByRole("button", { name: "Remove Stand-in Sigil" }),
    );
    fireEvent.click(
      within(sigil).getByRole("button", {
        name: "Remove Stand-in Sigil for good",
      }),
    );
    expect(
      await screen.findByText("Stand-in Sigil is removed."),
    ).toBeInTheDocument();
    expect(client.DELETE).toHaveBeenCalledWith(
      "/api/v1/admin/custom-cards/{card_id}",
      { params: { path: { card_id: "custom-stand-in-sigil" } } },
    );
    expect(await screen.findByText("No custom cards yet.")).toBeInTheDocument();
  });

  it("are uploaded as WebP fitted in the browser, with their text", async () => {
    on(
      CARDS,
      () => reply(200, []),
      () => reply(200, [customCard("Stand-in Herald")]),
    );
    on("POST /api/v1/admin/custom-cards", () =>
      reply(200, customCard("Stand-in Herald")),
    );
    vi.mocked(fitCardImage).mockResolvedValue({
      blob: new Blob([new Uint8Array(2400)], { type: "image/webp" }),
      width: 745,
      height: 1040,
      quality: 0.92,
    });
    const form = await open();
    // Only the Godlike tier's Planeswalker takes custom cards.
    const owner = within(form).getByLabelText("Planeswalker");
    await waitFor(() => expect(owner).toHaveValue("the-sphinx"));
    expect(
      within(owner)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["The Sphinx"]);
    // No image yet: nothing is sent.
    fireEvent.change(within(form).getByLabelText("Name"), {
      target: { value: "Stand-in Herald" },
    });
    fireEvent.change(within(form).getByLabelText("Type line"), {
      target: { value: "Creature — Stand-in" },
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "Upload the card" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose the card's image first.",
    );
    fireEvent.change(within(form).getByLabelText("Rules text"), {
      target: { value: "Flying" },
    });
    fireEvent.change(within(form).getByLabelText("Power"), {
      target: { value: "2" },
    });
    fireEvent.change(within(form).getByLabelText("Toughness"), {
      target: { value: "3" },
    });
    const original = new File(["raw"], "herald.png", { type: "image/png" });
    fireEvent.change(within(form).getByLabelText(/^Image/), {
      target: { files: [original] },
    });
    expect(
      await within(form).findByText("Ready: 745 × 1040 WebP, 2 KB."),
    ).toBeInTheDocument();
    expect(fitCardImage).toHaveBeenCalledWith(original);
    expect(
      within(form).getByRole("img", {
        name: "The image as it will be uploaded",
      }),
    ).toHaveAttribute("src", "blob:preview");
    fireEvent.click(
      within(form).getByRole("button", { name: "Upload the card" }),
    );
    expect(
      await screen.findByText("Stand-in Herald is saved."),
    ).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith("/api/v1/admin/custom-cards", {
      body: {
        name: "Stand-in Herald",
        planeswalker: "the-sphinx",
        mana_cost: null,
        type_line: "Creature — Stand-in",
        oracle_text: "Flying",
        flavor_text: null,
        power: "2",
        toughness: "3",
        loyalty: null,
        rarity: "mythic",
        set_code: null,
        collector_number: null,
        artist: null,
        image: "A".repeat(3200),
        image_type: "image/webp",
      },
    });
    expect(
      await screen.findByRole("listitem", { name: "Stand-in Herald" }),
    ).toBeInTheDocument();
    // The form is ready for the next card.
    expect(within(form).getByLabelText("Name")).toHaveValue("");
    expect(within(form).queryByRole("img")).toBeNull();
  });

  it("say why an image cannot be made ready", async () => {
    on(CARDS, () => reply(200, []));
    vi.mocked(fitCardImage).mockRejectedValue(
      new CardImageError(
        "This browser cannot make WebP images. Use a current Chrome, Edge or Firefox.",
      ),
    );
    const form = await open();
    fireEvent.change(within(form).getByLabelText(/^Image/), {
      target: { files: [new File(["raw"], "x.png", { type: "image/png" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This browser cannot make WebP images.",
    );
    expect(calls).not.toContain("POST /api/v1/admin/custom-cards");
  });
});

describe("what waits, and the problem reports (v0.4.1)", () => {
  const REPORTS = "GET /api/v1/admin/reports";
  const DETAIL = "GET /api/v1/admin/reports/{report_id}";
  const STATUS = "POST /api/v1/admin/reports/{report_id}/status";
  const reader: Me = {
    ...administrator,
    permissions: [...administrator.permissions, "reports.manage"],
  };
  const counts = { pending_accounts: 2, unread_reports: 1 };
  const summary: ReportSummary = {
    id: "r1",
    created_at: "2026-10-21T12:00:00Z",
    status: "new",
    summary: "The board froze",
    reporter: { id: "id-ada", handle: "ada", display_name: "Ada" },
    page: "#game/g1",
    app_version: "0.4.1",
    game_id: "8f14e45f-ceea-467f-a0e6-9d8b2c0e5f6a",
    game_turn: 7,
    screenshot: true,
  };
  const detail = (status: ReportDetail["status"]): ReportDetail => ({
    ...summary,
    status,
    description: "I passed priority.\nNothing happened.",
    api_version: "0.4.1",
    user_agent: "Mozilla/5.0 (test browser)",
    viewport_width: 1366,
    viewport_height: 768,
    pixel_ratio: 2,
    requests: [
      {
        method: "POST",
        path: "/api/v1/games",
        status: 0,
        request_id: null,
        at: "2026-10-21T11:59:58Z",
      },
      {
        method: "GET",
        path: "/api/v1/me",
        status: 200,
        request_id: "0f9c1e0a-1b2c-4d3e-8f90-123456789abc",
        at: "2026-10-21T11:59:59Z",
      },
    ],
    screenshot_width: 1280,
    screenshot_height: 720,
    status_changed_at: status === "new" ? null : "2026-10-21T12:05:00Z",
    status_changed_by: status === "new" ? null : { id: null, label: "sysop" },
  });
  /** What each request of the route asked for: its parameters, in order. */
  function queried(route: string) {
    const asked = vi.mocked(client.GET).mock.calls as unknown as [
      string,
      { params?: { query?: object } } | undefined,
    ][];
    return asked
      .filter(([path]) => `GET ${path}` === route)
      .map(([, init]) => init?.params);
  }

  it("counts on the tabs, with a way to the accounts that wait", async () => {
    on(USERS, () => page([user("ann", "active")]));
    const refresh = vi.fn();
    render(
      <Admin
        me={reader}
        heading={createRef()}
        counts={counts}
        onCounts={refresh}
      />,
    );
    expect(
      screen.getByRole("tab", {
        name: "Accounts, 2 accounts waiting for approval",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Reports, 1 unread report" }),
    ).toBeInTheDocument();
    await screen.findByRole("listitem", { name: "ann" });
    expect(
      screen.getByText("2 accounts waiting for approval."),
    ).toBeInTheDocument();
    on(USERS, () => page([user("pat", "pending")]));
    fireEvent.click(
      screen.getByRole("button", { name: "Show the waiting accounts" }),
    );
    await screen.findByRole("listitem", { name: "pat" });
    expect(queried(USERS).at(-1)).toMatchObject({
      query: { status: "pending" },
    });
    expect(screen.getByRole("combobox", { name: "Show" })).toHaveValue(
      "pending",
    );
    // An approval changes the counts: they are asked for again.
    on("POST /api/v1/admin/users/{user_id}/status", () =>
      reply(200, user("pat", "active")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve pat" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows no tab of reports to an account without reports.manage", () => {
    on(USERS, () => page([]));
    render(<Admin me={administrator} heading={createRef()} />);
    expect(screen.queryByRole("tab", { name: /Reports/ })).toBeNull();
  });

  it("lists new and seen reports; opening one reads it, and its status can be set", async () => {
    on(USERS, () => page([]));
    on(REPORTS, () => reply(200, { items: [summary], next_cursor: null }));
    on(DETAIL, () => reply(200, detail("new")));
    on(
      STATUS,
      () => reply(200, detail("seen")),
      () => reply(200, detail("fixed")),
    );
    const refresh = vi.fn();
    render(
      <Admin
        me={reader}
        heading={createRef()}
        counts={counts}
        onCounts={refresh}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Reports/ }));
    const item = await screen.findByRole("listitem", {
      name: "The board froze",
    });
    expect(queried(REPORTS).at(-1)).toMatchObject({
      query: { status: ["new", "seen"] },
    });
    expect(item).toHaveTextContent("ada (Ada)");
    expect(item).toHaveTextContent("#game/g1");
    expect(item).toHaveTextContent("v0.4.1");
    expect(item).toHaveTextContent("game 8f14e45f, turn 7");
    expect(item).toHaveTextContent("NEW");

    fireEvent.click(
      within(item).getByRole("button", { name: "Open “The board froze”" }),
    );
    expect(
      await within(item).findByText(/I passed priority\./),
    ).toBeInTheDocument();
    // Opened, a new report is seen.
    await waitFor(() => expect(item).toHaveTextContent("SEEN"));
    expect(calls).toContain(STATUS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(item).toHaveTextContent("Mozilla/5.0 (test browser)");
    expect(item).toHaveTextContent("1366 × 768 at 2×");
    expect(item).toHaveTextContent("Web app 0.4.1 · API 0.4.1");
    expect(item).toHaveTextContent("0f9c1e0a-1b2c-4d3e-8f90-123456789abc");
    expect(item).toHaveTextContent("No answer");
    expect(item).toHaveTextContent("by sysop");
    // The API's own image, with the session's cookie.
    expect(
      within(item).getByRole("img", {
        name: "Screenshot sent with “The board froze”",
      }),
    ).toHaveAttribute("src", "/api/v1/admin/reports/r1/screenshot");

    fireEvent.change(within(item).getByRole("combobox", { name: "Status" }), {
      target: { value: "fixed" },
    });
    await waitFor(() => expect(item).toHaveTextContent("FIXED"));
    expect(vi.mocked(client.POST).mock.calls.at(-1)?.[1]).toMatchObject({
      params: { path: { report_id: "r1" } },
      body: { status: "fixed" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "“The board froze”: Fixed.",
    );
    expect(refresh).toHaveBeenCalledTimes(2);

    // Every report, whatever its status.
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), {
      target: { value: "all" },
    });
    await waitFor(() =>
      expect(queried(REPORTS).at(-1)).toMatchObject({
        query: { status: undefined },
      }),
    );
  });

  it("says when no report matches, or the list cannot load", async () => {
    on(USERS, () => page([]));
    on(
      REPORTS,
      () => reply(200, { items: [], next_cursor: null }),
      () => reply(503, { code: "service_unavailable", message: unavailable }),
    );
    render(<Admin me={reader} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Reports/ }));
    expect(await screen.findByText("No reports match.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(unavailable),
    );
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
