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
import { InviteFriendsButton } from "./InviteFriends";
import game from "../game/game.module.css";
import {
  CIRCLE_ROWS,
  DECK_FORMAT_WORDS,
  DEFAULT_KINGS_TABLE,
  KINGS_TABLE,
  kingsTeam,
  kingsTeamName,
  roleWords,
  seatPosition,
  seatTitle,
  type KingsTableSettings,
} from "./kingsTable";
import {
  DeckChoices,
  Face,
  KingsRules,
  KingsSettingsFields,
  TableTags,
  teamsOf,
} from "./TableParts";
import {
  TEAM_FORMAT,
  deckFormat,
  formatNames,
  rulesSentence,
  teamName,
  unfit,
  useOwnDecks,
  usePolled,
  type TablePlayer,
  type TableView,
} from "./tables";
import styles from "./tables.module.css";

// One human table (v0.4.0): its seats, its invite link, and for its players their deck, ready and
// leave; the host starts. Every player's page follows the table and opens the game once it starts.
// A Two-Headed Giant table (v0.5.1) shows its seats by team: a player joins a team, or moves to the
// other one, and gets ready once their deck shares no card with their teammate's but basic lands.
// A King's Table table (v0.8.7) draws its six seats as the circle's two sides facing each other,
// each King between their Generals, and shows its settings before anyone readies. A player takes
// any open seat or moves to one; the host changes the settings, which seats bots take, and moves a
// player to an open seat. Every such change makes every player not ready again. Since v0.9.2 its
// players invite friends from here (InviteFriends.tsx).

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
  const teams = table.format === TEAM_FORMAT;
  const kingsTable = table.format === KINGS_TABLE;
  const kings = kingsTable ? (table.kings_table ?? DEFAULT_KINGS_TABLE) : null;
  const decksFormat = deckFormat(table.format, kings);
  const here = (decks ?? []).filter((deck) => deck.format === decksFormat);
  const chosen =
    (here.some((deck) => deck.id === choice) ? choice : "") ||
    here.find((deck) => unfit(deck, table.rules) === null)?.id ||
    "";
  // King's Table: after a change of deck format your seated deck may be of the other one.
  const seatedDeck = decks?.find((deck) => deck.id === mine?.deck_id);
  const wrongDeck =
    kingsTable && seatedDeck !== undefined && seatedDeck.format !== decksFormat
      ? seatedDeck
      : null;
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
    else setError(refusal(failure));
    refresh();
    return data;
  }
  /** The API's refusal in words. Getting ready at King's Table checks the deck by the settings'
   * deck format again (v0.8.7): a deck of the other one says which decks the table takes now. */
  function refusal(failure: unknown): string {
    const code = (failure as { code?: string } | undefined)?.code;
    if (kings && code === "invalid_deck")
      return `${describe(failure)} This table plays ${DECK_FORMAT_WORDS[kings.deck_format]} now: choose one of yours, then get ready.`;
    return describe(failure);
  }
  const path = { params: { path: { code } } };

  /** King's Table (v0.8.7): takes an open seat by its number, or moves to it when seated. */
  function takeSeat(seat: number) {
    void act(() =>
      mine
        ? client.PATCH("/api/v1/tables/{code}/seat", {
            ...path,
            body: { seat },
          })
        : client.POST("/api/v1/tables/{code}/join", {
            ...path,
            body: { deck_id: chosen, seat },
          }),
    );
  }
  /** The host's change to a King's Table table (v0.8.7): its settings, the seats bots take, or a
   * player's seat. */
  function change(body: {
    kings_table?: Partial<KingsTableSettings>;
    bot_seats?: number[];
    move?: { seat: number; to: number };
  }) {
    void act(() => client.PATCH("/api/v1/tables/{code}", { ...path, body }));
  }
  const botSeats = table.players
    .filter((player) => player.player === "bot")
    .map((player) => player.seat);

  /** Joins a team (v0.5.1), or moves to it when already seated. */
  function joinTeam(team: number) {
    void act(() =>
      mine
        ? client.PATCH("/api/v1/tables/{code}/seat", {
            ...path,
            body: { team },
          })
        : client.POST("/api/v1/tables/{code}/join", {
            ...path,
            body: { deck_id: chosen, team },
          }),
    );
  }

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
        {table.campaign
          ? "CAMPAIGN · KING'S TABLE"
          : table.visibility === "private"
            ? "PRIVATE TABLE"
            : "PUBLIC TABLE"}
      </span>
      <h1 ref={heading} tabIndex={-1}>
        {table.campaign ?? `${formatNames[table.format]} table`}
      </h1>
      {table.campaign && (
        <p className={styles.lead}>
          {table.host ?? "The host"} sits as King against The Sphinx&apos;s
          court: The Sphinx as King, Nicol Bolas and Liliana as his Generals.
          Take a General&apos;s seat beside them with one of your Commander
          decks. The game counts nothing for your own record; a friend who helps
          win it is paid once.
        </p>
      )}
      <TableTags table={table} />
      <p className={styles.lead}>
        Hosted by {table.host ?? "a player"}.{" "}
        {rulesSentence(table.rules, table.format, kings)}{" "}
        {table.best_of === 3
          ? "A best-of-three match: players sideboard between its games. "
          : ""}
        {teams
          ? "Two teams of two take their turns together, 30 life a team; a team's decks may share only basic lands, checked as you get ready. "
          : ""}
        {kingsTable
          ? "Two teams of three, a King and two Generals each, in a circle of six: each player takes their own turns, and a team wins when the other team's King is out. "
          : ""}
        {table.bots > 0
          ? `${table.bots} ${table.bots === 1 ? "bot" : "bots"} at skill ${table.bot_skill} ${teams || kingsTable ? "take the seats shown" : "fill the last seats"}. `
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

      {kings && (
        <section aria-labelledby="kings-rules-title">
          <h2 id="kings-rules-title" className={styles.visuallyHidden}>
            This table&apos;s King&apos;s Table settings
          </h2>
          <KingsRules settings={kings} />
        </section>
      )}

      {kings ? (
        <div className={styles.circle}>
          {(mine && mine.seat >= 3
            ? ([
                [2, 1, 0],
                [3, 4, 5],
              ] as const)
            : CIRCLE_ROWS
          ).map((row, i) => {
            const team = kingsTeam(row[0]);
            const players = row.map((seat) =>
              table.players.find((player) => player.seat === seat)!,
            );
            const yours = players.some((player) => player?.you);
            return (
              <div key={team}>
                {i === 1 && (
                  <p className={styles.circleTable} aria-hidden="true">
                    The table
                  </p>
                )}
                <section
                  className={styles.kingsSide}
                  data-team={team}
                  data-yours={yours}
                  aria-labelledby={`team-${team}`}
                >
                  <h2 id={`team-${team}`}>
                    <span>{kingsTeamName(team)}</span>
                    {yours && (
                      <span className={styles.badge} data-tone="gold">
                        Your team
                      </span>
                    )}
                  </h2>
                  <ul
                    className={styles.kingsRow}
                    aria-label={`${kingsTeamName(team)} seats`}
                  >
                    {players.map(
                      (player) =>
                        player && (
                          <KingsSeat
                            key={player.seat}
                            player={player}
                            table={table}
                            seated={mine !== undefined}
                            canJoin={Boolean(chosen)}
                            host={host}
                            busy={busy}
                            botSeats={botSeats}
                            onTake={takeSeat}
                            onChange={change}
                          />
                        ),
                    )}
                  </ul>
                </section>
              </div>
            );
          })}
        </div>
      ) : teams ? (
        <div className={styles.teamGroups}>
          {teamsOf(table).map((players, team) => {
            const yours = players.some((player) => player.you);
            const room = players.some(
              (player) => player.player === "human" && !player.taken,
            );
            return (
              <section
                key={team}
                className={styles.team}
                data-yours={yours}
                aria-labelledby={`team-${team}`}
              >
                <h2 id={`team-${team}`}>
                  <span>{teamName(team)}</span>{" "}
                  {yours && (
                    <span className={styles.badge} data-tone="gold">
                      Your team
                    </span>
                  )}
                </h2>
                <ul
                  className={styles.seats}
                  aria-label={`${teamName(team)} seats`}
                >
                  {players.map((player) => (
                    <Seat
                      key={player.seat}
                      player={player}
                      skill={table.bot_skill}
                    />
                  ))}
                </ul>
                {table.status === "open" &&
                  !yours &&
                  room &&
                  (mine || chosen) && (
                    <p>
                      <button
                        type="button"
                        className={
                          mine ? game.secondaryButton : game.primaryButton
                        }
                        disabled={busy}
                        onClick={() => joinTeam(team)}
                      >
                        {mine ? "Move to" : "Join"} {teamName(team)}
                      </button>
                    </p>
                  )}
              </section>
            );
          })}
        </div>
      ) : (
        <ul className={styles.seats} aria-label="Seats">
          {table.players.map((player) => (
            <Seat key={player.seat} player={player} skill={table.bot_skill} />
          ))}
        </ul>
      )}

      {kings && host && table.status === "open" && !table.campaign && (
        <section className={styles.hostPanel} aria-labelledby="host-title">
          <h2 id="host-title">Change the table</h2>
          <p className={game.hint}>
            Any change to the settings, to which seats bots take or to a
            player&apos;s seat makes every player not ready again. Bots and
            moves are on each seat above.
          </p>
          <KingsSettingsFields
            name="host-kings"
            settings={kings}
            disabled={busy}
            onChange={(settings) => change({ kings_table: settings })}
          />
        </section>
      )}

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
          <InviteFriendsButton
            code={code}
            seated={table.players.flatMap((player) =>
              player.taken && player.handle ? [player.handle] : [],
            )}
          />
        </div>
      )}

      {table.status === "open" && (
        <div className={styles.actions}>
          {(mine || free) && (
            <label className={game.field}>
              <span>Your deck</span>
              <select
                value={wrongDeck ? "" : (mine?.deck_id ?? chosen)}
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
                {wrongDeck && (
                  <option value="" disabled>
                    Choose a {formatNames[decksFormat]} deck
                  </option>
                )}
                <DeckChoices decks={here} rules={table.rules} />
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
              {kingsTable ? "Take the first open seat" : "Take a seat"}
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
      {wrongDeck && table.status === "open" && (
        <p className={styles.notice} role="status">
          {wrongDeck.title} is a {formatNames[wrongDeck.format]} deck, and this
          table plays {DECK_FORMAT_WORDS[kings!.deck_format]} now: choose one of
          yours before you get ready.
        </p>
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

/** One of a King's Table table's six seats (v0.8.7): its role, team and starting life, who sits
 * there, and what the viewer may do with it. An open seat may be taken, or moved to; the host may
 * give an open seat to a bot, open a bot's seat for a player, and move a player to an open seat. */
function KingsSeat({
  player,
  table,
  seated,
  canJoin,
  host,
  busy,
  botSeats,
  onTake,
  onChange,
}: {
  player: TablePlayer;
  table: TableView;
  seated: boolean;
  canJoin: boolean;
  host: boolean;
  busy: boolean;
  botSeats: number[];
  onTake: (seat: number) => void;
  onChange: (body: {
    bot_seats?: number[];
    move?: { seat: number; to: number };
  }) => void;
}) {
  const seat = player.seat;
  const title = seatTitle(seat);
  const open = table.status === "open";
  const bot = player.player === "bot";
  const empty = !bot && !player.taken;
  const openSeats = table.players
    .filter((other) => other.player === "human" && !other.taken)
    .map((other) => other.seat);
  return (
    <li
      className={styles.kingsSeat}
      data-role={player.role ?? undefined}
      data-you={player.you || undefined}
      data-empty={empty || undefined}
      aria-label={title}
    >
      <span className={styles.seatHead}>
        <span>
          {player.role === "king" ? roleWords("king") : seatPosition(seat)}
        </span>
        <span>{player.starting_life ?? "?"} life</span>
      </span>
      <span className={styles.seatWho}>
        {bot ? (
          <>
            <span className={styles.sigil} aria-hidden="true">
              ⚙
            </span>
            <span>
              <strong>Bot</strong>
              <small>Skill {table.bot_skill} of 6</small>
            </span>
          </>
        ) : empty ? (
          <>
            <span className={styles.sigil} aria-hidden="true">
              +
            </span>
            <span>
              <strong>Open seat</strong>
              <small>Waiting for a player</small>
            </span>
          </>
        ) : (
          <>
            <Face handle={player.handle} portrait={player.portrait} size={40} />
            <span>
              <strong>
                {player.handle ?? "A player"}
                {player.you ? " (you)" : ""}
              </strong>
              {player.you && player.deck && (
                <small>Playing {player.deck}</small>
              )}
              <span className={styles.seatBadges}>
                {player.host ? (
                  <span className={styles.badge} data-tone="gold">
                    Host
                  </span>
                ) : (
                  <span
                    className={styles.badge}
                    data-tone={player.ready ? "good" : "wait"}
                  >
                    {player.ready ? "Ready" : "Not ready"}
                  </span>
                )}
              </span>
            </span>
          </>
        )}
      </span>
      <small>
        {kingsTeamName(player.team ?? kingsTeam(seat))} ·{" "}
        {player.role === "king" ? "King" : "General"} ·{" "}
        {player.starting_life ?? "?"} starting life
      </small>
      {open && empty && (seated || canJoin) && (
        <button
          type="button"
          className={seated ? game.secondaryButton : game.primaryButton}
          disabled={busy}
          aria-label={`${seated ? "Move to this seat" : "Take this seat"}: ${title}`}
          onClick={() => onTake(seat)}
        >
          {seated ? "Move to this seat" : "Take this seat"}
        </button>
      )}
      {open && host && empty && (
        <button
          type="button"
          className={game.secondaryButton}
          disabled={busy}
          aria-label={`Give ${title}'s seat to a bot`}
          onClick={() => onChange({ bot_seats: [...botSeats, seat] })}
        >
          Give to a bot
        </button>
      )}
      {open && host && bot && (
        <button
          type="button"
          className={game.secondaryButton}
          disabled={busy}
          aria-label={`Open ${title}'s seat for a player`}
          onClick={() =>
            onChange({ bot_seats: botSeats.filter((other) => other !== seat) })
          }
        >
          Open for a player
        </button>
      )}
      {open && host && !bot && player.taken && openSeats.length > 0 && (
        <select
          aria-label={`Move ${player.you ? "yourself" : (player.handle ?? "this player")} to another seat`}
          value=""
          disabled={busy}
          onChange={(event) => {
            const to = Number(event.target.value);
            if (event.target.value !== "") onChange({ move: { seat, to } });
          }}
        >
          <option value="">Move to…</option>
          {openSeats.map((to) => (
            <option key={to} value={to}>
              {seatTitle(to)}
            </option>
          ))}
        </select>
      )}
    </li>
  );
}
