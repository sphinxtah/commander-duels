import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  answerTimeout,
  client,
  describe,
  loadMe,
  onboarding,
  setCsrfToken,
  sysopChangePassword,
  type ApiError,
  type Avatar,
  type Bootstrap,
  type Me,
  type SessionSummary,
} from "./api";
import { SetWins } from "./admin/SetWins";
import { GiveTokens } from "./tokens/GiveTokens";
import { TokensPanel } from "./tokens/TokensPanel";
import { Portrait } from "./alliance/Portrait";
import {
  AlliancePanel,
  ProgressPanel,
  useAllianceChange,
} from "./alliance/StandingPanels";
import { useStanding } from "./alliance/useStanding";
import { TierBadge } from "./alliance/TierBadge";
import { loadGoogle } from "./google";
import styles from "./Account.module.css";
import { PrivacySettings } from "./social/PrivacySettings";
import shell from "./App.module.css";

export const avatars: Record<Avatar, string> = {
  sigil: "◇",
  sun: "☼",
  moon: "☾",
  flame: "✺",
  wave: "≈",
  leaf: "❦",
  crown: "♛",
  tower: "♜",
};
const roleNames: Record<string, string> = {
  player: "Player",
  moderator: "Moderator",
  content_editor: "Content editor",
  administrator: "Administrator",
  sysop: "SysOp",
};
// The server's sign-in challenge and its cookie last 10 minutes. The page renews an idle one a
// minute early, and checks its age often by the wall clock, because timers stop while a
// computer or phone sleeps but the challenge keeps ageing.
const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;
const CHALLENGE_RENEW_MS = 9 * 60 * 1000;
const CHALLENGE_CHECK_MS = 15 * 1000;
// Google says nothing when its window is closed without signing in. A press this old, once the
// page has focus again, counts as given up, so it no longer holds off the early renewal.
const PRESS_GIVEN_UP_MS = 2 * 60 * 1000;
// A pending account asks the server again this often while its page is shown.
const APPROVAL_CHECK_MS = 60 * 1000;
// Where anyone, signed in or not, can write about the site (the public pages say the same).
const CONTACT = "info@thesphinx.co";

function when(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function GoogleSignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<
    "loading" | "ready" | "verifying" | "unavailable"
  >("loading");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // When the shown button's challenge was issued (0 while none is), and whether a sign-in
  // with it is under way. A new challenge replaces the cookie that Google's answer is checked
  // against, so it must not arrive while Google's window is open or the server is checking.
  const issued = useRef(0);
  const flow = useRef<"idle" | "pressed" | "verifying">("idle");
  const pressed = useRef(0);

  // The old button goes at once, so nobody starts a sign-in with a challenge being replaced.
  const renew = useCallback(() => {
    issued.current = 0;
    flow.current = "idle";
    container.current?.replaceChildren();
    setState("loading");
    setAttempt((value) => value + 1);
  }, []);
  const renewIfOld = useCallback(() => {
    // A hidden tab waits: coming back checks at once, before anyone can press the button.
    if (
      !issued.current ||
      flow.current === "verifying" ||
      document.visibilityState === "hidden"
    )
      return;
    const now = Date.now();
    const age = now - issued.current;
    // A recent press, or Google's pop-up still holding focus, means a sign-in may be under way.
    const signingIn =
      flow.current === "pressed" &&
      (now - pressed.current < PRESS_GIVEN_UP_MS || !document.hasFocus());
    // Past its lifetime the challenge is dead anyway, even for a sign-in begun with it.
    if (
      age >= CHALLENGE_LIFETIME_MS ||
      (age >= CHALLENGE_RENEW_MS && !signingIn)
    )
      renew();
  }, [renew]);

  useEffect(() => {
    const check = window.setInterval(renewIfOld, CHALLENGE_CHECK_MS);
    // Coming back to the page, or waking up, checks at once.
    window.addEventListener("focus", renewIfOld);
    window.addEventListener("pageshow", renewIfOld);
    document.addEventListener("visibilitychange", renewIfOld);
    return () => {
      window.clearInterval(check);
      window.removeEventListener("focus", renewIfOld);
      window.removeEventListener("pageshow", renewIfOld);
      document.removeEventListener("visibilitychange", renewIfOld);
    };
  }, [renewIfOld]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const google = await loadGoogle();
        // Each attempt gets a fresh challenge; its nonce is signed into Google's token.
        const { data, error: refused } = await client.POST(
          "/api/v1/auth/google/start",
        );
        if (!data) throw refused;
        if (!active || !container.current) return;
        google.initialize({
          client_id: data.client_id,
          nonce: data.nonce,
          ux_mode: "popup",
          use_fedcm_for_button: true,
          auto_select: false,
          itp_support: true,
          context: "signin",
          callback: async ({ credential }) => {
            flow.current = "verifying";
            setState("verifying");
            setError("");
            try {
              const result = await client.POST("/api/v1/auth/google", {
                body: { credential },
              });
              if (result.data) {
                setCsrfToken(result.data.csrf_token);
                // The landing page never changed the address, so the screen it names opens
                // now (T01).
                onSignedIn(result.data);
                return;
              }
              setError(describe(result.error));
            } catch {
              // The network failed: say so, rather than "Signing you in…" for good.
              setError(describe(undefined));
            }
            // The challenge is spent or doubtful either way: ask Google again with a new one.
            renew();
          },
        });
        container.current.replaceChildren();
        google.renderButton(container.current, {
          theme: "filled_black",
          size: "large",
          text: "signin_with",
          shape: "pill",
          logo_alignment: "left",
          width: 280,
          click_listener: () => {
            pressed.current = Date.now();
            flow.current = "pressed";
          },
        });
        issued.current = Date.now();
        flow.current = "idle";
        setState("ready");
      } catch (caught) {
        if (active) {
          setState("unavailable");
          setError(describe(caught));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt, onSignedIn, renew]);

  return (
    <div className={styles.google}>
      {/* Reaching for the button checks its challenge first. */}
      <div
        ref={container}
        className={styles.googleButton}
        onPointerEnter={renewIfOld}
        onFocus={renewIfOld}
      />
      {state === "loading" && (
        <p role="status" className={styles.visuallyHidden}>
          Preparing Google sign-in…
        </p>
      )}
      {state === "verifying" && (
        <p role="status" className={styles.fine}>
          Signing you in…
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {state === "unavailable" && (
        <button
          className={styles.secondary}
          onClick={() => {
            setError("");
            renew();
          }}
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The landing page's sign-in (v0.3.0): the Google button under the mark, with no words above it.
 * Anything the page must say (a refusal, an outage, what a sign-out left to say) comes below the
 * button, small; the heading and the "Preparing" states are for screen readers only.
 */
export function SignIn({
  auth,
  unavailable,
  onRetry,
  notice,
  onSignedIn,
  heading,
}: {
  auth: Bootstrap["auth"] | undefined;
  /** The bootstrap failed to load, so sign-in's settings are unknown. */
  unavailable: boolean;
  onRetry: () => void;
  /** What the sign-out that led here said, if anything; a sign-in clears it. */
  notice: string;
  onSignedIn: (me: Me) => void;
  /** Focused when the page arrives here from another screen, as after a sign-out. */
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className={styles.signIn}>
      <h1 ref={heading} tabIndex={-1} className={styles.visuallyHidden}>
        Sign in
      </h1>
      {/* Sign-in's settings come with the bootstrap: until it loads, nothing is known. */}
      {auth === undefined ? (
        unavailable ? (
          <>
            <p className={styles.fine} role="status">
              The application service did not answer, so sign-in cannot start
              yet.
            </p>
            <button className={styles.secondary} onClick={onRetry}>
              Try again
            </button>
          </>
        ) : (
          <p className={styles.visuallyHidden} role="status">
            Preparing sign-in…
          </p>
        )
      ) : auth.google_client_id ? (
        <>
          <GoogleSignIn onSignedIn={onSignedIn} />
          {/* The terms say signing in accepts them (v0.4.1), so the button says so too (v0.4.2). */}
          <p className={styles.consent}>
            By signing in you accept the <a href="/terms">terms of use</a> and
            the <a href="/privacy">privacy policy</a>.
          </p>
        </>
      ) : (
        <p className={styles.fine}>
          Google sign-in is not set up on this server yet. The operator needs to
          add a Google OAuth client ID.
        </p>
      )}
      {notice && (
        <p className={styles.fine} role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

/**
 * The handle: the name other players know the account by, at the table, in the lobby and, later,
 * in a game's chat. Chosen first in the setup wizard (v0.4.2), and changed later on Profile.
 */
export function HandleForm({
  me,
  onChange,
  heading,
}: {
  me: Me;
  onChange: (me: Me) => void;
  /** Focused when the wizard arrives at this step. */
  heading?: RefObject<HTMLHeadingElement | null>;
}) {
  const [handle, setHandle] = useState(me.handle ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const { data, error } = await client.PATCH("/api/v1/me", {
        body: { handle },
      });
      if (data) {
        onChange(data);
        setMessage("");
      } else setMessage(describe(error));
    } catch {
      setMessage(describe(undefined));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      aria-labelledby="handle-title"
    >
      <h2 id="handle-title" ref={heading} tabIndex={-1}>
        Choose your name
      </h2>
      <p className={styles.fine}>
        Your handle is the name other players see: at the table, in the lobby,
        and in the chat during games when it comes. 3–20 letters, digits,
        hyphens or underscores.
      </p>
      <label className={styles.field}>
        <span>Handle</span>
        <input
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          minLength={3}
          maxLength={20}
          required
          autoComplete="username"
        />
      </label>
      {message && (
        <p role="alert" className={styles.error}>
          {message}
        </p>
      )}
      <button
        className={shell.primary}
        type="submit"
        aria-disabled={busy || undefined}
      >
        Save and continue
      </button>
    </form>
  );
}

function ProfileForm({ me, onChange }: { me: Me; onChange: (me: Me) => void }) {
  const [displayName, setDisplayName] = useState(me.display_name);
  const [handle, setHandle] = useState(me.handle ?? "");
  const [avatar, setAvatar] = useState<Avatar>(me.avatar);
  const [message, setMessage] = useState("");
  const sysop = me.kind === "sysop";
  async function submit(event: FormEvent) {
    event.preventDefault();
    const { data, error } = await client.PATCH("/api/v1/me", {
      body: sysop
        ? { display_name: displayName, avatar }
        : { display_name: displayName, handle, avatar },
    });
    if (data) {
      onChange(data);
      setMessage("Profile saved.");
    } else setMessage(describe(error));
  }
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      aria-labelledby="profile-title"
    >
      <h2 id="profile-title">Profile</h2>
      <label className={styles.field}>
        <span>Display name</span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={64}
          required
        />
      </label>
      {!sysop && (
        <label className={styles.field}>
          <span>Handle</span>
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            minLength={3}
            maxLength={20}
            required
          />
        </label>
      )}
      <fieldset className={styles.avatars}>
        <legend>Avatar</legend>
        {(Object.keys(avatars) as Avatar[]).map((key) => (
          <label key={key} className={avatar === key ? styles.chosen : ""}>
            <input
              type="radio"
              name="avatar"
              value={key}
              checked={avatar === key}
              onChange={() => setAvatar(key)}
            />
            <span aria-hidden="true">{avatars[key]}</span>
            <small>{key}</small>
          </label>
        ))}
      </fieldset>
      {me.alliance && (
        <p className={styles.fine}>
          While you are in an alliance, its Planeswalker's portrait is your
          picture. The avatar shows again if you leave it.
        </p>
      )}
      <p role="status" className={styles.fine}>
        {message}
      </p>
      <button className={shell.primary} type="submit">
        Save profile
      </button>
    </form>
  );
}

/**
 * Sign out and Sign out everywhere for the account on show, on Profile and on the page an account
 * waits on for approval. The page shows the signed-out screen only once the server confirms: a
 * refused sign-out leaves the session alive, and saying otherwise would be false comfort.
 */
function useSignOut(
  me: Me,
  onChange: (me: Me) => void,
  onSignedOut: (notice: string) => void,
) {
  const [message, setMessage] = useState("");
  // One sign-out at a time. A second click's request would find this session already ended,
  // and its 401 would wrongly say the other sessions could not be ended.
  const [busy, setBusy] = useState(false);
  const signingOut = useRef(false);
  // Set for good once this page has signed out. The page goes a moment later, when the sign-in
  // is drawn; an answer arriving before then (an approval check under way) must not bring the
  // account back.
  const ended = useRef(false);
  // The notice is what the sign-in page then says below its button.
  const signedOut = useCallback(
    (notice = "You signed out.") => {
      ended.current = true;
      setCsrfToken(undefined);
      onSignedOut(notice);
    },
    [onSignedOut],
  );
  async function signOut(everywhere: boolean) {
    if (signingOut.current) return;
    signingOut.current = true;
    setBusy(true);
    setMessage("");
    const send = () =>
      client.POST(
        everywhere ? "/api/v1/auth/logout-all" : "/api/v1/auth/logout",
      );
    // An ended session ends only this browser's: the account's others are out of reach.
    const gone = everywhere
      ? "This browser was already signed out, so your other sessions could not be ended from here. Sign in again and choose Sign out everywhere."
      : undefined;
    try {
      let { response, error } = await send();
      if (
        response.status === 403 &&
        (error as ApiError | undefined)?.code === "csrf_failed"
      ) {
        // Another tab signed this browser in since this page loaded, so this page's token is
        // stale. Sign out only the account shown here; if the browser now holds another one,
        // show that one instead.
        const current = await loadMe();
        if (current === null) return signedOut(gone);
        if (current.id !== me.id) {
          onChange(current);
          const other = current.handle ?? current.display_name;
          const shown = me.handle ?? me.display_name;
          return setMessage(
            everywhere
              ? `Another tab signed this browser in as ${other}, so ${shown}'s sessions were not ended. To end them, sign in as ${shown} and choose Sign out everywhere.`
              : `Another tab signed this browser in as ${other}. Sign out again to end that session.`,
          );
        }
        ({ response, error } = await send());
      }
      if (response.ok) signedOut();
      // 401: the session had already ended, so this browser is signed out either way.
      else if (response.status === 401) signedOut(gone);
      else setMessage(describe(error));
    } catch {
      setMessage(describe(undefined));
    } finally {
      signingOut.current = false;
      setBusy(false);
    }
  }
  return { message, setMessage, busy, signingOut, ended, signedOut, signOut };
}

function Sessions({
  me,
  onChange,
  onSignedOut,
}: {
  me: Me;
  onChange: (me: Me) => void;
  onSignedOut: (notice: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const { message, setMessage, busy, signedOut, signOut } = useSignOut(
    me,
    onChange,
    onSignedOut,
  );
  async function load() {
    try {
      const { data } = await client.GET("/api/v1/me/sessions");
      setSessions(data);
    } catch {
      // A dropped network: the list stays as it was, and the next look asks again.
    }
  }
  useEffect(() => {
    void load();
  }, [me.session.id]);
  async function end(session: SessionSummary) {
    try {
      const { error } = await client.DELETE(
        "/api/v1/me/sessions/{session_id}",
        { params: { path: { session_id: session.id } } },
      );
      if (error) setMessage(describe(error));
      else if (session.current) signedOut();
      else await load();
    } catch {
      setMessage(describe(undefined));
    }
  }
  return (
    <section className={styles.panel} aria-labelledby="sessions-title">
      <h2 id="sessions-title">Where you're signed in</h2>
      <ul className={styles.sessions}>
        {sessions?.map((session) => (
          <li key={session.id}>
            <div>
              <strong>
                {session.current ? "This browser" : "Another browser"}
              </strong>
              <small>
                {session.user_agent ?? "Unknown browser"}
                {session.source_address ? ` · ${session.source_address}` : ""}
              </small>
              <small>
                Signed in {when(session.created_at)} · last active{" "}
                {when(session.last_seen_at)} · ends by{" "}
                {when(session.absolute_expires_at)}
              </small>
            </div>
            {/* Named for its session: beside this browser's own "Sign out", a second button
                of the same name would leave a screen reader guessing which one ends what. */}
            {!session.current && (
              <button
                className={styles.secondary}
                aria-label={`End the session in ${session.user_agent ?? "an unknown browser"}, signed in ${when(session.created_at)}`}
                onClick={() => void end(session)}
              >
                End the session
              </button>
            )}
          </li>
        ))}
      </ul>
      {message && (
        <p role="alert" className={styles.error}>
          {message}
        </p>
      )}
      {/* aria-disabled, not disabled: a disabled button loses keyboard focus, so after a
          refused sign-out a keyboard user would start again from the top of the page. */}
      <div className={styles.actions}>
        <button
          className={shell.primary}
          aria-disabled={busy}
          onClick={() => void signOut(false)}
        >
          Sign out
        </button>
        <button
          className={styles.secondary}
          aria-disabled={busy}
          onClick={() => void signOut(true)}
        >
          Sign out everywhere
        </button>
      </div>
    </section>
  );
}

function SysopPassword({ onChange }: { onChange: (me: Me) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next !== again) return setMessage("The new passwords do not match.");
    const { me, error } = await sysopChangePassword(current, next);
    if (!me) return setMessage(error ?? "");
    setCurrent("");
    setNext("");
    setAgain("");
    setMessage("Password changed. Every other SysOp session has ended.");
    onChange(me);
  }
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      aria-labelledby="password-title"
    >
      <h2 id="password-title">SysOp password</h2>
      <label className={styles.field}>
        <span>Current password</span>
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <label className={styles.field}>
        <span>New password (12 or more characters)</span>
        <input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      <label className={styles.field}>
        <span>New password again</span>
        <input
          type="password"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      <p role="status" className={styles.fine}>
        {message}
      </p>
      <button className={shell.primary} type="submit">
        Change password
      </button>
    </form>
  );
}

/**
 * All an account sees until it is approved (v0.3.0), under the landing page's mark: its state, its
 * email address, where to write and Sign out. A pending account asks the server again every minute
 * while shown, when the window regains focus or is shown again, and on Check again, so an approval
 * opens the app without a reload; it chooses its handle once approved. Any other account can only
 * sign out.
 */
export function Waiting({
  me,
  onChange,
  onSignedOut,
  heading,
}: {
  me: Me;
  onChange: (me: Me) => void;
  onSignedOut: (notice: string) => void;
  /** Focused when the page arrives here, as after a sign-in that must wait. */
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { message, busy, signingOut, ended, signedOut, signOut } = useSignOut(
    me,
    onChange,
    onSignedOut,
  );
  const pending = me.status === "pending";
  const [note, setNote] = useState("");
  const [checking, setChecking] = useState(false);
  // Focus and visibility often change together: one question at a time.
  const asking = useRef(false);
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const check = useCallback(
    async (asked: boolean) => {
      if (asking.current || signingOut.current || ended.current) return;
      asking.current = true;
      setChecking(true);
      if (asked) setNote("");
      // A check the service holds on to must not hold off every later one, Check again's too.
      const timeout = answerTimeout();
      try {
        const current = await loadMe(timeout.signal);
        // A sign-out begun or done meanwhile, or a page that has moved on, has the last word.
        if (!shown.current || signingOut.current || ended.current) return;
        // The session ended elsewhere: the sign-in page, with nothing to add.
        if (!current) return signedOut("");
        onChange(current);
        if (asked && current.status === "pending")
          setNote("Still waiting for approval.");
      } catch {
        // An unreachable service says nothing about the account: it stays as it is.
        if (asked) setNote(describe(undefined));
      } finally {
        timeout.done();
        asking.current = false;
        setChecking(false);
      }
    },
    [onChange, signedOut, signingOut, ended],
  );
  useEffect(() => {
    if (!pending) return;
    // A hidden page waits: being shown again asks at once.
    const again = () => {
      if (document.visibilityState !== "hidden") void check(false);
    };
    const timer = window.setInterval(again, APPROVAL_CHECK_MS);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [pending, check]);
  // Written for someone who has never heard of the site (v0.4.1): what happened, that there is
  // nothing to do, and whom to ask. No promise of when.
  return (
    <div className={styles.waiting}>
      <h1 ref={heading} tabIndex={-1}>
        {pending
          ? "Your request to join the Commander Duels beta is in."
          : "Your request was not approved this time."}
      </h1>
      {pending ? (
        <>
          <p className={styles.fine}>
            The site's owner reviews each request by hand.
          </p>
          <p className={styles.fine}>
            There is nothing else to do. This page checks every minute and opens
            the site once you are approved, so you can leave it open, or come
            back later and sign in with the same Google account.
          </p>
        </>
      ) : (
        <p className={styles.fine}>
          If you think this is a mistake, write to{" "}
          <a className={styles.mail} href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>
          . A request that is not approved is deleted 30 days after it was made.
        </p>
      )}
      {me.email && (
        <p className={styles.email}>
          Signed in as <span>{me.email}</span>
        </p>
      )}
      {pending && (
        <p className={styles.fine}>
          Questions?{" "}
          <a className={styles.mail} href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>
        </p>
      )}
      <p role="status" className={styles.fine}>
        {note}
      </p>
      {message && (
        <p role="alert" className={styles.error}>
          {message}
        </p>
      )}
      {/* aria-disabled, as on Profile: a disabled button loses keyboard focus. */}
      <div className={styles.actions}>
        {pending && (
          <button
            className={styles.secondary}
            aria-disabled={checking}
            onClick={() => void check(true)}
          >
            Check again
          </button>
        )}
        <button
          className={styles.secondary}
          aria-disabled={busy}
          onClick={() => void signOut(false)}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

/**
 * The Profile page. App shows it, like every page, only to an active account (v0.3.0). Until the
 * account has its handle and its two starter decks, the setup wizard does that (v0.4.2): here a
 * panel opens it again. Then the page shows the account's progress, its alliance and the
 * alliance picker, the profile form and where the account is signed in.
 */
export function Account({
  me,
  onChange,
  onSignedOut,
  onSetup,
  heading,
}: {
  me: Me;
  onChange: (me: Me) => void;
  /** This browser's session ended; the notice is what the sign-in page then says. */
  onSignedOut: (notice: string) => void;
  /** Opens the setup wizard at the account's step. */
  onSetup: () => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const standing = useStanding(me.id);
  const alliance = useAllianceChange(me, onChange, standing);
  const allied = me.alliance
    ? standing.roster?.find((found) => found.id === me.alliance)
    : undefined;
  const progress = standing.progress;
  // A grant SysOp gives itself here shows in the tokens panel at once.
  const [tokensShown, setTokensShown] = useState(0);
  return (
    <>
      <span className={shell.eyebrow}>YOUR ACCOUNT</span>
      <h1 ref={heading} tabIndex={-1}>
        {onboarding(me)
          ? "Welcome to the table."
          : `Welcome back, ${me.display_name}.`}
      </h1>
      <section className={styles.card} aria-label="Account">
        {/* The alliance's portrait is the account's picture, and its tier's crest sits beside
            it; with no alliance, the avatar stays (v0.3.1). */}
        <div className={styles.emblem}>
          {me.alliance ? (
            <Portrait
              id={me.alliance}
              name={allied?.name}
              description={allied?.description}
              portrait={allied?.portrait}
              size={88}
            />
          ) : (
            <span className={styles.avatar} aria-hidden="true">
              {avatars[me.avatar]}
            </span>
          )}
          {progress && <TierBadge tier={progress.tier.id} size={40} />}
        </div>
        <div>
          <strong>{me.handle ?? "No handle yet"}</strong>
          <span>{me.display_name}</span>
          {allied && <span>Allied with {allied.name}</span>}
          {me.email && <small>{me.email} · only you can see this</small>}
        </div>
        <ul className={styles.roles} aria-label="Roles">
          {me.roles.map((role) => (
            <li key={role} className={shell.tag}>
              {roleNames[role] ?? role}
            </li>
          ))}
        </ul>
      </section>
      {onboarding(me) ? (
        <section className={styles.panel} aria-labelledby="setup-title">
          <h2 id="setup-title">Set up your game</h2>
          <p className={styles.fine}>
            {me.onboarding === "handle"
              ? "Choose the name other players see, claim your two free starter decks, and ally with a Planeswalker."
              : "Claim your two free starter decks, then ally with a Planeswalker."}
          </p>
          <button type="button" className={shell.primary} onClick={onSetup}>
            Continue setup
          </button>
        </section>
      ) : (
        <>
          {progress ? (
            <ProgressPanel progress={progress} />
          ) : (
            standing.error && (
              <section className={styles.panel} aria-label="Your progress">
                <p role="alert" className={styles.error}>
                  {standing.error}
                </p>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={standing.reload}
                >
                  Try again
                </button>
              </section>
            )
          )}
          <TokensPanel refresh={tokensShown} />
          <AlliancePanel me={me} standing={standing} alliance={alliance} />
          <section className={styles.panel}>
            <ProfileForm key={me.id} me={me} onChange={onChange} />
          </section>
        </>
      )}
      {/* SysOp sets its own wins here: it is not among the accounts in Administration. */}
      {me.permissions.includes("progress.manage") && (
        <section className={styles.panel} aria-labelledby="own-wins-title">
          <h2 id="own-wins-title">Set your wins</h2>
          <p className={styles.fine}>
            SysOp may set any account's wins, its own included, to test the
            tiers and what they open. A setting is kept apart from the wins
            counted from games, and the audit log records it with its reason.
          </p>
          <SetWins
            userId={me.id}
            subject="your"
            wins={progress?.wins}
            onSet={(changed) => {
              standing.setProgress(changed);
              // A new tier opens or closes Planeswalkers: the roster is asked for again.
              standing.reload();
            }}
          />
        </section>
      )}
      {/* SysOp gives itself tokens here too, to try Leng's card shop (v0.4.0). */}
      {me.permissions.includes("economy.manage") && (
        <section className={styles.panel} aria-labelledby="own-tokens-title">
          <h2 id="own-tokens-title">Give yourself tokens</h2>
          <p className={styles.fine}>
            SysOp may give tokens to any account, its own included, or take them
            back. A grant is kept apart from the tokens won in games, and the
            audit log records it with its reason.
          </p>
          <GiveTokens
            userId={me.id}
            subject="your"
            onGiven={() => setTokensShown((value) => value + 1)}
          />
        </section>
      )}
      {me.kind === "sysop" && (
        <section className={styles.panel}>
          <SysopPassword onChange={onChange} />
        </section>
      )}
      {/* Who sees your presence, appearing offline, being found by email, blocks (v0.4.3). */}
      <PrivacySettings />
      <Sessions me={me} onChange={onChange} onSignedOut={onSignedOut} />
    </>
  );
}
