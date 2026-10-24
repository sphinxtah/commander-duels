import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { client, currentCsrfToken, loadMe, type Me } from "../api";
import type { components } from "../generated/api";
import type { PlayerRef } from "../social/social";

// Chat between friends (v0.4.4): the account's live connection, the unread count, the windows
// docked on the chat bar and its friends list (v0.5.1), and the messages that pop up beside the
// bell. The chat's WebSocket (/api/v1/chat/events) only tells this page what happened: a message
// stored, a conversation read in some tab. Messages are sent and pages read over HTTP.
// docs/chat.md describes it all.

export type ChatMessage = components["schemas"]["ChatMessage"];
export type ConversationItem = components["schemas"]["ConversationItem"];
export type MessagePage = components["schemas"]["MessagePage"];

/** What the socket tells, for the conversations shown to follow. */
export type ChatEvent =
  | {
      type: "message";
      player_id: string;
      /** The other player of the conversation. */
      player: PlayerRef;
      message: ChatMessage;
      unread: number;
    }
  | { type: "read"; player_id: string; unread: number };

/** A docked window: whose conversation, and whether it is folded to its title bar. */
export interface ChatWindow {
  playerId: string;
  folded: boolean;
}

/** A message that pops up beside the bell for a moment. */
export interface MessageToast {
  player: PlayerRef;
  message: ChatMessage;
}

export const MESSAGE_LENGTH = 500;
export const WINDOWS = 3;
export const TOAST_MS = 8000;
const WINDOWS_KEY = "cd.chat.windows";
const PANEL_KEY = "cd.chat.friends";
const PING_MS = 25_000;

/** The Messages page's old addresses (v0.4.4). The page is gone since v0.5.1: #messages opens the
 * chat bar's friends list, and #messages/<id> that player's window. */
export const MESSAGES_ROUTE = /^#messages(?:\/([0-9a-f-]{36}))?$/i;

/** What an old Messages address opens: a player's window (their ID), the friends list (""), or
 * nothing (undefined) for any other address. */
export function oldMessagesRoute(hash: string): string | undefined {
  const found = MESSAGES_ROUTE.exec(hash);
  if (!found) return undefined;
  return found[1]?.toLowerCase() ?? "";
}

/** A link's address for a player's window: followed in another tab, the app opens it there. A
 * click in this tab opens the window itself (chat.open). */
export function messagesLink(playerId?: string): string {
  return playerId ? `#messages/${playerId}` : "#messages";
}

/** Narrower than this, as for the shell's bar of pages (shell.module.css), the screen is a phone's:
 * the chat bar folds to one button and shows one conversation at a time. */
export const PHONE_WIDTH = 820;
// The chat bar's measures on a wider screen (chat.module.css): a window, the friends list, the
// gap between them, and the room left at the screen's edges.
const WINDOW_WIDTH = 300;
const FRIENDS_WIDTH = 280;
const GAP = 10;
const EDGES = 30;

/** How many windows fit beside the friends list on a screen this wide: at most WINDOWS, and one
 * on a phone. The others stay open, waiting their turn, and come back as the screen widens. */
export function roomFor(width: number): number {
  if (width <= PHONE_WIDTH) return 1;
  const fits = Math.floor(
    (width - EDGES - FRIENDS_WIDTH) / (WINDOW_WIDTH + GAP),
  );
  return Math.max(1, Math.min(WINDOWS, fits));
}

function onResize(change: () => void) {
  window.addEventListener("resize", change);
  return () => window.removeEventListener("resize", change);
}

/** How the screen's width shapes the bar: its room for windows, and whether it is a phone's. Each
 * changes only at its own widths, so resizing the window draws the app again only there. */
function useScreen(): { room: number; phone: boolean } {
  const room = useSyncExternalStore(onResize, () => roomFor(window.innerWidth));
  const phone = useSyncExternalStore(
    onResize,
    () => window.innerWidth <= PHONE_WIDTH,
  );
  return { room, phone };
}

/** A message's own ID, so a resend lands once. randomUUID needs a secure page (HTTPS or this
 * machine); elsewhere the same comes from random bytes. */
export function newClientId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The windows open when the page last closed: which, and folded or not; never what was written. */
export function savedWindows(): ChatWindow[] {
  try {
    const saved = JSON.parse(
      localStorage.getItem(WINDOWS_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(saved)) return [];
    return saved
      .filter(
        (each): each is ChatWindow =>
          typeof each?.playerId === "string" &&
          /^[0-9a-f-]{36}$/i.test(each.playerId) &&
          typeof each.folded === "boolean",
      )
      .slice(-WINDOWS);
  } catch {
    return [];
  }
}

function saveWindows(windows: ChatWindow[]) {
  try {
    localStorage.setItem(WINDOWS_KEY, JSON.stringify(windows));
  } catch {
    // A private window, or storage turned off: the windows last only this visit.
  }
}

/** Whether the bar's friends list was open when the page last closed (v0.5.1). */
export function savedPanel(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === "open";
  } catch {
    return false;
  }
}

function savePanel(open: boolean) {
  try {
    localStorage.setItem(PANEL_KEY, open ? "open" : "folded");
  } catch {
    // As for the windows.
  }
}

/** A friend's message said to screen readers: one that arrived in a window shown, which does not
 * pop up, or at the table, which has no bell for it to pop up beside. */
export interface ChatSaid {
  id: string;
  words: string;
}

/** The chat as the app shares it: the count, the windows and the live events. */
export interface Chat {
  /** Unread messages in every conversation. */
  unread: number;
  setUnread: (count: number) => void;
  /** Whether the live connection is up: while it is not, conversations ask again now and then. */
  live: boolean;
  /** Every open window, the oldest first. */
  windows: ChatWindow[];
  /** The windows on the bar: the newest that fit the screen (one on a phone). */
  docked: ChatWindow[];
  /** A phone's screen: the bar is one button, and one thing shows at a time. */
  phone: boolean;
  /** On a phone, what lies across the screen's lower part, the whole width: the friends list, a
   * conversation, or nothing. It covers the bar of pages, and a conversation the bar's own
   * button, which are out of reach meanwhile. */
  sheet: "list" | "window" | null;
  /** Opens a friend's window, unfolded, or unfolds it, and gives it focus; the oldest of more
   * than WINDOWS goes. On a phone it closes the friends list. */
  open: (playerId: string) => void;
  close: (playerId: string) => void;
  fold: (playerId: string, folded: boolean) => void;
  /** Whether a window's conversation is shown: on the bar, unfolded, not under the friends list
   * on a phone, and at the table not folded away. */
  shows: (window: ChatWindow) => boolean;
  /** The window just opened, which takes focus once it is drawn. */
  focusing: string | null;
  focused: () => void;
  /** The bar's friends list (v0.5.1): open or folded to its title bar, as the browser
   * remembers. */
  panel: boolean;
  setPanel: (open: boolean) => void;
  /** The game's table is shown: the bar folds away into the band's diamond until asked for. */
  atTable: boolean;
  /** At the table, whether the bar is out, floating over the table. Each table starts without. */
  tableOpen: boolean;
  setTableOpen: (open: boolean) => void;
  toasts: MessageToast[];
  dismiss: (messageId: string) => void;
  /** The last message said to screen readers from the bar: one in a window shown, and at the
   * table every one. */
  said: ChatSaid | null;
  /** Follows the socket's events; returns the way to stop. */
  listen: (listener: (event: ChatEvent) => void) => () => void;
  /** Marks a friend's messages read up to a time, in every tab. */
  markRead: (playerId: string, upTo: string) => Promise<void>;
}

export const ChatContext = createContext<Chat | null>(null);

/** Whether this tab is shown: a hidden tab reads nothing. */
export function useTabInUse(): boolean {
  const [shown, setShown] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const change = () => setShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return shown;
}

/** The app's chat, for a Message button: null outside an active account's app. */
export function useChatContext(): Chat | null {
  return useContext(ChatContext);
}

/**
 * The chat's live connection: one per tab, signed in by the session's cookie and its CSRF token.
 * It reconnects with backoff after a drop or a restart, and after a session refresh at once, as
 * the game's socket does (game/connection.ts). A signed-out session ends it; the app then leaves.
 */
export class ChatSocket {
  private socket: WebSocket | null = null;
  private timer: number | undefined;
  private pinger: number | undefined;
  private attempts = 0;
  private lastError = "";
  private refreshed = false;
  private stopped = false;

  constructor(
    private readonly onEvent: (event: ChatEvent) => void,
    private readonly onLive: (live: boolean, unread?: number) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    window.clearInterval(this.pinger);
    this.socket?.close(1000);
    this.socket = null;
  }

  private open(): void {
    if (this.stopped) return;
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        `${scheme}//${window.location.host}/api/v1/chat/events`,
      );
    } catch {
      return this.reconnect();
    }
    this.socket = socket;
    this.lastError = "";
    socket.onopen = () =>
      socket.send(
        JSON.stringify({ type: "hello", csrf_token: currentCsrfToken() ?? "" }),
      );
    socket.onmessage = (event) => {
      let message: { type?: string; code?: string; unread?: number };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (message.type === "welcome") {
        this.attempts = 0;
        this.refreshed = false;
        this.onLive(true, message.unread);
        window.clearInterval(this.pinger);
        this.pinger = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "ping" }));
        }, PING_MS);
      } else if (message.type === "message" || message.type === "read") {
        this.onEvent(message as ChatEvent);
      } else if (message.type === "error" && message.code) {
        this.lastError = message.code;
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      window.clearInterval(this.pinger);
      this.onLive(false);
      void this.closed(event.code);
    };
  }

  private async closed(code: number): Promise<void> {
    if (this.stopped) return;
    if (
      code === 4401 &&
      this.lastError === "session_refresh" &&
      !this.refreshed
    ) {
      // The account's roles changed: a request rotates the cookie, then the socket comes back.
      this.refreshed = true;
      await loadMe().catch(() => null);
      return this.open();
    }
    if (code === 4401) return; // Signed out: the app shows the sign-in page.
    if (
      code === 4403 &&
      this.lastError === "csrf_failed" &&
      this.attempts === 0
    ) {
      this.attempts += 1;
      await loadMe().catch(() => null);
      return this.open();
    }
    this.reconnect();
  }

  private reconnect(): void {
    const delay =
      Math.min(30_000, 1000 * 2 ** Math.min(this.attempts, 5)) +
      Math.random() * 500;
    this.attempts += 1;
    this.timer = window.setTimeout(() => this.open(), delay);
  }
}

/** The account's chat: its socket while the account is active, the windows, the bar's friends
 * list and the pop-ups. `table` is the game whose table is shown, if one is. */
export function useChat(
  me: Me | null | undefined,
  checkedIn: number | null,
  table: string | null = null,
): Chat {
  const account = me?.status === "active" ? me.id : null;
  const atTable = table !== null;
  const [unread, setUnread] = useState(0);
  const [live, setLive] = useState(false);
  const [windows, setWindows] = useState<ChatWindow[]>(savedWindows);
  const [toasts, setToasts] = useState<MessageToast[]>([]);
  const [panel, setPanel] = useState(savedPanel);
  const [tableOpen, setTableOpen] = useState(false);
  const [focusing, setFocusing] = useState<string | null>(null);
  const [said, setSaid] = useState<ChatSaid | null>(null);
  const listeners = useRef(new Set<(event: ChatEvent) => void>());
  const { room, phone } = useScreen();
  const docked = useMemo(() => windows.slice(-room), [windows, room]);
  // What is shown, so its messages do not pop up: the windows on the bar, unfolded, on a phone
  // not under the friends list, and at the table only while the bar is out.
  const shows = useCallback(
    (shown: ChatWindow) =>
      !shown.folded &&
      !(phone && panel) &&
      !(atTable && !tableOpen) &&
      docked.some((each) => each.playerId === shown.playerId),
    [docked, phone, panel, atTable, tableOpen],
  );
  const showing = useRef(new Set<string>());
  showing.current = new Set(docked.filter(shows).map((each) => each.playerId));
  const sheet: Chat["sheet"] =
    !account || !phone || (atTable && !tableOpen)
      ? null
      : panel
        ? "list"
        : docked.some((each) => !each.folded)
          ? "window"
          : null;
  const phoneNow = useRef(phone);
  phoneNow.current = phone;
  const atTableNow = useRef(atTable);
  atTableNow.current = atTable;

  useEffect(() => saveWindows(windows), [windows]);
  useEffect(() => savePanel(panel), [panel]);
  // Each table starts with the bar folded away, so it covers nothing of the table; the next
  // game's too, a rematch's straight after.
  useEffect(() => {
    setTableOpen(false);
  }, [table]);
  useEffect(() => {
    setUnread(0);
    setToasts([]);
    setLive(false);
    setSaid(null);
    if (!account) return;
    const socket = new ChatSocket(
      (event) => {
        setUnread(event.unread);
        for (const listener of listeners.current) listener(event);
        if (event.type !== "message" || event.message.sender_id === account)
          return;
        const visible = document.visibilityState !== "hidden";
        const said = {
          id: event.message.id,
          words: `${event.player.handle}: ${event.message.body}`,
        };
        if (visible && showing.current.has(event.player_id)) {
          // Shown, it does not pop up: screen readers hear it from the bar instead.
          setSaid(said);
          return;
        }
        // The table has no bell to pop up beside: screen readers hear it from the bar, and the
        // pop-up waits for the pages (v0.5.1).
        if (atTableNow.current) setSaid(said);
        setToasts((before) => [
          { player: event.player, message: event.message },
          ...before.filter((each) => each.player.id !== event.player_id),
        ]);
      },
      (up, count) => {
        setLive(up);
        if (count !== undefined) setUnread(count);
      },
    );
    socket.start();
    return () => socket.stop();
  }, [account]);

  // The check-in's count, while the socket is down or before it says. After the account's own
  // effect, which starts again from nothing.
  useEffect(() => {
    if (checkedIn !== null) setUnread(checkedIn);
  }, [checkedIn]);

  const open = useCallback((playerId: string) => {
    setWindows((before) => {
      const others = before.filter((each) => each.playerId !== playerId);
      return [...others, { playerId, folded: false }].slice(-WINDOWS);
    });
    setToasts((before) => before.filter((each) => each.player.id !== playerId));
    setFocusing(playerId);
    // A phone shows one thing at a time: the conversation, not the list it was chosen from.
    if (phoneNow.current) setPanel(false);
    if (atTableNow.current) setTableOpen(true);
  }, []);
  const focused = useCallback(() => setFocusing(null), []);
  const close = useCallback(
    (playerId: string) =>
      setWindows((before) =>
        before.filter((each) => each.playerId !== playerId),
      ),
    [],
  );
  const fold = useCallback(
    (playerId: string, folded: boolean) =>
      setWindows((before) =>
        before.map((each) =>
          each.playerId === playerId ? { ...each, folded } : each,
        ),
      ),
    [],
  );
  const dismiss = useCallback(
    (messageId: string) =>
      setToasts((before) =>
        before.filter((each) => each.message.id !== messageId),
      ),
    [],
  );
  const listen = useCallback((listener: (event: ChatEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const markRead = useCallback(async (playerId: string, upTo: string) => {
    const { data } = await client.POST(
      "/api/v1/conversations/{player_id}/read",
      {
        params: { path: { player_id: playerId } },
        body: { up_to: upTo },
      },
    );
    if (data) setUnread(data.unread);
  }, []);

  // One object while nothing in it changes, so what follows it does not start again each render.
  return useMemo(
    () => ({
      unread: account ? unread : 0,
      setUnread,
      live,
      windows: account ? windows : [],
      docked: account ? docked : [],
      phone,
      sheet,
      open,
      close,
      fold,
      shows,
      focusing,
      focused,
      panel: account ? panel : false,
      setPanel,
      atTable,
      tableOpen: account ? tableOpen : false,
      setTableOpen,
      toasts: account ? toasts : [],
      dismiss,
      said: account ? said : null,
      listen,
      markRead,
    }),
    [
      account,
      unread,
      live,
      windows,
      docked,
      phone,
      sheet,
      open,
      close,
      fold,
      shows,
      focusing,
      focused,
      panel,
      atTable,
      tableOpen,
      toasts,
      dismiss,
      said,
      listen,
      markRead,
    ],
  );
}
