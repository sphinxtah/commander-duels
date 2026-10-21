import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  client,
  describe,
  loadMe,
  type ApiError,
  type Me,
  type StarterDeck,
} from "../api";
import { printingImage } from "../catalog/catalog";
import styles from "./alliance.module.css";
import account from "../Account.module.css";
import shell from "../App.module.css";

/**
 * Onboarding's second step (v0.3.1), right after the handle: two of the ten Commander starter
 * decks, chosen once. Both become decks of the player's own, and every copy of their cards joins
 * the library for good. Each deck shows its commander, colours, description, how to play it and
 * what it teaches; exactly two can be chosen, and Confirm sends them.
 */
export function StarterPicker({
  me,
  onChange,
  onChosen,
  heading,
}: {
  me: Me;
  onChange: (me: Me) => void;
  /** The decks are chosen: the page offers an alliance next. */
  onChosen: () => void;
  /** Focused when the page arrives here from the handle. */
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [decks, setDecks] = useState<StarterDeck[]>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Commanders whose picture did not arrive show their name in a frame instead.
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const prefix = `starter${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/decks/starters")
      .then(({ data, error: refused }) => {
        if (!active) return;
        if (data) {
          setDecks(data);
          setError("");
        } else setError(describe(refused));
      })
      .catch(() => {
        if (active) setError(describe(undefined));
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  function toggle(name: string) {
    setError("");
    setChosen((current) =>
      current.includes(name)
        ? current.filter((found) => found !== name)
        : current.length < 2
          ? [...current, name]
          : current,
    );
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (chosen.length !== 2) return setError("Choose two starter decks first.");
    setBusy(true);
    setError("");
    try {
      const { data, error: refused } = await client.POST(
        "/api/v1/me/starters",
        {
          body: { decks: chosen },
        },
      );
      // Chosen already (in another tab, say): onboarding is over either way.
      if (
        !data &&
        (refused as ApiError | undefined)?.code !== "starters_chosen"
      )
        return setError(describe(refused));
      // The server has finished the account's onboarding; the account is asked for again, and
      // if that fails the page goes on with what the server just did.
      let current: Me | null = null;
      try {
        current = await loadMe();
      } catch {
        // Kept below.
      }
      onChosen();
      onChange(current ?? { ...me, onboarding: "complete" });
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }

  const titles = chosen.map(
    (name) => decks?.find((deck) => deck.name === name)?.title ?? name,
  );
  return (
    <form
      className={account.form}
      onSubmit={confirm}
      aria-labelledby="starters-title"
    >
      <h2 id="starters-title" ref={heading} tabIndex={-1}>
        Choose two starter decks
      </h2>
      <p className={account.fine}>
        Two of these ten Commander decks start your library. Each becomes a deck
        of your own, ready to play, and its cards stay in your library for good.
        You choose once.
      </p>
      {decks === undefined && !error && (
        <p role="status" className={account.fine}>
          Loading the starter decks…
        </p>
      )}
      {decks && (
        <fieldset className={styles.starterSet}>
          <legend className={styles.visuallyHidden}>Starter decks</legend>
          <ul className={styles.starters}>
            {decks.map((deck) => {
              const on = chosen.includes(deck.name);
              const id = `${prefix}-${deck.name}`;
              return (
                <li key={deck.name} data-chosen={on || undefined}>
                  <label className={styles.starter}>
                    <input
                      type="checkbox"
                      checked={on}
                      // Two are the most: the rest wait until one of the two is let go.
                      disabled={!on && chosen.length >= 2}
                      onChange={() => toggle(deck.name)}
                      aria-labelledby={`${id}-title`}
                      aria-describedby={`${id}-about`}
                    />
                    <span className={styles.starterArt}>
                      {deck.commander_printing_id && !missing.has(deck.name) ? (
                        <img
                          src={printingImage(deck.commander_printing_id)}
                          alt=""
                          width={244}
                          height={340}
                          loading="lazy"
                          decoding="async"
                          onError={() =>
                            setMissing((current) =>
                              new Set(current).add(deck.name),
                            )
                          }
                        />
                      ) : (
                        <span
                          className={styles.starterFrame}
                          aria-hidden="true"
                        >
                          {deck.commanders.join(" & ")}
                        </span>
                      )}
                    </span>
                    <span className={styles.starterText}>
                      <strong id={`${id}-title`}>{deck.title}</strong>
                      <span className={styles.starterColors}>
                        <span className={styles.pips} aria-hidden="true">
                          {deck.colors.split("").map((color) => (
                            <span key={color} data-color={color} />
                          ))}
                        </span>
                        {deck.color_names} · {deck.guild}
                      </span>
                      <span className={styles.starterCommander}>
                        Commander: {deck.commanders.join(" & ")}
                      </span>
                      <span id={`${id}-about`} className={styles.starterAbout}>
                        <span>{deck.description}</span>
                        <span>
                          <b>How to play.</b> {deck.how_to_play}
                        </span>
                        <span>
                          <b>Teaches.</b> {deck.teaches}
                        </span>
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      <p role="status" className={account.fine}>
        {decks === undefined
          ? ""
          : titles.length === 0
            ? "No deck chosen yet."
            : titles.length === 1
              ? `Chosen: ${titles[0]}. Choose one more.`
              : `Chosen: ${titles[0]} and ${titles[1]}.`}
      </p>
      {error && (
        <p role="alert" className={account.error}>
          {error}
        </p>
      )}
      <div className={account.actions}>
        {decks === undefined && error && (
          <button
            type="button"
            className={account.secondary}
            onClick={() => {
              setError("");
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        )}
        {/* aria-disabled, as elsewhere: a disabled button loses keyboard focus. */}
        {decks && (
          <button
            type="submit"
            className={shell.primary}
            aria-disabled={busy || chosen.length !== 2}
          >
            Confirm these two decks
          </button>
        )}
      </div>
    </form>
  );
}
