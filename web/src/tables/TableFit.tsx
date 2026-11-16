import { useCallback, useEffect, useState } from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";
import styles from "./tables.module.css";

// How the table fit (v1.0.0, docs/tables.md): after a game at a table that described itself
// (Rule Zero), each of its players may say in one tap whether the game was as described,
// stronger or weaker. It is optional and may be changed. The owner's decision 25: only the
// site's numbers count the answers; no player and no host sees one, and nobody is rated. The
// question says so where it is asked.

export type TableFitView = components["schemas"]["TableFitView"];
export type Fit = NonNullable<TableFitView["fit"]>;

export const FITS: [Fit, string][] = [
  ["as_described", "As described"],
  ["stronger", "Stronger than described"],
  ["weaker", "Weaker than described"],
];

export interface TableFit {
  /** What the API says of the question; null until it answered, or when it did not. */
  view: TableFitView | null;
  busy: boolean;
  error: string;
  answer: (fit: Fit) => void;
}

/**
 * The finished table game's question, for one who played in it: asked for once the game's end is
 * recorded. `ready` is false for every other game, which asks nothing.
 */
export function useTableFit(gameId: string, ready: boolean): TableFit {
  const [view, setView] = useState<TableFitView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void client
      .GET("/api/v1/games/{game_id}/table-fit", {
        params: { path: { game_id: gameId } },
      })
      .then(({ data }) => {
        if (active && data) setView(data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [gameId, ready]);
  const answer = useCallback(
    (fit: Fit) => {
      setBusy(true);
      setError("");
      void client
        .PUT("/api/v1/games/{game_id}/table-fit", {
          params: { path: { game_id: gameId } },
          body: { fit },
        })
        .catch(() => ({ data: undefined, error: undefined }))
        .then(({ data, error: failure }) => {
          setBusy(false);
          if (data) setView(data);
          else setError(describe(failure));
        });
    },
    [gameId],
  );
  return { view, busy, error, answer };
}

/** The question on the result: three answers to tap, the one given marked, and who sees it. */
export function TableFitPanel({ fit }: { fit: TableFit }) {
  const view = fit.view;
  if (!view?.asked) return null;
  return (
    <fieldset className={styles.fit}>
      <legend>How did the table fit?</legend>
      <p>
        Its host described this table as{" "}
        <strong>{view.intent_name ?? "a game of its own kind"}</strong>. Was the
        game that?
      </p>
      <div className={styles.fitChoices}>
        {FITS.map(([id, words]) => (
          <button
            key={id}
            type="button"
            aria-pressed={view.fit === id}
            disabled={fit.busy}
            onClick={() => fit.answer(id)}
          >
            {words}
          </button>
        ))}
      </div>
      {view.fit && !fit.error && (
        <p role="status">Counted. You can change your answer.</p>
      )}
      {fit.error && <p role="alert">{fit.error}</p>}
      <small>
        Optional. Only the site&apos;s numbers count it: no player and no host
        sees your answer, and nobody is rated.
      </small>
    </fieldset>
  );
}
