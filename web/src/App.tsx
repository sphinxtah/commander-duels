import { useEffect, useRef, useState } from "react";
import { loadFoundation, type Bootstrap, type Format } from "./api";
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
] as const;
type Page = (typeof pages)[number];
const glyphs = ["◇", "▱", "✧", "▤", "▦", "◈", "○", "⚙"];
const details: Record<
  Exclude<Page, "Play" | "Settings">,
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
  Decks: {
    title: "A strategy to call your own.",
    description: "Build, refine, and save Commander and Legacy decks.",
    next: "Deck creation opens with catalog identities and server-side validation.",
    milestone: "M1 · Catalog & decks",
  },
  Cards: {
    title: "Discover your next centerpiece.",
    description: "Browse cards, explore printings, and check playability.",
    next: "The first Scryfall import is pending. No cards are certified for play yet.",
    milestone: "M1 · Card catalog",
  },
  Collection: {
    title: "Room for every possibility.",
    description:
      "The default collection will include every legal, certified card.",
    next: "Collection browsing follows the catalog. Optional earned progression arrives later.",
    milestone: "M1 / M4 · Collection policies",
  },
  Profile: {
    title: "Your place at the table.",
    description:
      "Your identity, match history, and achievements will come together here.",
    next: "Google sign-in and private application sessions are planned for M1.",
    milestone: "M1 · Accounts",
  },
};
function currentPage(): Page {
  const path = window.location.hash.slice(1).toLowerCase();
  return pages.find((page) => page.toLowerCase() === path) ?? "Play";
}

export function App() {
  const [page, setPage] = useState<Page>(currentPage);
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
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);

  useEffect(() => {
    const change = () => {
      navigated.current = true;
      setPage(currentPage());
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (navigated.current) heading.current?.focus();
  }, [page]);
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

  function updatePreference(key: keyof Preferences, value: boolean) {
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    setSaveMessage(
      savePreferences(next)
        ? "Preferences saved on this device."
        : "Applied for this visit. Browser storage is unavailable.",
    );
  }

  return (
    <div className={styles.app}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <aside className={styles.sidebar}>
        <a
          href="#play"
          className={styles.brand}
          aria-label="Commander Duels home"
        >
          <img src="/mark.svg" alt="" />
          <span>
            COMMANDER<strong>DUELS</strong>
          </span>
        </a>
        <div className={styles.navLabel}>YOUR TABLE</div>
        <nav aria-label="Main navigation">
          {pages.map((item, index) => (
            <a
              key={item}
              href={`#${item.toLowerCase()}`}
              aria-current={page === item ? "page" : undefined}
              className={page === item ? styles.active : ""}
            >
              <span aria-hidden="true">{glyphs[index]}</span>
              {item}
              {item === "Play" && (
                <span className={styles.navArrow} aria-hidden="true">
                  ↗
                </span>
              )}
            </a>
          ))}
        </nav>
        <div className={styles.sidebarBottom}>
          <span className={styles.monogram}>CD</span>
          <div>
            Welcome, traveler<small>Accounts coming in M1</small>
          </div>
        </div>
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
            COMMANDER DUELS <span>/</span> {page.toUpperCase()}
          </div>
          {page === "Play" ? (
            <>
              <section className={styles.hero} aria-labelledby="page-title">
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
                  <a className={styles.primary} href="#formats">
                    Explore the formats <span aria-hidden="true">↓</span>
                  </a>
                  <span className={styles.heroNote}>
                    Framework preview · Matches are not available yet
                  </span>
                </div>
                <div className={styles.heroArt} aria-hidden="true">
                  <div className={styles.orbit} />
                  <div className={styles.cardBackLeft} />
                  <div className={styles.cardBackRight} />
                  <div className={styles.cardBack}>
                    <div className={styles.sigil}>
                      ◇<span>✧</span>
                    </div>
                    <span>
                      COMMANDER
                      <br />
                      <b>DUELS</b>
                    </span>
                  </div>
                  <div className={styles.artCaption}>
                    THE NEXT CHAPTER IS YOURS
                  </div>
                </div>
              </section>
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
                  <span className={styles.tag}>IN DEVELOPMENT</span>
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
                    <button onClick={() => setAttempt((value) => value + 1)}>
                      Retry connection
                    </button>
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
                    This first release establishes the application. Decks,
                    cards, and gameplay will arrive as their systems are ready.
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
                  <span className={styles.tag}>v{__APP_VERSION__} · FRAMEWORK</span>
                </h2>
                <p>
                  The application shell is available. These features are planned
                  and remain unavailable.
                </p>
                {bootstrap ? (
                  <ul>
                    {bootstrap.capabilities.map((item) => (
                      <li key={item.id}>
                        <div>
                          <strong>{item.name}</strong>
                          <p>{item.reason}</p>
                        </div>
                        <span>{item.milestone}</span>
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
                <span className={styles.tag}>NOT AVAILABLE IN v{__APP_VERSION__}</span>
                <a className={styles.primary} href="#play">
                  Return to the table <span aria-hidden="true">→</span>
                </a>
              </section>
            </>
          )}
          <footer className={styles.footer}>
            <span>COMMANDER DUELS</span>
            <span>
              Framework preview <span aria-hidden="true">·</span> v{__APP_VERSION__}
            </span>
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
        <span className={styles.eyebrow}>PLANNED FORMAT</span>
        <h2 id="format-dialog-title">{selected?.name}</h2>
        <p>{selected?.description}</p>
        <p>
          {selected?.seats.join(", ")} seats supported in the planned format.
          Default table: {selected?.default_seats} players.
        </p>
        <p>
          Matches will open after rules integration, deck validation, and
          player-view testing are complete.
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
