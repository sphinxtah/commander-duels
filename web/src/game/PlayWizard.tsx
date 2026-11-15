import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { client, describe, type Me } from "../api";
import { exitTableFullscreen } from "../app/fullscreen";
import { RunningMatches } from "../matches/RunningMatches";
import {
  PRACTICE_KINGS_TABLE,
  KINGS_SEATS,
  KINGS_TABLE,
  seatTitle,
  startingLife,
  type KingsTableSettings,
} from "../tables/kingsTable";
import {
  KingsRules,
  KingsSettingsFields,
  RulesFields,
} from "../tables/TableParts";
import {
  MAX_TURN_LIMIT,
  TURNS_PER_PLAYER,
  casualRules,
  defaultTurnLimit,
  rulesTag,
  unfit,
  type TableRules,
} from "../tables/tables";
import { useGames } from "./GamesList";
import { readLastSetup, saveLastSetup, type LastSetup } from "./lastSetup";
import {
  DeckOptions,
  OWN,
  ago,
  blankBots,
  botLabel,
  deckFormat,
  deckName,
  formatLines,
  formatNames,
  plainClick,
  refusals,
  seatChoice,
  tableFullscreen,
  type BestOf,
  type FixtureDeck,
  type OwnDeck,
  type PracticeFormatId,
  type PracticeOptions,
  type PracticeRequest,
} from "./practice";
import { getSoundEngine } from "./sound/engine";
import styles from "./game.module.css";
import wizard from "./play.module.css";

/** The wizard's slides (v1.0.0), in their order. One that has a single possible answer is left
 * out: Games where the format has no match, Your seat anywhere but King's Table, Your deck for
 * an account with one deck of the format. */
export type SlideId =
  "format" | "games" | "rules" | "seat" | "deck" | "bots" | "start";

/** Each slide's name, along the top and on the last slide's summary. */
export const SLIDE_NAMES: Record<SlideId, string> = {
  format: "Format",
  games: "Games",
  rules: "The table's rules",
  seat: "Your seat",
  deck: "Your deck",
  bots: "The bots",
  start: "Start Game",
};

/** What each slide asks: its heading. */
const QUESTIONS: Record<SlideId, string> = {
  format: "Which format do you play?",
  games: "One game, or a match?",
  rules: "What are the table's rules?",
  seat: "Where do you sit?",
  deck: "Which deck do you play?",
  bots: "Who do you play against?",
  start: "Ready to play",
};

/** The deck a "Play it" link from the deck builder asked for (#play?deck=<id>). */
function requestedDeck(): string | undefined {
  const query = window.location.hash.split("?")[1];
  return query
    ? (new URLSearchParams(query).get("deck") ?? undefined)
    : undefined;
}

/** Play (v1.0.0, the owner's request): a wizard that asks one thing a slide and ends on "Start
 * Game". Signed out, or not yet approved, it says why there is nothing to choose. */
export function PlayWizard({ me }: { me: Me | null | undefined }) {
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
  return <Wizard me={me} />;
}

function Wizard({ me }: { me: Me }) {
  const [options, setOptions] = useState<PracticeOptions>();
  const { games, refresh } = useGames();
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [format, setFormat] = useState<PracticeFormatId>("legacy");
  const [deck, setDeck] = useState<string>("");
  const [bots, setBots] = useState(1);
  const [botDecks, setBotDecks] = useState<string[]>(blankBots);
  const [skill, setSkill] = useState(4);
  // The turn limit the player typed; null leaves it to the table: 40 turns for each player
  // (v0.9.7), which follows the format and the number of bots.
  const [turnCap, setTurnCap] = useState<number | null>(null);
  const [rules, setRules] = useState<TableRules>(casualRules);
  // One game, or (v0.5.0, Legacy only) a best-of-three match with sideboards.
  const [bestOf, setBestOf] = useState<BestOf>(1);
  // King's Table (v0.8.7): its settings and your seat, team A's King unless you choose another.
  const [kings, setKings] = useState<KingsTableSettings>(PRACTICE_KINGS_TABLE);
  const [seat, setSeat] = useState(1);
  const [useList, setUseList] = useState(false);
  const [deckList, setDeckList] = useState("");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<string[]>([]);
  /** The account's decks; null until they have been asked for. */
  const [ownDecks, setOwnDecks] = useState<OwnDeck[] | null>(null);
  const [requested, setRequested] = useState(requestedDeck);
  /** The slide shown; null is the first one, whichever that is once the options are known. */
  const [slide, setSlide] = useState<SlideId | null>(null);
  /** What the account last started a game with here, when this browser remembers one. */
  const [last, setLast] = useState<LastSetup | null>(null);
  /** True once the options and the decks arrived and the wizard chose where it opens. */
  const [ready, setReady] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  /** Whether a slide was changed by the player: only then does its heading take the focus. */
  const moved = useRef(false);

  useEffect(() => {
    // StrictMode (pnpm dev, and so the browser journeys) mounts the wizard twice: the first
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

  /** A format chosen: its default bots, and no deck of the format before it. */
  function pickFormat(id: PracticeFormatId, from: PracticeOptions) {
    setFormat(id);
    setBots(from.formats.find((f) => f.id === id)?.default_bots ?? 1);
    setDeck("");
    setBotDecks(blankBots);
  }

  /** Every slide set to a remembered setup; false where its format is no longer offered. */
  function applySetup(setup: LastSetup, from: PracticeOptions): boolean {
    const offered = from.formats.find((f) => f.id === setup.format);
    if (!offered) return false;
    setFormat(setup.format);
    setBestOf(setup.best_of);
    setRules(setup.rules);
    if (setup.kings) setKings(setup.kings);
    setSeat(setup.seat);
    setDeck(setup.deck);
    setBots(
      offered.bots.includes(setup.bots) ? setup.bots : offered.default_bots,
    );
    setBotDecks([...setup.bot_decks, ...blankBots].slice(0, blankBots.length));
    setSkill(setup.skill);
    setTurnCap(
      setup.turn_cap === null
        ? null
        : Math.min(setup.turn_cap, from.max_turn_cap ?? MAX_TURN_LIMIT),
    );
    setUseList(false);
    return true;
  }

  const opened = useRef(false);
  useEffect(() => {
    // Where the wizard opens, once: on the account's last setup where this browser remembers
    // one; else on a format the account has a deck for (v0.3.1): Commander, when its only
    // playable decks are the Commander starter decks.
    if (opened.current || !options || ownDecks === null) return;
    opened.current = true;
    const kingsDefaults = options.formats.find(
      (f) => f.id === KINGS_TABLE,
    )?.kings_table;
    if (kingsDefaults) setKings(kingsDefaults);
    const saved = readLastSetup(me.id);
    if (saved && applySetup(saved, options)) setLast(saved);
    else {
      const here = (id: string) =>
        options.formats.some((f) => f.id === id && f.decks.length > 0) ||
        ownDecks.some((d) => d.format === id && d.playable);
      const other = ownDecks.find((d) => d.playable);
      pickFormat(!here("legacy") && other ? other.format : "legacy", options);
    }
    setReady(true);
    // applySetup and pickFormat only set state: they are not dependencies.
  }, [options, ownDecks, me.id]);

  useEffect(() => {
    // A deck asked for by a "Play it" link from the deck builder: its format, the deck itself,
    // and straight to the last slide, where everything else is the last setup's or the table's
    // defaults, each with its way back to change it.
    if (!ready || !options || ownDecks === null || !requested) return;
    const wanted = ownDecks.find((d) => d.id === requested);
    setRequested(undefined);
    if (!wanted) return;
    if (wanted.format !== format) pickFormat(wanted.format, options);
    // Rules remembered from another game must not refuse the deck that was asked for.
    if (unfit(wanted, rules) !== null && unfit(wanted, casualRules) === null)
      setRules(casualRules);
    setDeck(`${OWN}${wanted.id}`);
    setUseList(false);
    setSlide("start");
    document.getElementById("practice")?.scrollIntoView();
    // The format and the rules are read as they are when the link arrives, not followed.
  }, [ready, options, ownDecks, requested]);

  useEffect(() => {
    if (!useList || query.trim().length < 2) {
      setFound([]);
      return;
    }
    // An answer for a query since changed is dropped (v0.8.6): it may come after the new one's.
    let current = true;
    const timer = window.setTimeout(() => {
      void client
        .GET("/api/v1/engine/cards", {
          params: { query: { q: query.trim(), limit: 12 } },
        })
        .then(({ data }) => {
          if (current) setFound(data?.names ?? []);
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, useList]);

  const chosenFormat = options?.formats.find((f) => f.id === format);
  const kingsTable = format === KINGS_TABLE;
  // The API names each table's default turn limit by its bots; before the options arrive, the
  // same rule here: 40 turns for each player who takes turns.
  const defaultTurnCap =
    chosenFormat?.turn_caps?.[String(bots)] ?? defaultTurnLimit(format, bots);
  const maxTurnCap = options?.max_turn_cap ?? MAX_TURN_LIMIT;
  const decksFormat = deckFormat(format, kings);
  // King's Table's fixture decks come by its deck format (v0.8.8); an older API's single list
  // is told apart by the decks' names.
  const byFormat =
    chosenFormat?.decks_by_format?.[decksFormat as "legacy" | "commander"];
  const fixtures = (byFormat ?? chosenFormat?.decks ?? []).filter(
    (d) =>
      !kingsTable || byFormat !== undefined || d.startsWith(`${decksFormat}-`),
  );
  const ownHere = (ownDecks ?? []).filter((d) => d.format === decksFormat);
  /** A seat's choice while the game's rules take it (v0.4.5); else none. */
  const allowed = (value: string): string =>
    value.startsWith(OWN)
      ? ownHere.some(
          (d) => `${OWN}${d.id}` === value && unfit(d, rules) === null,
        )
        ? value
        : ""
      : !value || fixtures.includes(value as FixtureDeck)
        ? value
        : "";
  // A player has no fixture decks (v0.3.1): they play a deck of their own, the first one the
  // rules take unless they choose another. SysOp may leave it to the engine's free fixture decks.
  const firstPlayable = ownHere.find((d) => unfit(d, rules) === null);
  const ownOnly = options !== undefined && fixtures.length === 0;
  const chosenDeck =
    allowed(deck) ||
    (ownOnly && firstPlayable ? `${OWN}${firstPlayable.id}` : "");
  const noDeck = ownOnly && ownDecks !== null && !firstPlayable && !useList;
  const canStart =
    options !== undefined &&
    (useList ? deckList.trim() !== "" : !(ownOnly && !chosenDeck));

  // The slides this game has. Your deck is left out for an account whose one deck of the format
  // is the only thing the slide could offer.
  const oneDeck =
    ownOnly &&
    !options?.deck_lists &&
    ownHere.length === 1 &&
    firstPlayable !== undefined;
  const slides: SlideId[] = [
    ...((options?.formats.length ?? 0) > 1 ? (["format"] as const) : []),
    ...(chosenFormat?.best_of?.includes(3) ? (["games"] as const) : []),
    "rules",
    ...(kingsTable ? (["seat"] as const) : []),
    ...(oneDeck ? [] : (["deck"] as const)),
    "bots",
    "start",
  ];
  const current: SlideId =
    slide !== null && slides.includes(slide) ? slide : slides[0]!;
  const at = slides.indexOf(current);
  const first = at === 0;

  function go(to: SlideId) {
    moved.current = true;
    setError("");
    setSlide(to);
  }
  useEffect(() => {
    // A slide the player moved to takes the focus to its heading, as following a link does: the
    // button that led there went with the slide before.
    if (moved.current) title.current?.focus();
  }, [current]);

  /** What stops the slide from moving on, said beside Next; "" when nothing does. */
  const blocked =
    current === "deck"
      ? noDeck
        ? "You need a deck to go on."
        : useList && !deckList.trim()
          ? "Type your deck list to go on."
          : ""
      : "";

  async function start() {
    const fullscreen = tableFullscreen();
    // Browsers start sound only from a click, and this is the last one before the table opens.
    getSoundEngine().unlock();
    setError("");
    setStarting(true);
    const chosenBots = Array.from({ length: bots }, (_, i) =>
      allowed(botDecks[i] ?? ""),
    );
    const games = chosenFormat?.best_of?.includes(bestOf) ? bestOf : 1;
    const body: PracticeRequest = {
      format,
      bot_skill: skill,
      // Left out, the API gives the table its default: 40 turns for each player.
      ...(turnCap !== null ? { turn_cap: turnCap } : {}),
      rules,
      best_of: games,
      bots: chosenBots.map(seatChoice),
      ...(useList && deckList.trim()
        ? { deck_list: deckList }
        : seatChoice(chosenDeck)),
      // King's Table (v0.8.7): your seat and the settings; the bots in the other seats.
      ...(kingsTable ? { seat, kings_table: kings } : {}),
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
      // The setup is remembered for the next visit (v1.0.0); a typed deck list is not.
      saveLastSetup(me.id, {
        format,
        best_of: games,
        rules,
        kings: kingsTable ? kings : null,
        seat,
        deck: useList ? "" : chosenDeck,
        bots,
        bot_decks: chosenBots,
        skill,
        turn_cap: turnCap,
      });
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

  function submit(event: FormEvent) {
    event.preventDefault();
    if (current === "start") {
      if (canStart && !starting) void start();
    } else if (!blocked) go(slides[at + 1]!);
  }

  /** A deck select's value in words. */
  const deckWords = (value: string, none: string): string =>
    value.startsWith(OWN)
      ? (ownHere.find((d) => `${OWN}${d.id}` === value)?.title ?? none)
      : value
        ? deckName(value)
        : none;
  const turnWords =
    turnCap === null
      ? `${defaultTurnCap} turns (${TURNS_PER_PLAYER} for each player)`
      : `${turnCap} turns`;
  const botWords = `${bots} ${bots === 1 ? "bot" : "bots"} at skill ${skill} of 6`;

  // A game of the account's still running leads back to it, from every slide.
  const running = games?.find(
    (game) =>
      game.status === "active" &&
      game.your_seat !== null &&
      !game.seats.find((s) => s.seat === game.your_seat)?.left,
  );

  /** One line of the last slide's summary, with the way back to its slide. */
  function row(id: SlideId, value: ReactNode) {
    return (
      <div key={id} className={wizard.row}>
        <dt>{SLIDE_NAMES[id]}</dt>
        <dd>{value}</dd>
        {slides.includes(id) && (
          <button
            type="button"
            className={wizard.change}
            aria-label={`Change ${SLIDE_NAMES[id].toLowerCase()}`}
            onClick={() => go(id)}
          >
            Change
          </button>
        )}
      </div>
    );
  }

  return (
    <section className={styles.table} aria-labelledby="wizard-title">
      {running && (
        <aside className={wizard.running} aria-label="Your running game">
          <p>
            <strong>You have a game running.</strong>{" "}
            {formatNames[running.format]}
            {running.kind === "table" ? " table" : ""} · started{" "}
            {ago(running.created_at)}
          </p>
          <a
            className={styles.primaryButton}
            href={`#game/${running.id}`}
            onClick={(event) => {
              if (plainClick(event.nativeEvent)) {
                void tableFullscreen();
                getSoundEngine().unlock();
              }
            }}
          >
            Return to your game
          </a>
        </aside>
      )}
      <RunningMatches refreshKey={games} />
      <ol className={wizard.steps} aria-label="The Play wizard's slides">
        {slides.map((id, number) => (
          <li
            key={id}
            aria-current={id === current ? "step" : undefined}
            data-done={number < at ? "true" : undefined}
          >
            {/* Its name is one hidden line, "Slide 3 of 5: Your deck": the number and the name
                beside it are for the eye. */}
            <button type="button" onClick={() => go(id)}>
              <span className={wizard.unseen}>
                {`Slide ${number + 1} of ${slides.length}: ${SLIDE_NAMES[id]}`}
              </span>
              <span className={wizard.number} aria-hidden="true">
                {number + 1}
              </span>
              <em aria-hidden="true">{SLIDE_NAMES[id]}</em>
            </button>
          </li>
        ))}
      </ol>
      <form className={wizard.slide} onSubmit={submit} data-slide={current}>
        <div className={wizard.head}>
          <span className={styles.eyebrow}>
            PLAY · SLIDE {at + 1} OF {slides.length}
          </span>
          <h2 id="wizard-title" ref={title} tabIndex={-1}>
            {QUESTIONS[current]}
          </h2>
        </div>
        {!options ? (
          <p role="status">Loading the table…</p>
        ) : (
          <div className={`${styles.startForm} ${wizard.body}`}>
            {first && last && current !== "start" && (
              <div
                className={wizard.again}
                role="group"
                aria-label="Your last setup"
              >
                <p>
                  <strong>Your last game</strong>
                  <small>
                    {[
                      options.formats.find((f) => f.id === last.format)?.name,
                      last.best_of === 3 ? "best of three" : "",
                      last.deck.startsWith(OWN)
                        ? ownDecks?.find((d) => `${OWN}${d.id}` === last.deck)
                            ?.title
                        : last.deck && deckName(last.deck),
                      `${last.bots} ${last.bots === 1 ? "bot" : "bots"} at skill ${last.skill}`,
                      rulesTag(last.rules, last.format, last.kings),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </p>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => {
                    applySetup(last, options);
                    go("start");
                  }}
                >
                  Play again with your last setup
                </button>
              </div>
            )}
            {current === "format" && (
              <fieldset>
                <legend>Format</legend>
                {options.formats.map((f) => (
                  <label key={f.id} className={styles.choice}>
                    <input
                      type="radio"
                      name="format"
                      value={f.id}
                      checked={format === f.id}
                      onChange={() => pickFormat(f.id, options)}
                    />
                    <span>
                      <strong>{f.name}</strong>
                      <small>{formatLines[f.id]}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {current === "games" && (
              <fieldset>
                <legend>Games</legend>
                <label className={styles.choice}>
                  <input
                    type="radio"
                    name="best-of"
                    checked={bestOf === 1}
                    onChange={() => setBestOf(1)}
                  />
                  <span>
                    <strong>One game</strong>
                    <small>The main deck alone</small>
                  </span>
                </label>
                <label className={styles.choice}>
                  <input
                    type="radio"
                    name="best-of"
                    checked={bestOf === 3}
                    onChange={() => setBestOf(3)}
                  />
                  <span>
                    <strong>Best of three</strong>
                    <small>
                      Sideboard between games; every game won counts
                    </small>
                  </span>
                </label>
              </fieldset>
            )}
            {current === "rules" && (
              <>
                {kingsTable && (
                  <KingsSettingsFields
                    name="practice-kings"
                    settings={kings}
                    onChange={(change) => {
                      // The decks of one deck format do not play in the other.
                      if (
                        change.deck_format &&
                        change.deck_format !== kings.deck_format
                      ) {
                        setDeck("");
                        setBotDecks(blankBots);
                      }
                      setKings((held) => ({ ...held, ...change }));
                    }}
                  />
                )}
                <RulesFields
                  rules={rules}
                  format={decksFormat}
                  onChange={setRules}
                />
                <label className={styles.field}>
                  <span>
                    Turn limit{" "}
                    <small>
                      {turnCap === null
                        ? `${TURNS_PER_PLAYER} turns for each player`
                        : `instead of the table's ${defaultTurnCap}`}
                    </small>
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={maxTurnCap}
                    value={turnCap ?? defaultTurnCap}
                    onChange={(event) => {
                      // An emptied field goes back to the table's own limit.
                      const typed = Math.floor(Number(event.target.value));
                      setTurnCap(
                        typed >= 1 ? Math.min(typed, maxTurnCap) : null,
                      );
                    }}
                  />
                </label>
              </>
            )}
            {current === "seat" && (
              <fieldset>
                <legend>Your seat</legend>
                {KINGS_SEATS.map((place) => (
                  <label key={place} className={styles.choice}>
                    <input
                      type="radio"
                      name="practice-seat"
                      checked={seat === place}
                      onChange={() => setSeat(place)}
                    />
                    <span>
                      <strong>{seatTitle(place)}</strong>
                      <small>{startingLife(kings, place)} life to start</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {current === "deck" && (
              <>
                {noDeck ? (
                  <div className={styles.field} data-no-deck>
                    <span>Your deck</span>
                    {ownHere.some((d) => d.playable) ? (
                      <span>
                        None of your {formatNames[decksFormat]} decks fits the
                        table's rules: each holds cards they do not allow.
                      </span>
                    ) : (
                      <span>
                        You have no playable {formatNames[decksFormat]} deck
                        yet. Build one, or fix one, in{" "}
                        <a href="#decks">Decks</a>.
                      </span>
                    )}
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
                      {!ownOnly && (
                        <option value="">Any free fixture deck</option>
                      )}
                      <DeckOptions
                        fixtures={fixtures}
                        own={ownHere}
                        rules={rules}
                      />
                    </select>
                  </label>
                )}
                {options.deck_lists && (
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
                              decksFormat === "commander"
                                ? "Commander: Tetsuko Umezawa, Fugitive\n38 Island\n1 Fact or Fiction"
                                : "4 Lightning Bolt\n20 Mountain"
                            }
                            onChange={(event) =>
                              setDeckList(event.target.value)
                            }
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
                          <ul
                            className={styles.found}
                            aria-label="Matching cards"
                          >
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
              </>
            )}
            {current === "bots" && (
              <>
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
                          {count} {count === 1 ? "bot" : "bots"} ({count + 1}{" "}
                          players)
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {Array.from({ length: bots }, (_, i) => (
                  <label key={i} className={styles.field}>
                    <span>{botLabel(format, bots, i, seat)}</span>
                    <select
                      aria-label={botLabel(format, bots, i, seat)}
                      value={allowed(botDecks[i] ?? "")}
                      onChange={(event) =>
                        setBotDecks((held) =>
                          held.map((value, j) =>
                            j === i ? event.target.value : value,
                          ),
                        )
                      }
                    >
                      {/* Left to the server: Commander bots play the starter decks, Legacy bots
                          the engine's fixture decks, Two-Headed Giant bots fixture decks that
                          share no card with their teammate's, and King's Table bots the engine's
                          fixture decks of its deck format. */}
                      <option value="">Chosen by the table</option>
                      <DeckOptions
                        fixtures={fixtures}
                        own={ownHere}
                        rules={rules}
                      />
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
              </>
            )}
            {current === "start" && (
              <dl className={wizard.summary} aria-label="What you chose">
                {row("format", chosenFormat?.name ?? formatNames[format])}
                {slides.includes("games") &&
                  row("games", bestOf === 3 ? "Best of three" : "One game")}
                {row(
                  "rules",
                  <>
                    {rulesTag(rules, format, kings)} · {turnWords}
                    {kingsTable && <KingsRules settings={kings} />}
                  </>,
                )}
                {kingsTable &&
                  row(
                    "seat",
                    `${seatTitle(seat)} · ${startingLife(kings, seat)} life to start`,
                  )}
                {row(
                  "deck",
                  useList
                    ? "Your own deck list"
                    : noDeck
                      ? `No playable ${formatNames[decksFormat]} deck`
                      : deckWords(chosenDeck, "Any free fixture deck"),
                )}
                {row(
                  "bots",
                  <>
                    {botWords}
                    <small>
                      {Array.from({ length: bots }, (_, i) =>
                        allowed(botDecks[i] ?? ""),
                      ).every((value) => !value)
                        ? "Their decks chosen by the table"
                        : Array.from(
                            { length: bots },
                            (_, i) =>
                              `${botLabel(format, bots, i, seat)}: ${deckWords(allowed(botDecks[i] ?? ""), "chosen by the table")}`,
                          ).join(" · ")}
                    </small>
                  </>,
                )}
              </dl>
            )}
          </div>
        )}
        <div className={wizard.nav}>
          {first ? (
            <a className={styles.secondaryButton} href="#play/games">
              Your games
            </a>
          ) : (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => go(slides[at - 1]!)}
            >
              Back
            </button>
          )}
          {current === "start" ? (
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={starting || !canStart}
            >
              {starting ? "Shuffling…" : "Start Game"}
            </button>
          ) : (
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={!options || blocked !== ""}
            >
              Next
            </button>
          )}
          {blocked && <p className={styles.hint}>{blocked}</p>}
          {current === "start" && !canStart && options && (
            <p className={styles.hint}>
              {useList
                ? "Type your deck list to start."
                : "Choose a deck to start."}
            </p>
          )}
          {error && (
            <p role="alert" className={styles.refusal}>
              {error}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
