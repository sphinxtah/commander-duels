import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Icon } from "../shell/pages";
import { PlayerPicture, PresenceDot, PresenceLine } from "../social/PlayerBits";
import {
  playerLink,
  presenceWords,
  type PlayerSummary,
} from "../social/social";
import type { Chat, ChatWindow } from "./chat";
import { ConversationView } from "./Conversation";
import { useBarPeople, type BarPeople, type BarPerson } from "./friends";
import styles from "./chat.module.css";

// The chat bar (v0.5.1, the owner's request), along the bottom of every page of the app: the
// friends list at its right end, with who is online and what is unread, and the conversations
// with friends docked beside it, each folded to its title bar or open. They stay open from page
// to page and, which ones, when the page reloads (chat.ts), as does the list's own fold; a closed
// conversation opens again from the list. On a phone the bar is one button, which opens the list,
// and one conversation shows at a time, the whole width of the screen. It replaced the Messages
// page and the windows docked at the bottom right (v0.4.4).
//
// At the game's table the bar folds away into a diamond on the band (game/table/BandHud.tsx), so
// it covers nothing there; the diamond brings it out, floating over the table's lower right, and
// it or Escape puts it away again. The table's keys leave alone every key pressed in the bar
// (game/table/keys.ts, data-chat-bar).

function badge(count: number) {
  return count > 99 ? "99+" : String(count);
}

function DockedWindow({
  window: shown,
  chat,
  known,
  onClosed,
}: {
  window: ChatWindow;
  chat: Chat;
  /** The player as the friends list last saw them, with the newer presence. */
  known: PlayerSummary | undefined;
  onClosed: () => void;
}) {
  // A live game keeps its address, so at the table nothing here leads to another page.
  const links = !chat.atTable;
  const [player, setPlayer] = useState<PlayerSummary | null>(null);
  const [unread, setUnread] = useState(0);
  const learned = useCallback((who: PlayerSummary, count: number) => {
    setPlayer(who);
    setUnread(count);
  }, []);
  const who = known ?? player;
  const name = who?.handle ?? "Friend";
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
          {who && <PlayerPicture player={who} size={26} />}
          <span>
            {name}
            {who?.presence && (
              <small>
                <PresenceDot presence={who.presence} />
                {presenceWords(who.presence)}
              </small>
            )}
          </span>
          {shown.folded && unread > 0 && (
            <span className={styles.unread} aria-label={`${unread} unread`}>
              {badge(unread)}
            </span>
          )}
          <span className={styles.chevron} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.windowAction}
          aria-label={`Close the chat with ${name}`}
          title="Close"
          onClick={() => {
            chat.close(shown.playerId);
            onClosed();
          }}
        >
          ×
        </button>
      </header>
      {/* Folded, the conversation stays mounted: it keeps following, and counts what is new. */}
      <div id={id} className={styles.windowBody} hidden={shown.folded}>
        {who && links && (
          <a className={styles.profileLink} href={playerLink(who.id)}>
            Profile
          </a>
        )}
        <ConversationView
          playerId={shown.playerId}
          chat={chat}
          visible={chat.shows(shown)}
          compact
          onPlayer={learned}
          focus={chat.focusing === shown.playerId && !shown.folded}
          onFocused={chat.focused}
        />
      </div>
    </section>
  );
}

/** A friend, or a player once one, on the list: a click opens (or reopens) the conversation. */
function PersonRow({
  person,
  chat,
  friend,
}: {
  person: BarPerson;
  chat: Chat;
  friend: boolean;
}) {
  const { player, unread } = person;
  const words = friend ? presenceWords(player.presence) : "No longer friends";
  const open = chat.windows.some((each) => each.playerId === player.id);
  return (
    <li>
      <button
        type="button"
        className={styles.person}
        data-open={open || undefined}
        aria-label={[
          `Chat with ${player.handle}`,
          words,
          unread > 0 ? `${unread} unread` : "",
        ]
          .filter(Boolean)
          .join(", ")}
        onClick={() => chat.open(player.id)}
      >
        <PlayerPicture player={player} size={34} />
        <span className={styles.personText}>
          <strong>{player.handle}</strong>
          {friend ? (
            <PresenceLine presence={player.presence} />
          ) : (
            <small>{words}</small>
          )}
        </span>
        {unread > 0 && (
          <span className={styles.unread} aria-hidden="true">
            {badge(unread)}
          </span>
        )}
      </button>
    </li>
  );
}

/** The friends list at the bar's right end: its title bar ("Friends · 3 online", with what is
 * unread) folds and unfolds it, as a window's does. On a phone, folded, it is the bar's one
 * button. */
function FriendsPanel({
  chat,
  people,
  toggle,
}: {
  chat: Chat;
  people: BarPeople;
  toggle: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId();
  const open = chat.panel;
  const label = [
    "Friends",
    people.online !== null ? `${people.online} online` : "",
    chat.unread > 0
      ? `${chat.unread} unread ${chat.unread === 1 ? "message" : "messages"}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <section
      className={styles.friends}
      data-open={open || undefined}
      aria-label="Friends"
      onKeyDown={(event) => {
        // At the table Escape puts the whole bar away (ChatBar).
        if (event.key !== "Escape" || !open || chat.atTable) return;
        event.preventDefault();
        event.stopPropagation();
        chat.setPanel(false);
        toggle.current?.focus();
      }}
    >
      <button
        ref={toggle}
        type="button"
        className={styles.friendsTitle}
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => chat.setPanel(!open)}
      >
        <Icon name="friends" className={styles.friendsIcon} />
        <Icon name="messages" className={styles.chatIcon} />
        <span className={styles.friendsWords}>
          Friends
          {people.online !== null && (
            <small>
              <span aria-hidden="true">·</span> {people.online} online
            </small>
          )}
        </span>
        {chat.unread > 0 && (
          <span className={styles.unread}>{badge(chat.unread)}</span>
        )}
        <span className={styles.chevron} aria-hidden="true" />
      </button>
      {/* Drawn only while open: folded, the list is not on the page at all. */}
      <div id={id} className={styles.friendsBody} hidden={!open}>
        {open && <FriendsList chat={chat} people={people} id={id} />}
      </div>
    </section>
  );
}

/** The friends list's content: the friends, the earlier conversations, and the Friends page. */
function FriendsList({
  chat,
  people,
  id,
}: {
  chat: Chat;
  people: BarPeople;
  id: string;
}) {
  return (
    <>
      {people.state === "loading" && <p className={styles.quiet}>Loading…</p>}
      {people.state === "error" && (
        <p className={styles.error} role="alert">
          {people.error}
        </p>
      )}
      {people.state === "ready" && people.friends.length === 0 && (
        <p className={styles.quiet}>
          No friends yet. Find players with the search at the top of the page,
          then Add friend on their profile.
        </p>
      )}
      {people.friends.length > 0 && (
        <>
          <h3 id={`${id}-friends`} className={styles.peopleTitle}>
            Your friends
          </h3>
          <ul className={styles.people} aria-labelledby={`${id}-friends`}>
            {people.friends.map((each) => (
              <PersonRow
                key={each.player.id}
                person={each}
                chat={chat}
                friend
              />
            ))}
          </ul>
        </>
      )}
      {people.earlier.length > 0 && (
        <>
          <h3 id={`${id}-earlier`} className={styles.peopleTitle}>
            Earlier conversations
          </h3>
          <ul className={styles.people} aria-labelledby={`${id}-earlier`}>
            {people.earlier.map((each) => (
              <PersonRow
                key={each.player.id}
                person={each}
                chat={chat}
                friend={false}
              />
            ))}
          </ul>
        </>
      )}
      {!chat.atTable && (
        <a
          href="#friends"
          className={styles.friendsLink}
          onClick={() => chat.setPanel(false)}
        >
          {people.requests > 0
            ? `${people.requests} friend ${people.requests === 1 ? "request" : "requests"} waiting`
            : "Friends and requests"}{" "}
          <span aria-hidden="true">→</span>
        </a>
      )}
    </>
  );
}

/** The band's diamond at the table, which brings the bar out (game/table/BandHud.tsx). */
export const CHAT_TOGGLE = "[data-chat-toggle]";

/** The bar; at the table, App gives it the game's key, so each table starts afresh. */
export function ChatBar({ chat }: { chat: Chat }) {
  const { atTable, tableOpen, setTableOpen } = chat;
  // At the table, folded away, it asks the API for nothing.
  const out = !atTable || tableOpen;
  const people = useBarPeople(chat, out);
  const toggle = useRef<HTMLButtonElement>(null);
  // Once brought out at this table, it stays drawn, hidden while put away, so what was being
  // written waits for its return. Before, nothing of it is drawn.
  const [used, setUsed] = useState(false);
  // Brought out at the table, focus moves into it.
  const before = useRef(tableOpen);
  useEffect(() => {
    if (!atTable || !tableOpen) {
      before.current = tableOpen;
      return;
    }
    setUsed(true);
    if (!before.current && !chat.focusing) toggle.current?.focus();
    before.current = tableOpen;
  }, [atTable, tableOpen, chat.focusing]);
  // A friend's message: in a window shown, which does not pop up beside the bell; at the table,
  // every one.
  const said = (
    <p className={styles.visuallyHidden} role="status" data-chat-bar="">
      {chat.said && <span key={chat.said.id}>{chat.said.words}</span>}
    </p>
  );
  if (!out && !used) return said;
  return (
    <>
      {/* Room at the foot of the page, so its end scrolls clear of the bar. */}
      {!atTable && <div className={styles.barRoom} aria-hidden="true" />}
      <aside
        id="chat-bar"
        hidden={!out}
        className={styles.bar}
        aria-label="Friends and messages"
        data-panel={chat.panel || undefined}
        data-table={atTable || undefined}
        data-chat-bar=""
        onKeyDown={(event) => {
          // At the table Escape puts the bar away, one layer as the table's Escape closes one.
          if (event.key !== "Escape" || !atTable) return;
          event.preventDefault();
          event.stopPropagation();
          setTableOpen(false);
          document.querySelector<HTMLElement>(CHAT_TOGGLE)?.focus();
        }}
      >
        <div className={styles.windows}>
          {chat.docked.map((window) => (
            <DockedWindow
              key={window.playerId}
              window={window}
              chat={chat}
              known={people.known.get(window.playerId)}
              onClosed={() => toggle.current?.focus()}
            />
          ))}
        </div>
        <FriendsPanel chat={chat} people={people} toggle={toggle} />
      </aside>
      {said}
    </>
  );
}
