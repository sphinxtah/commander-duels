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
  type ChatEvent,
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
const OTHER = "00000000-0000-4000-8000-0000000000f5";
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
/** The chat, for a conversation alone: live, following nothing, keeping no draft. */
function fakeChat(changes: Record<string, unknown> = {}): Chat {
  return {
    live: true,
    listen: () => () => undefined,
    markRead: async () => undefined,
    draft: () => "",
    setDraft: () => undefined,
    ...changes,
  } as unknown as Chat;
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
    const chat = fakeChat({ markRead });
    render(<ConversationView playerId={ADA} chat={chat} visible />);
    await settle();
    expect(markRead).toHaveBeenCalledWith(ADA, "2026-10-22T10:00:00Z");
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it("asks once on opening, and again when the socket comes back; still unread, it marks again (v0.5.1)", async () => {
    const unread = page({ unread: 2 });
    on("GET /api/v1/conversations/{player_id}", () => reply(200, unread));
    const markRead = vi.fn(async () => undefined);
    const { rerender } = render(
      <ConversationView playerId={ADA} chat={fakeChat({ markRead })} visible />,
    );
    await settle();
    // One question with the socket up, not one for opening and one for the socket.
    const asked = sent("GET /api/v1/conversations/{player_id}");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.init?.headers).toBeUndefined();
    expect(markRead).toHaveBeenCalledTimes(1);
    // The socket drops and comes back: the page asks on its own, and the answer, still unread
    // (it crossed the mark, or the mark failed), is marked again.
    rerender(
      <ConversationView
        playerId={ADA}
        chat={fakeChat({ markRead, live: false })}
        visible
      />,
    );
    rerender(
      <ConversationView playerId={ADA} chat={fakeChat({ markRead })} visible />,
    );
    await settle();
    const again = sent("GET /api/v1/conversations/{player_id}");
    expect(again).toHaveLength(2);
    expect(again[1]!.init?.headers).toEqual({ "X-Background": "1" });
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it("clears its count when read in another tab, whatever the account's total (v0.5.1)", async () => {
    on(
      "GET /api/v1/conversations/{player_id}",
      () => reply(200, page({ unread: 2 })),
      () => reply(200, page({ unread: 0 })),
    );
    let tell: (event: ChatEvent) => void = () => undefined;
    const chat = fakeChat({
      listen: (listener: (event: ChatEvent) => void) => {
        tell = listener;
        return () => undefined;
      },
    });
    const counts: number[] = [];
    render(
      <ConversationView
        playerId={ADA}
        chat={chat}
        visible={false}
        onPlayer={(_, count) => counts.push(count)}
      />,
    );
    await settle();
    expect(counts.at(-1)).toBe(2);
    // Bob still has one unread elsewhere: the event's count is the account's, 1. The window asks
    // for its own.
    act(() => tell({ type: "read", player_id: ADA, unread: 1 }));
    await settle();
    expect(sent("GET /api/v1/conversations/{player_id}")).toHaveLength(2);
    expect(counts.at(-1)).toBe(0);
    // Nothing unread here: a read asks nothing.
    act(() => tell({ type: "read", player_id: ADA, unread: 1 }));
    await settle();
    expect(sent("GET /api/v1/conversations/{player_id}")).toHaveLength(2);
  });

  it("asks again when the friends list's friendship changes, and offers no Try again to an ex-friend (v0.5.1)", async () => {
    on(
      "GET /api/v1/conversations/{player_id}",
      () => reply(200, page()),
      () => reply(200, page({ friends: false })),
      () => reply(200, page()),
    );
    on("POST /api/v1/conversations/{player_id}/messages", () => ({
      error: {
        code: "not_friends",
        message: "You can write only to your friends.",
      },
      response: new Response(null, { status: 409 }),
    }));
    const chat = fakeChat();
    const view = (friend: boolean) => (
      <ConversationView playerId={ADA} chat={chat} visible friend={friend} />
    );
    const { rerender } = render(view(true));
    await settle();
    // The two still agree: nothing more is asked.
    expect(sent("GET /api/v1/conversations/{player_id}")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Write to ada"), {
      target: { value: "Still there?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    // Refused, as no longer friends: the box closes, and trying again could only fail. The list,
    // which still counts ada a friend, has the conversation ask once, which agrees.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You can write only to your friends.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByLabelText("Write to ada")).toBeNull();
    expect(sent("GET /api/v1/conversations/{player_id}")).toHaveLength(2);
    // The list catches up: nothing more is asked.
    rerender(view(false));
    await settle();
    expect(sent("GET /api/v1/conversations/{player_id}")).toHaveLength(2);
    // They make up, and the list counts ada a friend again: the conversation asks on its own, and
    // its box opens.
    rerender(view(true));
    await settle();
    const asked = sent("GET /api/v1/conversations/{player_id}");
    expect(asked).toHaveLength(3);
    expect(asked[2]!.init?.headers).toEqual({ "X-Background": "1" });
    expect(screen.getByLabelText("Write to ada")).toBeInTheDocument();
  });
});

/** Mounts useChat and hands its result out, with the chat bar: as App does, a table's own, drawn
 * afresh for each game and apart from the pages'. */
let shown: Chat | null = null;
function Probe({
  me,
  checkedIn = null,
  table = null,
}: {
  me: Me | null;
  checkedIn?: number | null;
  /** The game whose table is shown. */
  table?: string | null;
}) {
  shown = useChat(me, checkedIn, table);
  return (
    <ChatContext.Provider value={shown}>
      <ChatBar key={table ? `chat-${table}` : "pages"} chat={shown} />
    </ChatContext.Provider>
  );
}
const me = { id: ME, status: "active" } as Me;
/** Where the browser keeps the account's windows and list (v0.5.1). */
const WINDOWS_KEY = `cd.chat.windows.${ME}`;
const PANEL_KEY = `cd.chat.friends.${ME}`;

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
    expect(savedWindows(ME)).toEqual([
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

  it("keeps each account's windows, list and drafts to itself, and forgets them on sign-out (v0.5.1)", async () => {
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(200, page({ messages: [] })),
    );
    // Kept before v0.5.1 for whoever used the browser: they go, unread.
    localStorage.setItem(
      "cd.chat.windows",
      JSON.stringify([{ playerId: CAL, folded: false }]),
    );
    localStorage.setItem("cd.chat.friends", "open");
    const { rerender } = render(<Probe me={me} />);
    expect(shown!.windows).toEqual([]);
    expect(shown!.panel).toBe(false);
    expect(localStorage.getItem("cd.chat.windows")).toBeNull();
    expect(localStorage.getItem("cd.chat.friends")).toBeNull();
    act(() => shown!.open(ADA));
    act(() => shown!.setPanel(true));
    fireEvent.change(await screen.findByLabelText("Write to ada"), {
      target: { value: "See you at the table" },
    });
    expect(savedWindows(ME)).toEqual([{ playerId: ADA, folded: false }]);
    expect(savedPanel(ME)).toBe(true);
    // Another account signs in on this browser: nothing of the last one's, and the browser
    // forgets what it kept for it.
    const other = { id: OTHER, status: "active" } as Me;
    rerender(<Probe me={other} />);
    expect(shown!.windows).toEqual([]);
    expect(shown!.panel).toBe(false);
    expect(screen.queryByRole("region", { name: /^Chat with/ })).toBeNull();
    expect(localStorage.getItem(WINDOWS_KEY)).toBeNull();
    expect(localStorage.getItem(PANEL_KEY)).toBeNull();
    act(() => shown!.open(BOB));
    expect(savedWindows(OTHER)).toEqual([{ playerId: BOB, folded: false }]);
    // Signing out forgets that account's too.
    rerender(<Probe me={null} />);
    expect(shown!.windows).toEqual([]);
    expect(savedWindows(OTHER)).toEqual([]);
    expect(localStorage.getItem(`cd.chat.windows.${OTHER}`)).toBeNull();
    // The first account back: a fresh start, its draft gone with the sign-out.
    rerender(<Probe me={me} />);
    expect(shown!.windows).toEqual([]);
    act(() => shown!.open(ADA));
    expect(await screen.findByLabelText("Write to ada")).toHaveValue("");
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
    expect(localStorage.getItem(PANEL_KEY)).toBe("open");
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(savedPanel(ME)).toBe(false);
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
      WINDOWS_KEY,
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
    localStorage.setItem(PANEL_KEY, "open");
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
    localStorage.setItem(PANEL_KEY, "open");
    localStorage.setItem(
      WINDOWS_KEY,
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

  it("takes a friendship that ended off the list and the window, whatever older conversations said (v0.5.1)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const dee = friend(DEE, "dee", { presence: presence("online") });
    let ended = false;
    on("GET /api/v1/friends", () =>
      reply(200, {
        friends: ended ? [ada] : [ada, dee],
        incoming: [],
        outgoing: [],
      }),
    );
    on("GET /api/v1/conversations", () =>
      reply(200, {
        conversations: [
          {
            player: dee,
            friends: true,
            last_message: message({ sender_id: DEE }),
            unread: 0,
          },
        ],
        unread: 0,
      }),
    );
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(
        200,
        page({
          player: friend(DEE, "dee", { presence: null }),
          friends: !ended,
        }),
      ),
    );
    localStorage.setItem(PANEL_KEY, "open");
    localStorage.setItem(
      WINDOWS_KEY,
      JSON.stringify([{ playerId: DEE, folded: false }]),
    );
    render(<Probe me={me} />);
    // The socket is up, so the window does not ask now and then on its own.
    const [socket] = FakeSocket.all;
    act(() => socket!.onopen?.());
    socket!.tell({ type: "welcome", unread: 0 });
    await settle();
    expect(toggle()).toHaveAccessibleName("Friends, 2 online");
    const friends = () => screen.getByRole("list", { name: "Your friends" });
    expect(
      within(friends()).getByRole("button", { name: /^Chat with dee/ }),
    ).toHaveAccessibleName("Chat with dee, Online");
    const window = screen.getByRole("region", { name: "Chat with dee" });
    expect(within(window).getByLabelText("Write to dee")).toBeInTheDocument();
    // Dee ends the friendship, or blocks: the friends asked for again no longer list dee, and the
    // older conversations' word does not bring dee back, nor the presence the two shared.
    ended = true;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(toggle()).toHaveAccessibleName("Friends, 1 online");
    expect(
      within(friends()).queryByRole("button", { name: /^Chat with dee/ }),
    ).toBeNull();
    expect(
      within(
        screen.getByRole("list", { name: "Earlier conversations" }),
      ).getByRole("button"),
    ).toHaveAccessibleName("Chat with dee, No longer friends");
    expect(
      within(window).getByRole("button", { expanded: true, name: /^dee/ }),
    ).not.toHaveTextContent("Online");
    // The window asks again on its own, and its box closes.
    await settle();
    expect(within(window).queryByLabelText("Write to dee")).toBeNull();
    expect(window).toHaveTextContent("You and dee are not friends");
  });

  it("drops a pop-up waiting at the table once its conversation is read or shown (v0.5.1)", async () => {
    people();
    on("GET /api/v1/conversations/{player_id}", () =>
      reply(200, page({ unread: 1 })),
    );
    on("POST /api/v1/conversations/{player_id}/read", () =>
      reply(200, { unread: 0 }),
    );
    localStorage.setItem(
      WINDOWS_KEY,
      JSON.stringify([{ playerId: ADA, folded: false }]),
    );
    render(<Probe me={me} table="g1" />);
    const [socket] = FakeSocket.all;
    act(() => socket!.onopen?.());
    socket!.tell({ type: "welcome", unread: 0 });
    const bob = { ...ada, id: BOB, handle: "bob" };
    for (const [who, id] of [
      [ada, "m7"],
      [bob, "m8"],
    ] as const)
      socket!.tell({
        type: "message",
        player_id: who.id,
        player: who,
        message: message({ id, sender_id: who.id }),
        unread: 2,
      });
    // Put away, the table has no bell: the pop-ups wait for the pages.
    const waiting = () => shown!.toasts.map((each) => each.player.handle);
    expect(waiting()).toEqual(["bob", "ada"]);
    // Bob's conversation is read on the phone meanwhile: it would pop up as new after the game.
    socket!.tell({ type: "read", player_id: BOB, unread: 1 });
    expect(waiting()).toEqual(["ada"]);
    // The bar brought out shows Ada's window, which reads her message: hers goes too.
    act(() => shown!.setTableOpen(true));
    await settle();
    expect(waiting()).toEqual([]);
    expect(sent("POST /api/v1/conversations/{player_id}/read")).toHaveLength(1);
  });

  it("starts the next table's bar put away from its first drawing, asking nothing (v0.5.1)", async () => {
    people();
    on("GET /api/v1/conversations/{player_id}", () => reply(200, page()));
    localStorage.setItem(
      WINDOWS_KEY,
      JSON.stringify([{ playerId: ADA, folded: false }]),
    );
    const { rerender } = render(<Probe me={me} table="g1" />);
    act(() => shown!.setTableOpen(true));
    await settle();
    expect(document.getElementById("chat-bar")).not.toBeNull();
    const asked = calls.length;
    // A rematch, straight from one table to the next, with the bar out at the first.
    rerender(<Probe me={me} table="g2" />);
    await settle();
    expect(shown!.tableOpen).toBe(false);
    // Never drawn there, not even hidden, and nothing asked of the API.
    expect(document.getElementById("chat-bar")).toBeNull();
    expect(calls.slice(asked).map((each) => each.route)).toEqual([]);
  });

  it("keeps what is being written from the pages to the table and back, in memory only (v0.5.1)", async () => {
    people();
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
    localStorage.setItem(
      WINDOWS_KEY,
      JSON.stringify([{ playerId: ADA, folded: false }]),
    );
    const { rerender } = render(<Probe me={me} />);
    fireEvent.change(await screen.findByLabelText("Write to ada"), {
      target: { value: "Half a rep" },
    });
    // The queue finds a game: the table's own bar, brought out, has it still.
    rerender(<Probe me={me} table="g1" />);
    act(() => shown!.setTableOpen(true));
    const box = await screen.findByLabelText("Write to ada");
    expect(box).toHaveValue("Half a rep");
    fireEvent.change(box, { target: { value: "Half a reply" } });
    // Back on the pages after the game, it is there; the browser's storage never had it.
    rerender(<Probe me={me} />);
    expect(await screen.findByLabelText("Write to ada")).toHaveValue(
      "Half a reply",
    );
    const stored = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.getItem(localStorage.key(index)!),
    ).join();
    expect(stored).not.toContain("Half a");
    // Sent, it is gone.
    fireEvent.keyDown(screen.getByLabelText("Write to ada"), { key: "Enter" });
    await settle();
    expect(shown!.draft(ADA)).toBe("");
  });

  it("marks the reads it makes on its own, never the player's or the page's first (v0.5.1)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    people();
    render(<Probe me={me} />);
    await settle();
    const [socket] = FakeSocket.all;
    act(() => socket!.onopen?.());
    socket!.tell({ type: "welcome", unread: 0 });
    // The player opens the list; then the socket tells of a read mark, and the friends' 30
    // seconds pass.
    fireEvent.click(toggle());
    await settle();
    socket!.tell({ type: "read", player_id: ADA, unread: 0 });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    const headers = (route: string) =>
      sent(route).map((each) => each.init?.headers ?? null);
    const marked = { "X-Background": "1" };
    expect(headers("GET /api/v1/friends")).toEqual([null, marked]);
    expect(headers("GET /api/v1/conversations")).toEqual([null, marked]);
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
