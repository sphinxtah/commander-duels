import { useRef, useState } from "react";
import { client, describe } from "../api";
import { ago, tableFullscreen } from "../game/practice";
import { expiresText, saveRules, type SuspendedTable } from "../game/saves";
import { getSoundEngine } from "../game/sound/engine";
import type { TableView } from "./tables";
import game from "../game/game.module.css";
import styles from "./tables.module.css";

/**
 * A private table whose players suspended its game together (v1.0.0, api/saves.py): who is back
 * and ready, this player's own "Ready to play on", and for the host the way to give the game up.
 * The game is taken up once every player still in it is ready; the page then goes to it, as it
 * does when a table's game starts. Nobody is voted out for missing the restart.
 */
export function SuspendedPanel({
  suspended,
  onTable,
  onChanged,
}: {
  suspended: SuspendedTable;
  /** The table as an action's reply has it. */
  onTable(table: TableView): void;
  /** Something changed that the reply does not carry: the table is asked for again. */
  onChanged(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const discardDialog = useRef<HTMLDialogElement>(null);
  const mine = suspended.players.find((player) => player.you);
  const needed = suspended.players.filter((player) => player.needed);
  const waiting = needed.filter((player) => !player.ready);

  async function ready(to: boolean) {
    setBusy(true);
    setRefusal(null);
    const path = { params: { path: { code: suspended.code } } };
    // The last player's "ready" opens the game: the table fills the screen as a start does.
    if (to) {
      void tableFullscreen();
      getSoundEngine().unlock();
    }
    const { data, error } = await (
      to
        ? client.POST("/api/v1/tables/{code}/suspension/ready", path)
        : client.DELETE("/api/v1/tables/{code}/suspension/ready", path)
    ).catch(() => ({ data: undefined, error: {} }));
    setBusy(false);
    if (data) onTable(data);
    else {
      setRefusal(describe(error));
      onChanged();
    }
  }

  async function discard() {
    setBusy(true);
    setRefusal(null);
    const { error } = await client
      .DELETE("/api/v1/saves/{save_id}", {
        params: { path: { save_id: suspended.save_id } },
      })
      .catch(() => ({ error: {} }));
    setBusy(false);
    if (error) setRefusal(describe(error));
    onChanged();
  }

  return (
    <section className={styles.notice} aria-labelledby="suspended-title">
      <div>
        <h2 id="suspended-title" className={styles.suspendedTitle}>
          This table&apos;s game is suspended
        </h2>
        <p>
          {suspended.turn !== null ? `Turn ${suspended.turn}. ` : ""}
          Suspended {ago(suspended.saved_at)}; it runs out{" "}
          {expiresText(suspended.expires_at)}. It is played on from where it
          stopped once every player still in it is back here and ready.
        </p>
        <ul className={styles.suspendedPlayers}>
          {suspended.players.map((player) => (
            <li key={player.seat} data-ready={player.ready}>
              <strong>
                {player.handle ?? "Player"}
                {player.you ? " (you)" : ""}
              </strong>{" "}
              {!player.needed
                ? "is out of the game, and is not waited for"
                : player.ready
                  ? "is ready"
                  : "is not here yet"}
            </li>
          ))}
        </ul>
        <p role="status">
          {waiting.length === 0
            ? "Everyone is ready: opening the game…"
            : `${needed.length - waiting.length} of ${needed.length} ready.`}
        </p>
        {refusal && (
          <p role="alert" className={game.refusal}>
            {refusal}
          </p>
        )}
        <div className={game.gameActions}>
          {mine?.needed &&
            (mine.ready ? (
              <button
                type="button"
                className={game.secondaryButton}
                disabled={busy}
                onClick={() => void ready(false)}
              >
                Not ready after all
              </button>
            ) : (
              <button
                type="button"
                className={game.primaryButton}
                disabled={busy}
                onClick={() => void ready(true)}
              >
                Ready to play on
              </button>
            ))}
          {suspended.you_host && (
            <button
              type="button"
              className={game.secondaryButton}
              disabled={busy}
              onClick={() => discardDialog.current?.showModal()}
            >
              Discard the game
            </button>
          )}
        </div>
        <ul className={game.saveRules}>
          <li>
            It counts as one of {suspended.you_host ? "your" : "the host's"}{" "}
            saved games
            {suspended.you_host ? "" : `, ${suspended.host ?? "the host"}'s`},
            and only the host can discard it.
          </li>
          {saveRules()
            .filter((rule) => !rule.startsWith("You can hold"))
            .map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
        </ul>
      </div>
      <dialog
        ref={discardDialog}
        className={game.confirm}
        aria-labelledby="discard-suspended-title"
      >
        <h2 id="discard-suspended-title">Discard this suspended game?</h2>
        <p>
          The game ends for every player with no result and cannot be played on.
          It counts for nothing: no win, no loss.
        </p>
        <form method="dialog" className={game.confirmButtons}>
          <button type="submit" className={game.secondaryButton} autoFocus>
            Keep it
          </button>
          <button
            type="submit"
            className={game.dangerButton}
            onClick={() => void discard()}
          >
            Discard
          </button>
        </form>
      </dialog>
    </section>
  );
}
