import { useCallback, useState } from "react";
import { client, describe } from "../api";
import { expiresText } from "../game/saves";
import type { CampaignState, SavedDuel } from "./campaign";
import styles from "./campaign.module.css";

// A campaign duel saved to be played on later (v1.0.0, api/saves.py; docs/games.md): the map says
// so, at the duel's ward and in this list, where each is played on. A court its players suspended
// together is played on at its table. Discarding a save is on Your games, with the saves' rules.

/** What a saved duel is called: its ward's title, or the challenge's name. */
export function savedTitle(state: CampaignState, duel: SavedDuel): string {
  if (duel.challenge) return state.challenge.name;
  return (
    state.encounters.find((e) => e.number === duel.encounter)?.title ??
    `Ward ${duel.encounter}`
  );
}

/** "Saved on turn 7 · runs out in 29 days (14 Dec)". */
export function savedLine(duel: SavedDuel, now = Date.now()): string {
  const saved = duel.table ? "Suspended" : "Saved";
  return `${duel.turn !== null ? `${saved} on turn ${duel.turn}` : saved} · runs out ${expiresText(duel.expires_at, now)}`;
}

/** Playing a saved duel on, for the map's first button and its list alike. */
export interface Resuming {
  /** The save being resumed. */
  busy: string | null;
  /** Why the last resume was refused. */
  refusal: string | null;
  resume(duel: SavedDuel): Promise<void>;
}

/**
 * Resumes a saved duel and opens its game. A refused resume says why, and the campaign is asked
 * for again (onChanged), since the save may be gone.
 */
export function useResuming(onChanged: () => void): Resuming {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const resume = useCallback(
    async (duel: SavedDuel) => {
      setBusy(duel.save);
      setRefusal(null);
      const { data, error } = await client
        .POST("/api/v1/saves/{save_id}/resume", {
          params: { path: { save_id: duel.save } },
        })
        .catch(() => ({ data: undefined, error: undefined }));
      setBusy(null);
      if (data) {
        window.location.hash = `#game/${data.id}`;
        return;
      }
      setRefusal(describe(error));
      onChanged();
    },
    [onChanged],
  );
  return { busy, refusal, resume };
}

/** The saved duels of the map: each resumed here, or at its table when its players suspended it. */
export function SavedDuels({
  state,
  resuming,
}: {
  state: CampaignState;
  resuming: Resuming;
}) {
  const { busy, refusal, resume } = resuming;
  if (state.saved.length === 0 && !refusal) return null;
  return (
    <section className={styles.saved} aria-labelledby="saved-duels-title">
      <h2 id="saved-duels-title" className={styles.openingsTitle}>
        {state.saved.length > 1 ? "Saved duels" : "Saved duel"}
      </h2>
      {state.saved.length > 0 && (
        <ul>
          {state.saved.map((duel) => {
            const title = savedTitle(state, duel);
            return (
              <li key={duel.save} data-encounter={duel.encounter}>
                <span className={styles.savedWords}>
                  <strong>{title}</strong>
                  <small>{savedLine(duel)}</small>
                </span>
                {duel.table ? (
                  <a className={styles.gold} href={`#tables/${duel.table}`}>
                    Go to its table <span aria-hidden="true">▶</span>
                    <span className={styles.visuallyHidden}>: {title}</span>
                  </a>
                ) : (
                  <button
                    type="button"
                    className={styles.gold}
                    disabled={busy !== null}
                    onClick={() => void resume(duel)}
                  >
                    {busy === duel.save ? "Resuming…" : "Resume"}{" "}
                    <span aria-hidden="true">▶</span>
                    <span className={styles.visuallyHidden}>: {title}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {refusal && (
        <p role="alert" className={styles.error}>
          {refusal}
        </p>
      )}
      {state.saved.length > 0 && (
        <p className={styles.quiet}>
          Each is also under Saved games on <a href="#play/games">Your games</a>
          , where a save can be discarded and its rules are told.
        </p>
      )}
    </section>
  );
}
