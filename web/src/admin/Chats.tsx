import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";
import styles from "../Account.module.css";
import shell from "../App.module.css";
import admin from "./admin.module.css";
import { ChatLines, when } from "./ChatLines";

// Administration's Chats tab (v0.4.4), SysOp's alone (chat.read_all): the latest conversations
// and tables' chats, or one player's, with their players and how many messages they hold.
// Listing reads no message. Opening a chat reads it, and the API records that in the audit
// trail, so a chat is fetched only when SysOp opens it, never ahead.

type ReaderChat = components["schemas"]["ReaderChat"];
type ReaderTranscript = components["schemas"]["ReaderTranscript"];
type Player = { id: string; handle: string };

// The most the API sends of one chat: its newest messages.
const READER_LIMIT = 1000;

/** "ada", "ada and bob", "ada, bob and cyd". */
function handles(players: Player[]) {
  const names = players.map((player) => player.handle);
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What a chat is called on its row and its button: "conversation between ada and bob". */
function chatName(chat: ReaderChat) {
  return chat.kind === "direct"
    ? `conversation between ${handles(chat.players)}`
    : `table chat of game ${chat.id.slice(0, 8)}`;
}

function facts(chat: ReaderChat) {
  return [
    chat.kind === "direct"
      ? "Conversation"
      : `Table, game ${chat.id.slice(0, 8)}`,
    `${chat.messages.toLocaleString("en-US")} ${chat.messages === 1 ? "message" : "messages"}`,
    `last ${when(chat.last_message_at)}`,
  ].join(" · ");
}

async function transcriptOf(chat: ReaderChat) {
  try {
    const { data, error } =
      chat.kind === "direct"
        ? await client.GET(
            "/api/v1/admin/chats/conversations/{conversation_id}",
            { params: { path: { conversation_id: chat.id } } },
          )
        : await client.GET("/api/v1/admin/chats/games/{game_id}", {
            params: { path: { game_id: chat.id } },
          });
    return { data, error };
  } catch {
    return { data: undefined, error: undefined };
  }
}

export function Chats() {
  const [chats, setChats] = useState<ReaderChat[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  // Only this player's chats, when one is chosen.
  const [player, setPlayer] = useState<Player>();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Player[]>();
  const [opened, setOpened] = useState<string>();
  const [transcripts, setTranscripts] = useState<
    Record<string, ReaderTranscript>
  >({});
  const latest = useRef(0);

  const load = useCallback(async () => {
    // Only the newest request may change the list, as for accounts.
    const ticket = ++latest.current;
    const { data, error } = await client
      .GET("/api/v1/admin/chats", {
        params: { query: { player_id: player?.id } },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    if (ticket !== latest.current) return;
    setLoaded(true);
    if (!data) return setMessage(describe(error));
    setMessage("");
    setChats(data.chats);
  }, [player]);
  useEffect(() => {
    void load();
  }, [load]);

  async function find(event: FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    const { data, error } = await client
      .GET("/api/v1/players", { params: { query: { q: text } } })
      .catch(() => ({ data: undefined, error: undefined }));
    if (!data) return setMessage(describe(error));
    setFound(data.players);
  }
  function choose(chosen: Player | undefined) {
    setPlayer(chosen && { id: chosen.id, handle: chosen.handle });
    setFound(undefined);
    setQuery("");
    setOpened(undefined);
  }
  async function toggle(chat: ReaderChat) {
    if (opened === chat.id) return setOpened(undefined);
    setOpened(chat.id);
    // A reading: the API audits it.
    const { data, error } = await transcriptOf(chat);
    if (!data) return setMessage(describe(error));
    setTranscripts((current) => ({ ...current, [chat.id]: data }));
  }

  return (
    <section className={styles.panel} aria-labelledby="chats-title">
      <h2 id="chats-title">Chats</h2>
      <p className={styles.fine}>
        Opening a chat is recorded in the audit trail.
      </p>
      <form className={styles.filters} role="search" onSubmit={find}>
        <label className={styles.field}>
          <span>Find a player's chats by handle</span>
          <input
            type="search"
            value={query}
            maxLength={64}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className={styles.secondary} type="submit">
          Find
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void load()}
        >
          Refresh
        </button>
      </form>
      {found &&
        (found.length === 0 ? (
          <p className={styles.fine}>No player found with that handle.</p>
        ) : (
          <div className={styles.actions}>
            {found.map((each) => (
              <button
                key={each.id}
                type="button"
                className={styles.secondary}
                onClick={() => choose(each)}
              >
                Show {each.handle}'s chats
              </button>
            ))}
          </div>
        ))}
      {player && (
        <p className={admin.shortcut}>
          <span>Showing {player.handle}'s chats.</span>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => choose(undefined)}
          >
            Show everyone's chats
          </button>
        </p>
      )}
      <p role="status" className={styles.fine}>
        {message}
      </p>
      {loaded && chats.length === 0 ? (
        <p className={styles.fine}>No chats yet.</p>
      ) : (
        <ul className={styles.users}>
          {chats.map((chat) => {
            const open = opened === chat.id;
            const transcript = transcripts[chat.id];
            const name = chatName(chat);
            return (
              <li
                key={chat.id}
                aria-label={name[0].toUpperCase() + name.slice(1)}
              >
                <div className={styles.userHead}>
                  <div>
                    <strong>
                      {handles(chat.players) || "No players left"}
                    </strong>
                    <small>{facts(chat)}</small>
                  </div>
                  <span className={shell.tag}>
                    {chat.kind === "direct" ? "CONVERSATION" : "TABLE"}
                  </span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    aria-expanded={open}
                    aria-controls={open ? `chat-${chat.id}` : undefined}
                    onClick={() => void toggle(chat)}
                  >
                    {open ? "Close" : "Open"} the {name}
                  </button>
                </div>
                {open && transcript && (
                  <div className={admin.report} id={`chat-${chat.id}`}>
                    {chat.kind === "table" && (
                      <p className={styles.fine}>
                        Game <code>{chat.id}</code>
                      </p>
                    )}
                    {transcript.lines.length >= READER_LIMIT && (
                      <p className={styles.fine}>
                        The newest {READER_LIMIT.toLocaleString("en-US")}{" "}
                        messages.
                      </p>
                    )}
                    {transcript.lines.length === 0 ? (
                      <p className={styles.fine}>No messages left.</p>
                    ) : (
                      <ChatLines
                        lines={transcript.lines}
                        label={`Messages of the ${name}`}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
