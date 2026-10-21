import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Account, SignIn, Waiting, avatars } from "./Account";
import { Admin, SysopSignIn, canAdminister } from "./Admin";
import {
  countsTotal,
  countsWords,
  useAdminCounts,
  useCountTitle,
} from "./admin/counts";
import { Portrait } from "./alliance/Portrait";
import { exitTableFullscreen } from "./app/fullscreen";
import { InstallBanner } from "./app/InstallBanner";
import { Landing } from "./app/Landing";
import { guardLiveGame } from "./app/liveGame";
import { useOnline } from "./app/online";
import { ReportButton } from "./app/ReportProblem";
import { leaveTable } from "./app/serviceWorker";
import { Settings } from "./app/Settings";
import { UpdateNotice } from "./app/UpdateNotice";
import {
  answerTimeout,
  client,
  loadFoundation,
  loadMe,
  onboarding,
  setCsrfToken,
  sysopEntrance,
  type Bootstrap,
  type Format,
  type Me,
  type PracticeFormat,
} from "./api";
import { CardsPage } from "./catalog/CardsPage";
import { DeckEditor } from "./decks/DeckEditor";
import { DecksPage } from "./decks/DecksPage";
import { SharedDeck } from "./decks/SharedDeck";
import { ShopPage } from "./shop/ShopPage";
import { GameScreen } from "./game/GameScreen";
import { PracticeTable } from "./game/PracticeTable";
import { TablesPage } from "./tables/TablesPage";
import {
  readPreferences,
  savePreferences,
  type Preferences,
} from "./preferences";
import styles from "./App.module.css";

const pages = [
  "Play",
  "Tables",
  "Campaign",
  "Learn",
  "Decks",
  "Cards",
  "Shop",
  "Collection",
  "Profile",
  "Settings",
  "Admin",
] as const;
// SysOp's entrance has no navigation entry; it opens only from the SysOp networks.
type Page = (typeof pages)[number] | "SysOp";
const glyphs = ["◇", "⚔", "▱", "✧", "▤", "▦", "⬡", "◈", "○", "⚙", "⚖"];
const details: Record<
  Exclude<
    Page,
    | "Play"
    | "Tables"
    | "Settings"
    | "Profile"
    | "Admin"
    | "SysOp"
    | "Decks"
    | "Cards"
    | "Shop"
  >,
  { title: string; description: string; next: string; milestone: string }
> = {
  Campaign: {
    title: "Every journey starts at the table.",
    description: "Stories, encounters, and challenges will live here.",
    next: "The reference campaign audit and scenario authoring come first.",
    milestone: "M4 · Campaign & progression",
  },
  Learn: {
    title: "Make your next move with confidence.",
    description:
      "Guided lessons will introduce resources, combat, priority, and Commander.",
    next: "Interactive lessons need the rules adapter and validated scenarios.",
    milestone: "M4 · Tutorials & lessons",
  },
  Collection: {
    title: "Room for every possibility.",
    description:
      "The default collection will include every legal, certified card.",
    next: "Collection browsing follows the catalog. Optional earned progression arrives later.",
    milestone: "M1 / M4 · Collection policies",
  },
};
// Practice games against the bots cover these; a format that is neither one of them nor marked
// available by the server is still planned. Keyed by the API's practice formats, so a new one
// fails the type check until it is listed here.
const practiceFormats: Record<PracticeFormat["id"], true> = {
  commander: true,
  legacy: true,
};
function plannedFormat(format: Format | undefined): boolean {
  return Boolean(
    format && !format.available && !(format.id in practiceFormats),
  );
}
const GAME_ROUTE = /^#game\/([0-9a-f-]{36})$/i;
const DECK_ROUTE = /^#deck\/([0-9a-f-]{36})$/i;
const SHARED_ROUTE = /^#shared\/([A-Za-z0-9_-]{8,32})$/;
const TABLE_ROUTE = /^#tables\/([A-Za-z0-9_-]{8,32})$/;
/** #game/<id> opens a game's table, full screen. */
function currentGame(): string | undefined {
  return GAME_ROUTE.exec(window.location.hash)?.[1]?.toLowerCase();
}
/** The hash of a whole address, such as a hashchange event's oldURL. */
function hashOf(url: string): string {
  try {
    return new URL(url).hash;
  } catch {
    return "";
  }
}
/** #deck/<id> opens a deck in the editor; #shared/<code>, a deck shared by link. */
function currentDeck(): { deck?: string; shared?: string } {
  const hash = window.location.hash;
  return {
    deck: DECK_ROUTE.exec(hash)?.[1]?.toLowerCase(),
    shared: SHARED_ROUTE.exec(hash)?.[1],
  };
}
/** #tables/<code> opens a human table: its invite link (v0.4.0). */
function currentTable(): string | undefined {
  return TABLE_ROUTE.exec(window.location.hash)?.[1];
}
function currentPage(): Page {
  const path = window.location.hash.slice(1).toLowerCase().split("?")[0] ?? "";
  if (path === "sysop") return "SysOp";
  if (path.startsWith("tables/")) return "Tables";
  if (path.startsWith("deck/") || path.startsWith("shared/")) return "Decks";
  return pages.find((page) => page.toLowerCase() === path) ?? "Play";
}

export function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [game, setGame] = useState(currentGame);
  const [deckRoute, setDeckRoute] = useState(currentDeck);
  const [tableRoute, setTableRoute] = useState(currentTable);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [formats, setFormats] = useState<Format[]>([]);
  const [connection, setConnection] = useState<
    "loading" | "connected" | "unavailable"
  >("loading");
  const [attempt, setAttempt] = useState(0);
  const online = useOnline();
  const [preferences, setPreferences] = useState(readPreferences);
  const [saveMessage, setSaveMessage] = useState("");
  const [selected, setSelected] = useState<Format>();
  // undefined while loading, null when signed out.
  const [me, setMe] = useState<Me | null>();
  // Only an active account sees the app; everyone else, the landing page (v0.3.0).
  const admitted = me?.status === "active";
  // What the sign-in page says about the sign-out that led to it; a sign-in clears it.
  const [notice, setNotice] = useState("");
  // Whether #sysop is SysOp's entrance here: undefined until the server answers.
  const [entrance, setEntrance] = useState<boolean>();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  // Counts the account's changes made here (a sign-in, an approval, a sign-out). An answer
  // asked for before the latest one (an account check started by going online or Try again, a
  // preferences save) is dropped, so it can never bring back an account just signed out.
  const generation = useRef(0);
  // At #sysop nothing shows until the server says whether this is SysOp's network: off it, the
  // address is the landing page like any other. A service that did not answer shows the sign-in
  // with its Try again, never the mark alone with nothing to press.
  const checking =
    (me === undefined && connection !== "unavailable") ||
    (!me && page === "SysOp" && entrance === undefined);
  // What the page shows once it knows: the app, an account's wait (by its status), SysOp's
  // entrance or the sign-in.
  const view = admitted
    ? "app"
    : checking
      ? undefined
      : me
        ? me.status
        : page === "SysOp" && entrance
          ? "sysop"
          : "sign-in";
  const shownBefore = useRef<string | undefined>(undefined);
  // A #game/<id> opens the table for an active account only; before then it is the landing page.
  const atTable = Boolean(game) && admitted;
  // What waits for SysOp and administrators (v0.4.1): on Admin in the navigation, on
  // Administration's tabs and in the tab's title, asked again every minute.
  const { counts, refresh: refreshCounts } = useAdminCounts(me);
  const waiting = countsTotal(counts);
  useCountTitle(waiting);

  useEffect(() => {
    const change = (event: HashChangeEvent) => {
      // A live game keeps its address unless an in-game link meant to leave (v0.3.0): the
      // browser's Back, or the installed app opening #play in this window, changes nothing.
      if (guardLiveGame(event.oldURL)) return;
      if (GAME_ROUTE.test(hashOf(event.oldURL)) && !currentGame()) {
        // Leaving the table: its full screen ends, and the update the game screen said was
        // ready applies now. One that took over during the game loads at once instead of
        // drawing the next page with the old code.
        void exitTableFullscreen();
        if (leaveTable()) return;
      }
      navigated.current = true;
      setPage(currentPage());
      setGame(currentGame());
      setDeckRoute(currentDeck());
      setTableRoute(currentTable());
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useLayoutEffect(() => {
    // The table fills the window and never scrolls; the other pages scroll as ever, and so does
    // the landing page that a #game/<id> shows before sign-in. A layout effect, so the route
    // changes in the commit that draws its screen: a session that ends at the table never shows
    // the landing page with the table's layout, even for a moment.
    document.documentElement.dataset.route = atTable ? "game" : "shell";
  }, [atTable]);
  // Focus moves in the commit that draws the new screen (a layout effect, not a passive one), so
  // it never rests on the page's body in between, even when an answer from the API caused the
  // change and React would otherwise run the effect a moment later.
  useLayoutEffect(() => {
    if (view === undefined) return;
    const before = shownBefore.current;
    shownBefore.current = view;
    if (before === undefined || before === view) return;
    // Once the page has settled, a change in what it shows (a sign-in, one that must wait, an
    // approval, a refusal found on a check, a sign-out) moves focus as following a link does.
    navigated.current = true;
    if (!atTable) heading.current?.focus();
    // The session ending at the table (it expired, or Sign out everywhere ended it from another
    // browser) swaps the game for the landing page without a change of address. The table's
    // full screen, with Escape held, ends here, and a waiting update applies, as leaving does.
    if (before === "app" && game) {
      void exitTableFullscreen();
      leaveTable();
    }
  }, [view, game, atTable]);
  useLayoutEffect(() => {
    // Leaving a game also lands on a page (usually Play, whose state never changed), so focus
    // follows the game route too; the game screen focuses its own heading.
    if (navigated.current && !atTable) heading.current?.focus();
  }, [page, atTable]);
  useEffect(() => {
    // Either change is a reason to ask the service again.
    const update = () => setAttempt((value) => value + 1);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    // Each question has its own time to answer: the foundation answering must not leave the
    // landing page waiting on a stalled account check, with nothing to press.
    const foundation = answerTimeout();
    const account = answerTimeout();
    let active = true;
    setConnection("loading");
    loadFoundation(foundation.signal)
      .then((data) => {
        if (active) {
          setBootstrap(data.bootstrap);
          setFormats(data.formats);
          setConnection("connected");
        }
      })
      .catch(() => {
        if (active) setConnection("unavailable");
      })
      .finally(foundation.done);
    const sent = generation.current;
    loadMe(account.signal, { token: false })
      .then((value) => {
        if (!active || sent !== generation.current) return;
        setCsrfToken(value?.csrf_token);
        changeMe(value);
      })
      .catch(() => {
        // An unreachable service, or one that did not answer in time, says nothing about the
        // session: a network blip must not sign the page out and throw away open forms, so a
        // known account stays. A first load that fails still settles on signed out.
        if (active && sent === generation.current)
          setMe((current) => (current === undefined ? null : current));
      })
      .finally(account.done);
    return () => {
      active = false;
      foundation.abort();
      account.abort();
    };
  }, [attempt]);
  useEffect(() => {
    document.documentElement.dataset.largeText = String(preferences.largeText);
    document.documentElement.dataset.reducedMotion = String(
      preferences.reducedMotion,
    );
  }, [preferences]);
  useEffect(() => {
    if (selected) dialog.current?.showModal();
  }, [selected]);
  useEffect(() => {
    if (page !== "SysOp") return;
    let active = true;
    // A check that has not answered in time counts as off the network, so #sysop never stays
    // the mark alone.
    const check = answerTimeout();
    void sysopEntrance(check.signal).then((open) => {
      check.done();
      if (active) setEntrance(open);
    });
    return () => {
      active = false;
      check.abort();
    };
  }, [page]);
  // Off the SysOp networks, #sysop is indistinguishable from any unknown address.
  const shown: Page = page === "SysOp" && !entrance ? "Play" : page;
  const changeMe = useCallback((value: Me | null) => {
    setMe(value);
    if (value) setNotice("");
    // An account's accessibility settings follow it to every device it signs in on.
    if (value && value.status === "active") {
      const next = {
        largeText: value.preferences.large_text,
        reducedMotion: value.preferences.reduced_motion,
      };
      setPreferences(next);
      savePreferences(next);
    }
  }, []);
  // What the page's own screens report: each is a change of account, newer than any answer
  // still on its way.
  const accountChanged = useCallback(
    (value: Me | null) => {
      generation.current += 1;
      changeMe(value);
    },
    [changeMe],
  );
  const signedOut = useCallback(
    (said: string) => {
      setNotice(said);
      accountChanged(null);
    },
    [accountChanged],
  );
  const retry = () => setAttempt((value) => value + 1);

  function updatePreference(key: keyof Preferences, value: boolean) {
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    const local = savePreferences(next);
    setSaveMessage(
      local
        ? "Preferences saved on this device."
        : "Applied for this visit. Browser storage is unavailable.",
    );
    if (me?.status === "active") {
      const sent = generation.current;
      void client
        .PATCH("/api/v1/me", {
          body: {
            preferences: {
              large_text: next.largeText,
              reduced_motion: next.reducedMotion,
            },
          },
        })
        .then(({ data }) => {
          if (data && sent === generation.current) {
            setMe(data);
            setSaveMessage(
              "Preferences saved to your account and this device.",
            );
          }
        });
    }
  }

  // Nothing of the app is drawn, or asks the API for anything, before the account is active
  // (v0.3.0). Every address shows the landing page and stays as it was, so the screen it names
  // opens after sign-in and approval; a #game/<id> never opens the game's WebSocket.
  if (!me || me.status !== "active") {
    return (
      <Landing>
        {checking ? undefined : me ? (
          <Waiting
            me={me}
            onChange={accountChanged}
            onSignedOut={signedOut}
            heading={heading}
          />
        ) : page === "SysOp" && entrance ? (
          <SysopSignIn onSignedIn={accountChanged} heading={heading} />
        ) : (
          <SignIn
            auth={bootstrap?.auth}
            unavailable={connection === "unavailable"}
            onRetry={retry}
            notice={notice}
            onSignedIn={accountChanged}
            heading={heading}
          />
        )}
      </Landing>
    );
  }

  // The account is known by now, with the CSRF token that the game's WebSocket needs.
  if (game) return <GameScreen key={game} gameId={game} me={me} />;

  return (
    <div className={styles.app}>
      <a
        className={styles.skip}
        href="#main"
        onClick={(event) => {
          // The hash is the router: following #main would leave this page for Play.
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className={styles.sidebar}>
        <a
          href="#play"
          className={styles.brand}
          aria-label="Commander Duels home"
        >
          <img src="/brand/mark.webp" alt="" width={48} height={48} />
          <span>
            COMMANDER<strong>DUELS</strong>
          </span>
        </a>
        <div className={styles.navLabel}>YOUR TABLE</div>
        <nav aria-label="Main navigation">
          {pages
            .filter((item) => item !== "Admin" || canAdminister(me))
            .map((item) => (
              <a
                key={item}
                href={`#${item.toLowerCase()}`}
                aria-current={shown === item ? "page" : undefined}
                className={shown === item ? styles.active : ""}
                aria-label={
                  item === "Admin" && waiting > 0
                    ? `Admin, ${countsWords(counts)}`
                    : undefined
                }
              >
                <span aria-hidden="true">{glyphs[pages.indexOf(item)]}</span>
                {item}
                {item === "Play" && (
                  <span className={styles.navArrow} aria-hidden="true">
                    ↗
                  </span>
                )}
                {item === "Admin" && waiting > 0 && (
                  <span className={styles.navBadge} aria-hidden="true">
                    {waiting}
                  </span>
                )}
              </a>
            ))}
        </nav>
        <a className={styles.sidebarBottom} href="#profile">
          {/* The alliance's portrait is the account's picture; with none, its avatar (v0.3.1). */}
          {me.alliance ? (
            <Portrait
              id={me.alliance}
              size={40}
              thumbnail
              decorative
              className={styles.sidebarPortrait}
            />
          ) : (
            <span className={styles.monogram} aria-hidden="true">
              {avatars[me.avatar]}
            </span>
          )}
          <div>
            {me.handle ?? me.display_name}
            <small>
              {me.kind === "sysop"
                ? "Local administrator"
                : me.onboarding === "handle"
                  ? "Choose your handle"
                  : me.onboarding === "starters"
                    ? "Choose your starter decks"
                    : "Signed in"}
            </small>
          </div>
        </a>
      </aside>
      <div className={styles.workspace}>
        <InstallBanner me={me} onGame={false} />
        <header className={styles.topbar}>
          <span>THE GATHERING STARTS HERE</span>
          <div>
            <span
              className={styles.statusDot}
              data-connected={connection === "connected" && online}
            />
            <span role="status" aria-label="Connection status">
              {!online
                ? "Offline"
                : connection === "loading"
                  ? "Connecting"
                  : connection === "connected"
                    ? "Service connected"
                    : "Service unavailable"}
            </span>
            <UpdateNotice />
            {/* On every page of the app (v0.4.1); the table has its own, in the Game menu. */}
            <ReportButton className={styles.report} />
            <span className={styles.version}>v{__APP_VERSION__}</span>
          </div>
        </header>
        <main id="main" className={styles.main} tabIndex={-1}>
          <div className={styles.breadcrumb}>
            COMMANDER DUELS <span>/</span> {shown.toUpperCase()}
          </div>
          {/* Sign-in and approval keep the address, so a new account rarely lands on Profile,
              where it chooses its handle and then its two starter decks (v0.3.1): every other
              page points the way until both are done. */}
          {onboarding(me) && page !== "Profile" && (
            <p className={styles.handleNotice}>
              {me.onboarding === "handle" ? (
                <>
                  Other players know you by your handle.{" "}
                  <a href="#profile">
                    Choose yours on Profile <span aria-hidden="true">→</span>
                  </a>
                </>
              ) : (
                <>
                  Two starter decks of your choice begin your card library.{" "}
                  <a href="#profile">
                    Choose them on Profile <span aria-hidden="true">→</span>
                  </a>
                </>
              )}
            </p>
          )}
          {page === "Profile" ? (
            <Account
              me={me}
              onChange={accountChanged}
              onSignedOut={signedOut}
              heading={heading}
            />
          ) : page === "Admin" ? (
            <Admin
              me={me}
              heading={heading}
              counts={counts}
              onCounts={refreshCounts}
            />
          ) : page === "Decks" && deckRoute.deck ? (
            <DeckEditor
              key={deckRoute.deck}
              deckId={deckRoute.deck}
              heading={heading}
            />
          ) : page === "Decks" && deckRoute.shared ? (
            <SharedDeck
              key={deckRoute.shared}
              code={deckRoute.shared}
              heading={heading}
            />
          ) : page === "Decks" ? (
            <DecksPage me={me} heading={heading} />
          ) : page === "Cards" ? (
            <CardsPage me={me} heading={heading} />
          ) : page === "Shop" ? (
            <ShopPage me={me} heading={heading} />
          ) : page === "Tables" ? (
            <TablesPage
              key={tableRoute ?? "lobby"}
              me={me}
              heading={heading}
              code={tableRoute}
            />
          ) : page === "SysOp" && entrance ? (
            <SysopSignIn onSignedIn={accountChanged} heading={heading} />
          ) : page === "Play" || page === "SysOp" ? (
            <>
              <section className={styles.hero} aria-labelledby="page-title">
                <picture className={styles.heroBanner}>
                  <source
                    media="(max-width: 600px)"
                    srcSet="/brand/banner-logo-640.webp"
                    width={640}
                    height={584}
                  />
                  <source
                    media="(max-width: 1100px)"
                    srcSet="/brand/banner-960.webp"
                    width={960}
                    height={411}
                  />
                  <img
                    src="/brand/banner-1600.webp"
                    alt="Commander Duels: an armoured warrior with an axe on a battlefield, beside the Commander Duels logo"
                    width={1600}
                    height={686}
                  />
                </picture>
                <div className={styles.heroCopy}>
                  <div className={styles.eyebrow}>
                    <span /> A NEW TABLE. ENDLESS POSSIBILITIES.
                  </div>
                  <h1 id="page-title" ref={heading} tabIndex={-1}>
                    Gather your cards.
                    <br />
                    <em>Make your mark.</em>
                  </h1>
                  <p>
                    Build something unmistakably yours.
                    <br />A new home for Commander, Legacy, and playing
                    together.
                  </p>
                  <a className={styles.primary} href="#practice">
                    Play a practice game <span aria-hidden="true">↓</span>
                  </a>
                  <span className={styles.heroNote}>
                    Testing preview · Practice games against the bots
                  </span>
                </div>
              </section>
              <div id="practice" className={styles.practice}>
                <PracticeTable me={me} />
              </div>
              <section
                id="formats"
                className={styles.formats}
                aria-labelledby="formats-title"
              >
                <div className={styles.sectionHeading}>
                  <div>
                    <span className={styles.eyebrow}>
                      FIND YOUR WAY TO PLAY
                    </span>
                    <h2 id="formats-title">
                      One game. Different possibilities.
                    </h2>
                  </div>
                  <span className={styles.tag}>TESTING PREVIEW</span>
                </div>
                {connection === "loading" && (
                  <p role="status">Loading format information…</p>
                )}
                {connection === "unavailable" && (
                  <div className={styles.notice}>
                    <strong>The application service is unavailable.</strong>
                    <p>
                      The shell is ready. Format information will appear when
                      the service reconnects.
                    </p>
                    <button onClick={retry}>Retry connection</button>
                  </div>
                )}
                {connection === "connected" && (
                  <div className={styles.formatGrid}>
                    {formats.map((format, index) => (
                      <article
                        key={format.id}
                        className={styles.formatCard}
                        data-format={format.id}
                      >
                        <div className={styles.formatTop}>
                          <span
                            className={styles.formatSymbol}
                            aria-hidden="true"
                          >
                            {["♜", "⚔", "♜♜"][index]}
                          </span>
                          <span>
                            {format.id === "commander"
                              ? "2–4 PLAYERS"
                              : format.id === "legacy"
                                ? "2 PLAYERS"
                                : "2 × 2 PLAYERS"}
                          </span>
                        </div>
                        <h3>{format.name}</h3>
                        <p>{format.description}</p>
                        <button onClick={() => setSelected(format)}>
                          About this format <span aria-hidden="true">↗</span>
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <section className={styles.foundation}>
                <div>
                  <span className={styles.eyebrow}>
                    BUILT ONE MILESTONE AT A TIME
                  </span>
                  <h2>The foundation is taking shape.</h2>
                  <p>
                    Practice games against the bots are open for testing, with
                    your own decks from the card catalog. Sit down with other
                    players at a human table from Tables.
                  </p>
                </div>
                <a href="#settings">
                  View release status <span aria-hidden="true">→</span>
                </a>
              </section>
            </>
          ) : page === "Settings" ? (
            <Settings
              preferences={preferences}
              onPreference={updatePreference}
              saveMessage={saveMessage}
              bootstrap={bootstrap}
              heading={heading}
            />
          ) : (
            <>
              <span className={styles.eyebrow}>{details[page].milestone}</span>
              <h1 ref={heading} tabIndex={-1}>
                {details[page].title}
              </h1>
              <p className={styles.lead}>{details[page].description}</p>
              <section className={styles.empty}>
                <span aria-hidden="true">{glyphs[pages.indexOf(page)]}</span>
                <h2>{page} is on the horizon.</h2>
                <p>{details[page].next}</p>
                <span className={styles.tag}>
                  NOT AVAILABLE IN v{__APP_VERSION__}
                </span>
                <a className={styles.primary} href="#play">
                  Return to the table <span aria-hidden="true">→</span>
                </a>
              </section>
            </>
          )}
          <footer className={styles.footer}>
            <span>COMMANDER DUELS</span>
            <span>
              Testing preview <span aria-hidden="true">·</span> v
              {__APP_VERSION__}
            </span>
            <p className={styles.legal}>
              Commander Duels is unofficial Fan Content permitted under the Fan
              Content Policy. Not approved/endorsed by Wizards. Portions of the
              materials used are property of Wizards of the Coast. ©Wizards of
              the Coast LLC. Card images from Scryfall.
            </p>
          </footer>
        </main>
      </div>
      <dialog
        ref={dialog}
        className={styles.dialog}
        onClose={() => setSelected(undefined)}
        aria-labelledby="format-dialog-title"
      >
        <button
          className={styles.close}
          aria-label="Close format details"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
        <span className={styles.eyebrow}>
          {plannedFormat(selected) ? "PLANNED FORMAT" : "OPEN FOR PRACTICE"}
        </span>
        <h2 id="format-dialog-title">{selected?.name}</h2>
        <p>{selected?.description}</p>
        <p>
          {selected?.seats.join(", ")} seats supported
          {plannedFormat(selected) ? " in the planned format" : ""}. Default
          table: {selected?.default_seats} players.
        </p>
        <p>
          {plannedFormat(selected)
            ? `${selected?.name} opens after its engine work is proven.`
            : "Practice games against the bots are open for testing: start one from the practice table."}
        </p>
        <button
          className={styles.primary}
          onClick={() => dialog.current?.close()}
        >
          Back to the table
        </button>
      </dialog>
    </div>
  );
}
