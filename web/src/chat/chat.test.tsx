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
import { client, type Me } from "../api";
import { notificationWords, type NotificationItem } from "../social/social";
import {
  ChatContext,
  newClientId,
  oldMessagesRoute,
  roomFor,
  savedPanel,
  savedWindows,
  useChat,
  WINDOWS,
  type Chat,
  type ChatMessage,
} from "./chat";
import { ChatBar } from "./ChatBar";
import { ConversationView } from "./Conversation";

// Chat between friends (v0.4.4): a conversation's sending, failures and reports; the live
// connection's count, pop-ups and windows; and the chat bar (v0.5.1) with its friends list, which
// replaced the Messages page.

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

const ME = "00000000-0000-4000-8000-0000000000e1";
const ADA = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b2";
const CAL = "00000000-0000-4000-8000-0000000000c3";
const DEE = "00000000-0000-4000-8000-0000000000d4";
const ada = {
  id: ADA,
  handle: "ada",
  avatar: "sigil",
  alliance: null,
  tier: { id: "bronze", name: "Bronze", wins: 0 },
  presence: {
    state: "online",
    game_kind: null,
    game_format: null,
    appears_offline: false,
  },
  friendship: "friends",
} as const;
interface Presence {
  state: string;
  game_kind: string | null;
  game_format: string | null;
  appears_offline: boolean;
}
type Friend = Omit<typeof ada, "id" | "handle" | "presence" | "friendship"> & {
  id: string;
  handle: string;
  presence: Presence | null;
  friendship: string;
};
function friend(id: string, handle: string, changes: Partial<Friend> = {}) {
  return { ...ada, id, handle, ...changes } as Friend;
}
function presence(state: string): Presence {
  return { ...ada.presence, state };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    sender_id: ADA,
    body: "Hello there",
    created_at: "2026-10-22T10:00:00Z",
    client_id: "c1",
    ...overrides,
  };
}
function page(overrides: Record<string, unknown> = {}) {
  return {
    player: ada,
    friends: true,
    messages: [message()],
    next: null,
    unread: 0,
    ...overrides,
  };
}

/** A WebSocket the test drives. */
class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  tell(message: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
}

beforeAll(() => {
  // jsdom has no modal dialogs; reporting a message opens one.
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
/** The window's width, as a resize tells the page. */
function screenWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

beforeEach(() => {
  calls = [];
  queues.clear();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  // The chat bar's friends list, empty unless a test says otherwise; a screen wide enough for
  // three windows.
  on("GET /api/v1/friends", () =>
    reply(200, { friends: [], incoming: [], outgoing: [] }),
  );
  on("GET /api/v1/conversations", () =>
    reply(200, { conversations: [], unread: 0 }),
  );
  screenWidth(1400);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a conversation", () => {
  it("sends with Enter, keeps Shift+Enter for a new line, and lands each message once", async () => {
    on("GET /api/v1/conversations/{player_id}", () => reply(200, page()));
    on("POST /api/v1/conversations/{player_id}/messages", (init) => {
      const body = init!.body as { text: string; client_id: string };
      return reply(
        201,
        message({
          id: "m2",
          sender_id: ME,
          body: body.text,
          client_id: body.client_id,
        }),
      );
    });
    render(<ConversationView playerId={ADA} chat={null} visible />);
    await settle();
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    const box = screen.getByLabelText("Write to ada");
    fireEvent.change(box, { target: { value: "Rematch?" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(
      sent("POST /api/v1/conversations/{player_id}/messages"),
    ).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter" });
    await settle();
    const [post] = sent("POST /api/v1/conversations/{player_id}/messages");
    expect(post!.init).toMatchObject({
      params: { path: { player_id: ADA } },
      body: {
        text: "Rematch?",
        client_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
    expect(screen.getAllByText("Rematch?")).toHaveLength(1);
    expect(box).toHaveValue("");
  });

  it("says why a message failed, and tries again under the same client_id", async () => {
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(200, page({ messages: [] })),
    );
    on(
      "POST /api/v1/conversations/{player_id}/messages",
      () => {
        const response = new Response(null, {
          status: 429,
          headers: { "Retry-After": "4" },
        });
        return {
          error: { code: "chat_limited", message: "Too fast" },
          response,
        };
      },
      (init) =>
        reply(
          201,
          message({
            id: "m3",
            sender_id: ME,
            body: "Again",
            client_id: (init!.body as { client_id: string }).client_id,
          }),
        ),
    );
    render(<ConversationView playerId={ADA} chat={null} visible />);
    await settle();
    fireEvent.change(screen.getByLabelText("Write to ada"), {
      target: { value: "Again" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Wait 4 seconds.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    const [first, second] = sent(
      "POST /api/v1/conversations/{player_id}/messages",
    );
    expect((second!.init!.body as { client_id: string }).client_id).toBe(
      (first!.init!.body as { client_id: string }).client_id,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getAllByText("Again")).toHaveLength(1);
  });

  it("closes the box once the two are no longer friends", async () => {
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(200, page({ friends: false })),
    );
    render(<ConversationView playerId={ADA} chat={null} visible />);
    await settle();
    expect(screen.queryByLabelText("Write to ada")).toBeNull();
    expect(screen.getByText(/You and ada are not friends/)).toBeInTheDocument();
    expect(screen.getByText("Hello there")).toBeInTheDocument();
  });

  it("reports a friend's message, never one's own", async () => {
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(
        200,
        page({
          messages: [
            message(),
            message({ id: "m2", sender_id: ME, body: "Mine" }),
          ],
        }),
      ),
    );
    on("POST /api/v1/reports", () =>
      reply(201, {
        id: "r1",
        created_at: "2026-10-22T10:01:00Z",
        screenshot: false,
      }),
    );
    render(<ConversationView playerId={ADA} chat={null} visible />);
    await settle();
    expect(
      screen.getAllByRole("button", { name: /More about the message/ }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "More about the message from ada" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    const dialog = screen.getByRole("dialog", { name: "Report a message" });
    expect(dialog).toHaveTextContent("ada: Hello there");
    fireEvent.change(
      within(dialog).getByLabelText(/Why are you reporting it/),
      {
        target: { value: "Rude" },
      },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Report the message" }),
    );
    await settle();
    expect(sent("POST /api/v1/reports")[0]!.init).toMatchObject({
      body: {
        summary: "A message from ada",
        description: "Rude",
        message: { kind: "direct", id: "m1" },
        context: { page: expect.any(String) },
      },
    });
    expect(
      screen.getByText("Thank you. The message was reported."),
    ).toBeInTheDocument();
  });

  it("is read when shown: the friend's messages up to the newest", async () => {
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(
        200,
        page({
          unread: 1,
          messages: [
            message(),
            message({
              id: "m2",
              sender_id: ME,
              created_at: "2026-10-22T10:05:00Z",
            }),
          ],
        }),
      ),
    );
    const markRead = vi.fn(async () => undefined);
    const chat = {
      live: true,
      listen: () => () => undefined,
      markRead,
    } as unknown as Chat;
    render(<ConversationView playerId={ADA} chat={chat} visible />);
    await settle();
    expect(markRead).toHaveBeenCalledWith(ADA, "2026-10-22T10:00:00Z");
    expect(markRead).toHaveBeenCalledTimes(1);
  });
});

/** Mounts useChat and hands its result out, with the chat bar. */
let shown: Chat | null = null;
function Probe({
  me,
  checkedIn = null,
  table = null,
}: {
  me: Me;
  checkedIn?: number | null;
  /** The game whose table is shown. */
  table?: string | null;
}) {
  shown = useChat(me, checkedIn, table);
  return (
    <ChatContext.Provider value={shown}>
      <ChatBar chat={shown} />
    </ChatContext.Provider>
  );
}
const me = { id: ME, status: "active" } as Me;

describe("the live connection", () => {
  it("says hello, counts what is unread, and pops up a friend's message", async () => {
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(200, page({ messages: [] })),
    );
    on("POST /api/v1/conversations/{player_id}/read", () =>
      reply(200, { unread: 0 }),
    );
    render(<Probe me={me} checkedIn={2} />);
    expect(shown!.unread).toBe(2);
    const [socket] = FakeSocket.all;
    expect(socket!.url).toMatch(/\/api\/v1\/chat\/events$/);
    act(() => socket!.onopen?.());
    expect(JSON.parse(socket!.sent[0]!)).toMatchObject({ type: "hello" });
    socket!.tell({ type: "welcome", unread: 3 });
    expect(shown!.unread).toBe(3);
    expect(shown!.live).toBe(true);
    socket!.tell({
      type: "message",
      player_id: ADA,
      player: ada,
      message: message(),
      unread: 4,
    });
    expect(shown!.unread).toBe(4);
    expect(shown!.toasts.map((each) => each.player.handle)).toEqual(["ada"]);
    // Opening the conversation takes its pop-up away; its messages no longer pop up, and screen
    // readers hear them from the bar instead.
    act(() => shown!.open(ADA));
    expect(shown!.toasts).toEqual([]);
    await settle();
    socket!.tell({
      type: "message",
      player_id: ADA,
      player: ada,
      message: message({ id: "m9" }),
      unread: 4,
    });
    expect(shown!.toasts).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("ada: Hello there");
    // The open window shows it, so it is read at once.
    await settle();
    expect(
      sent("POST /api/v1/conversations/{player_id}/read")[0]!.init,
    ).toMatchObject({ body: { up_to: "2026-10-22T10:00:00Z" } });
    // One's own messages, from another tab, never pop up.
    socket!.tell({
      type: "message",
      player_id: BOB,
      player: { ...ada, id: BOB, handle: "bob" },
      message: message({ id: "m10", sender_id: ME }),
      unread: 4,
    });
    expect(shown!.toasts).toEqual([]);
    socket!.tell({ type: "read", player_id: ADA, unread: 0 });
    expect(shown!.unread).toBe(0);
    // Folded, its messages pop up again.
    act(() => shown!.fold(ADA, true));
    socket!.tell({
      type: "message",
      player_id: ADA,
      player: ada,
      message: message({ id: "m11", body: "Still there?" }),
      unread: 1,
    });
    expect(shown!.toasts.map((each) => each.message.body)).toEqual([
      "Still there?",
    ]);
  });

  it("keeps at most three windows, and remembers which", async () => {
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(200, page({ messages: [] })),
    );
    render(<Probe me={me} />);
    const ids = [1, 2, 3, 4].map(
      (n) => `00000000-0000-4000-8000-00000000000${n}`,
    );
    for (const id of ids) act(() => shown!.open(id));
    await settle();
    expect(shown!.windows.map((each) => each.playerId)).toEqual(ids.slice(1));
    expect(WINDOWS).toBe(3);
    act(() => shown!.fold(ids[1]!, true));
    expect(savedWindows()).toEqual([
      { playerId: ids[1], folded: true },
      { playerId: ids[2], folded: false },
      { playerId: ids[3], folded: false },
    ]);
    expect(screen.getAllByRole("region", { name: /^Chat with/ })).toHaveLength(
      3,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /Close the chat with/ })[0]!,
    );
    expect(shown!.windows).toHaveLength(2);
  });

  it("starts nothing for an account that is not active", () => {
    render(<Probe me={{ ...me, status: "pending" } as Me} />);
    expect(FakeSocket.all).toHaveLength(0);
    expect(shown!.unread).toBe(0);
  });
});

describe("the chat bar (v0.5.1)", () => {
  /** Ada online with 2 unread, Bob offline, Cal at a table, and Dee no longer a friend. */
  function people() {
    on("GET /api/v1/friends", () =>
      reply(200, {
        friends: [
          friend(BOB, "bob", { presence: presence("offline") }),
          ada,
          friend(CAL, "cal", {
            presence: {
              ...presence("in_game"),
              game_kind: "table",
              game_format: "commander",
            },
          }),
        ],
        incoming: [friend(BOB, "eve")],
        outgoing: [],
      }),
    );
    on("GET /api/v1/conversations", () =>
      reply(200, {
        conversations: [
          {
            player: friend(DEE, "dee", {
              presence: null,
              friendship: "none",
            }),
            friends: false,
            last_message: message({ sender_id: DEE }),
            unread: 1,
          },
          { player: ada, friends: true, last_message: message(), unread: 2 },
        ],
        unread: 3,
      }),
    );
    on("GET /api/v1/conversations/{player_id}", (init) => {
      const id = (init!.params as { path: { player_id: string } }).path
        .player_id;
      // The conversation's presence is older than the friends list's.
      return reply(
        200,
        page({
          player:
            id === DEE
              ? friend(DEE, "dee")
              : friend(ADA, "ada", { presence: presence("offline") }),
          friends: id !== DEE,
        }),
      );
    });
  }
  function toggle() {
    return screen.getByRole("button", { name: /^Friends/ });
  }

  it("lists the friends online first with what is unread, and old conversations under their own heading", async () => {
    people();
    render(<Probe me={me} checkedIn={3} />);
    await settle();
    // The bar's button: the friends online (Ada, and Cal at a table) and the unread messages.
    expect(toggle()).toHaveAccessibleName(
      "Friends, 2 online, 3 unread messages",
    );
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveTextContent("Friends· 2 online3");
    fireEvent.click(toggle());
    await settle();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    const friends = screen.getByRole("list", { name: "Your friends" });
    expect(
      within(friends)
        .getAllByRole("button")
        .map((each) => each.getAttribute("aria-label")),
    ).toEqual([
      "Chat with cal, Playing Commander at a table",
      "Chat with ada, Online, 2 unread",
      "Chat with bob, Offline",
    ]);
    const earlier = screen.getByRole("list", { name: "Earlier conversations" });
    expect(within(earlier).getByRole("button")).toHaveAccessibleName(
      "Chat with dee, No longer friends, 1 unread",
    );
    expect(
      screen.getByRole("link", { name: /1 friend request waiting/ }),
    ).toHaveAttribute("href", "#friends");
    // A friend's conversation opens on the bar, with focus in the box to write in.
    fireEvent.click(
      within(friends).getByRole("button", { name: /^Chat with ada/ }),
    );
    const window = await screen.findByRole("region", { name: "Chat with ada" });
    await waitFor(() =>
      expect(within(window).getByLabelText("Write to ada")).toHaveFocus(),
    );
    expect(
      within(friends).getByRole("button", { name: /^Chat with ada/ }),
    ).toHaveAttribute("data-open");
    // A player no longer a friend: the history, read only, with focus on it.
    fireEvent.click(within(earlier).getByRole("button"));
    const old = await screen.findByRole("region", { name: "Chat with dee" });
    await waitFor(() =>
      expect(
        within(old).getByRole("list", { name: "Messages with dee" }),
      ).toHaveFocus(),
    );
    expect(within(old).queryByLabelText("Write to dee")).toBeNull();
  });

  it("folds with Escape, follows the socket while open, and asks again for presence", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    people();
    render(<Probe me={me} />);
    await settle();
    const [socket] = FakeSocket.all;
    act(() => socket!.onopen?.());
    socket!.tell({ type: "welcome", unread: 0 });
    fireEvent.click(toggle());
    await settle();
    const lists = sent("GET /api/v1/conversations").length;
    // A message and its read mark: the list asks once for the new counts.
    socket!.tell({
      type: "message",
      player_id: ADA,
      player: ada,
      message: message({ id: "m5" }),
      unread: 3,
    });
    socket!.tell({ type: "read", player_id: ADA, unread: 0 });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(sent("GET /api/v1/conversations")).toHaveLength(lists + 1);
    // Presence, every 30 seconds, as on the Friends page.
    const friends = sent("GET /api/v1/friends").length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(sent("GET /api/v1/friends")).toHaveLength(friends + 1);
    // Escape folds the list, with focus on its button.
    fireEvent.keyDown(screen.getByRole("button", { name: /^Chat with bob/ }), {
      key: "Escape",
    });
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(toggle()).toHaveFocus();
    // Folded, it no longer follows the socket.
    socket!.tell({
      type: "message",
      player_id: ADA,
      player: ada,
      message: message({ id: "m6" }),
      unread: 1,
    });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(sent("GET /api/v1/conversations")).toHaveLength(lists + 1);
  });

  it("closes a conversation, and opens it again from the list", async () => {
    people();
    render(<Probe me={me} />);
    await settle();
    fireEvent.click(toggle());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Chat with ada/ }));
    await screen.findByRole("region", { name: "Chat with ada" });
    // The list stays open until it is folded, a click elsewhere included, and the browser
    // remembers which.
    fireEvent.pointerDown(document.body);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(localStorage.getItem("cd.chat.friends")).toBe("open");
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(savedPanel()).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Close the chat with ada" }),
    );
    expect(screen.queryByRole("region", { name: "Chat with ada" })).toBeNull();
    expect(toggle()).toHaveFocus();
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: /^Chat with ada/ }));
    expect(
      await screen.findByRole("region", { name: "Chat with ada" }),
    ).toBeInTheDocument();
    // The window's title bar shows the list's newer presence.
    expect(
      screen.getByRole("button", { expanded: true, name: /^ada/ }),
    ).toHaveTextContent("Online");
  });

  it("fits the windows to the screen; the others wait their turn", async () => {
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(200, page({ messages: [] })),
    );
    expect([1400, 1280, 1024, 900, 820, 390].map(roomFor)).toEqual([
      3, 3, 2, 1, 1, 1,
    ]);
    render(<Probe me={me} />);
    for (const id of [ADA, BOB, CAL]) act(() => shown!.open(id));
    await settle();
    const windows = () =>
      screen.getAllByRole("region", { name: /^Chat with/ }).length;
    expect(windows()).toBe(3);
    screenWidth(1024);
    expect(windows()).toBe(2);
    expect(shown!.docked.map((each) => each.playerId)).toEqual([BOB, CAL]);
    expect(shown!.windows).toHaveLength(3);
    // Ada's window, waiting, opens again as the newest.
    act(() => shown!.open(ADA));
    expect(shown!.docked.map((each) => each.playerId)).toEqual([CAL, ADA]);
    screenWidth(1400);
    expect(windows()).toBe(3);
  });

  it("on a phone, is one button, and shows the list or one conversation", async () => {
    people();
    screenWidth(390);
    localStorage.setItem(
      "cd.chat.windows",
      JSON.stringify([
        { playerId: BOB, folded: false },
        { playerId: CAL, folded: false },
      ]),
    );
    render(<Probe me={me} checkedIn={1} />);
    await settle();
    expect(shown!.phone).toBe(true);
    // The newest conversation alone.
    expect(screen.getAllByRole("region", { name: /^Chat with/ })).toHaveLength(
      1,
    );
    expect(shown!.shows(shown!.docked[0]!)).toBe(true);
    expect(toggle()).toHaveAccessibleName(
      "Friends, 2 online, 1 unread message",
    );
    // The list covers it: it is not shown meanwhile, so its messages are not read.
    fireEvent.click(toggle());
    expect(shown!.shows(shown!.docked[0]!)).toBe(false);
    // Choosing a friend shows their conversation instead of the list.
    fireEvent.click(screen.getByRole("button", { name: /^Chat with ada/ }));
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(shown!.docked.map((each) => each.playerId)).toEqual([ADA]);
    expect(shown!.shows(shown!.docked[0]!)).toBe(true);
  });

  it("opens the friends list as the browser remembers it", async () => {
    people();
    localStorage.setItem("cd.chat.friends", "open");
    render(<Probe me={me} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("button", { name: /^Chat with ada/ }),
    ).toBeInTheDocument();
  });

  it("at the table, folds away until brought out, and puts itself away with Escape", async () => {
    people();
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(200, page({ unread: 1 })),
    );
    on("POST /api/v1/conversations/{player_id}/read", () =>
      reply(200, { unread: 0 }),
    );
    localStorage.setItem("cd.chat.friends", "open");
    localStorage.setItem(
      "cd.chat.windows",
      JSON.stringify([{ playerId: ADA, folded: false }]),
    );
    const { rerender } = render(<Probe me={me} table="g1" />);
    await settle();
    // Folded away: nothing over the table, and nothing asked of the API.
    expect(
      screen.queryByRole("complementary", { name: "Friends and messages" }),
    ).toBeNull();
    expect(sent("GET /api/v1/friends")).toHaveLength(0);
    expect(sent("GET /api/v1/conversations/{player_id}")).toHaveLength(0);
    // A friend's message counts, and is said, since the table has no bell; it is not read.
    const [socket] = FakeSocket.all;
    act(() => socket!.onopen?.());
    socket!.tell({ type: "welcome", unread: 0 });
    socket!.tell({
      type: "message",
      player_id: ADA,
      player: ada,
      message: message({ id: "m7", body: "Good luck!" }),
      unread: 1,
    });
    expect(shown!.unread).toBe(1);
    expect(screen.getByRole("status")).toHaveTextContent("ada: Good luck!");
    expect(shown!.shows(shown!.windows[0]!)).toBe(false);
    // Brought out (the band's diamond does this): the bar as on the pages, focus in it, and no
    // link that would leave the game.
    act(() => shown!.setTableOpen(true));
    const bar = await screen.findByRole("complementary", {
      name: "Friends and messages",
    });
    expect(bar).toHaveAttribute("data-table");
    expect(toggle()).toHaveFocus();
    await settle();
    expect(
      within(bar).getByRole("region", { name: "Chat with ada" }),
    ).toBeInTheDocument();
    expect(within(bar).queryByRole("link")).toBeNull();
    expect(sent("POST /api/v1/conversations/{player_id}/read")).toHaveLength(1);
    // Escape, anywhere in it, puts it away; what was being written waits for its return.
    const box = within(bar).getByLabelText("Write to ada");
    fireEvent.change(box, { target: { value: "One moment" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(shown!.tableOpen).toBe(false);
    expect(
      screen.queryByRole("complementary", { name: "Friends and messages" }),
    ).toBeNull();
    act(() => shown!.setTableOpen(true));
    expect(screen.getByLabelText("Write to ada")).toHaveValue("One moment");
    // The next table starts with it folded away.
    rerender(<Probe me={me} table="g2" />);
    expect(shown!.tableOpen).toBe(false);
  });

  it("at the table, leaves Escape in a message's Report dialog to the dialog, and stays out", async () => {
    people();
    on("GET /api/v1/conversations/{player_id}", () => reply(200, page()));
    on("POST /api/v1/conversations/{player_id}/read", () =>
      reply(200, { unread: 0 }),
    );
    localStorage.setItem(
      "cd.chat.windows",
      JSON.stringify([{ playerId: ADA, folded: false }]),
    );
    render(<Probe me={me} table="g1" />);
    act(() => shown!.setTableOpen(true));
    await settle();
    fireEvent.click(
      screen.getByRole("button", { name: "More about the message from ada" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    const dialog = screen.getByRole("dialog", { name: "Report a message" });
    expect(dialog).toHaveAttribute("open");
    // Escape in the dialog is the dialog's: the browser's close is not cancelled, and the bar
    // stays out, so no modal dialog is left open out of sight over the table.
    const why = within(dialog).getByLabelText(/Why are you reporting it/);
    expect(fireEvent.keyDown(why, { key: "Escape" })).toBe(true);
    expect(shown!.tableOpen).toBe(true);
    // A key a part of the bar already handled is left alone too.
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    act(() => {
      screen.getByLabelText("Write to ada").dispatchEvent(handled);
    });
    expect(shown!.tableOpen).toBe(true);
    // The browser closes the dialog; the next Escape puts the bar away.
    act(() => (dialog as HTMLDialogElement).close());
    expect(dialog).not.toHaveAttribute("open");
    expect(
      fireEvent.keyDown(screen.getByLabelText("Write to ada"), {
        key: "Escape",
      }),
    ).toBe(false);
    expect(shown!.tableOpen).toBe(false);
  });

  it("on a phone, a window's Profile link folds it, so the profile shows; on a wider screen it stays", async () => {
    on("GET /api/v1/conversations/{player_id}", () => reply(200, page()));
    on("POST /api/v1/conversations/{player_id}/read", () =>
      reply(200, { unread: 0 }),
    );
    screenWidth(390);
    localStorage.setItem(
      "cd.chat.windows",
      JSON.stringify([{ playerId: ADA, folded: false }]),
    );
    render(<Probe me={me} />);
    await settle();
    const profile = screen.getByRole("link", { name: "Profile" });
    expect(profile).toHaveAttribute("href", `#player/${ADA}`);
    fireEvent.click(profile);
    expect(shown!.windows).toEqual([{ playerId: ADA, folded: true }]);
    // Wider, the window sits beside the page and stays open.
    screenWidth(1400);
    act(() => shown!.fold(ADA, false));
    fireEvent.click(screen.getByRole("link", { name: "Profile" }));
    expect(shown!.windows).toEqual([{ playerId: ADA, folded: false }]);
  });

  it("on a phone, keeps what a sheet covers out of reach, and gives focus to what shows after a close", async () => {
    people();
    on("POST /api/v1/conversations/{player_id}/read", () =>
      reply(200, { unread: 0 }),
    );
    screenWidth(390);
    localStorage.setItem(
      "cd.chat.windows",
      JSON.stringify([
        { playerId: BOB, folded: false },
        { playerId: CAL, folded: false },
      ]),
    );
    render(<Probe me={me} />);
    await settle();
    const bar = screen.getByRole("complementary", {
      name: "Friends and messages",
    });
    // Cal's conversation lies across the screen, over the list's button (chat.module.css hides
    // it) and the bar of pages (App makes it inert).
    expect(shown!.sheet).toBe("window");
    expect(bar).toHaveAttribute("data-sheet", "window");
    // Closed, Bob's, waiting its turn, shows in its place and covers the button still: focus goes
    // to its title bar.
    fireEvent.click(
      screen.getByRole("button", { name: "Close the chat with cal" }),
    );
    expect(shown!.docked).toEqual([{ playerId: BOB, folded: false }]);
    expect(shown!.sheet).toBe("window");
    await waitFor(() =>
      expect(document.getElementById(`chat-window-${BOB}-title`)).toHaveFocus(),
    );
    // Closed too, nothing covers the button, which takes focus.
    fireEvent.click(
      screen.getByRole("button", { name: "Close the chat with bob" }),
    );
    expect(shown!.sheet).toBeNull();
    expect(bar).not.toHaveAttribute("data-sheet");
    await waitFor(() => expect(toggle()).toHaveFocus());
    // The list is a sheet of its own.
    fireEvent.click(toggle());
    expect(shown!.sheet).toBe("list");
    expect(bar).toHaveAttribute("data-sheet", "list");
    // Wider, nothing lies across the page.
    screenWidth(1400);
    expect(shown!.sheet).toBeNull();
  });

  it("knows the Messages page's old addresses", () => {
    expect(oldMessagesRoute("#messages")).toBe("");
    expect(oldMessagesRoute(`#messages/${ADA.toUpperCase()}`)).toBe(ADA);
    expect(oldMessagesRoute("#messages/nobody")).toBeUndefined();
    expect(oldMessagesRoute("#friends")).toBeUndefined();
  });
});

describe("the words", () => {
  it("count new messages on the bell", () => {
    const item = {
      kind: "message",
      actor: ada,
      messages: 3,
    } as unknown as NotificationItem;
    expect(notificationWords(item)).toBe("ada sent you 3 messages.");
    expect(notificationWords({ ...item, messages: 1 })).toBe(
      "ada sent you a message.",
    );
    expect(notificationWords({ ...item, messages: 0 })).toBe(
      "ada sent you messages.",
    );
  });

  it("make client ids that look like UUIDs, with or without randomUUID", () => {
    expect(newClientId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    vi.spyOn(crypto, "randomUUID").mockImplementation(undefined as never);
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(newClientId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        value: original,
        configurable: true,
      });
    }
  });
});
