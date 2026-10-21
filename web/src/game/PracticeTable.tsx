import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { client, describe, type Me } from "../api";
import {
  canFullscreen,
  enterTableFullscreen,
  exitTableFullscreen,
} from "../app/fullscreen";
import { readTableSettings } from "../app/tableSettings";
import { getSoundEngine } from "./sound/engine";
import type { components } from "../generated/api";
import styles from "./game.module.css";

type Options = components["schemas"]["PracticeOptions"];
type GameSummary = components["schemas"]["GameSummary"];
type Request = components["schemas"]["PracticeGameRequest"];
type Deck = NonNullable<Request["deck"]>;
type OwnDeck = components["schemas"]["DeckSummary"];
/** Own decks ride in the deck selects as "own:<id>"; fixture decks by name. */
const OWN = "own:";

/** The deck a "Play it" link from the deck builder asked for (#play?deck=<id>). */
function requestedDeck(): string | undefined {
  const query = window.location.hash.split("?")[1];
  return query
    ? (new URLSearchParams(query).get("deck") ?? undefined)
    : undefined;
}

function seatChoice(value: string): { deck?: Deck; deck_id?: string } {
  if (value.startsWith(OWN)) return { deck_id: value.slice(OWN.length) };
  return value ? { deck: value as Deck } : {};
}

/** "commander-mono-red-raiders" reads "Mono-red raiders". */
export function deckName(deck: string | null | undefined): string {
  if (!deck) return "Custom list";
  const text = deck.replace(/^(legacy|commander)-/, "").replace(/-/g, " ");
  return (text.charAt(0).toUpperCase() + text.slice(1)).replace(
    /^Mono (\w+)/,
    "Mono-$1",
  );
}

const time = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return time.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return time.format(hours, "hour");
  return time.format(Math.round(hours / 24), "day");
}

function outcome(game: GameSummary): string {
  if (game.status === "active") return "In progress";
  if (game.status === "interrupted") return "Interrupted";
  const result = game.result;
  if (!result) return "Finished";
  const turns = `${result.turns} turn${result.turns === 1 ? "" : "s"}`;
  if (result.draw) return `Draw after ${turns}`;
  if (result.winner_seat !== null && game.your_seat !== null)
    return result.winner_seat === game.your_seat
      ? `Won in ${turns}`
      : `Lost in ${turns}`;
  const kinds: Record<string, string> = {
    turn_limit: "Turn limit",
    closed: "Closed",
    idle_timeout: "Timed out",
    humans_eliminated: "Lost",
    error: "Engine error",
  };
  return `${kinds[result.kind] ?? "Finished"} after ${turns}`;
}

/** The account's own decks, then the engine's fixture decks: offered to SysOp only (v0.3.1), so
 * a player's lists are empty and get no group. */
function DeckOptions({
  fixtures,
  own,
}: {
  fixtures: string[];
  own: OwnDeck[];
}) {
  return (
    <>
      {own.length > 0 && (
        <optgroup label="Your decks">
          {own.map((d) => (
            <option key={d.id} value={`${OWN}${d.id}`} disabled={!d.playable}>
              {d.title}
              {d.playable ? "" : " (not playable yet)"}
            </option>
          ))}
        </optgroup>
      )}
      {fixtures.length > 0 && (
        <optgroup label="Fixture decks">
          {fixtures.map((d) => (
            <option key={d} value={d}>
              {deckName(d)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

/**
 * Starting or resuming a game fills the screen (v0.3.0), unless the player turned it off. The
 * browser allows it only inside the click, so this runs before anything is awaited.
 */
function tableFullscreen(): Promise<boolean> | null {
  return readTableSettings().fullscreenOnStart && canFullscreen()
    ? enterTableFullscreen()
    : null;
}

/**
 * A Ctrl, Shift, Alt or Meta click (or another button) opens the game in another tab or window,
 * so this page stays on Play and must not fill the screen for it.
 */
function plainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  );
}

const refusals: Record<string, string> = {
  deck_not_playable:
    "That deck has problems to fix first: open it in the deck builder to see them.",
  invalid_deck: "That deck cannot be played in this format.",
  game_limit:
    "You already have a game running. Resume it or close it below first.",
  games_busy: "Every table is busy right now. Try again in half a minute.",
  games_unavailable: "Games are switched off on this server.",
  engine_unavailable: "The rules engine is not answering. Try again shortly.",
};

export function PracticeTable({ me }: { me: Me | null | undefined }) {
  if (me === undefined) return null;
  if (me === null)
    return (
      <section className={styles.table} aria-labelledby="table-title">
        <h2 id="table-title">Play a practice game</h2>
        <p>
          Sign in to sit down against the bots. New accounts are approved by the
          site's operator during testing.
        </p>
        <a className={styles.primaryButton} href="#profile">
          Sign in
        </a>
      </section>
    );
  if (me.status !== "active" || !me.permissions.includes("games.play"))
    return (
      <section className={styles.table} aria-labelledby="table-title">
        <h2 id="table-title">Play a practice game</h2>
        <p>
          {me.status === "pending"
            ? "Your account is waiting for approval. You can play once it is approved."
            : me.status === "denied"
              ? "This account was not approved for testing."
              : "This account cannot play games yet."}
        </p>
      </section>
    );
  return <Table me={me} />;
}

function Table({ me }: { me: Me }) {
  const sysop = me.permissions.includes("games.view_concealed");
  const [options, setOptions] = useState<Options>();
  const [games, setGames] = useState<GameSummary[]>();
  const [everyone, setEveryone] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [format, setFormat] = useState<"legacy" | "commander">("legacy");
  const [deck, setDeck] = useState<string>("");
  const [bots, setBots] = useState(1);
  const [botDecks, setBotDecks] = useState<string[]>(["", "", ""]);
  const [skill, setSkill] = useState(4);
  const [turnCap, setTurnCap] = useState(60);
  const [useList, setUseList] = useState(false);
  const [deckList, setDeckList] = useState("");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<string[]>([]);
  /** The account's decks; null until they have been asked for. */
  const [ownDecks, setOwnDecks] = useState<OwnDeck[] | null>(null);
  const [requested, setRequested] = useState(requestedDeck);
  /** Whether the format was chosen (by the player, or a "Play it" link) rather than defaulted. */
  const formatChosen = useRef(false);

  const refresh = useCallback(async () => {
    const { data } = await client.GET("/api/v1/games", {
      params: { query: { scope: everyone ? "all" : "mine" } },
    });
    setGames(data ?? []);
  }, [everyone]);

  useEffect(() => {
    // StrictMode (pnpm dev, and so the browser journeys) mounts the table twice: the first
    // mount's answers must not land after the second's and reset a deck already chosen.
    let active = true;
    void client.GET("/api/v1/practice-games/options").then(({ data }) => {
      if (!active) return;
      if (data) setOptions(data);
      if (data?.own_decks)
        void client
          .GET("/api/v1/decks", { params: { query: { view: "active" } } })
          .then(({ data: decks }) => {
            if (active) setOwnDecks(decks ?? []);
          });
      else if (data) setOwnDecks([]);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const change = () => setRequested(requestedDeck());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // The reset follows the format (and its default bots once the options arrive), never the
  // options object itself: a fresh copy of the same options must not clear the chosen decks.
  const defaultBots = options?.formats.find(
    (f) => f.id === format,
  )?.default_bots;
  useEffect(() => {
    if (defaultBots !== undefined) setBots(defaultBots);
    setDeck("");
    setBotDecks(["", "", ""]);
  }, [format, defaultBots]);
  useEffect(() => {
    // A deck asked for by a link from the deck builder: its format, then the deck itself. It
    // runs after the reset above, which a change of format also triggers.
    const wanted = ownDecks?.find((d) => d.id === requested);
    if (!wanted) return;
    formatChosen.current = true;
    if (wanted.format !== format) setFormat(wanted.format);
    else {
      setDeck(`${OWN}${wanted.id}`);
      document.getElementById("practice")?.scrollIntoView();
      setRequested(undefined);
    }
  }, [ownDecks, requested, format]);
  useEffect(() => {
    // A player plays their own decks (v0.3.1), so the table opens on a format they have one for:
    // Commander, when their only playable decks are the Commander starter decks. Once only, and
    // never over a format they or a "Play it" link chose.
    if (formatChosen.current || requested || !options || ownDecks === null)
      return;
    formatChosen.current = true;
    const here = (id: string) =>
      options.formats.some((f) => f.id === id && f.decks.length > 0) ||
      ownDecks.some((d) => d.format === id && d.playable);
    const other = ownDecks.find((d) => d.playable);
    if (!here(format) && other) setFormat(other.format);
  }, [options, ownDecks, requested, format]);
  useEffect(() => {
    if (!useList || query.trim().length < 2) {
      setFound([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void client
        .GET("/api/v1/engine/cards", {
          params: { query: { q: query.trim(), limit: 12 } },
        })
        .then(({ data }) => setFound(data?.names ?? []));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, useList]);

  const chosenFormat = options?.formats.find((f) => f.id === format);
  const fixtures = chosenFormat?.decks ?? [];
  const ownHere = (ownDecks ?? []).filter((d) => d.format === format);
  // A player has no fixture decks (v0.3.1): they play a deck of their own, the first playable
  // one unless they choose another. SysOp may leave it to the engine's free fixture decks.
  const firstPlayable = ownHere.find((d) => d.playable);
  const ownOnly = options !== undefined && fixtures.length === 0;
  const chosenDeck =
    deck || (ownOnly && firstPlayable ? `${OWN}${firstPlayable.id}` : "");
  const noDeck = ownOnly && ownDecks !== null && !firstPlayable && !useList;

  async function start(event: FormEvent) {
    event.preventDefault();
    const fullscreen = tableFullscreen();
    // Browsers start sound only from a click, and this is the last one before the table opens.
    getSoundEngine().unlock();
    setError("");
    setStarting(true);
    const body: Request = {
      format,
      bot_skill: skill,
      turn_cap: turnCap,
      bots: Array.from({ length: bots }, (_, i) =>
        seatChoice(botDecks[i] ?? ""),
      ),
      ...(useList && deckList.trim()
        ? { deck_list: deckList }
        : seatChoice(chosenDeck)),
    };
    // A request that throws (the network dropped) is a failure like a refusal: no game, so the
    // full screen asked for above ends and the button comes back.
    const answer = await client
      .POST("/api/v1/practice-games", { body })
      .catch(() => undefined);
    const data = answer?.data;
    const failure = answer?.error;
    setStarting(false);
    if (data) {
      window.location.hash = `#game/${data.id}`;
      return;
    }
    // No game to fill the screen for. The full-screen request may still be pending: wait for it.
    void fullscreen?.then((entered) => {
      if (entered) void exitTableFullscreen();
    });
    const code = (failure as { code?: string } | undefined)?.code ?? "";
    const names = (failure as { names?: string[] } | undefined)?.names;
    setError(
      names?.length
        ? `Unknown card names: ${names.join(", ")}`
        : (refusals[code] ?? describe(failure)),
    );
    void refresh();
  }

  async function close(game: GameSummary) {
    await client.POST("/api/v1/games/{game_id}/close", {
      params: { path: { game_id: game.id } },
    });
    void refresh();
  }

  const active = games?.filter((g) => g.status === "active") ?? [];
  const recent = games?.filter((g) => g.status !== "active").slice(0, 8) ?? [];

  return (
    <section className={styles.table} aria-labelledby="table-title">
      <div className={styles.tableHead}>
        <div>
          <span className={styles.eyebrow}>PRACTICE TABLE</span>
          <h2 id="table-title">Sit down against the bots</h2>
        </div>
      </div>
      <form className={styles.startForm} onSubmit={start}>
        <fieldset>
          <legend>Format</legend>
          {(options?.formats ?? []).map((f) => (
            <label key={f.id} className={styles.choice}>
              <input
                type="radio"
                name="format"
                value={f.id}
                checked={format === f.id}
                onChange={() => {
                  formatChosen.current = true;
                  setFormat(f.id);
                }}
              />
              <span>
                <strong>{f.name}</strong>
                <small>
                  {f.id === "legacy"
                    ? "One bot, 20 life"
                    : "One to three bots, 40 life"}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        {noDeck ? (
          <div className={styles.field} data-no-deck>
            <span>Your deck</span>
            <span>
              You have no playable {chosenFormat?.name ?? ""} deck yet. Build
              one, or fix one, in <a href="#decks">Decks</a>.
            </span>
          </div>
        ) : (
          <label className={styles.field}>
            <span>Your deck</span>
            <select
              aria-label="Your deck"
              value={chosenDeck}
              disabled={useList}
              onChange={(event) => setDeck(event.target.value)}
            >
              {!ownOnly && <option value="">Any free fixture deck</option>}
              <DeckOptions fixtures={fixtures} own={ownHere} />
            </select>
          </label>
        )}
        {chosenFormat && chosenFormat.bots.length > 1 && (
          <label className={styles.field}>
            <span>Bots</span>
            <select
              aria-label="Bots"
              value={bots}
              onChange={(event) => setBots(Number(event.target.value))}
            >
              {chosenFormat.bots.map((count) => (
                <option key={count} value={count}>
                  {count} {count === 1 ? "bot" : "bots"} ({count + 1} players)
                </option>
              ))}
            </select>
          </label>
        )}
        {Array.from({ length: bots }, (_, i) => (
          <label key={i} className={styles.field}>
            <span>{bots === 1 ? "Bot's deck" : `Bot ${i + 1}'s deck`}</span>
            <select
              aria-label={bots === 1 ? "Bot's deck" : `Bot ${i + 1}'s deck`}
              value={botDecks[i]}
              onChange={(event) =>
                setBotDecks((current) =>
                  current.map((value, j) =>
                    j === i ? event.target.value : value,
                  ),
                )
              }
            >
              {/* Left to the server: Commander bots play the starter decks, Legacy bots the
                  engine's fixture decks. */}
              <option value="">Chosen by the table</option>
              <DeckOptions fixtures={fixtures} own={ownHere} />
            </select>
          </label>
        ))}
        <label className={styles.field}>
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
        <label className={styles.field}>
          <span>Turn limit</span>
          <input
            type="number"
            min={1}
            max={200}
            value={turnCap}
            onChange={(event) => setTurnCap(Number(event.target.value) || 60)}
          />
        </label>
        {options?.deck_lists && (
          <div className={styles.deckList}>
            <label className={styles.switch}>
              <input
                type="checkbox"
                checked={useList}
                onChange={(event) => setUseList(event.target.checked)}
              />
              <span>
                Play my own deck list (any card the engine implements)
              </span>
            </label>
            {useList && (
              <>
                <label className={styles.field}>
                  <span>Deck list</span>
                  <textarea
                    rows={10}
                    value={deckList}
                    placeholder={
                      format === "commander"
                        ? "Commander: Tetsuko Umezawa, Fugitive\n38 Island\n1 Fact or Fiction"
                        : "4 Lightning Bolt\n20 Mountain"
                    }
                    onChange={(event) => setDeckList(event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  <span>Find a card</span>
                  <input
                    type="search"
                    value={query}
                    placeholder="Type part of a name"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                {found.length > 0 && (
                  <ul className={styles.found} aria-label="Matching cards">
                    {found.map((name) => (
                      <li key={name}>
                        <button
                          type="button"
                          onClick={() =>
                            setDeckList(
                              (list) =>
                                `${list.replace(/\s*$/, "")}${list.trim() ? "\n" : ""}1 ${name}\n`,
                            )
                          }
                        >
                          Add {name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
        <div className={styles.startRow}>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={
              starting ||
              !options ||
              (useList ? !deckList.trim() : ownOnly && !chosenDeck)
            }
          >
            {starting ? "Shuffling…" : "Start the game"}
          </button>
          {error && (
            <p role="alert" className={styles.refusal}>
              {error}
            </p>
          )}
        </div>
      </form>

      <div className={styles.gamesHead}>
        <h3>{everyone ? "Every player's games" : "Your games"}</h3>
        {sysop && (
          <label className={styles.switch}>
            <input
              type="checkbox"
              checked={everyone}
              onChange={(event) => setEveryone(event.target.checked)}
            />
            <span>Show every player's games</span>
          </label>
        )}
      </div>
      {!games ? (
        <p role="status">Loading games…</p>
      ) : games.length === 0 ? (
        <p className={styles.hint}>No games yet.</p>
      ) : (
        <ul className={styles.games}>
          {[...active, ...recent].map((game) => {
            const players = game.seats
              .map((seat) =>
                seat.player === "bot" ? "Bot" : (seat.handle ?? "Player"),
              )
              .join(" · ");
            return (
              <li key={game.id} data-status={game.status}>
                <div>
                  <strong>
                    {game.format === "commander" ? "Commander" : "Legacy"}
                  </strong>{" "}
                  <span>{players}</span>
                  <small>
                    {outcome(game)} · started {ago(game.created_at)}
                    {game.your_seat !== null &&
                      ` · ${deckName(game.seats.find((s) => s.seat === game.your_seat)?.deck)}`}
                  </small>
                </div>
                {game.status === "active" && (
                  <div className={styles.gameActions}>
                    <a
                      className={styles.primaryButton}
                      href={`#game/${game.id}`}
                      onClick={(event) => {
                        if (plainClick(event.nativeEvent)) {
                          void tableFullscreen();
                          getSoundEngine().unlock();
                        }
                      }}
                    >
                      {game.your_seat === null ? "Observe" : "Resume"}
                    </a>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => void close(game)}
                    >
                      Close
                    </button>
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
