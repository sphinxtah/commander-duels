import { useCallback, useEffect, useRef, useState } from "react";
import { Account, avatars } from "./Account";
import { Admin, SysopSignIn, canAdminister } from "./Admin";
import {
  client,
  loadFoundation,
  loadMe,
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
import { GameScreen } from "./game/GameScreen";
import { PracticeTable } from "./game/PracticeTable";
import {
  readPreferences,
  savePreferences,
  type Preferences,
} from "./preferences";
import styles from "./App.module.css";

const pages = [
  "Play",
  "Campaign",
  "Learn",
  "Decks",
  "Cards",
  "Collection",
  "Profile",
  "Settings",
  "Admin",
] as const;
// SysOp's entrance has no navigation entry; it opens only from the SysOp networks.
type Page = (typeof pages)[number] | "SysOp";
const glyphs = ["◇", "▱", "✧", "▤", "▦", "◈", "○", "⚙", "⚖"];
const details: Record<
  Exclude<
    Page,
    "Play" | "Settings" | "Profile" | "Admin" | "SysOp" | "Decks" | "Cards"
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
/** #game/<id> opens a game's table, full screen. */
function currentGame(): string | undefined {
  return GAME_ROUTE.exec(window.location.hash)?.[1]?.toLowerCase();
}
/** #deck/<id> opens a deck in the editor; #shared/<code>, a deck shared by link. */
function currentDeck(): { deck?: string; shared?: string } {
  const hash = window.location.hash;
  return {
    deck: DECK_ROUTE.exec(hash)?.[1]?.toLowerCase(),
    shared: SHARED_ROUTE.exec(hash)?.[1],
  };
}
function currentPage(): Page {
  const path = window.location.hash.slice(1).toLowerCase().split("?")[0] ?? "";
  if (path === "sysop") return "SysOp";
  if (path.startsWith("deck/") || path.startsWith("shared/")) return "Decks";
  return pages.find((page) => page.toLowerCase() === path) ?? "Play";
}

export function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [game, setGame] = useState(currentGame);
  const [deckRoute, setDeckRoute] = useState(currentDeck);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [formats, setFormats] = useState<Format[]>([]);
  const [connection, setConnection] = useState<
    "loading" | "connected" | "unavailable"
  >("loading");
  const [attempt, setAttempt] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [preferences, setPreferences] = useState(readPreferences);
  const [saveMessage, setSaveMessage] = useState("");
  const [selected, setSelected] = useState<Format>();
  // undefined while loading, null when signed out.
  const [me, setMe] = useState<Me | null>();
  const [entrance, setEntrance] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);

  useEffect(() => {
    const change = () => {
      navigated.current = true;
      setPage(currentPage());
      setGame(currentGame());
      setDeckRoute(currentDeck());
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    // Leaving a game also lands on a page (usually Play, whose state never changed), so focus
    // follows the game route too; the game screen focuses its own heading.
    if (navigated.current && !game) heading.current?.focus();
  }, [page, game]);
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      setAttempt((value) => value + 1);
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 7000);
    let active = true;
    setConnection("loading");
    loadFoundation(controller.signal)
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
      .finally(() => window.clearTimeout(timeout));
    loadMe()
      .then((value) => {
        if (active) changeMe(value);
      })
      .catch(() => {
        // An unreachable service says nothing about the session: a network blip must not sign
        // the page out and throw away open forms, so a known account stays. A first load
        // that fails still settles on signed out.
        if (active)
          setMe((current) => (current === undefined ? null : current));
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
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
    let active = true;
    if (page === "SysOp")
      void sysopEntrance().then((open) => active && setEntrance(open));
    return () => {
      active = false;
    };
  }, [page]);
  // Off the SysOp networks, #sysop is indistinguishable from any unknown address.
  const shown: Page = page === "SysOp" && !entrance ? "Play" : page;
  const changeMe = useCallback((value: Me | null) => {
    setMe(value);
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
    if (me?.status === "active")
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
          if (data) {
            setMe(data);
            setSaveMessage(
              "Preferences saved to your account and this device.",
            );
          }
        });
  }

  // The table waits for the account, whose CSRF token the game's WebSocket needs.
  if (game)
    return me === undefined ? (
      <p className={styles.tableLoading} role="status">
        Opening the table…
      </p>
    ) : (
      <GameScreen key={game} gameId={game} me={me} />
    );

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
              >
                <span aria-hidden="true">{glyphs[pages.indexOf(item)]}</span>
                {item}
                {item === "Play" && (
                  <span className={styles.navArrow} aria-hidden="true">
                    ↗
                  </span>
                )}
              </a>
            ))}
        </nav>
        <a className={styles.sidebarBottom} href="#profile">
          <span className={styles.monogram} aria-hidden="true">
            {me ? avatars[me.avatar] : "CD"}
          </span>
          {me ? (
            <div>
              {me.handle ?? me.display_name}
              <small>
                {me.kind === "sysop"
                  ? "Local administrator"
                  : me.status === "pending"
                    ? "Waiting for approval"
                    : me.status === "denied"
                      ? "Not approved"
                      : "Signed in"}
              </small>
            </div>
          ) : (
            <div>
              Welcome, traveler<small>{me === null ? "Sign in" : " "}</small>
            </div>
          )}
        </a>
      </aside>
      <div className={styles.workspace}>
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
            <span className={styles.version}>v{__APP_VERSION__}</span>
          </div>
        </header>
        <main id="main" className={styles.main} tabIndex={-1}>
          <div className={styles.breadcrumb}>
            COMMANDER DUELS <span>/</span> {shown.toUpperCase()}
          </div>
          {page === "Profile" ? (
            <Account
              me={me}
              auth={bootstrap?.auth}
              unavailable={connection === "unavailable"}
              onRetry={retry}
              onChange={changeMe}
              heading={heading}
            />
          ) : page === "Admin" ? (
            <Admin me={me} heading={heading} />
          ) : page === "Decks" && deckRoute.deck && me ? (
            <DeckEditor
              key={deckRoute.deck}
              deckId={deckRoute.deck}
              heading={heading}
            />
          ) : page === "Decks" && deckRoute.shared && me ? (
            <SharedDeck
              key={deckRoute.shared}
              code={deckRoute.shared}
              heading={heading}
            />
          ) : page === "Decks" ? (
            <DecksPage me={me} heading={heading} />
          ) : page === "Cards" ? (
            <CardsPage me={me} heading={heading} />
          ) : page === "SysOp" && entrance ? (
            <SysopSignIn onSignedIn={changeMe} heading={heading} />
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
                    your own decks from the card catalog. Human opponents arrive
                    as their systems are ready.
                  </p>
                </div>
                <a href="#settings">
                  View release status <span aria-hidden="true">→</span>
                </a>
              </section>
            </>
          ) : page === "Settings" ? (
            <>
              <h1 ref={heading} tabIndex={-1}>
                Make yourself at home.
              </h1>
              <p className={styles.lead}>
                A few preferences for your side of the table.
              </p>
              <section
                className={styles.settingsPanel}
                aria-labelledby="preferences-title"
              >
                <h2 id="preferences-title">Display & accessibility</h2>
                <label>
                  <span>
                    <strong>Larger text</strong>
                    <small>Increase the interface text size.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={preferences.largeText}
                    onChange={(event) =>
                      updatePreference("largeText", event.target.checked)
                    }
                  />
                </label>
                <label>
                  <span>
                    <strong>Reduce motion</strong>
                    <small>
                      Keep transitions and movement to a minimum. System
                      preferences are also respected.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={preferences.reducedMotion}
                    onChange={(event) =>
                      updatePreference("reducedMotion", event.target.checked)
                    }
                  />
                </label>
                <p role="status">
                  {saveMessage || "Preferences are stored on this device."}
                </p>
              </section>
              <section className={styles.release}>
                <h2>
                  Release status{" "}
                  <span className={styles.tag}>
                    v{__APP_VERSION__} · TESTING PREVIEW
                  </span>
                </h2>
                <p>
                  Practice games against the bots are open for testing. Here is
                  where each part of Commander Duels stands.
                </p>
                {bootstrap ? (
                  <ul>
                    {bootstrap.capabilities.map((item) => (
                      <li key={item.id}>
                        <div>
                          <strong>{item.name}</strong>
                          <p>{item.reason}</p>
                        </div>
                        <span data-available={item.available}>
                          {item.available ? "Available" : item.milestone}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    Connect to the application service to load the feature
                    roadmap.
                  </p>
                )}
              </section>
            </>
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
