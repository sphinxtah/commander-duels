import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { client, describe, type Me } from "../api";
import game from "../game/game.module.css";
import { FindGame } from "../queues/FindGame";
import { useQueue } from "../queues/queue";
import { timeAgo } from "../social/social";
import { FriendPicker, useFriendList } from "./InviteFriends";
import { TableLobby } from "./TableLobby";
import {
  DEFAULT_KINGS_TABLE,
  KINGS_SEATS,
  KINGS_TABLE,
  seatTitle,
  startingLife,
  type KingsTableSettings,
} from "./kingsTable";
import {
  DeckChoices,
  Face,
  KingsSettingsFields,
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
// v0.5.1 a table may be Two-Headed Giant's: two teams of two, with bots in either team. Since
// v0.8.7 a table may be King's Table's: six seats in two teams of three, players in any seats and
// bots in the others.
// Since v0.9.2 (the owner's request of 2026-11-09) the lobby is "Find a game": every table waiting
// for players as a card, filtered live by checkboxes, 20, 50 or 100 a page. "Open a table" is a
// button at the top whose pop-up holds the table's settings and the friends to invite, and "Quick
// match" beside it holds the public queues (#find opens it), which this section was before.

const FORMATS: Format[] = ["legacy", "commander", TEAM_FORMAT, KINGS_TABLE];
const FORMAT_WORDS: Record<Format, string> = {
  legacy: "Two players, 20 life",
  commander: "Two to four seats, 40 life",
  two_headed_giant: "Two teams of two, Legacy decks, 30 life a team",
  kings_table:
    "Six seats, two teams of three: a King and two Generals each. A team wins when the other King is out",
};
/** The other team's seats in Two-Headed Giant, by how many bots fill them. */
const OTHER_TEAM = ["Two players", "A player and a bot", "Two bots"];

export const PAGE_SIZES = [20, 50, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];
type RulesKind = "casual" | "tournament";

/** The lobby's filters (v0.9.2): every box ticks a kind of table in or narrows the list. */
export type Filters = {
  formats: Format[];
  rules: RulesKind[];
  openSeats: boolean;
  noBots: boolean;
  bestOfThree: boolean;
  friends: boolean;
};
export const DEFAULT_FILTERS: Filters = {
  formats: [...FORMATS],
  rules: ["casual", "tournament"],
  openSeats: false,
  noBots: false,
  bestOfThree: false,
  friends: false,
};
const FILTERS_KEY = "cd.tables.filters";

/** The filters and page size this browser chose last; the defaults when none were kept. */
function keptFilters(): { filters: Filters; perPage: PageSize } {
  try {
    const raw = window.localStorage.getItem(FILTERS_KEY);
    if (!raw) return { filters: DEFAULT_FILTERS, perPage: 20 };
    const kept = JSON.parse(raw) as Partial<Filters> & { perPage?: number };
    const perPage = PAGE_SIZES.find((size) => size === kept.perPage) ?? 20;
    return {
      filters: {
        formats: Array.isArray(kept.formats)
          ? FORMATS.filter((format) => kept.formats!.includes(format))
          : DEFAULT_FILTERS.formats,
        rules: Array.isArray(kept.rules)
          ? (["casual", "tournament"] as const).filter((rule) =>
              kept.rules!.includes(rule),
            )
          : DEFAULT_FILTERS.rules,
        openSeats: Boolean(kept.openSeats),
        noBots: Boolean(kept.noBots),
        bestOfThree: Boolean(kept.bestOfThree),
        friends: Boolean(kept.friends),
      },
      perPage,
    };
  } catch {
    return { filters: DEFAULT_FILTERS, perPage: 20 };
  }
}

function keepFilters(filters: Filters, perPage: PageSize) {
  try {
    window.localStorage.setItem(
      FILTERS_KEY,
      JSON.stringify({ ...filters, perPage }),
    );
  } catch {
    // A browser that keeps nothing starts from the defaults next time.
  }
}

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
  return <Lobby me={me} heading={heading} />;
}

/** Whether the address asks for the Quick match pop-up: #find (v0.5.0). */
function asksForQueue(): boolean {
  return window.location.hash === "#find";
}

function Lobby({
  me,
  heading,
}: {
  me: Me;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const kept = useState(keptFilters)[0];
  const [filters, setFilters] = useState<Filters>(kept.filters);
  const [perPage, setPerPage] = useState<PageSize>(kept.perPage);
  const [page, setPage] = useState(1);
  const [opening, setOpening] = useState(false);
  const [quick, setQuick] = useState(asksForQueue);
  const { status: queue } = useQueue();

  useEffect(() => {
    const follow = () => {
      if (asksForQueue()) setQuick(true);
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  const nothing = filters.formats.length === 0 || filters.rules.length === 0;
  const load = useCallback(async () => {
    if (nothing) return null;
    const { data } = await client.GET("/api/v1/tables/browse", {
      params: {
        query: {
          ...(filters.formats.length < FORMATS.length
            ? { format: filters.formats }
            : {}),
          ...(filters.rules.length === 1 ? { rules: filters.rules } : {}),
          open_seats: filters.openSeats,
          no_bots: filters.noBots,
          best_of_three: filters.bestOfThree,
          friends: filters.friends,
          page,
          per_page: perPage,
        },
      },
    });
    return data;
  }, [filters, nothing, page, perPage]);
  const [found, refresh] = usePolled(load);
  // The answer for these filters: an older one, still shown while the new one comes, is marked.
  const current = nothing ? null : found;

  function filter(change: Partial<Filters>) {
    const next = { ...filters, ...change };
    setFilters(next);
    setPage(1);
    keepFilters(next, perPage);
  }

  function choosePerPage(size: PageSize) {
    setPerPage(size);
    setPage(1);
    keepFilters(filters, size);
  }

  const yours = current?.yours ?? null;
  const pages = current ? Math.max(1, Math.ceil(current.total / perPage)) : 1;
  const waiting =
    queue &&
    (queue.status === "waiting" ||
      queue.status === "inviting" ||
      Boolean(queue.invites?.length));

  return (
    <div className={styles.page}>
      <span className={game.eyebrow}>HUMAN TABLES</span>
      <h1 ref={heading} tabIndex={-1}>
        Sit down with other players.
      </h1>
      <p className={styles.lead}>
        Join a table below, open your own and invite your friends, or take a
        quick match from the public queue. Bring a deck of your own that the
        table&apos;s rules take. Wins over players pay 50 to 500 tokens, by how
        many wins they have. In Two-Headed Giant and at King&apos;s Table a team
        wins together, and each of its players is paid.
      </p>
      <div className={styles.lobbyActions}>
        <button
          type="button"
          className={game.primaryButton}
          onClick={() => setOpening(true)}
          disabled={Boolean(yours)}
          title={yours ? "You sit at a table already" : undefined}
        >
          Open a table
        </button>
        <button
          type="button"
          className={game.secondaryButton}
          onClick={() => setQuick(true)}
        >
          Quick match
        </button>
      </div>
      {yours && (
        <p className={styles.notice} role="status">
          You sit at a {formatNames[yours.format]} table.
          <a href={`#tables/${yours.code}`}>Go to your table</a>
        </p>
      )}
      {waiting && !quick && (
        <p className={styles.notice} role="status">
          {queue.status === "waiting"
            ? "You are waiting in the public queue."
            : queue.status === "inviting"
              ? "You are inviting a friend to the Two-Headed Giant queue."
              : "A friend invites you to the Two-Headed Giant queue."}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setQuick(true)}
          >
            Show the quick match
          </button>
        </p>
      )}

      <section
        id="tables-browser"
        className={game.table}
        aria-labelledby="tables-title"
      >
        <span className={game.eyebrow}>OPEN TABLES</span>
        <h2 id="tables-title">Find a game</h2>
        <FilterBar filters={filters} onChange={filter} />
        <div className={styles.listHead}>
          <p role="status" className={styles.count}>
            {nothing
              ? "Tick at least one format and one kind of rules."
              : !current
                ? "Looking for tables…"
                : current.total === 0
                  ? "No table matches."
                  : `${current.total} ${current.total === 1 ? "table" : "tables"}${
                      pages > 1 ? ` · page ${current.page} of ${pages}` : ""
                    }`}
          </p>
          <label className={styles.perPage}>
            <span>Tables a page</span>
            <select
              value={perPage}
              onChange={(event) =>
                choosePerPage(Number(event.target.value) as PageSize)
              }
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
        {current && current.total === 0 && (
          <p className={game.hint}>
            {Object.values(filters).some((value) => value === true) ||
            filters.formats.length < FORMATS.length ||
            filters.rules.length < 2
              ? "No table waiting for players matches these filters. Untick some, or open a table of your own."
              : "No table is waiting for players. Open one, and invite your friends."}
          </p>
        )}
        {current && current.tables.length > 0 && (
          <ul className={styles.cards}>
            {current.tables.map((table) => (
              <TableCard key={table.code} table={table} />
            ))}
          </ul>
        )}
        {current && pages > 1 && (
          <nav className={styles.pager} aria-label="Pages of tables">
            <button
              type="button"
              className={game.secondaryButton}
              disabled={current.page <= 1}
              onClick={() => setPage(current.page - 1)}
            >
              Previous
            </button>
            <span>
              Page {current.page} of {pages}
            </span>
            <button
              type="button"
              className={game.secondaryButton}
              disabled={current.page >= pages}
              onClick={() => setPage(current.page + 1)}
            >
              Next
            </button>
          </nav>
        )}
      </section>

      <Popup
        open={opening}
        onClose={() => setOpening(false)}
        labelledBy="open-title"
        wide
      >
        <OpenTable
          onOpened={(code) => {
            window.location.hash = `#tables/${code}`;
          }}
          onRefused={refresh}
        />
      </Popup>
      <Popup
        open={quick}
        onClose={() => {
          setQuick(false);
          // Leaving #find, so the address no longer opens the pop-up again.
          if (asksForQueue()) window.history.replaceState(null, "", "#tables");
        }}
        labelledBy="find-title"
      >
        <FindGame me={me} title="Quick match" />
      </Popup>
    </div>
  );
}

/** A pop-up over the lobby: its content is shown only while it is open. */
function Popup({
  open,
  onClose,
  labelledBy,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal?.();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      data-wide={wide || undefined}
      aria-labelledby={labelledBy}
      onClose={onClose}
    >
      {open && (
        <>
          <button
            type="button"
            className={styles.dialogClose}
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
          {children}
        </>
      )}
    </dialog>
  );
}

function FilterBar({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (change: Partial<Filters>) => void;
}) {
  const toggle = <T,>(list: T[], item: T, on: boolean): T[] =>
    on ? [...list, item] : list.filter((other) => other !== item);
  return (
    <div className={styles.filters} role="group" aria-label="Filters">
      <fieldset>
        <legend>Format</legend>
        {FORMATS.map((format) => (
          <label key={format} className={styles.filter}>
            <input
              type="checkbox"
              checked={filters.formats.includes(format)}
              onChange={(event) =>
                onChange({
                  formats: toggle(
                    filters.formats,
                    format,
                    event.target.checked,
                  ),
                })
              }
            />
            {formatNames[format]}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Rules</legend>
        {(
          [
            ["casual", "Casual"],
            ["tournament", "Tournament rules"],
          ] as const
        ).map(([rule, words]) => (
          <label key={rule} className={styles.filter}>
            <input
              type="checkbox"
              checked={filters.rules.includes(rule)}
              onChange={(event) =>
                onChange({
                  rules: toggle(filters.rules, rule, event.target.checked),
                })
              }
            />
            {words}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Tables</legend>
        {(
          [
            ["openSeats", "Seats open"],
            ["noBots", "No bots"],
            ["bestOfThree", "Best of three"],
            ["friends", "Friends' tables"],
          ] as const
        ).map(([key, words]) => (
          <label key={key} className={styles.filter}>
            <input
              type="checkbox"
              checked={filters[key]}
              onChange={(event) => onChange({ [key]: event.target.checked })}
            />
            {words}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

/** One table waiting for players, as a card. */
export function TableCard({ table }: { table: TableView }) {
  const players = table.players.filter(
    (player) => player.player === "human" && player.taken,
  );
  const humans = table.seats - table.bots;
  const mine = table.your_seat !== null;
  const host = table.players.find((player) => player.host);
  const name = `${table.host ?? "a player"}'s ${formatNames[table.format]} table`;
  const friends = table.friends ?? [];
  const open = table.players.filter(
    (player) => player.player === "human" && !player.taken,
  ).length;
  return (
    <li className={styles.card} data-yours={mine}>
      <header className={styles.cardHead}>
        {host && <Face handle={host.handle} portrait={host.portrait} />}
        <div>
          <h3>
            {formatNames[table.format]}{" "}
            {table.visibility === "private" && (
              <span className={styles.badge}>Private</span>
            )}
            {mine && (
              <span className={styles.badge} data-tone="gold">
                Yours
              </span>
            )}
          </h3>
          <small>
            Hosted by {table.host ?? "a player"} · opened{" "}
            <time dateTime={table.created_at}>{timeAgo(table.created_at)}</time>
          </small>
        </div>
      </header>
      <TableTags table={table} />
      <dl className={styles.cardFacts}>
        <div>
          <dt>Players</dt>
          <dd>
            {players.length} of {humans}
          </dd>
        </div>
        <div>
          <dt>Open seats</dt>
          <dd>{open}</dd>
        </div>
        <div>
          <dt>Bots</dt>
          <dd>
            {table.bots === 0
              ? "None"
              : `${table.bots} at skill ${table.bot_skill}`}
          </dd>
        </div>
      </dl>
      {table.format === TEAM_FORMAT || table.format === KINGS_TABLE ? (
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
      {(table.invited_by || friends.length > 0) && (
        <p className={styles.cardFriends}>
          {table.invited_by && <>{table.invited_by} invited you. </>}
          {friends.length > 0 && (
            <>
              {friends.length === 1 ? "Your friend " : "Your friends "}
              {friends.join(", ")} {friends.length === 1 ? "sits" : "sit"} here.
            </>
          )}
        </p>
      )}
      <a
        className={mine ? game.secondaryButton : game.primaryButton}
        href={`#tables/${table.code}`}
        aria-label={`${mine ? "Open" : "Join"} ${name}`}
      >
        {mine ? "Open" : open > 0 ? "Join" : "Look"}
      </a>
    </li>
  );
}

/** "Open a table" (v0.4.0), since v0.9.2 in a pop-up, with the friends to invite. */
function OpenTable({
  onOpened,
  onRefused,
}: {
  onOpened: (code: string) => void;
  onRefused: () => void;
}) {
  const decks = useOwnDecks();
  const { friends, error: friendsError } = useFriendList();
  const [invite, setInvite] = useState<string[]>([]);
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
  // King's Table (v0.8.7): its settings, the host's seat and the seats bots take.
  const [kings, setKings] = useState<KingsTableSettings>(DEFAULT_KINGS_TABLE);
  const [hostSeat, setHostSeat] = useState(1);
  const [botSeats, setBotSeats] = useState<number[]>([]);
  const [deck, setDeck] = useState("");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);

  const teams = format === TEAM_FORMAT;
  const kingsTable = format === KINGS_TABLE;
  const allBots = kingsTable
    ? botSeats.length
    : teams
      ? Number(teammateBot) + otherBots
      : bots;
  const decksFormat = deckFormat(format, kings);
  const here = (decks ?? []).filter((d) => d.format === decksFormat);
  // The deck chosen while the rules take it; else the first deck they take.
  const fitting = here.filter((d) => unfit(d, rules) === null);
  const chosen =
    (fitting.some((d) => d.id === deck) ? deck : fitting[0]?.id) ?? "";

  function chooseFormat(next: Format) {
    setFormat(next);
    setDeck("");
    setSeats(next === "legacy" ? 2 : next === KINGS_TABLE ? 6 : 4);
    setBots(0);
    setTeammateBot(false);
    setOtherBots(0);
    setBotSeats([]);
  }

  /** Your seat at a King's Table table: a bot never takes it. */
  function chooseSeat(seat: number) {
    setHostSeat(seat);
    setBotSeats((current) => current.filter((other) => other !== seat));
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
        invite,
        ...(kingsTable
          ? {
              seat: hostSeat,
              bot_seats: [...botSeats].sort((a, b) => a - b),
              kings_table: kings,
            }
          : {}),
      },
    });
    setOpening(false);
    if (data) return onOpened(data.code);
    setError(describe(failure));
    onRefused();
  }

  return (
    <section aria-labelledby="open-title">
      <h2 id="open-title" className={styles.dialogTitle}>
        Open a table
      </h2>
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
        {kingsTable && (
          <>
            <KingsSettingsFields
              name="table-kings"
              settings={kings}
              onChange={(change) => {
                setKings((current) => ({ ...current, ...change }));
                if (change.deck_format) setDeck("");
              }}
            />
            <fieldset>
              <legend>Your seat</legend>
              {KINGS_SEATS.map((seat) => (
                <label key={seat} className={game.choice}>
                  <input
                    type="radio"
                    name="table-kings-seat"
                    checked={hostSeat === seat}
                    onChange={() => chooseSeat(seat)}
                  />
                  <span>
                    <strong>{seatTitle(seat)}</strong>
                    <small>{startingLife(kings, seat)} life to start</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Seats bots take</legend>
              {KINGS_SEATS.filter((seat) => seat !== hostSeat).map((seat) => (
                <label key={seat} className={game.choice}>
                  <input
                    type="checkbox"
                    checked={botSeats.includes(seat)}
                    onChange={(event) =>
                      setBotSeats((current) =>
                        event.target.checked
                          ? [...current, seat]
                          : current.filter((other) => other !== seat),
                      )
                    }
                  />
                  <span>
                    <strong>A bot as {seatTitle(seat)}</strong>
                    <small>Left unticked, the seat waits for a player</small>
                  </span>
                </label>
              ))}
            </fieldset>
          </>
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
            <option value="private">
              Only invited friends and players with the link
            </option>
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
        <RulesFields
          rules={rules}
          format={format}
          kings={kings}
          onChange={setRules}
        />
        {decks !== null && here.every((d) => !d.playable) ? (
          <div className={game.field} data-no-deck>
            <span>Your deck</span>
            <span>
              You have no playable {formatNames[decksFormat]} deck yet. Build
              one in <a href="#decks">Decks</a>.
            </span>
          </div>
        ) : decks !== null && fitting.length === 0 ? (
          <div className={game.field} data-no-deck>
            <span>Your deck</span>
            <span>
              None of your {formatNames[decksFormat]} decks fits these rules:
              each holds cards they do not allow.
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
        <FriendPicker
          friends={friends}
          error={friendsError}
          selected={invite}
          onChange={setInvite}
        />
        <div className={game.startRow}>
          <button
            type="submit"
            className={game.primaryButton}
            disabled={opening || !chosen}
          >
            {opening
              ? "Opening…"
              : invite.length
                ? `Open the table and invite ${invite.length === 1 ? "1 friend" : `${invite.length} friends`}`
                : "Open the table"}
          </button>
          {error && (
            <p role="alert" className={game.refusal}>
              {error}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
