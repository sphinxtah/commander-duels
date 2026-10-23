import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { client, describe } from "../api";
import {
  messagesLink,
  TOAST_MS as MESSAGE_TOAST_MS,
  useChatContext,
} from "../chat/chat";
import chatStyles from "../chat/chat.module.css";
import { PlayerPicture } from "./PlayerBits";
import type { Social } from "./presence";
import {
  awardLink,
  notificationLink,
  notificationWords,
  playerLink,
  timeAgo,
  type NotificationItem,
} from "./social";
import styles from "./social.module.css";

// The notification bell (v0.4.3), in the top bar's right-hand corner on every page of the app:
// its count of unread notifications, and a bubble with the latest ones and a link to them all
// (#notifications, the full history). Opening the bubble or the history marks what it shows
// read. A friend request answers from either. New notifications pop up beside the bell for a
// moment, from the app's check-in (presence.ts). Since v0.4.4 new messages from a friend are one
// notification while unread, which opens the conversation; a message itself pops up beside the
// bell the moment it arrives, from the chat's connection (chat/chat.ts). Since v0.5.0 a rematch
// offered opens the game's result screen, where it is answered.

export const BUBBLE_ITEMS = 6;
export const TOAST_MS = 8000;

/** Accept or decline a friend request, then show what became of it. */
function RequestAnswer({
  item,
  onAnswered,
}: {
  item: NotificationItem;
  onAnswered: (item: NotificationItem, words: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actor = item.actor;
  if (!actor || !item.request_pending || item.kind !== "friend_request")
    return null;
  async function answer(accept: boolean) {
    setBusy(true);
    setError("");
    const path = { params: { path: { player_id: actor!.id } } };
    const { data, error } = accept
      ? await client.PUT("/api/v1/friends/{player_id}", path)
      : await client.DELETE("/api/v1/friends/{player_id}", path);
    setBusy(false);
    if (!data) return setError(describe(error));
    onAnswered(
      { ...item, request_pending: false, read: true },
      data.friendship === "friends"
        ? `You and ${actor!.handle} are friends.`
        : "Request declined.",
    );
  }
  return (
    <span className={styles.answer}>
      <button
        type="button"
        className={styles.small}
        disabled={busy}
        onClick={() => void answer(true)}
      >
        Accept
      </button>
      <button
        type="button"
        className={styles.smallQuiet}
        disabled={busy}
        onClick={() => void answer(false)}
      >
        Decline
      </button>
      {error && (
        <span className={styles.rowError} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** One notification: who, what, when, and a friend request's answer. */
export function NotificationRow({
  item,
  wasUnread,
  onFollow,
}: {
  item: NotificationItem;
  /** Unread when it was fetched: marked with a dot while shown. */
  wasUnread: boolean;
  onFollow?: () => void;
}) {
  const [shown, setShown] = useState(item);
  const [said, setSaid] = useState("");
  const chat = useChatContext();
  useEffect(() => setShown(item), [item]);
  const actor = shown.actor;
  // New messages open the conversation: its docked window, or the Messages page. A rematch
  // (v0.5.0) opens its game's result screen, which holds the offer.
  const message = shown.kind === "message" && actor;
  // A quest completed opens the main menu, an achievement Profile (v0.5.0).
  const award = awardLink(shown);
  return (
    <li className={styles.note} data-unread={wasUnread || undefined}>
      {award ? (
        <a
          href={award}
          className={styles.noteLink}
          onClick={() => onFollow?.()}
        >
          <span className={styles.noteText}>
            {notificationWords(shown)}
            <small>
              {wasUnread && (
                <span className={styles.visuallyHidden}>New. </span>
              )}
              <time dateTime={shown.created_at}>
                {timeAgo(shown.created_at)}
              </time>
            </small>
          </span>
        </a>
      ) : actor ? (
        <a
          href={
            message
              ? messagesLink(actor.id)
              : (notificationLink(shown) ?? playerLink(actor.id))
          }
          className={styles.noteLink}
          onClick={(event) => {
            if (message && chat) {
              event.preventDefault();
              chat.open(actor.id);
            }
            onFollow?.();
          }}
        >
          <PlayerPicture player={actor} size={34} />
          <span className={styles.noteText}>
            {notificationWords(shown)}
            <small>
              {wasUnread && (
                <span className={styles.visuallyHidden}>New. </span>
              )}
              <time dateTime={shown.created_at}>
                {timeAgo(shown.created_at)}
              </time>
            </small>
          </span>
        </a>
      ) : (
        <span className={styles.noteLink}>
          <span className={styles.noteText}>
            {notificationWords(shown)}
            <small>
              <time dateTime={shown.created_at}>
                {timeAgo(shown.created_at)}
              </time>
            </small>
          </span>
        </span>
      )}
      <RequestAnswer
        item={shown}
        onAnswered={(next, words) => {
          setShown(next);
          setSaid(words);
        }}
      />
      {said && (
        <span className={styles.answered} role="status">
          {said}
        </span>
      )}
    </li>
  );
}

/** Marks what was shown read, and passes on the new count. */
async function markRead(
  items: NotificationItem[],
  onUnread: (n: number) => void,
) {
  const newest = items[0];
  if (!newest || items.every((item) => item.read)) return;
  const { data } = await client.POST("/api/v1/notifications/read", {
    body: { up_to: newest.created_at },
  });
  if (data) onUnread(data.unread);
}

function useOutside(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, box, close]);
}

export function NotificationBell({
  social,
  className,
}: {
  social: Social;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const id = useId();
  const { unread, setUnread, toasts, dismiss } = social;
  const chat = useChatContext();
  const messages = chat?.toasts ?? [];
  const close = useRef(() => setOpen(false)).current;
  useOutside(open, box, close);
  // Another page closes it.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    void client
      .GET("/api/v1/notifications", {
        params: { query: { limit: BUBBLE_ITEMS } },
      })
      .then(({ data, error }) => {
        if (!active) return;
        if (!data) return setError(describe(error));
        setItems(data.items);
        setUnreadIds(
          new Set(
            data.items.filter((item) => !item.read).map((item) => item.id),
          ),
        );
        void markRead(data.items, setUnread);
      });
    bubble.current?.focus();
    return () => {
      active = false;
    };
  }, [open, setUnread]);

  // Each pop-up goes by itself after a moment.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((item) =>
      window.setTimeout(() => dismiss(item.id), TOAST_MS),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toasts, dismiss]);
  useEffect(() => {
    if (!chat || messages.length === 0) return;
    const timers = messages.map((each) =>
      window.setTimeout(() => chat.dismiss(each.message.id), MESSAGE_TOAST_MS),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [messages, chat]);

  const label =
    unread === 0 ? "Notifications" : `Notifications, ${unread} unread`;

  return (
    <div
      ref={box}
      className={[styles.bell, className].filter(Boolean).join(" ")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={styles.bellButton}
        aria-label={label}
        aria-expanded={open}
        aria-controls={`${id}-bubble`}
        onClick={() => setOpen((now) => !now)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M12 3a6 6 0 0 0-6 6v3.6L4.3 16a.7.7 0 0 0 .6 1h14.2a.7.7 0 0 0 .6-1L18 12.6V9a6 6 0 0 0-6-6Zm-2.2 15.5a2.3 2.3 0 0 0 4.4 0Z"
            fill="currentColor"
          />
        </svg>
        {unread > 0 && (
          <span className={styles.badge} aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={bubble}
          id={`${id}-bubble`}
          className={styles.bubble}
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
        >
          <h2 className={styles.bubbleTitle}>Notifications</h2>
          {error && (
            <p className={styles.rowError} role="alert">
              {error}
            </p>
          )}
          {items === null && !error && <p className={styles.quiet}>Loading…</p>}
          {items?.length === 0 && (
            <p className={styles.quiet}>
              Nothing yet. Friend requests, friends coming online, new messages,
              rematches, quests completed and achievements earned show here.
            </p>
          )}
          {items && items.length > 0 && (
            <ul className={styles.notes}>
              {items.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  wasUnread={unreadIds.has(item.id)}
                  onFollow={close}
                />
              ))}
            </ul>
          )}
          <a href="#notifications" className={styles.seeAll} onClick={close}>
            See all notifications <span aria-hidden="true">→</span>
          </a>
        </div>
      )}
      <div className={styles.toasts} role="status" aria-live="polite">
        {chat &&
          messages.map((each) => (
            <div
              key={each.message.id}
              className={[styles.toast, chatStyles.toast].join(" ")}
            >
              <button
                type="button"
                className={chatStyles.toastOpen}
                onClick={() => chat.open(each.player.id)}
              >
                <PlayerPicture player={each.player} size={30} />
                <span>
                  <strong>{each.player.handle}</strong>
                  <small>{each.message.body}</small>
                </span>
              </button>
              <button
                type="button"
                className={styles.toastClose}
                aria-label="Dismiss"
                onClick={() => chat.dismiss(each.message.id)}
              >
                ×
              </button>
            </div>
          ))}
        {toasts.map((item) => (
          <div key={item.id} className={styles.toast}>
            {awardLink(item) ? (
              <a href={awardLink(item)!} onClick={() => dismiss(item.id)}>
                <span>{notificationWords(item)}</span>
              </a>
            ) : item.actor ? (
              <a
                href={notificationLink(item) ?? playerLink(item.actor.id)}
                onClick={() => dismiss(item.id)}
              >
                <PlayerPicture player={item.actor} size={30} />
                <span>{notificationWords(item)}</span>
              </a>
            ) : (
              <span>{notificationWords(item)}</span>
            )}
            <button
              type="button"
              className={styles.toastClose}
              aria-label="Dismiss"
              onClick={() => dismiss(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The full history (#notifications), newest first, a page at a time. */
export function NotificationsPage({
  social,
  heading,
}: {
  social: Social;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const { setUnread } = social;

  async function load(cursor?: string) {
    setState("loading");
    const { data, error } = await client.GET("/api/v1/notifications", {
      params: { query: { limit: 20, ...(cursor ? { cursor } : {}) } },
    });
    if (!data) {
      setError(describe(error));
      setState("error");
      return;
    }
    setItems((before) => (cursor ? [...before, ...data.items] : data.items));
    setUnreadIds(
      (before) =>
        new Set([
          ...(cursor ? before : []),
          ...data.items.filter((item) => !item.read).map((item) => item.id),
        ]),
    );
    setNext(data.next ?? null);
    setState("ready");
    void markRead(data.items, setUnread);
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <span className={styles.eyebrow}>YOUR NOTIFICATIONS</span>
      <h1 ref={heading} tabIndex={-1}>
        Notifications
      </h1>
      <p className={styles.lead}>
        Friend requests, answers to yours, friends coming online, new messages,
        and your quests completed and achievements earned, kept for 90 days.
      </p>
      {state === "error" && (
        <p className={styles.rowError} role="alert">
          {error}
        </p>
      )}
      {state !== "loading" && items.length === 0 && state === "ready" && (
        <p className={styles.quiet}>No notifications yet.</p>
      )}
      {items.length > 0 && (
        <ul className={[styles.notes, styles.history].join(" ")}>
          {items.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              wasUnread={unreadIds.has(item.id)}
            />
          ))}
        </ul>
      )}
      {state === "loading" && <p className={styles.quiet}>Loading…</p>}
      {next && state === "ready" && (
        <button
          type="button"
          className={styles.more}
          onClick={() => void load(next)}
        >
          Show older notifications
        </button>
      )}
    </>
  );
}
