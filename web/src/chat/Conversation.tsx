import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { client, describe } from "../api";
import { timeAgo, type PlayerSummary } from "../social/social";
import {
  MESSAGE_LENGTH,
  newClientId,
  useTabInUse,
  type Chat,
  type ChatMessage,
} from "./chat";
import { ReportMessageDialog, type ReportedMessage } from "./ReportMessage";
import styles from "./chat.module.css";

// One conversation with a friend (v0.4.4), in a window on the chat bar (v0.5.1): its messages,
// the older ones a page at a time, the box to write in, and what the socket says as it happens. A message waits greyed until the server has it; one that fails says so and can
// be sent again under the same client_id, so it lands once. A conversation that is shown, in a
// tab in use, is read: the page tells the server up to the newest message of the friend's.

/** A message on its way: shown greyed until the server answers, or failed with Try again. */
interface Pending {
  clientId: string;
  body: string;
  failed: string;
}

// While the live connection is down, a shown conversation asks again this often.
const POLL_MS = 30_000;

/** A conversation's messages and how to write in it. */
export function useConversation(
  playerId: string,
  chat: Chat | null,
  visible: boolean,
) {
  const [player, setPlayer] = useState<PlayerSummary | null>(null);
  const [friends, setFriends] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  // The friend's messages not yet read, as this page knows it.
  const [unread, setUnread] = useState(0);
  const marked = useRef("");

  const merge = useCallback((more: ChatMessage[]) => {
    setMessages((before) => {
      const known = new Set(before.map((each) => each.id));
      const added = more.filter((each) => !known.has(each.id));
      if (added.length === 0) return before;
      return [...before, ...added].sort(
        (a, b) =>
          Date.parse(a.created_at) - Date.parse(b.created_at) ||
          a.id.localeCompare(b.id),
      );
    });
    const sent = new Set(more.map((each) => each.client_id));
    setPending((before) => before.filter((each) => !sent.has(each.clientId)));
  }, []);

  const load = useCallback(async () => {
    const { data, error } = await client.GET(
      "/api/v1/conversations/{player_id}",
      {
        params: { path: { player_id: playerId } },
      },
    );
    if (!data) {
      setError(describe(error));
      setState((before) => (before === "ready" ? before : "error"));
      return;
    }
    setPlayer(data.player);
    setFriends(data.friends);
    setUnread(data.unread);
    setNext((before) => before ?? data.next ?? null);
    merge(data.messages);
    setError("");
    setState("ready");
  }, [playerId, merge]);

  useEffect(() => {
    void load();
  }, [load]);
  // The socket resends nothing: coming back, the conversation asks for what it missed; while it
  // is down, it asks now and then.
  const live = chat?.live ?? false;
  useEffect(() => {
    if (live) {
      void load();
      return;
    }
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, load]);
  useEffect(() => {
    if (!chat) return;
    return chat.listen((event) => {
      if (event.player_id !== playerId) return;
      if (event.type === "message") {
        merge([event.message]);
        if (event.message.sender_id === playerId) setUnread((n) => n + 1);
      } else if (event.unread === 0) setUnread(0);
    });
  }, [chat, playerId, merge]);

  // Shown in a tab in use: the friend's messages are read, up to the newest.
  const newestTheirs = [...messages]
    .reverse()
    .find((each) => each.sender_id === playerId);
  useEffect(() => {
    if (!visible || !chat || unread === 0 || !newestTheirs) return;
    if (marked.current === newestTheirs.id) return;
    marked.current = newestTheirs.id;
    setUnread(0);
    void chat.markRead(playerId, newestTheirs.created_at);
  }, [visible, chat, unread, newestTheirs, playerId]);

  async function older() {
    if (!next) return;
    const { data, error } = await client.GET(
      "/api/v1/conversations/{player_id}",
      {
        params: { path: { player_id: playerId }, query: { cursor: next } },
      },
    );
    if (!data) return setError(describe(error));
    setNext(data.next ?? null);
    merge(data.messages);
  }

  async function send(body: string, clientId = newClientId()) {
    setPending((before) => [
      ...before.filter((each) => each.clientId !== clientId),
      { clientId, body, failed: "" },
    ]);
    const { data, error, response } = await client.POST(
      "/api/v1/conversations/{player_id}/messages",
      {
        params: { path: { player_id: playerId } },
        body: { text: body, client_id: clientId },
      },
    );
    if (data) return merge([data]);
    if (response?.status === 409) setFriends(false);
    const wait = Number(response?.headers.get("Retry-After")) || 0;
    const why =
      response?.status === 429
        ? `You are sending messages very fast. Wait ${wait || "a few"} seconds.`
        : describe(error);
    setPending((before) =>
      before.map((each) =>
        each.clientId === clientId ? { ...each, failed: why } : each,
      ),
    );
  }

  return {
    player,
    friends,
    messages,
    pending,
    next,
    state,
    error,
    unread,
    older,
    send,
  };
}

function Message({
  message,
  mine,
  sender,
  onReport,
}: {
  message: ChatMessage;
  mine: boolean;
  sender: string;
  onReport: () => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <li className={styles.message} data-mine={mine || undefined}>
      <span className={styles.visuallyHidden}>{mine ? "You" : sender}: </span>
      <span className={styles.body}>{message.body}</span>
      <time
        dateTime={message.created_at}
        title={new Date(message.created_at).toLocaleString()}
      >
        {timeAgo(message.created_at)}
      </time>
      {!mine && (
        <span className={styles.menu}>
          <button
            type="button"
            className={styles.menuButton}
            aria-label={`More about the message from ${sender}`}
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
          >
            ⋯
          </button>
          {menu && (
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                setMenu(false);
                onReport();
              }}
            >
              Report
            </button>
          )}
        </span>
      )}
    </li>
  );
}

/** The messages and the box to write in; the header is the window's. */
export function ConversationView({
  playerId,
  chat,
  visible,
  compact = false,
  onPlayer,
  focus = false,
  onFocused,
}: {
  playerId: string;
  chat: Chat | null;
  /** Shown, in a tab in use: its messages are read. */
  visible: boolean;
  /** In a docked window: smaller. */
  compact?: boolean;
  /** Who the friend is, once known, for the header. */
  onPlayer?: (player: PlayerSummary, unread: number) => void;
  /** Just opened (v0.5.1): once loaded, focus moves to the box to write in, or to the messages
   * when the two are no longer friends. */
  focus?: boolean;
  onFocused?: () => void;
}) {
  const inUse = useTabInUse();
  const conversation = useConversation(playerId, chat, visible && inUse);
  const { player, friends, messages, pending, next, state, error } =
    conversation;
  const [text, setText] = useState("");
  const [reported, setReported] = useState<ReportedMessage | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const heightBefore = useRef<number | null>(null);
  const handle = player?.handle ?? "your friend";

  useEffect(() => {
    if (player) onPlayer?.(player, conversation.unread);
  }, [player, conversation.unread, onPlayer]);
  useEffect(() => {
    if (!focus || state === "loading") return;
    (box.current ?? list.current)?.focus();
    onFocused?.();
  }, [focus, state, onFocused]);
  // New messages keep the newest in view when it was; older ones keep the reader's place.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (heightBefore.current !== null) {
      element.scrollTop += element.scrollHeight - heightBefore.current;
      heightBefore.current = null;
    } else if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, pending.length, state]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = text.trim();
    if (!body || !friends) return;
    setText("");
    atBottom.current = true;
    void conversation.send(body);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter starts a new line, as do the keys of a phone's keyboard.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className={styles.conversation} data-compact={compact || undefined}>
      {state === "loading" && <p className={styles.quiet}>Loading…</p>}
      {state === "error" && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <ol
        ref={list}
        className={styles.messages}
        aria-label={`Messages with ${handle}`}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            40;
        }}
      >
        {next && (
          <li className={styles.olderRow}>
            <button
              type="button"
              className={styles.older}
              onClick={() => {
                heightBefore.current = list.current?.scrollHeight ?? null;
                void conversation.older();
              }}
            >
              Show older messages
            </button>
          </li>
        )}
        {state === "ready" && messages.length === 0 && pending.length === 0 && (
          <li className={styles.quiet}>
            {friends
              ? `No messages yet. Say hello to ${handle}.`
              : "No messages."}
          </li>
        )}
        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            mine={message.sender_id !== playerId}
            sender={handle}
            onReport={() =>
              setReported({
                kind: "direct",
                id: message.id,
                sender: handle,
                body: message.body,
              })
            }
          />
        ))}
        {pending.map((each) => (
          <li
            key={each.clientId}
            className={styles.message}
            data-mine=""
            data-pending={each.failed ? undefined : ""}
            data-failed={each.failed ? "" : undefined}
          >
            <span className={styles.body}>{each.body}</span>
            {each.failed ? (
              <span className={styles.failed} role="alert">
                {each.failed}{" "}
                <button
                  type="button"
                  className={styles.retry}
                  onClick={() =>
                    void conversation.send(each.body, each.clientId)
                  }
                >
                  Try again
                </button>
              </span>
            ) : (
              <span className={styles.sending}>Sending…</span>
            )}
          </li>
        ))}
      </ol>
      {friends ? (
        <form className={styles.composer} onSubmit={submit}>
          <label
            className={styles.visuallyHidden}
            htmlFor={`write-${playerId}`}
          >
            Write to {handle}
          </label>
          <textarea
            ref={box}
            id={`write-${playerId}`}
            value={text}
            rows={compact ? 1 : 2}
            maxLength={MESSAGE_LENGTH}
            placeholder={`Write to ${handle}…`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={keyDown}
          />
          <button type="submit" className={styles.send} disabled={!text.trim()}>
            Send
          </button>
          {text.length > MESSAGE_LENGTH - 50 && (
            <small className={styles.count}>
              {MESSAGE_LENGTH - text.length} left
            </small>
          )}
        </form>
      ) : (
        <p className={styles.closed}>
          You and {handle} are not friends, so you cannot write here.
        </p>
      )}
      <ReportMessageDialog
        message={reported}
        onClose={() => setReported(null)}
      />
    </div>
  );
}
