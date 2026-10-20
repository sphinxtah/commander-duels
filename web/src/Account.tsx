import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  client,
  describe,
  loadMe,
  setCsrfToken,
  sysopChangePassword,
  type ApiError,
  type Avatar,
  type Bootstrap,
  type Me,
  type SessionSummary,
} from "./api";
import { loadGoogle } from "./google";
import styles from "./Account.module.css";
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
const RETURN_KEY = "cd.returnTo";
// The server's sign-in challenge and its cookie last 10 minutes. The page renews an idle one a
// minute early, and checks its age often by the wall clock, because timers stop while a
// computer or phone sleeps but the challenge keeps ageing.
const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;
const CHALLENGE_RENEW_MS = 9 * 60 * 1000;
const CHALLENGE_CHECK_MS = 15 * 1000;
// Google says nothing when its window is closed without signing in. A press this old, once the
// page has focus again, counts as given up, so it no longer holds off the early renewal.
const PRESS_GIVEN_UP_MS = 2 * 60 * 1000;

/** Remember where to come back to after signing in (T01: return to the intended screen). */
export function signInFrom(hash: string) {
  try {
    sessionStorage.setItem(RETURN_KEY, hash);
  } catch {
    // Without storage the user simply stays on Profile.
  }
}

function returnAfterSignIn() {
  try {
    const target = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (target && target.startsWith("#") && target !== "#profile")
      window.location.hash = target;
  } catch {
    // Storage unavailable: stay here.
  }
}

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
                onSignedIn(result.data);
                returnAfterSignIn();
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
      {state === "loading" && <p role="status">Preparing Google sign-in…</p>}
      {state === "verifying" && <p role="status">Signing you in…</p>}
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

function SignedOut({
  auth,
  unavailable,
  onRetry,
  notice,
  onSignedIn,
  heading,
}: {
  auth: Bootstrap["auth"] | undefined;
  unavailable: boolean;
  onRetry: () => void;
  notice: string;
  onSignedIn: (me: Me) => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <>
      <span className={shell.eyebrow}>M1 · ACCOUNTS</span>
      <h1 ref={heading} tabIndex={-1}>
        Your place at the table.
      </h1>
      <p className={shell.lead}>
        Sign in with Google to create your Commander Duels account. One Google
        account is one player.
      </p>
      {notice && (
        <div className={shell.notice} role="status">
          <p>{notice}</p>
        </div>
      )}
      <section className={styles.panel} aria-labelledby="sign-in-title">
        <h2 id="sign-in-title">Sign in</h2>
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
            <p className={styles.fine} role="status">
              Preparing sign-in…
            </p>
          )
        ) : auth.google_client_id ? (
          <>
            <GoogleSignIn onSignedIn={onSignedIn} />
            <p className={styles.fine}>
              Google tells Commander Duels only your name, email address and
              account ID. Your email stays private: other players see the handle
              you choose.
              {auth.signup_policy === "approval" &&
                " New accounts wait for an administrator's approval."}
            </p>
          </>
        ) : (
          <p className={styles.fine}>
            Google sign-in is not set up on this server yet. The operator needs
            to add a Google OAuth client ID.
          </p>
        )}
      </section>
    </>
  );
}

function HandleForm({ me, onChange }: { me: Me; onChange: (me: Me) => void }) {
  const [handle, setHandle] = useState(me.handle ?? "");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const { data, error } = await client.PATCH("/api/v1/me", {
      body: { handle },
    });
    if (data) {
      onChange(data);
      setMessage("");
    } else setMessage(describe(error));
  }
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      aria-labelledby="handle-title"
    >
      <h2 id="handle-title">Choose your handle</h2>
      <p className={styles.fine}>
        Your handle is how other players know you: 3–20 letters, digits, hyphens
        or underscores.
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
      <button className={shell.primary} type="submit">
        Save handle
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
      <p role="status" className={styles.fine}>
        {message}
      </p>
      <button className={shell.primary} type="submit">
        Save profile
      </button>
    </form>
  );
}

function Sessions({
  me,
  onChange,
  onSignedOut,
}: {
  me: Me;
  onChange: (me: Me) => void;
  onSignedOut: (notice?: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [message, setMessage] = useState("");
  // One sign-out at a time. A second click's request would find this session already ended,
  // and its 401 would wrongly say the other sessions could not be ended.
  const [busy, setBusy] = useState(false);
  const signingOut = useRef(false);
  async function load() {
    const { data } = await client.GET("/api/v1/me/sessions");
    setSessions(data);
  }
  useEffect(() => {
    void load();
  }, [me.session.id]);
  async function end(session: SessionSummary) {
    const { error } = await client.DELETE("/api/v1/me/sessions/{session_id}", {
      params: { path: { session_id: session.id } },
    });
    if (error) setMessage(describe(error));
    else if (session.current) onSignedOut();
    else await load();
  }
  // The page shows the signed-out screen only once the server confirms: a refused sign-out
  // leaves the session alive, and saying otherwise would be false comfort.
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
        if (current === null) return onSignedOut(gone);
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
      if (response.ok) onSignedOut();
      // 401: the session had already ended, so this browser is signed out either way.
      else if (response.status === 401) onSignedOut(gone);
      else setMessage(describe(error));
    } catch {
      setMessage(describe(undefined));
    } finally {
      signingOut.current = false;
      setBusy(false);
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

export function Account({
  me,
  auth,
  unavailable,
  onRetry,
  onChange,
  heading,
}: {
  me: Me | null | undefined;
  auth: Bootstrap["auth"] | undefined;
  /** The bootstrap failed to load, so sign-in's settings are unknown. */
  unavailable: boolean;
  onRetry: () => void;
  onChange: (me: Me | null) => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  // What the signed-out screen says about the sign-out that led to it; a sign-in clears it.
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (me) setNotice("");
  }, [me]);
  if (me === undefined)
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>
          Your place at the table.
        </h1>
        <p role="status" className={shell.lead}>
          Checking your sign-in…
        </p>
      </>
    );
  if (me === null)
    return (
      <SignedOut
        auth={auth}
        unavailable={unavailable}
        onRetry={onRetry}
        notice={notice}
        onSignedIn={onChange}
        heading={heading}
      />
    );
  const signedOut = (said = "") => {
    setCsrfToken(undefined);
    setNotice(said);
    onChange(null);
  };
  return (
    <>
      <span className={shell.eyebrow}>YOUR ACCOUNT</span>
      <h1 ref={heading} tabIndex={-1}>
        {me.onboarding === "handle"
          ? "Welcome to the table."
          : `Welcome back, ${me.display_name}.`}
      </h1>
      {me.status === "pending" && (
        <div className={shell.notice} role="status">
          <strong>Your account is waiting for approval.</strong>
          <p>
            An administrator will review it. You can choose your handle while
            you wait.
          </p>
        </div>
      )}
      {me.status === "denied" && (
        <div className={shell.notice} role="status">
          <strong>Your account was not approved.</strong>
          <p>
            Contact the operator of this server if you think this is a mistake.
          </p>
        </div>
      )}
      <section className={styles.card} aria-label="Account">
        <span className={styles.avatar} aria-hidden="true">
          {avatars[me.avatar]}
        </span>
        <div>
          <strong>{me.handle ?? "No handle yet"}</strong>
          <span>{me.display_name}</span>
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
      {me.status !== "denied" &&
        (me.onboarding === "handle" ? (
          <section className={styles.panel}>
            {/* Keyed by account: a form must never keep another account's values. */}
            <HandleForm key={me.id} me={me} onChange={onChange} />
          </section>
        ) : (
          <section className={styles.panel}>
            <ProfileForm key={me.id} me={me} onChange={onChange} />
          </section>
        ))}
      {me.kind === "sysop" && (
        <section className={styles.panel}>
          <SysopPassword onChange={onChange} />
        </section>
      )}
      <Sessions me={me} onChange={onChange} onSignedOut={signedOut} />
    </>
  );
}
