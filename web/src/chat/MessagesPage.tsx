import { useCallback, useEffect, useState, type RefObject } from "react";
import { client, describe } from "../api";
import { PlayerPicture, PresenceLine } from "../social/PlayerBits";
import { playerLink, timeAgo, type PlayerSummary } from "../social/social";
import { messagesLink, type Chat, type ConversationItem } from "./chat";
import { ConversationView } from "./Conversation";
import styles from "./chat.module.css";

// Messages (#messages, v0.4.4): the account's conversations with friends, the latest first, and
// one of them beside the list (#messages/<id>); on a phone, the list or the conversation. The list
// follows the socket, so a new message moves its conversation to the top.

export function MessagesPage({
  chat,
  playerId,
  heading,
}: {
  chat: Chat | null;
  /** The conversation shown, from #messages/<id>. */
  playerId?: string;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [error, setError] = useState("");
  const [shownPlayer, setShownPlayer] = useState<PlayerSummary | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await client.GET("/api/v1/conversations");
    if (!data) return setError(describe(error));
    setError("");
    setItems(data.conversations);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => chat?.listen(() => void load()), [chat, load]);
  // Its messages do not pop up while it is shown here.
  useEffect(() => {
    chat?.setShown(playerId ?? null);
    return () => chat?.setShown(null);
  }, [chat, playerId]);
  const known = useCallback(
    (player: PlayerSummary) => setShownPlayer(player),
    [],
  );

  return (
    <div className={styles.page} data-open={playerId ? "" : undefined}>
      <div className={styles.listSide}>
        <span className={styles.eyebrow}>YOUR MESSAGES</span>
        <h1 ref={heading} tabIndex={-1}>
          Messages
        </h1>
        <p className={styles.lead}>
          Your conversations with friends, kept for a year. Write to a friend
          from the Friends page or their profile.
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {items === null && !error && <p className={styles.quiet}>Loading…</p>}
        {items?.length === 0 && (
          <p className={styles.quiet}>
            No messages yet. <a href="#friends">Find a friend to write to.</a>
          </p>
        )}
        {items && items.length > 0 && (
          <ul className={styles.list} aria-label="Conversations">
            {items.map((item) => (
              <li key={item.player.id}>
                <a
                  href={messagesLink(item.player.id)}
                  className={styles.listItem}
                  aria-current={
                    item.player.id === playerId ? "page" : undefined
                  }
                >
                  <PlayerPicture player={item.player} size={38} />
                  <span className={styles.listText}>
                    <strong>{item.player.handle}</strong>
                    <PresenceLine presence={item.player.presence} />
                    {item.last_message && (
                      <small>
                        {item.last_message.sender_id === item.player.id
                          ? ""
                          : "You: "}
                        {item.last_message.body}
                      </small>
                    )}
                  </span>
                  <span className={styles.listEnd}>
                    {item.last_message && (
                      <time dateTime={item.last_message.created_at}>
                        {timeAgo(item.last_message.created_at)}
                      </time>
                    )}
                    {item.unread > 0 && (
                      <span
                        className={styles.unread}
                        aria-label={`${item.unread} unread`}
                      >
                        {item.unread}
                      </span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      {playerId && (
        <section
          className={styles.pageConversation}
          aria-label={`Conversation with ${shownPlayer?.handle ?? "a friend"}`}
        >
          <header className={styles.pageBar}>
            <a href={messagesLink()} className={styles.back}>
              <span aria-hidden="true">←</span> All messages
            </a>
            {shownPlayer && (
              <a href={playerLink(shownPlayer.id)} className={styles.pageWho}>
                <PlayerPicture player={shownPlayer} size={30} />
                <span>
                  <strong>{shownPlayer.handle}</strong>
                  <PresenceLine presence={shownPlayer.presence} />
                </span>
              </a>
            )}
          </header>
          <ConversationView
            key={playerId}
            playerId={playerId}
            chat={chat}
            visible
            onPlayer={known}
          />
        </section>
      )}
    </div>
  );
}
