import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { client } from "../api";
import { portraitUrl } from "../game/table/portrait";
import { selectSound } from "../shell/menuSound";
import {
  changeTutorial,
  startEncounter,
  TIER_NAMES,
  type CampaignEncounter,
  type CampaignState,
  type StartChoice,
} from "./campaign";
import { STORY } from "./script";
import styles from "./campaign.module.css";

// Before a duel (v0.8.0): the handoff's first screen's controls. Learn Commander (the loaner, the
// training seed and the hints), the campaign's loaner deck, one of the player's own Commander
// decks, or for the first encounter "I know how to play" (the teaching skipped, the duel kept);
// Review my alliance leads to the profile. Kaya's advice for a duel lost before is the encounter's
// counterplay.

type OwnDeck = { id: string; title: string; commanders: string[] };

export function DuelSetup({
  state,
  encounter,
  lostBefore,
  canUseOwnDecks,
  challenge = false,
  onClose,
  onState,
}: {
  state: CampaignState;
  encounter: CampaignEncounter;
  lostBefore: boolean;
  canUseOwnDecks: boolean;
  /** Apex Unbound (v0.9.3): the finale again, for its badge alone. */
  challenge?: boolean;
  onClose: () => void;
  onState: (state: CampaignState) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [decks, setDecks] = useState<OwnDeck[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = encounter.number === 1 && !challenge;
  const tutorial = state.progress.tutorial;
  const story = STORY.encounters[encounter.number];

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
  }, []);
  useEffect(() => {
    if (!canUseOwnDecks) {
      setDecks([]);
      return;
    }
    let active = true;
    void client.GET("/api/v1/decks").then(({ data }) => {
      if (!active) return;
      const playable = (data ?? []).filter(
        (deck) =>
          deck.format === "commander" &&
          deck.playable &&
          !deck.archived &&
          !deck.deleted_at,
      );
      setDecks(
        playable.map((deck) => ({
          id: deck.id,
          title: deck.title,
          commanders: deck.commanders,
        })),
      );
      if (playable[0]) setChosen(playable[0].id);
    });
    return () => {
      active = false;
    };
  }, [canUseOwnDecks]);

  async function start(choice: StartChoice) {
    setBusy(true);
    setError("");
    selectSound();
    const started = await startEncounter(encounter.number, choice, challenge);
    if (started.gameId) {
      window.location.hash = `#game/${started.gameId}`;
      return;
    }
    setBusy(false);
    setError(started.error ?? "The duel could not start.");
  }

  async function skipTeaching() {
    const next = await changeTutorial({ skip: true });
    if (next) onState(next);
  }

  const opponentPortrait =
    encounter.number === 14 ? null : portraitUrl(encounter.opponent, 256);

  return (
    <dialog
      ref={dialog}
      className={styles.setup}
      aria-labelledby="duel-setup-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className={styles.setupHead}>
        {opponentPortrait ? (
          <img
            className={styles.setupPortrait}
            src={opponentPortrait}
            alt=""
            width={128}
            height={128}
          />
        ) : (
          <span className={styles.setupThrone} aria-hidden="true" />
        )}
        <div>
          <span className={styles.kicker}>
            {challenge
              ? "The post-campaign challenge"
              : encounter.number === 14
                ? "The final duel"
                : `Encounter ${String(encounter.number).padStart(2, "0")} · ${TIER_NAMES[encounter.tier]}`}
          </span>
          <h2 id="duel-setup-title" className={styles.setupTitle}>
            {challenge ? state.challenge.name : encounter.title}
          </h2>
          <p className={styles.quiet}>
            {encounter.name}
            {encounter.commander
              ? `, commanding ${encounter.commander}`
              : ""}. {encounter.location}.
          </p>
          {challenge ? (
            <p className={styles.spoilsLine}>
              {state.challenge.earned
                ? "Its badge is yours already; play it again for the challenge alone."
                : "Win it for the Apex Unbound badge, once. Kaya's aids stay off, and the ending you won stays yours."}
            </p>
          ) : (
            <p className={styles.spoilsLine}>
              {encounter.spoils.earned ? "Won: " : "Win it for "}
              <strong>{encounter.spoils.deck}</strong> (led by{" "}
              {encounter.spoils.commander}) and{" "}
              <strong>
                {encounter.spoils.tokens.toLocaleString("en-US")} tokens
              </strong>
              {encounter.spoils.earned ? "." : ", once."}
            </p>
          )}
        </div>
      </header>

      {lostBefore && !challenge && story?.counterplay && (
        <p className={styles.advice}>
          <strong>Kaya:</strong> {story.counterplay}
        </p>
      )}

      <div className={styles.choices}>
        {first && (
          <button
            type="button"
            className={styles.choice}
            disabled={busy}
            onClick={() => void start({ kind: "learn" })}
          >
            <strong>Learn Commander</strong>
            <span>
              The loaner deck, {state.loaner}, with {state.loaner_commander} in
              the command zone, the training shuffle and Kaya&rsquo;s hints.
            </span>
          </button>
        )}
        <button
          type="button"
          className={styles.choice}
          disabled={busy}
          onClick={() => void start({ kind: "loaner" })}
        >
          <strong>Use the loaner: {state.loaner}</strong>
          <span>
            A mono-white deck led by {state.loaner_commander}. It stays the
            campaign&rsquo;s and never touches your collection.
          </span>
        </button>
        {canUseOwnDecks && (
          <div className={styles.choice}>
            <strong>Use my deck</strong>
            {decks === null ? (
              <span>Finding your Commander decks…</span>
            ) : decks.length === 0 ? (
              <span>
                None of your Commander decks is ready to play.{" "}
                <a href="#decks">Open your decks</a>.
              </span>
            ) : (
              <span className={styles.deckPick}>
                <label>
                  <span className={styles.visuallyHidden}>Your deck</span>
                  <select
                    value={chosen}
                    onChange={(event) => setChosen(event.target.value)}
                  >
                    {decks.map((deck) => (
                      <option key={deck.id} value={deck.id}>
                        {deck.title}
                        {deck.commanders.length
                          ? ` (${deck.commanders.join(" & ")})`
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={styles.gold}
                  disabled={busy || !chosen}
                  onClick={() => void start({ kind: "own", deckId: chosen })}
                >
                  Duel with it
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {first && !tutorial.skipped && (
        <p className={styles.quiet}>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void skipTeaching()}
          >
            I know how to play
          </button>{" "}
          skips Kaya&rsquo;s teaching; the duel and the story stay.
        </p>
      )}
      {encounter.number === 14 && (
        <p className={styles.warning}>
          The Sphinx plays without restraint: acceleration, tutors and
          combinations can end the duel from the first turns. At 15 life or less
          he crosses into the duel himself.
        </p>
      )}

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className={styles.quiet}>
          Opening the ward…
        </p>
      )}

      <footer className={styles.setupFoot}>
        <a href="#profile" className={styles.linkButton}>
          Review my alliance
        </a>
        <button type="button" className={styles.secondary} onClick={onClose}>
          Back to the map
        </button>
      </footer>
    </dialog>
  );
}
