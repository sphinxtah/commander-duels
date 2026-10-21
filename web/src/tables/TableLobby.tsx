import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { client, describe } from "../api";
import { exitTableFullscreen } from "../app/fullscreen";
import { tableFullscreen } from "../game/PracticeTable";
import { getSoundEngine } from "../game/sound/engine";
import game from "../game/game.module.css";
import { DeckChoices, Face } from "./TableParts";
import {
  formatNames,
  useOwnDecks,
  usePolled,
  type TablePlayer,
  type TableView,
} from "./tables";
import styles from "./tables.module.css";

// One human table (v0.4.0): its seats, its invite link, and for its players their deck, ready and
// leave; the host starts. Every player's page follows the table and opens the game once it starts.

/** The table's own address: its invite link. */
export function inviteLink(code: string): string {
  return `${window.location.origin}${window.location.pathname}#tables/${code}`;
}

type Loaded = { table?: TableView; missing?: boolean };

export function TableLobby({
  code,
  heading,
}: {
  code: string;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const load = useCallback(async (): Promise<Loaded> => {
    const { data, response } = await client.GET("/api/v1/tables/{code}", {
      params: { path: { code } },
    });
    return data ? { table: data } : { missing: response.status === 404 };
  }, [code]);
  const [loaded, refresh] = usePolled(load);
  // The table as the latest answer has it: the page's own asking, or an action's reply.
  const [table, setTable] = useState<TableView>();
  const decks = useOwnDecks();
  const [choice, setChoice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const opened = useRef(false);
  useEffect(() => {
    if (loaded?.table) setTable(loaded.table);
  }, [loaded]);

  // Once the game starts, every player at the table goes to it.
  useEffect(() => {
    if (
      table?.status === "started" &&
      table.game_id &&
      table.your_seat !== null &&
      !opened.current
    ) {
      opened.current = true;
      window.location.hash = `#game/${table.game_id}`;
    }
  }, [table]);

  if (!loaded && !table) return <p role="status">Finding the table…</p>;
  if (!table)
    return (
      <div className={styles.page}>
        <h1 ref={heading} tabIndex={-1}>
          {loaded?.missing
            ? "There is no such table."
            : "The table is not answering."}
        </h1>
        <p className={styles.lead}>
          {loaded?.missing
            ? "The invite link may be mistyped, or the table is gone."
            : "The application service is unavailable. Try again shortly."}{" "}
          <a href="#tables">Back to the lobby</a>
        </p>
      </div>
    );

  const mine = table.players.find((player) => player.you);
  const host = mine?.host ?? false;
  const here = (decks ?? []).filter((deck) => deck.format === table.format);
  const chosen = choice || here.find((deck) => deck.playable)?.id || "";
  const free = table.players.some(
    (player) => player.player === "human" && !player.taken,
  );

  /** Runs one action on the table; its answer is the table as it now stands. */
  async function act(
    request: () => Promise<{ data?: TableView; error?: unknown }>,
  ): Promise<TableView | undefined> {
    setError("");
    setBusy(true);
    const { data, error: failure } = await request().catch(() => ({
      data: undefined,
      error: undefined,
    }));
    setBusy(false);
    if (data) setTable(data);
    else setError(describe(failure));
    refresh();
    return data;
  }
  const path = { params: { path: { code } } };

  async function start() {
    // The host's click: the table fills the screen, and sound may start, as at the practice
    // table. The other players' pages follow without a click of their own.
    const fullscreen = tableFullscreen();
    getSoundEngine().unlock();
    const started = await act(() =>
      client.POST("/api/v1/tables/{code}/start", path),
    );
    if (!started?.game_id)
      void fullscreen?.then((entered) => {
        if (entered) void exitTableFullscreen();
      });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      setCopied(true);
    } catch {
      setError("This browser would not copy the link: select it and copy it.");
    }
  }

  const status =
    table.status === "closed"
      ? "This table is closed."
      : table.status === "started"
        ? mine
          ? "The game has started. Opening it…"
          : "This table's game has started."
        : null;

  return (
    <div className={styles.page}>
      <span className={game.eyebrow}>
        {table.visibility === "private" ? "PRIVATE TABLE" : "PUBLIC TABLE"}
      </span>
      <h1 ref={heading} tabIndex={-1}>
        {formatNames[table.format]} table
      </h1>
      <p className={styles.lead}>
        Hosted by {table.host ?? "a player"}.{" "}
        {table.bots > 0
          ? `${table.bots} ${table.bots === 1 ? "bot" : "bots"} at skill ${table.bot_skill} fill the last seats. `
          : ""}
        Others see your handle and portrait, never your deck.{" "}
        <a href="#tables">Back to the lobby</a>
      </p>
      {status && (
        <p className={styles.notice} role="status">
          {status}
          {table.status === "started" && table.game_id && mine && (
            <a href={`#game/${table.game_id}`}>Open the game</a>
          )}
        </p>
      )}

      <ul className={styles.seats} aria-label="Seats">
        {table.players.map((player) => (
          <Seat key={player.seat} player={player} skill={table.bot_skill} />
        ))}
      </ul>

      {table.status === "open" && mine && (
        <div className={styles.invite}>
          <label className={game.field}>
            <span>Invite link</span>
            <input
              readOnly
              value={inviteLink(code)}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <button
            type="button"
            className={game.secondaryButton}
            onClick={() => void copy()}
          >
            Copy invite link
          </button>
          {copied && (
            <span className={styles.status} role="status">
              Copied
            </span>
          )}
        </div>
      )}

      {table.status === "open" && (
        <div className={styles.actions}>
          {(mine || free) && (
            <label className={game.field}>
              <span>Your deck</span>
              <select
                value={mine?.deck_id ?? chosen}
                disabled={busy}
                onChange={(event) => {
                  const deck = event.target.value;
                  setChoice(deck);
                  if (mine)
                    void act(() =>
                      client.PATCH("/api/v1/tables/{code}/seat", {
                        ...path,
                        body: { deck_id: deck },
                      }),
                    );
                }}
              >
                <DeckChoices decks={here} />
              </select>
            </label>
          )}
          {!mine && free && (
            <button
              type="button"
              className={game.primaryButton}
              disabled={busy || !chosen}
              onClick={() =>
                void act(() =>
                  client.POST("/api/v1/tables/{code}/join", {
                    ...path,
                    body: { deck_id: chosen },
                  }),
                )
              }
            >
              Take a seat
            </button>
          )}
          {!mine && !free && (
            <p className={game.hint}>Every player's seat is taken.</p>
          )}
          {mine && !host && (
            <button
              type="button"
              className={mine.ready ? game.secondaryButton : game.primaryButton}
              disabled={busy}
              aria-pressed={mine.ready}
              onClick={() => {
                // Sound starts only from a click: this is the last one before the game opens.
                getSoundEngine().unlock();
                void act(() =>
                  client.PATCH("/api/v1/tables/{code}/seat", {
                    ...path,
                    body: { ready: !mine.ready },
                  }),
                );
              }}
            >
              {mine.ready ? "Not ready" : "Ready"}
            </button>
          )}
          {host && (
            <button
              type="button"
              className={game.primaryButton}
              disabled={busy || !table.can_start}
              onClick={() => void start()}
            >
              Start the game
            </button>
          )}
          {mine && (
            <button
              type="button"
              className={host ? game.dangerButton : game.secondaryButton}
              disabled={busy}
              onClick={() =>
                void act(() => client.POST("/api/v1/tables/{code}/leave", path))
              }
            >
              {host ? "Close the table" : "Leave the table"}
            </button>
          )}
        </div>
      )}
      {table.status === "open" && host && !table.can_start && (
        <p className={game.hint}>
          The game starts when every seat is taken and every player is ready.
        </p>
      )}
      {error && (
        <p role="alert" className={game.refusal}>
          {error}
        </p>
      )}
    </div>
  );
}

function Seat({ player, skill }: { player: TablePlayer; skill: number }) {
  if (player.player === "bot")
    return (
      <li className={styles.seat}>
        <span className={styles.sigil} aria-hidden="true">
          ⚙
        </span>
        <span>
          <strong>Bot</strong>
          <small>Skill {skill} of 6</small>
        </span>
      </li>
    );
  if (!player.taken)
    return (
      <li className={styles.seat} data-empty="true">
        <span className={styles.sigil} aria-hidden="true">
          +
        </span>
        <span>
          <strong>Open seat</strong>
          <small>Waiting for a player</small>
        </span>
      </li>
    );
  return (
    <li className={styles.seat} data-you={player.you}>
      <Face handle={player.handle} portrait={player.portrait} size={48} />
      <span>
        <strong>
          {player.handle ?? "A player"}
          {player.you ? " (you)" : ""}
        </strong>
        {player.you && player.deck && <small>Playing {player.deck}</small>}
        <span className={styles.seatBadges}>
          {player.host && (
            <span className={styles.badge} data-tone="gold">
              Host
            </span>
          )}
          {!player.host && (
            <span
              className={styles.badge}
              data-tone={player.ready ? "good" : "wait"}
            >
              {player.ready ? "Ready" : "Not ready"}
            </span>
          )}
        </span>
      </span>
    </li>
  );
}
