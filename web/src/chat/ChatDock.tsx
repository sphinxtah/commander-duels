import { useCallback, useState } from "react";
import { PlayerPicture, PresenceDot } from "../social/PlayerBits";
import {
  playerLink,
  presenceWords,
  type PlayerSummary,
} from "../social/social";
import { messagesLink, type Chat, type ChatWindow } from "./chat";
import { ConversationView } from "./Conversation";
import styles from "./chat.module.css";

// The docked chat windows (v0.4.4), at the bottom right of every page of the app but the table:
// up to three conversations with friends, each folded to its title bar or open, kept as the
// player moves between pages and, which ones, when the page reloads (chat.ts).

function DockedWindow({
  window: shown,
  chat,
}: {
  window: ChatWindow;
  chat: Chat;
}) {
  const [player, setPlayer] = useState<PlayerSummary | null>(null);
  const [unread, setUnread] = useState(0);
  const known = useCallback((who: PlayerSummary, count: number) => {
    setPlayer(who);
    setUnread(count);
  }, []);
  const name = player?.handle ?? "Friend";
  const id = `chat-window-${shown.playerId}`;
  return (
    <section
      className={styles.window}
      data-folded={shown.folded || undefined}
      aria-label={`Chat with ${name}`}
    >
      <header className={styles.windowBar}>
        <button
          type="button"
          className={styles.windowTitle}
          id={`${id}-title`}
          aria-expanded={!shown.folded}
          aria-controls={id}
          onClick={() => chat.fold(shown.playerId, !shown.folded)}
        >
          {player && <PlayerPicture player={player} size={24} />}
          <span>
            {name}
            {player?.presence && (
              <small>
                <PresenceDot presence={player.presence} />
                {presenceWords(player.presence)}
              </small>
            )}
          </span>
          {shown.folded && unread > 0 && (
            <span className={styles.unread} aria-label={`${unread} unread`}>
              {unread}
            </span>
          )}
        </button>
        <a
          className={styles.windowAction}
          href={messagesLink(shown.playerId)}
          aria-label={`All messages with ${name}`}
          title="Open on the Messages page"
        >
          ⤢
        </a>
        <button
          type="button"
          className={styles.windowAction}
          aria-label={`Close the chat with ${name}`}
          onClick={() => chat.close(shown.playerId)}
        >
          ×
        </button>
      </header>
      {/* Folded, the conversation stays mounted: it keeps following, and counts what is new. */}
      <div id={id} className={styles.windowBody} hidden={shown.folded}>
        {player && (
          <a className={styles.profileLink} href={playerLink(player.id)}>
            Profile
          </a>
        )}
        <ConversationView
          playerId={shown.playerId}
          chat={chat}
          visible={!shown.folded}
          compact
          onPlayer={known}
        />
      </div>
    </section>
  );
}

export function ChatDock({ chat }: { chat: Chat }) {
  if (chat.windows.length === 0) return null;
  return (
    <div className={styles.dock} aria-label="Chats">
      {chat.windows.map((window) => (
        <DockedWindow key={window.playerId} window={window} chat={chat} />
      ))}
    </div>
  );
}
