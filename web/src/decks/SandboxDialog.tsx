import { useEffect, useRef, useState } from "react";
import { client } from "../api";
import { formatLabels } from "../catalog/catalog";
import type { DeckSummary } from "./decks";
import {
  botChoices,
  botDecks,
  NOTHING_EARNED,
  startSandbox,
  type SandboxSetup,
} from "./sandbox";
import styles from "./decks.module.css";

// A sandbox game's setup (v1.0.0), opened from a sandbox deck's own Sandbox button (the owner's
// decision of 2026-11-16: from the deck, not in the Play wizard). The deck is the one the
// button is on; the player chooses the bots, their decks and skill, or bots that do nothing.

export function SandboxDialog({
  deck,
  decks,
  onClose,
}: {
  deck: DeckSummary;
  /** The account's decks, for the bots to play; asked for here where the page holds none. */
  decks?: DeckSummary[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState<DeckSummary[]>();
  useEffect(() => {
    if (decks) return;
    let current = true;
    void client
      .GET("/api/v1/decks")
      .catch(() => ({ data: undefined }))
      .then(({ data }) => {
        if (current && data) setLoaded(data);
      });
    return () => {
      current = false;
    };
  }, [decks]);
  const [setup, setSetup] = useState<SandboxSetup>({
    bots: [null],
    skill: 4,
    passive: false,
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal?.();
  }, []);
  const offered = botDecks(deck, decks ?? loaded ?? []);
  const counts = botChoices(deck.format);

  function botCount(count: number) {
    setSetup((current) => ({
      ...current,
      bots: Array.from({ length: count }, (_, i) => current.bots[i] ?? null),
    }));
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="sandbox-title"
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setStarting(true);
          setError("");
          void startSandbox(deck, setup).then((answer) => {
            setStarting(false);
            if (answer.id) window.location.hash = `#game/${answer.id}`;
            else setError(answer.error ?? "");
          });
        }}
      >
        <h2 id="sandbox-title">Play {deck.title} in the sandbox</h2>
        <p className={styles.hint}>
          {formatLabels[deck.format]}, against bots. {NOTHING_EARNED}
        </p>
        {counts.length > 1 && (
          <label className={styles.field}>
            <span>Opponents</span>
            <select
              value={setup.bots.length}
              onChange={(event) => botCount(Number(event.target.value))}
            >
              {counts.map((count) => (
                <option key={count} value={count}>
                  {count} {count === 1 ? "bot" : "bots"}
                </option>
              ))}
            </select>
          </label>
        )}
        {setup.bots.map((chosen, index) => (
          <label key={index} className={styles.field}>
            <span>
              {setup.bots.length === 1
                ? "The bot's deck"
                : `Bot ${index + 1}'s deck`}
            </span>
            <select
              value={chosen ?? ""}
              onChange={(event) =>
                setSetup((current) => ({
                  ...current,
                  bots: current.bots.map((kept, at) =>
                    at === index ? event.target.value || null : kept,
                  ),
                }))
              }
            >
              <option value="">A deck of the game's own</option>
              {offered.map((found) => (
                <option key={found.id} value={found.id}>
                  {found.title}
                  {found.sandbox ? " (sandbox deck)" : ""}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className={styles.field}>
          <span>
            Bot skill <small>{setup.skill} of 6</small>
          </span>
          <input
            type="range"
            min={1}
            max={6}
            step={1}
            value={setup.skill}
            disabled={setup.passive}
            onChange={(event) =>
              setSetup((current) => ({
                ...current,
                skill: Number(event.target.value),
              }))
            }
          />
        </label>
        <label className={styles.sandboxCheck}>
          <input
            type="checkbox"
            checked={setup.passive}
            aria-describedby="sandbox-passive-words"
            onChange={(event) =>
              setSetup((current) => ({
                ...current,
                passive: event.target.checked,
              }))
            }
          />
          <span>Bots that do nothing</span>
        </label>
        <p id="sandbox-passive-words" className={styles.hint}>
          They only draw, pass and discard, so you can play your deck out alone.
          You can switch them back, and off again, from the game's menu.
        </p>
        {error && (
          <p role="alert" className={styles.refusal}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={starting}>
            {starting ? "Starting…" : "Start the sandbox game"}
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
