import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Account, SignIn, Waiting } from "./Account";
import { Admin, SysopSignIn } from "./Admin";
import { useAdminCounts, useCountTitle, countsTotal } from "./admin/counts";
import { exitTableFullscreen } from "./app/fullscreen";
import { InstallBanner } from "./app/InstallBanner";
import { Landing } from "./app/Landing";
import { guardLiveGame } from "./app/liveGame";
import { useOnline } from "./app/online";
import { SetupWizard } from "./app/SetupWizard";
import { leaveTable } from "./app/serviceWorker";
import { Settings } from "./app/Settings";
import { SiteLinks } from "./app/SiteLinks";
import { ChatContext, MESSAGES_ROUTE, useChat } from "./chat/chat";
import { ChatDock } from "./chat/ChatDock";
import { MessagesPage } from "./chat/MessagesPage";
import { FriendsPage } from "./social/FriendsPage";
import { NotificationsPage } from "./social/Notifications";
import { PlayerPage } from "./social/PlayerPage";
import { useSocial } from "./social/presence";
import { PLAYER_ROUTE } from "./social/social";
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
} from "./api";
import { CardsPage } from "./catalog/CardsPage";
import { DeckEditor } from "./decks/DeckEditor";
import { DecksPage } from "./decks/DecksPage";
import { SharedDeck } from "./decks/SharedDeck";
import { ShopPage } from "./shop/ShopPage";
import { GameScreen } from "./game/GameScreen";
import { TablesPage } from "./tables/TablesPage";
import { HomeHub } from "./shell/HomeHub";
import { useHud } from "./shell/hud";
import { PageBand } from "./shell/PageBand";
import { pages, type Page } from "./shell/pages";
import { PlayPage } from "./shell/PlayPage";
import { PhoneBar, TopBar } from "./shell/TopBar";
import {
  readPreferences,
  savePreferences,
  type Preferences,
} from "./preferences";
import styles from "./App.module.css";

/** The account is asked for again on the tab's focus at most this often (v0.4.5). */
const RECHECK_MS = 30_000;
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
/** #messages/<id> opens a conversation with a friend (v0.4.4) on the Messages page. */
function currentMessages(): string | undefined {
  return MESSAGES_ROUTE.exec(window.location.hash)?.[1]?.toLowerCase();
}
/** #player/<id> opens a player's profile (v0.4.3), under Friends. */
function currentPlayer(): string | undefined {
  return PLAYER_ROUTE.exec(window.location.hash)?.[1]?.toLowerCase();
}
function currentPage(): Page {
  const path = window.location.hash.slice(1).toLowerCase().split("?")[0] ?? "";
  if (path === "sysop") return "SysOp";
  if (path === "notifications") return "Notifications";
  if (path.startsWith("player/")) return "Friends";
  if (path.startsWith("messages/")) return "Messages";
  if (path.startsWith("tables/")) return "Tables";
  if (path.startsWith("deck/") || path.startsWith("shared/")) return "Decks";
  // The Play page's own anchors: its practice table and its formats.
  if (path === "practice" || path === "formats") return "Play";
  // Any other address, Campaign, Learn and Collection's old ones included, is the main menu.
  return pages.find((page) => page.toLowerCase() === path) ?? "Home";
}

export function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [game, setGame] = useState(currentGame);
  const [deckRoute, setDeckRoute] = useState(currentDeck);
  const [tableRoute, setTableRoute] = useState(currentTable);
  const [playerRoute, setPlayerRoute] = useState(currentPlayer);
  const [messagesRoute, setMessagesRoute] = useState(currentMessages);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [formats, setFormats] = useState<Format[]>([]);
  const [connection, setConnection] = useState<
    "loading" | "connected" | "unavailable"
  >("loading");
  const [attempt, setAttempt] = useState(0);
  const online = useOnline();
  const [preferences, setPreferences] = useState(readPreferences);
  const [saveMessage, setSaveMessage] = useState("");
  // undefined while loading, null when signed out.
  const [me, setMe] = useState<Me | null>();
  // Only an active account sees the app; everyone else, the landing page (v0.3.0).
  const admitted = me?.status === "active";
  // What the sign-in page says about the sign-out that led to it; a sign-in clears it.
  const [notice, setNotice] = useState("");
  // Whether #sysop is SysOp's entrance here: undefined until the server answers.
  const [entrance, setEntrance] = useState<boolean>();
  const heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  // The setup wizard (v0.4.2) and where it opens. It opens by itself once each time the site opens
  // on an account still setting up, a new sign-in or a reload; the account it opened for is kept,
  // so the account's own changes inside it do not open it again. An account that finished setting
  // up and starts again (SysOp's reset, v0.4.5) gets it again, even in the same visit.
  const [setup, setSetup] = useState<"welcome" | "current" | null>(null);
  const setupOpened = useRef<string | null>(null);
  useEffect(() => {
    if (me?.status !== "active") {
      setupOpened.current = null;
      setSetup(null);
      return;
    }
    if (!onboarding(me)) {
      setupOpened.current = null;
      return;
    }
    if (setupOpened.current !== me.id) {
      setupOpened.current = me.id;
      setSetup("welcome");
    }
  }, [me]);
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
  // The app's check-in, on every screen of an active account, the table's too (v0.4.3): presence
  // for friends, and the bell's count. Unread notifications join the tab title's count.
  const social = useSocial(me);
  useCountTitle(waiting + social.unread);
  // Chat between friends (v0.4.4): its live connection, the unread count on Messages, the docked
  // windows and the messages that pop up beside the bell. A message from a friend is also a
  // notification, so the bell asks for its count at once.
  const chat = useChat(me, social.messagesUnread);
  const { checkIn } = social;
  useEffect(
    () =>
      chat.listen((event) => {
        if (
          event.type === "message" &&
          event.message.sender_id === event.player_id
        )
          checkIn();
      }),
    [chat.listen, checkIn],
  );

  useEffect(() => {
    const change = (event: HashChangeEvent) => {
      // A live game keeps its address unless an in-game link meant to leave (v0.3.0): the
      // browser's Back, or the installed app opening #home in this window, changes nothing.
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
      setPlayerRoute(currentPlayer());
      setMessagesRoute(currentMessages());
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
    // Leaving a game also lands on a page (usually the main menu, whose state never changed), so
    // focus follows the game route too; the game screen focuses its own heading. A new page opens
    // at its top, under the top bar (v0.4.5), however far down the last one was read.
    if (!navigated.current || atTable) return;
    // At once, not with the page's smooth scrolling meant for its own anchors.
    const root = document.documentElement;
    root.style.scrollBehavior = "auto";
    root.scrollTop = 0;
    root.style.scrollBehavior = "";
    heading.current?.focus({ preventScroll: true });
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
  const shown: Page = page === "SysOp" && !entrance ? "Home" : page;
  // The top bar's tokens and tier (v0.4.5), asked again on every change of page.
  const hud = useHud(me, atTable ? "table" : shown);
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
  // What changed on the account elsewhere (SysOp resetting it, v0.4.5) shows when the tab is used
  // again: its account is asked for once more on focus, at most every half a minute. A network
  // failure is no news; a signed-out answer signs the page out, as any account check does.
  useEffect(() => {
    if (!admitted) return;
    let last = Date.now();
    const check = () => {
      if (
        document.visibilityState === "hidden" ||
        Date.now() - last < RECHECK_MS
      )
        return;
      last = Date.now();
      const sent = generation.current;
      const ask = answerTimeout();
      loadMe(ask.signal, { token: false })
        .then((value) => {
          if (sent !== generation.current) return;
          setCsrfToken(value?.csrf_token);
          changeMe(value);
        })
        .catch(() => undefined)
        .finally(ask.done);
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [admitted, changeMe]);

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
    <ChatContext.Provider value={chat}>
      <div className={styles.app}>
        <a
          className={styles.skip}
          href="#main"
          onClick={(event) => {
            // The hash is the router: following #main would leave this page for the main menu.
            event.preventDefault();
            document.getElementById("main")?.focus();
          }}
        >
          Skip to content
        </a>
        <InstallBanner me={me} onGame={false} />
        <TopBar
          me={me}
          shown={shown}
          hud={hud}
          social={social}
          messagesUnread={chat.unread}
          counts={counts}
          connection={connection}
          online={online}
        />
        <main
          id="main"
          className={styles.main}
          data-page={shown.toLowerCase()}
          tabIndex={-1}
        >
          {shown !== "Home" && <PageBand page={shown} />}
          {/* Until the account has its handle and its two starter decks (v0.3.1), every page but
            Profile, which has its own, points to the setup wizard (v0.4.2). */}
          {onboarding(me) && page !== "Profile" && (
            <p className={styles.handleNotice}>
              {me.onboarding === "handle"
                ? "Your game is not set up yet: choose the name other players see, and claim two free starter decks."
                : "Two free starter decks are waiting for you to claim them."}{" "}
              <button
                type="button"
                className={styles.noticeButton}
                onClick={() => setSetup("current")}
              >
                Continue setup <span aria-hidden="true">→</span>
              </button>
            </p>
          )}
          {/* Each page comes in as Magic Duels' screens did; its own heading takes focus. */}
          <div key={shown} className={styles.stage}>
            {page === "Profile" ? (
              <Account
                me={me}
                onChange={accountChanged}
                onSetup={() => setSetup("current")}
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
              <ShopPage
                me={me}
                heading={heading}
                onSetup={() => setSetup("current")}
              />
            ) : page === "Friends" && playerRoute ? (
              <PlayerPage
                key={playerRoute}
                playerId={playerRoute}
                heading={heading}
              />
            ) : page === "Friends" ? (
              <FriendsPage heading={heading} />
            ) : page === "Messages" ? (
              <MessagesPage
                chat={chat}
                playerId={messagesRoute}
                heading={heading}
              />
            ) : page === "Notifications" ? (
              <NotificationsPage social={social} heading={heading} />
            ) : page === "Tables" ? (
              <TablesPage
                key={tableRoute ?? "lobby"}
                me={me}
                heading={heading}
                code={tableRoute}
              />
            ) : page === "SysOp" && entrance ? (
              <SysopSignIn onSignedIn={accountChanged} heading={heading} />
            ) : page === "Play" ? (
              <PlayPage
                me={me}
                formats={formats}
                connection={connection}
                onRetry={retry}
                heading={heading}
              />
            ) : page === "Settings" ? (
              <Settings
                preferences={preferences}
                onPreference={updatePreference}
                saveMessage={saveMessage}
                bootstrap={bootstrap}
                heading={heading}
              />
            ) : (
              <HomeHub me={me} hud={hud} heading={heading} />
            )}
          </div>
          <footer className={styles.footer}>
            <span>COMMANDER DUELS</span>
            <span>v{__APP_VERSION__}</span>
            <p className={styles.legal}>
              Commander Duels is unofficial Fan Content permitted under the Fan
              Content Policy. Not approved/endorsed by Wizards. Portions of the
              materials used are property of Wizards of the Coast. ©Wizards of
              the Coast LLC. Card images from Scryfall.
            </p>
            {/* The public pages (v0.4.1), as on the landing page. */}
            <SiteLinks className={styles.footerLinks} />
          </footer>
        </main>
        <PhoneBar shown={shown} />
        <SetupWizard
          me={me}
          onChange={accountChanged}
          open={setup}
          onClose={() => setSetup(null)}
        />
        <ChatDock chat={chat} />
      </div>
    </ChatContext.Provider>
  );
}
