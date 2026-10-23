import { useCallback, useState, type FormEvent, type RefObject } from "react";
import { client, describe, type Me } from "../api";
import game from "../game/game.module.css";
import { TableLobby } from "./TableLobby";
import {
  DeckChoices,
  Face,
  RulesFields,
  TableTags,
  TeamsLine,
} from "./TableParts";
import {
  TEAM_FORMAT,
  casualRules,
  deckFormat,
  formatNames,
  unfit,
  useOwnDecks,
  usePolled,
  type TableFormat as Format,
  type TableRules,
  type TableView,
} from "./tables";
import styles from "./tables.module.css";

// Human tables (v0.4.0, docs/tables.md): the lobby lists the open tables and opens new ones; a
// table's own page (#tables/<code>, its invite link) seats the players and starts the game. Since
// v0.5.1 a table may be Two-Headed Giant's: two teams of two, with bots in either team.

const FORMATS: Format[] = ["legacy", "commander", TEAM_FORMAT];
const FORMAT_WORDS: Record<Format, string> = {
  legacy: "Two players, 20 life",
  commander: "Two to four seats, 40 life",
  two_headed_giant: "Two teams of two, Legacy decks, 30 life a team",
};
/** The other team's seats in Two-Headed Giant, by how many bots fill them. */
const OTHER_TEAM = ["Two players", "A player and a bot", "Two bots"];

export function TablesPage({
  me,
  heading,
  code,
}: {
  me: Me;
  heading: RefObject<HTMLHeadingElement | null>;
  /** A table's invite code, from #tables/<code>. */
  code?: string;
}) {
  if (
    !me.permissions.includes("games.play") ||
    !me.permissions.includes("decks.edit")
  )
    return (
      <div className={styles.page}>
        <span className={game.eyebrow}>HUMAN TABLES</span>
        <h1 ref={heading} tabIndex={-1}>
          Sit down with other players.
        </h1>
        <p className={styles.lead}>This account cannot play games yet.</p>
      </div>
    );
  if (code) return <TableLobby key={code} code={code} heading={heading} />;
  return <Lobby heading={heading} />;
}

function Lobby({ heading }: { heading: RefObject<HTMLHeadingElement | null> }) {
  const load = useCallback(
    async () => (await client.GET("/api/v1/tables")).data,
    [],
  );
  const [tables, refresh] = usePolled(load);
  const decks = useOwnDecks();
  const [format, setFormat] = useState<Format>("legacy");
  const [seats, setSeats] = useState(2);
  const [bots, setBots] = useState(0);
  const [skill, setSkill] = useState(4);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [rules, setRules] = useState<TableRules>(casualRules);
  // One game, or (v0.5.0, Legacy only) a best-of-three match with sideboards.
  const [bestOf, setBestOf] = useState<1 | 3>(1);
  // Two-Headed Giant (v0.5.1): whether your teammate is a bot, and the other team's bots.
  const [teammateBot, setTeammateBot] = useState(false);
  const [otherBots, setOtherBots] = useState(0);
  const [deck, setDeck] = useState("");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);

  const teams = format === TEAM_FORMAT;
  const allBots = teams ? Number(teammateBot) + otherBots : bots;
  const here = (decks ?? []).filter((d) => d.format === deckFormat(format));
  // The deck chosen while the rules take it; else the first deck they take.
  const fitting = here.filter((d) => unfit(d, rules) === null);
  const chosen =
    (fitting.some((d) => d.id === deck) ? deck : fitting[0]?.id) ?? "";
  const yours = tables?.find((table) => table.your_seat !== null);

  function chooseFormat(next: Format) {
    setFormat(next);
    setDeck("");
    setSeats(next === "legacy" ? 2 : 4);
    setBots(0);
    setTeammateBot(false);
    setOtherBots(0);
  }

  async function open(event: FormEvent) {
    event.preventDefault();
    setError("");
    setOpening(true);
    const { data, error: failure } = await client.POST("/api/v1/tables", {
      body: {
        format,
        seats,
        bots: allBots,
        bot_teammate: teams && teammateBot,
        bot_skill: skill,
        turn_cap: 60,
        visibility,
        rules,
        best_of: format === "legacy" ? bestOf : 1,
        deck_id: chosen,
      },
    });
    setOpening(false);
    if (data) {
      window.location.hash = `#tables/${data.code}`;
      return;
    }
    setError(describe(failure));
    refresh();
  }

  return (
    <div className={styles.page}>
      <span className={game.eyebrow}>HUMAN TABLES</span>
      <h1 ref={heading} tabIndex={-1}>
        Sit down with other players.
      </h1>
      <p className={styles.lead}>
        Open a table and share its invite link, or join one below. Bring a deck
        of your own that the table's rules take: its host chooses whether banned
        cards, and cards not legal in the format, may play. Wins over players
        pay 50 to 500 tokens, by how many wins they have. In Two-Headed Giant a
        team wins together, and both its players are paid.
      </p>
      {yours && (
        <p className={styles.notice} role="status">
          You sit at a {formatNames[yours.format]} table.
          <a href={`#tables/${yours.code}`}>Go to your table</a>
        </p>
      )}

      <section className={game.table} aria-labelledby="open-title">
        <h2 id="open-title">Open a table</h2>
        <form className={game.startForm} onSubmit={open}>
          <fieldset>
            <legend>Format</legend>
            {FORMATS.map((id) => (
              <label key={id} className={game.choice}>
                <input
                  type="radio"
                  name="table-format"
                  value={id}
                  checked={format === id}
                  onChange={() => chooseFormat(id)}
                />
                <span>
                  <strong>{formatNames[id]}</strong>
                  <small>{FORMAT_WORDS[id]}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {teams && (
            <fieldset>
              <legend>Your teammate</legend>
              <label className={game.choice}>
                <input
                  type="radio"
                  name="table-teammate"
                  checked={!teammateBot}
                  onChange={() => setTeammateBot(false)}
                />
                <span>
                  <strong>A player</strong>
                  <small>Who joins your team</small>
                </span>
              </label>
              <label className={game.choice}>
                <input
                  type="radio"
                  name="table-teammate"
                  checked={teammateBot}
                  onChange={() => {
                    setTeammateBot(true);
                    // A table needs two players: the other team keeps one.
                    setOtherBots((current) => Math.min(current, 1));
                  }}
                />
                <span>
                  <strong>A bot</strong>
                  <small>
                    Plays beside you, with a deck sharing no card with yours
                  </small>
                </span>
              </label>
            </fieldset>
          )}
          {teams && (
            <label className={game.field}>
              <span>The other team</span>
              <select
                value={otherBots}
                onChange={(event) => setOtherBots(Number(event.target.value))}
              >
                {OTHER_TEAM.map((words, count) => (
                  <option
                    key={words}
                    value={count}
                    disabled={teammateBot && count === 2}
                  >
                    {words}
                  </option>
                ))}
              </select>
            </label>
          )}
          {format === "commander" && (
            <label className={game.field}>
              <span>Seats</span>
              <select
                value={seats}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setSeats(next);
                  setBots((current) => Math.min(current, next - 2));
                }}
              >
                {[2, 3, 4].map((count) => (
                  <option key={count} value={count}>
                    {count} seats
                  </option>
                ))}
              </select>
            </label>
          )}
          {format === "commander" && seats > 2 && (
            <label className={game.field}>
              <span>Bots</span>
              <select
                value={bots}
                onChange={(event) => setBots(Number(event.target.value))}
              >
                {Array.from({ length: seats - 1 }, (_, count) => count).map(
                  (count) => (
                    <option key={count} value={count}>
                      {count === 0
                        ? "No bots"
                        : `${count} ${count === 1 ? "bot" : "bots"}`}{" "}
                      ({seats - count} players)
                    </option>
                  ),
                )}
              </select>
            </label>
          )}
          {allBots > 0 && (
            <label className={game.field}>
              <span>
                Bot skill <small>{skill} of 6</small>
              </span>
              <input
                type="range"
                min={1}
                max={6}
                value={skill}
                onChange={(event) => setSkill(Number(event.target.value))}
              />
            </label>
          )}
          <label className={game.field}>
            <span>Who may join</span>
            <select
              value={visibility}
              onChange={(event) =>
                setVisibility(event.target.value as "public" | "private")
              }
            >
              <option value="public">Anyone: listed in the lobby</option>
              <option value="private">Only players with the invite link</option>
            </select>
          </label>
          {format === "legacy" && (
            <fieldset>
              <legend>Games</legend>
              <label className={game.choice}>
                <input
                  type="radio"
                  name="table-best-of"
                  checked={bestOf === 1}
                  onChange={() => setBestOf(1)}
                />
                <span>
                  <strong>One game</strong>
                  <small>The main deck alone</small>
                </span>
              </label>
              <label className={game.choice}>
                <input
                  type="radio"
                  name="table-best-of"
                  checked={bestOf === 3}
                  onChange={() => setBestOf(3)}
                />
                <span>
                  <strong>Best of three</strong>
                  <small>Sideboard between games; every game won counts</small>
                </span>
              </label>
            </fieldset>
          )}
          <RulesFields rules={rules} format={format} onChange={setRules} />
          {decks !== null && here.every((d) => !d.playable) ? (
            <div className={game.field} data-no-deck>
              <span>Your deck</span>
              <span>
                You have no playable {formatNames[deckFormat(format)]} deck yet.
                Build one in <a href="#decks">Decks</a>.
              </span>
            </div>
          ) : decks !== null && fitting.length === 0 ? (
            <div className={game.field} data-no-deck>
              <span>Your deck</span>
              <span>
                None of your {formatNames[deckFormat(format)]} decks fits these
                rules: each holds cards they do not allow.
              </span>
            </div>
          ) : (
            <label className={game.field}>
              <span>Your deck</span>
              <select
                value={chosen}
                onChange={(event) => setDeck(event.target.value)}
              >
                <DeckChoices decks={here} rules={rules} />
              </select>
            </label>
          )}
          <div className={game.startRow}>
            <button
              type="submit"
              className={game.primaryButton}
              disabled={opening || !chosen || Boolean(yours)}
            >
              {opening ? "Opening…" : "Open the table"}
            </button>
            {error && (
              <p role="alert" className={game.refusal}>
                {error}
              </p>
            )}
          </div>
        </form>
      </section>

      <section className={game.table} aria-labelledby="tables-title">
        <h2 id="tables-title">Open tables</h2>
        {!tables ? (
          <p role="status">Looking for tables…</p>
        ) : tables.length === 0 ? (
          <p className={game.hint}>
            No table is waiting for players. Open one, and share its link.
          </p>
        ) : (
          <ul className={styles.list}>
            {tables.map((table) => (
              <ListedTable key={table.code} table={table} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ListedTable({ table }: { table: TableView }) {
  const players = table.players.filter(
    (player) => player.player === "human" && player.taken,
  );
  const humans = table.seats - table.bots;
  const mine = table.your_seat !== null;
  return (
    <li className={styles.listed} data-yours={mine}>
      <div>
        <h3>
          {formatNames[table.format]}{" "}
          {table.visibility === "private" && (
            <span className={styles.badge}>Private</span>
          )}
        </h3>
        <TableTags table={table} />
        <small>
          Hosted by {table.host ?? "a player"} · {players.length} of {humans}{" "}
          players
          {table.bots > 0 &&
            ` · ${table.bots} ${table.bots === 1 ? "bot" : "bots"} at skill ${table.bot_skill}`}
        </small>
        {table.format === TEAM_FORMAT ? (
          <TeamsLine table={table} />
        ) : (
          <div className={styles.faces} aria-label="Seated players">
            {players.map((player) => (
              <span key={player.seat} className={styles.face}>
                <Face handle={player.handle} portrait={player.portrait} />
                {player.handle ?? "A player"}
              </span>
            ))}
          </div>
        )}
      </div>
      <a
        className={mine ? game.secondaryButton : game.primaryButton}
        href={`#tables/${table.code}`}
        aria-label={`${mine ? "Open" : "Join"} ${table.host ?? "a player"}'s ${formatNames[table.format]} table`}
      >
        {mine ? "Open" : "Join"}
      </a>
    </li>
  );
}
