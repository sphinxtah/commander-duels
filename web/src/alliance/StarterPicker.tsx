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
import { RetryingImage } from "../game/RetryingImage";
import styles from "./alliance.module.css";
import account from "../Account.module.css";
import shell from "../App.module.css";

/**
 * The setup wizard's starter decks (v0.3.1; in the wizard since v0.4.2), right after the handle:
 * two of the ten Commander starter decks, free and chosen once. Both become decks of the player's
 * own, and every copy of their cards joins the library for good; the welcome tokens are not
 * touched. Each deck shows its commander's card, its colours, description, how to play it and
 * what it teaches; exactly two can be chosen, and the button claims them.
 */
export function StarterPicker({
  me,
  onChange,
  onChosen,
  heading,
}: {
  me: Me;
  onChange: (me: Me) => void;
  /** The decks are chosen: the wizard offers an alliance next. */
  onChosen: () => void;
  /** Focused when the wizard arrives at this step. */
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [decks, setDecks] = useState<StarterDeck[]>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
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
        Claim your two free starter decks
      </h2>
      <p className={account.fine}>
        Pick any two of these ten Commander decks. They are free and yours to
        keep: each becomes a deck of your own, ready to play right away, and
        every card in it joins your library for good. Your 1,000 welcome tokens
        stay yours for packs in Leng's card shop, where the other decks are sold
        later.
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
              // A commander whose picture does not arrive shows its name in a frame instead.
              const frame = (
                <span className={styles.starterFrame} aria-hidden="true">
                  {deck.commanders.join(" & ")}
                </span>
              );
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
                      {deck.commander_printing_id ? (
                        <RetryingImage
                          src={printingImage(deck.commander_printing_id)}
                          width={244}
                          height={340}
                          fallback={frame}
                        />
                      ) : (
                        frame
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
            Claim these two decks
          </button>
        )}
      </div>
    </form>
  );
}
