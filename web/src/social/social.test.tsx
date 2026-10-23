import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { client, type Me } from "../api";
import { badges, stats } from "../records/fixtures";
import { FriendsPage } from "./FriendsPage";
import { NotificationBell, NotificationsPage, TOAST_MS } from "./Notifications";
import { PlayerPage } from "./PlayerPage";
import { PlayerSearch, SEARCH_DELAY_MS } from "./PlayerSearch";
import { PrivacySettings } from "./PrivacySettings";
import { CHECK_IN_MS, IDLE_MS, useSocial, type Social } from "./presence";
import {
  looksLikeEmail,
  notificationWords,
  presenceRank,
  presenceWords,
  timeAgo,
  type NotificationItem,
  type PlayerProfile,
  type PlayerSummary,
} from "./social";

// The API, answered route by route. Each route takes its answers in order and keeps the last.
type Call = { route: string; init?: Record<string, unknown> };
type Answer = (init?: Record<string, unknown>) => unknown;
const queues = new Map<string, Answer[]>();
let calls: Call[] = [];
function on(route: string, ...answers: Answer[]) {
  queues.set(route, answers);
}
function reply(status: number, body?: unknown) {
  const response = new Response(null, { status });
  return response.ok ? { data: body, response } : { error: body, response };
}
function serve(method: string) {
  return (async (path: string, init?: Record<string, unknown>) => {
    const route = `${method} ${path}`;
    calls.push({ route, init });
    const queue = queues.get(route);
    if (!queue?.length) throw new Error(`No answer for ${route}`);
    return (queue.length > 1 ? queue.shift()! : queue[0])(init);
  }) as never;
}
function sent(route: string): Call[] {
  return calls.filter((call) => call.route === route);
}
async function settle() {
  await act(() => new Promise((done) => setTimeout(done, 20)));
}
async function later(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

const ADA = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b2";
const bronze = { id: "bronze", name: "Bronze", wins: 0 } as const;

function summary(overrides: Partial<PlayerSummary> = {}): PlayerSummary {
  return {
    id: ADA,
    handle: "ada",
    avatar: "sun",
    alliance: null,
    tier: bronze,
    presence: { state: "online", appears_offline: false },
    friendship: "none",
    ...overrides,
  };
}
function profile(overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    ...summary(),
    wins: 12,
    member_since: "2026-10-01T10:00:00Z",
    blocked: false,
    you: false,
    ...overrides,
  };
}
function note(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "n1",
    kind: "friend_request",
    messages: 0,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    read: false,
    actor: { id: BOB, handle: "bob", avatar: "moon", alliance: null },
    request_pending: true,
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  queues.clear();
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  // A profile's badges and record (v0.5.0, records/records.test.tsx).
  on("GET /api/v1/players/{player_id}/stats", () => reply(200, stats()));
  on("GET /api/v1/players/{player_id}/achievements", () =>
    reply(200, badges()),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the words (v0.4.3)", () => {
  it("say what a player is doing, and nothing when it is not shared", () => {
    expect(presenceWords(null)).toBe("");
    expect(presenceWords({ state: "online", appears_offline: false })).toBe(
      "Online",
    );
    expect(
      presenceWords({
        state: "in_game",
        game_kind: "table",
        game_format: "commander",
        appears_offline: false,
      }),
    ).toBe("Playing Commander at a table");
    expect(
      presenceWords({
        state: "in_game",
        game_kind: "practice",
        game_format: "legacy",
        appears_offline: false,
      }),
    ).toBe("Playing a Legacy practice game");
    expect(presenceWords({ state: "idle", appears_offline: true })).toBe(
      "Idle (appears offline)",
    );
    expect(
      [null, { state: "offline" }, { state: "in_game" }, { state: "idle" }]
        .map((presence) => presenceRank(presence as PlayerSummary["presence"]))
        .sort(),
    ).toEqual([0, 2, 3, 4]);
  });

  it("tell each notification and how long ago it came", () => {
    expect(notificationWords(note())).toBe("bob wants to be your friend.");
    expect(notificationWords(note({ kind: "friend_accepted" }))).toBe(
      "bob accepted your friend request.",
    );
    expect(notificationWords(note({ kind: "friend_online" }))).toBe(
      "bob is online.",
    );
    expect(notificationWords(note({ actor: null }))).toBe(
      "A player who has left wants to be your friend.",
    );
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(timeAgo("2026-10-22T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-10-22T11:15:00Z", now)).toBe("45 min ago");
    expect(timeAgo("2026-10-22T07:00:00Z", now)).toBe("5 h ago");
    expect(timeAgo("2026-10-21T10:00:00Z", now)).toBe("yesterday");
    expect(timeAgo("2026-10-18T10:00:00Z", now)).toBe("4 days ago");
    expect(timeAgo("2026-09-01T10:00:00Z", now)).toBe("Sep 1, 2026");
    expect(looksLikeEmail("ada@example.com")).toBe(true);
    expect(looksLikeEmail("ada")).toBe(false);
  });
});

describe("the player search (v0.4.3)", () => {
  it("finds handles as they are typed, a moment after the last key", async () => {
    vi.useFakeTimers();
    on("GET /api/v1/players", () =>
      reply(200, {
        players: [
          summary(),
          summary({ id: BOB, handle: "adamant", presence: null }),
        ],
        by_email: false,
      }),
    );
    render(<PlayerSearch />);
    const box = screen.getByRole("combobox", {
      name: "Find players by handle or email",
    });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "a" } });
    await later(SEARCH_DELAY_MS * 2);
    expect(sent("GET /api/v1/players")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Type at least two letters",
    );
    fireEvent.change(box, { target: { value: "ad" } });
    fireEvent.change(box, { target: { value: "ada" } });
    await later(SEARCH_DELAY_MS);
    expect(sent("GET /api/v1/players")).toHaveLength(1);
    expect(sent("GET /api/v1/players")[0]!.init).toMatchObject({
      params: { query: { q: "ada" } },
    });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "☼adaBronze · Online",
      "☼adamantBronze",
    ]);
    expect(box).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", options[1]!.id);
    fireEvent.submit(box.closest("form")!);
    expect(window.location.hash).toBe(`#player/${BOB}`);
    expect(box).toHaveValue("");
  });

  it("sends an email address only on Enter, and never shows one", async () => {
    vi.useFakeTimers();
    on("GET /api/v1/players", () =>
      reply(200, { players: [], by_email: true }),
    );
    render(<PlayerSearch />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "ada@example.com" } });
    await later(SEARCH_DELAY_MS * 3);
    expect(sent("GET /api/v1/players")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Press Enter to search for this email address.",
    );
    fireEvent.submit(box.closest("form")!);
    await later(0);
    expect(sent("GET /api/v1/players")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No player found with that email address.",
    );
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue("");
  });

  it("says when the address's player has no name yet, and sends a request that waits (v0.5.1)", async () => {
    vi.useFakeTimers();
    on("GET /api/v1/players", () =>
      reply(200, {
        players: [],
        by_email: true,
        unnamed: { id: BOB, friendship: "none" },
      }),
    );
    on("PUT /api/v1/friends/waiting/{player_id}", () =>
      reply(200, { id: BOB, friendship: "requested" }),
    );
    on("DELETE /api/v1/friends/waiting/{player_id}", () =>
      reply(200, { id: BOB, friendship: "none" }),
    );
    render(<PlayerSearch />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "new.comer@gmail.com" } });
    fireEvent.submit(box.closest("form")!);
    await later(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "That player hasn't chosen a player name yet.",
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));
    await later(0);
    expect(
      sent("PUT /api/v1/friends/waiting/{player_id}")[0]!.init,
    ).toMatchObject({ params: { path: { player_id: BOB } } });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your friend request waits for this player to choose a player name.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    await later(0);
    expect(sent("DELETE /api/v1/friends/waiting/{player_id}")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add friend" })).toBeEnabled();
  });

  it("says when the address's player, with no name yet, asked first (v0.5.1)", async () => {
    vi.useFakeTimers();
    on("GET /api/v1/players", () =>
      reply(200, {
        players: [],
        by_email: true,
        unnamed: { id: BOB, friendship: "requested_you" },
      }),
    );
    render(<PlayerSearch />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "new.comer@gmail.com" } });
    fireEvent.submit(box.closest("form")!);
    await later(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "That player asked to be your friend and hasn't chosen a player name yet. Add friend to accept.",
    );
  });

  it("says when searching is limited", async () => {
    vi.useFakeTimers();
    on("GET /api/v1/players", () =>
      reply(429, {
        code: "search_limited",
        message: "That is a lot of searching. Wait a minute and try again.",
      }),
    );
    render(<PlayerSearch />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "ada" } });
    await later(SEARCH_DELAY_MS);
    expect(screen.getByRole("status")).toHaveTextContent(
      "That is a lot of searching.",
    );
  });
});

describe("the app's check-in (v0.4.3)", () => {
  const me = { id: ADA, status: "active" } as Me;
  let shown: Social | undefined;
  function Probe({ who }: { who: Me | null }) {
    shown = useSocial(who);
    return null;
  }

  it("checks in every 30 seconds, idle once untouched or hidden, and pops up what is new", async () => {
    vi.useFakeTimers();
    const fresh = note({
      id: "n2",
      kind: "friend_online",
      request_pending: false,
    });
    on(
      "POST /api/v1/presence",
      () =>
        reply(200, { unread: 1, newest: "2026-10-22T10:00:00Z", fresh: [] }),
      () =>
        reply(200, {
          unread: 2,
          newest: "2026-10-22T10:05:00Z",
          fresh: [fresh],
        }),
      () =>
        reply(200, { unread: 2, newest: "2026-10-22T10:05:00Z", fresh: [] }),
    );
    render(<Probe who={me} />);
    await later(0);
    const posts = () => sent("POST /api/v1/presence");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.init).toMatchObject({
      body: { idle: false, since: null },
    });
    expect(shown!.unread).toBe(1);
    await later(CHECK_IN_MS);
    expect(posts()[1]!.init).toMatchObject({
      body: { idle: false, since: "2026-10-22T10:00:00Z" },
    });
    expect(shown!.unread).toBe(2);
    expect(shown!.toasts.map((item) => item.id)).toEqual(["n2"]);
    act(() => shown!.dismiss("n2"));
    expect(shown!.toasts).toEqual([]);
    await later(IDLE_MS);
    expect(posts().at(-1)!.init).toMatchObject({ body: { idle: true } });
    fireEvent.keyDown(window, { key: "a" });
    await later(CHECK_IN_MS);
    expect(posts().at(-1)!.init).toMatchObject({ body: { idle: false } });
  });

  it("stays quiet for an account that is not active", async () => {
    vi.useFakeTimers();
    render(<Probe who={{ ...me, status: "pending" } as Me} />);
    await later(CHECK_IN_MS * 2);
    expect(calls).toEqual([]);
    expect(shown!.unread).toBe(0);
  });
});

describe("the notification bell (v0.4.3)", () => {
  function social(overrides: Partial<Social> = {}): Social {
    return {
      unread: 2,
      messagesUnread: 0,
      setUnread: vi.fn(),
      toasts: [],
      dismiss: vi.fn(),
      checkIn: vi.fn(),
      ...overrides,
    };
  }

  it("shows the count, and opens the latest with a friend request to answer", async () => {
    const own = social();
    on("GET /api/v1/notifications", () =>
      reply(200, {
        items: [
          note(),
          note({
            id: "n0",
            kind: "friend_online",
            read: true,
            request_pending: false,
            created_at: "2026-10-20T10:00:00Z",
          }),
        ],
        unread: 1,
        next: null,
      }),
    );
    on("POST /api/v1/notifications/read", () => reply(200, { unread: 0 }));
    on("PUT /api/v1/friends/{player_id}", () =>
      reply(200, profile({ id: BOB, handle: "bob", friendship: "friends" })),
    );
    render(<NotificationBell social={own} />);
    const bell = screen.getByRole("button", {
      name: "Notifications, 2 unread",
    });
    fireEvent.click(bell);
    await settle();
    const bubble = screen.getByRole("dialog", { name: "Notifications" });
    expect(sent("GET /api/v1/notifications")[0]!.init).toMatchObject({
      params: { query: { limit: 6 } },
    });
    expect(sent("POST /api/v1/notifications/read")[0]!.init).toMatchObject({
      body: { up_to: expect.any(String) },
    });
    expect(own.setUnread).toHaveBeenCalledWith(0);
    const items = within(bubble).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("bob wants to be your friend.");
    expect(items[0]).toHaveTextContent("New.");
    expect(items[1]).not.toHaveTextContent("New.");
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Accept" }));
    await settle();
    expect(sent("PUT /api/v1/friends/{player_id}")[0]!.init).toMatchObject({
      params: { path: { player_id: BOB } },
    });
    expect(items[0]).toHaveTextContent("You and bob are friends.");
    expect(
      within(items[0]!).queryByRole("button", { name: "Accept" }),
    ).toBeNull();
    expect(
      within(bubble).getByRole("link", { name: /See all notifications/ }),
    ).toHaveAttribute("href", "#notifications");
    fireEvent.keyDown(bubble, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bell).toHaveFocus();
  });

  it("pops up new ones for a moment", async () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    render(
      <NotificationBell
        social={social({
          unread: 0,
          dismiss,
          toasts: [note({ id: "n9", kind: "friend_online" })],
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "bob is online." }),
    ).toHaveAttribute("href", `#player/${BOB}`);
    await later(TOAST_MS);
    expect(dismiss).toHaveBeenCalledWith("n9");
  });

  it("keeps the whole history a page at a time", async () => {
    const own = social();
    on(
      "GET /api/v1/notifications",
      () => reply(200, { items: [note()], unread: 1, next: "older" }),
      () =>
        reply(200, {
          items: [note({ id: "n0", kind: "friend_accepted", read: true })],
          unread: 0,
          next: null,
        }),
    );
    on("POST /api/v1/notifications/read", () => reply(200, { unread: 0 }));
    render(<NotificationsPage social={own} heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("heading", { name: "Notifications" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Show older notifications" }),
    );
    await settle();
    expect(sent("GET /api/v1/notifications")[1]!.init).toMatchObject({
      params: { query: { cursor: "older" } },
    });
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("bob wants to be your friend."),
      expect.stringContaining("bob accepted your friend request."),
    ]);
    expect(
      screen.queryByRole("button", { name: "Show older notifications" }),
    ).toBeNull();
    expect(own.setUnread).toHaveBeenCalledWith(0);
  });
});

describe("a player's profile (v0.4.3)", () => {
  it("adds a friend, who stays pending until they accept", async () => {
    on("GET /api/v1/players/{player_id}", () => reply(200, profile()));
    on("PUT /api/v1/friends/{player_id}", () =>
      reply(200, profile({ friendship: "requested" })),
    );
    on("DELETE /api/v1/friends/{player_id}", () =>
      reply(200, profile({ friendship: "none" })),
    );
    render(<PlayerPage playerId={ADA} heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("heading", { level: 1, name: "ada" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Bronze · 12 wins · Playing since October 2026/),
    ).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add friend" }));
    await settle();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Friend request sent to ada.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
    await settle();
    expect(sent("DELETE /api/v1/friends/{player_id}")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Add friend" }),
    ).toBeInTheDocument();
  });

  it("answers a request, ends a friendship after asking, and blocks", async () => {
    on("GET /api/v1/players/{player_id}", () =>
      reply(200, profile({ friendship: "requested_you", presence: null })),
    );
    on("PUT /api/v1/friends/{player_id}", () =>
      reply(200, profile({ friendship: "friends" })),
    );
    on("DELETE /api/v1/friends/{player_id}", () =>
      reply(200, profile({ friendship: "none" })),
    );
    on("PUT /api/v1/blocks/{player_id}", () =>
      reply(200, profile({ blocked: true, presence: null })),
    );
    on("DELETE /api/v1/blocks/{player_id}", () => reply(200, profile()));
    render(<PlayerPage playerId={ADA} heading={createRef()} />);
    await settle();
    expect(
      screen.getByText("ada wants to be your friend."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await settle();
    expect(screen.getByText("Friends")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));
    expect(sent("DELETE /api/v1/friends/{player_id}")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove friend" }));
    await settle();
    expect(sent("DELETE /api/v1/friends/{player_id}")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(screen.getByText(/Block ada\? Any friendship/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Block ada" }));
    await settle();
    expect(screen.getByText(/You have blocked ada/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unblock" }));
    await settle();
    expect(
      screen.getByRole("button", { name: "Add friend" }),
    ).toBeInTheDocument();
  });

  it("says when a player is not there, and marks one's own", async () => {
    on(
      "GET /api/v1/players/{player_id}",
      () => reply(404, { code: "http_404", message: "Not Found" }),
      () => reply(200, profile({ you: true })),
    );
    const { unmount } = render(
      <PlayerPage playerId={ADA} heading={createRef()} />,
    );
    await settle();
    expect(
      screen.getByRole("heading", { name: "No such player" }),
    ).toBeInTheDocument();
    unmount();
    render(<PlayerPage playerId={ADA} heading={createRef()} />);
    await settle();
    expect(
      screen.getByText(/This is your profile as other players see it/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add friend" })).toBeNull();
  });
});

describe("friends (v0.4.3)", () => {
  it("lists requests, friends by what they are doing, and requests sent", async () => {
    on("GET /api/v1/friends", () =>
      reply(200, {
        friends: [
          summary({
            id: "f1",
            handle: "zed",
            friendship: "friends",
            presence: null,
          }),
          summary({
            id: "f2",
            handle: "yan",
            friendship: "friends",
            presence: {
              state: "in_game",
              game_kind: "practice",
              game_format: "commander",
              appears_offline: false,
            },
          }),
          summary({
            id: "f3",
            handle: "xia",
            friendship: "friends",
            presence: { state: "offline", appears_offline: false },
          }),
        ],
        incoming: [
          summary({ id: BOB, handle: "bob", friendship: "requested_you" }),
        ],
        outgoing: [
          summary({ id: "o1", handle: "cy", friendship: "requested" }),
        ],
      }),
    );
    on("PUT /api/v1/friends/{player_id}", () =>
      reply(200, profile({ id: BOB, handle: "bob", friendship: "friends" })),
    );
    render(<FriendsPage heading={createRef()} />);
    await settle();
    const friends = screen.getByRole("region", { name: "Your friends (3)" });
    expect(
      within(friends)
        .getAllByRole("link")
        .map((link) => link.querySelector("strong")?.textContent),
    ).toEqual(["yan", "xia", "zed"]);
    expect(
      within(friends).getByText("Playing a Commander practice game"),
    ).toBeInTheDocument();
    const requests = screen.getByRole("region", { name: "Friend requests" });
    fireEvent.click(
      within(requests).getByRole("button", { name: "Accept bob's request" }),
    );
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent(
      "You and bob are friends.",
    );
    expect(sent("GET /api/v1/friends")).toHaveLength(2);
    expect(
      within(
        screen.getByRole("region", { name: "Requests you sent" }),
      ).getByRole("button", { name: "Withdraw your request to cy" }),
    ).toBeInTheDocument();
  });

  it("lists requests waiting for a player name, and withdraws one (v0.5.1)", async () => {
    const asked = new Date(Date.now() - 2 * 86_400_000).toISOString();
    on(
      "GET /api/v1/friends",
      () =>
        reply(200, {
          friends: [],
          incoming: [],
          outgoing: [],
          waiting: [{ player_id: BOB, requested_at: asked }],
        }),
      () =>
        reply(200, { friends: [], incoming: [], outgoing: [], waiting: [] }),
    );
    on("DELETE /api/v1/friends/waiting/{player_id}", () =>
      reply(200, { id: BOB, friendship: "none" }),
    );
    render(<FriendsPage heading={createRef()} />);
    await settle();
    const waiting = screen.getByRole("region", {
      name: "Waiting for a player name",
    });
    expect(
      within(waiting).getByText("A player still choosing a name"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(waiting).getByRole("button", {
        name: "Withdraw your request asked 2 days ago",
      }),
    );
    await settle();
    expect(
      sent("DELETE /api/v1/friends/waiting/{player_id}")[0]!.init,
    ).toMatchObject({ params: { path: { player_id: BOB } } });
    expect(screen.getByRole("status")).toHaveTextContent("Request withdrawn.");
    expect(
      screen.queryByRole("region", { name: "Waiting for a player name" }),
    ).not.toBeInTheDocument();
  });
});

describe("privacy settings (v0.4.3)", () => {
  it("save each change, and unblock", async () => {
    on("GET /api/v1/me/privacy", () =>
      reply(200, {
        presence_visibility: "friends",
        appear_offline: false,
        email_searchable: true,
      }),
    );
    on("GET /api/v1/me/blocks", () =>
      reply(200, [
        {
          player: { id: BOB, handle: "bob", avatar: "moon", alliance: null },
          blocked_at: "2026-10-22T10:00:00Z",
        },
      ]),
    );
    on(
      "PATCH /api/v1/me/privacy",
      () =>
        reply(200, {
          presence_visibility: "everyone",
          appear_offline: false,
          email_searchable: true,
        }),
      () =>
        reply(200, {
          presence_visibility: "everyone",
          appear_offline: true,
          email_searchable: true,
        }),
    );
    on("DELETE /api/v1/blocks/{player_id}", () => reply(200, profile()));
    render(<PrivacySettings />);
    await settle();
    expect(screen.getByRole("radio", { name: "Your friends" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Every player" }));
    await settle();
    expect(sent("PATCH /api/v1/me/privacy")[0]!.init).toMatchObject({
      body: { presence_visibility: "everyone" },
    });
    expect(screen.getByRole("radio", { name: "Every player" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /Appear offline/ }));
    await settle();
    expect(
      screen.getByRole("checkbox", { name: /Appear offline/ }),
    ).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Privacy settings saved.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Unblock bob" }));
    await settle();
    expect(screen.getByText(/You have blocked no one/)).toBeInTheDocument();
  });
});
