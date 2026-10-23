import { useEffect, useRef, useState } from "react";
import { client, describe } from "../api";
import { exitTableFullscreen } from "../app/fullscreen";
import { tableFullscreen } from "../game/PracticeTable";
import { getSoundEngine } from "../game/sound/engine";
import game from "../game/game.module.css";
import {
  arranged,
  clock,
  counts,
  MAX_SIDEBOARD,
  MIN_MAIN,
  moved,
  opponentOf,
  problems,
  same,
  seatName,
  type MatchPlayer,
  type MatchView,
  type SideboardCard,
} from "./matches";
import styles from "./matches.module.css";

// Sideboarding between a match's games (v0.5.0, docs/matches.md): the player swaps cards between
// the main deck and the sideboard of the deck the match started with, sees the counts and what
// Legacy's rules say of them, and is ready; the last game's loser also chooses to play or draw.
// The arrangement saves by itself once it is a deck again, so the next game, which starts when
// sideboarding's time is up, plays it. Nobody else ever sees it.

/** How long after the last change a valid arrangement saves by itself. */
export const SAVE_DELAY_MS = 800;

type Saving = "saved" | "saving" | "unsaved" | "refused";

export function SideboardEditor({
  match,
  mine,
  onMatch,
}: {
  match: MatchView;
  mine: MatchPlayer;
  /** The match as an action's reply has it. */
  onMatch: (match: MatchView) => void;
}) {
  const saved = mine.deck_cards?.cards ?? [];
  const [cards, setCards] = useState<SideboardCard[]>(saved);
  const [saving, setSaving] = useState<Saving>("saved");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [playFirst, setPlayFirst] = useState(
    match.starting_seat === null || match.starting_seat === mine.seat,
  );
  const [now, setNow] = useState(() => Date.now());
  // Edits stay while the page asks again; with none, the page shows what the server holds.
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setCards(saved);
    // The server's arrangement, by its content.
  }, [JSON.stringify(saved)]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const total = counts(cards);
  const wrong = problems(cards);
  const changed = !same(cards, saved);
  const chooser = match.chooser_seat === mine.seat;
  const other = opponentOf(match, mine.seat);
  const left = match.sideboard_until
    ? (Date.parse(match.sideboard_until) - now) / 1000
    : null;
  const next = match.game_number;

  async function save(next: SideboardCard[]): Promise<boolean> {
    setSaving("saving");
    const { data, error: failure } = await client
      .PUT("/api/v1/matches/{match_id}/sideboard", {
        params: { path: { match_id: match.id } },
        body: { cards: arranged(next) },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    if (!data) {
      setSaving("refused");
      setError(describe(failure));
      return false;
    }
    edited.current = false;
    setSaving("saved");
    setError("");
    onMatch(data);
    return true;
  }

  // A valid arrangement saves by itself a moment after the last change; Ready saves it at once.
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!changed || wrong.length > 0 || !mine.deck_cards?.can_sideboard) return;
    pending.current = window.setTimeout(() => void save(cards), SAVE_DELAY_MS);
    return () => window.clearTimeout(pending.current);
  }, [cards]);

  function move(index: number, to: "main" | "sideboard") {
    edited.current = true;
    setSaving("unsaved");
    setCards((current) => moved(current, index, to));
  }

  async function ready(value: boolean) {
    // The last click before the game opens: the table fills the screen, and sound may start.
    const fullscreen = value ? tableFullscreen() : null;
    if (value) getSoundEngine().unlock();
    window.clearTimeout(pending.current);
    setBusy(true);
    setError("");
    if (value && changed && !(await save(cards))) {
      setBusy(false);
      void fullscreen?.then((entered) => {
        if (entered) void exitTableFullscreen();
      });
      return;
    }
    const { data, error: failure } = await client
      .POST("/api/v1/matches/{match_id}/ready", {
        params: { path: { match_id: match.id } },
        body: {
          ready: value,
          ...(chooser && value ? { play_first: playFirst } : {}),
        },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    setBusy(false);
    if (data) onMatch(data);
    else setError(describe(failure));
    // Still waiting for the other player: no game to fill the screen for yet.
    if (!data || data.status !== "playing")
      void fullscreen?.then((entered) => {
        if (entered) void exitTableFullscreen();
      });
  }

  const choice =
    match.starting_seat === null
      ? null
      : match.starting_seat === mine.seat
        ? "You play first."
        : `${seatName(match, match.starting_seat)} plays first.`;

  return (
    <section className={game.table} aria-labelledby="sideboard-title">
      <h2 id="sideboard-title">Sideboard for game {next}</h2>
      {left !== null && (
        <p className={game.hint} role="timer" aria-live="off">
          Game {next} starts by itself in {clock(left)}, with your deck as it is
          saved.
        </p>
      )}
      {!mine.deck_cards?.can_sideboard ? (
        <p className={styles.lead}>
          This deck has no sideboard: it plays as it is in every game.
        </p>
      ) : (
        <>
          <p className={styles.lead}>
            Swap cards between your main deck and your sideboard: the same cards
            as in game 1, no others. Nobody else sees your choices.
          </p>
          <p className={styles.counts}>
            <span data-over={total.main < MIN_MAIN}>
              Main deck <strong>{total.main}</strong> (at least {MIN_MAIN})
            </span>
            <span data-over={total.sideboard > MAX_SIDEBOARD}>
              Sideboard <strong>{total.sideboard}</strong> (at most{" "}
              {MAX_SIDEBOARD})
            </span>
            <span className={styles.saved} role="status">
              {saving === "saving"
                ? "Saving…"
                : saving === "unsaved"
                  ? wrong.length
                    ? "Not saved yet"
                    : "Saving soon…"
                  : saving === "refused"
                    ? "Not saved"
                    : "Saved"}
            </span>
          </p>
          {wrong.length > 0 && (
            <ul className={styles.problems} aria-label="Problems">
              {wrong.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <ul className={styles.cards} aria-label="Your cards">
            {cards.map((card, index) => (
              <li
                key={`${card.card_id}|${card.printing_id ?? ""}`}
                data-changed={
                  card.main !==
                  saved.find(
                    (entry) =>
                      entry.card_id === card.card_id &&
                      entry.printing_id === card.printing_id,
                  )?.main
                }
              >
                <span>
                  {card.name}
                  <small>{card.type_line}</small>
                </span>
                <button
                  type="button"
                  className={styles.move}
                  aria-label={`Move one ${card.name} to the sideboard`}
                  disabled={card.main === 0 || busy || mine.ready}
                  onClick={() => move(index, "sideboard")}
                >
                  →
                </button>
                <span
                  className={styles.count}
                  aria-label={`${card.main} in the main deck`}
                >
                  {card.main}
                  <span aria-hidden="true">Main</span>
                </span>
                <span
                  className={styles.count}
                  aria-label={`${card.sideboard} in the sideboard`}
                >
                  {card.sideboard}
                  <span aria-hidden="true">Side</span>
                </span>
                <button
                  type="button"
                  className={styles.move}
                  aria-label={`Move one ${card.name} to the main deck`}
                  disabled={card.sideboard === 0 || busy || mine.ready}
                  onClick={() => move(index, "main")}
                >
                  ←
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {chooser ? (
        <fieldset className={styles.choices}>
          <legend>
            You lost the last game: choose who plays first in game {next}.
          </legend>
          <label className={game.choice}>
            <input
              type="radio"
              name="play-first"
              checked={playFirst}
              disabled={mine.ready}
              onChange={() => setPlayFirst(true)}
            />
            <span>
              <strong>Play first</strong>
              <small>You take the first turn and skip its draw</small>
            </span>
          </label>
          <label className={game.choice}>
            <input
              type="radio"
              name="play-first"
              checked={!playFirst}
              disabled={mine.ready}
              onChange={() => setPlayFirst(false)}
            />
            <span>
              <strong>Draw first</strong>
              <small>
                {seatName(match, other?.seat ?? null)} takes the first turn
              </small>
            </span>
          </label>
        </fieldset>
      ) : (
        <p className={game.hint}>
          {choice ??
            `${seatName(match, match.chooser_seat)} lost the last game and chooses who plays first.`}
        </p>
      )}

      {match.waiting && (
        <p className={styles.notice} role="status">
          {match.waiting}
        </p>
      )}
      <div className={styles.actions}>
        {mine.ready ? (
          <>
            <span className={styles.saved} role="status">
              You are ready.{" "}
              {other && !other.ready
                ? `Waiting for ${seatName(match, other.seat)}…`
                : "Starting the game…"}
            </span>
            <button
              type="button"
              className={game.secondaryButton}
              disabled={busy}
              onClick={() => void ready(false)}
            >
              Not ready
            </button>
          </>
        ) : (
          <button
            type="button"
            className={game.primaryButton}
            disabled={busy || wrong.length > 0}
            onClick={() => void ready(true)}
          >
            Ready for game {next}
          </button>
        )}
        {changed && !mine.ready && (
          <button
            type="button"
            className={game.secondaryButton}
            disabled={busy}
            onClick={() => {
              edited.current = false;
              setSaving("saved");
              setError("");
              setCards(saved);
            }}
          >
            Undo changes
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className={game.refusal}>
          {error}
        </p>
      )}
    </section>
  );
}
