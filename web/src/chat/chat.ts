import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client, currentCsrfToken, loadMe, type Me } from "../api";
import type { components } from "../generated/api";
import type { PlayerRef } from "../social/social";

// Chat between friends (v0.4.4): the account's live connection, the unread count, the docked
// windows and the messages that pop up beside the bell. The chat's WebSocket (/api/v1/chat/events)
// only tells this page what happened: a message stored, a conversation read in some tab. Messages
// are sent and pages read over HTTP. docs/chat.md describes it all.

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
const PING_MS = 25_000;

/** #messages/<id> opens one conversation on the Messages page. */
export const MESSAGES_ROUTE = /^#messages\/([0-9a-f-]{36})$/i;

export function messagesLink(playerId?: string): string {
  return playerId ? `#messages/${playerId}` : "#messages";
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

/** The chat as the app shares it: the count, the windows and the live events. */
export interface Chat {
  /** Unread messages in every conversation. */
  unread: number;
  setUnread: (count: number) => void;
  /** Whether the live connection is up: while it is not, conversations ask again now and then. */
  live: boolean;
  windows: ChatWindow[];
  /** Opens a friend's window, unfolded, or unfolds it; the oldest of more than WINDOWS goes. */
  open: (playerId: string) => void;
  close: (playerId: string) => void;
  fold: (playerId: string, folded: boolean) => void;
  /** The conversation shown on the Messages page, whose messages do not pop up. */
  setShown: (playerId: string | null) => void;
  toasts: MessageToast[];
  dismiss: (messageId: string) => void;
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

/** The account's chat: its socket while the account is active, the windows and the pop-ups. */
export function useChat(
  me: Me | null | undefined,
  checkedIn: number | null,
): Chat {
  const account = me?.status === "active" ? me.id : null;
  const [unread, setUnread] = useState(0);
  const [live, setLive] = useState(false);
  const [windows, setWindows] = useState<ChatWindow[]>(savedWindows);
  const [toasts, setToasts] = useState<MessageToast[]>([]);
  const listeners = useRef(new Set<(event: ChatEvent) => void>());
  // What is shown and in use, so its messages do not pop up: the open, unfolded windows and the
  // Messages page's conversation.
  const shown = useRef<string | null>(null);
  const windowsNow = useRef(windows);
  windowsNow.current = windows;

  useEffect(() => saveWindows(windows), [windows]);
  useEffect(() => {
    setUnread(0);
    setToasts([]);
    setLive(false);
    if (!account) return;
    const socket = new ChatSocket(
      (event) => {
        setUnread(event.unread);
        for (const listener of listeners.current) listener(event);
        if (event.type !== "message" || event.message.sender_id === account)
          return;
        const open = windowsNow.current.some(
          (each) => each.playerId === event.player_id && !each.folded,
        );
        const visible = document.visibilityState !== "hidden";
        if (visible && (open || shown.current === event.player_id)) return;
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
  }, []);
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
  const setShown = useCallback((playerId: string | null) => {
    shown.current = playerId;
    if (playerId)
      setToasts((before) =>
        before.filter((each) => each.player.id !== playerId),
      );
  }, []);
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
      open,
      close,
      fold,
      setShown,
      toasts: account ? toasts : [],
      dismiss,
      listen,
      markRead,
    }),
    [
      account,
      unread,
      live,
      windows,
      toasts,
      open,
      close,
      fold,
      setShown,
      dismiss,
      listen,
      markRead,
    ],
  );
}
