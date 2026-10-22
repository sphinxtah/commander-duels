import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
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
  savedWindows,
  useChat,
  WINDOWS,
  type Chat,
  type ChatMessage,
} from "./chat";
import { ChatDock } from "./ChatDock";
import { ConversationView } from "./Conversation";
import { MessagesPage } from "./MessagesPage";

// Chat between friends (v0.4.4): a conversation's sending, failures and reports; the live
// connection's count, pop-ups and windows; and the Messages page.

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
beforeEach(() => {
  calls = [];
  queues.clear();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
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

/** Mounts useChat and hands its result out. */
let shown: Chat | null = null;
function Probe({
  me,
  checkedIn = null,
}: {
  me: Me;
  checkedIn?: number | null;
}) {
  shown = useChat(me, checkedIn);
  return (
    <ChatContext.Provider value={shown}>
      <ChatDock chat={shown} />
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
    // Opening the conversation takes its pop-up away; its messages no longer pop up.
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
    expect(screen.getAllByRole("region")).toHaveLength(3);
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

describe("the Messages page", () => {
  it("lists the conversations and shows one beside them", async () => {
    on("GET /api/v1/conversations", () =>
      reply(200, {
        conversations: [
          { player: ada, friends: true, last_message: message(), unread: 2 },
        ],
        unread: 2,
      }),
    );
    on("GET /api/v1/conversations/{player_id}", () => reply(200, page()));
    render(<MessagesPage chat={null} playerId={ADA} heading={createRef()} />);
    await settle();
    const list = screen.getByRole("list", { name: "Conversations" });
    const link = within(list).getByRole("link", { name: /ada/ });
    expect(link).toHaveAttribute("href", `#messages/${ADA}`);
    expect(link).toHaveAttribute("aria-current", "page");
    expect(within(list).getByLabelText("2 unread")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Conversation with ada" }),
    ).toBeInTheDocument();
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
