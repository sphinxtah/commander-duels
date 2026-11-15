import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";
import { seatTitle } from "../tables/kingsTable";
import { getSoundEngine } from "./sound/engine";
import {
  ago,
  deckName,
  formatNames,
  plainClick,
  tableFullscreen,
} from "./practice";
import styles from "./game.module.css";

// Save and resume (v1.0.0, api/saves.py; docs/games.md): a game against the bots is closed into
// its recording and played on later. The table's Game menu saves it (SaveDialog); it then waits
// under "Saved games" on Your games (SavedGames), where it is resumed or discarded. Behind the
// gate save_resume: the pages show the way in only when the account may reach it.

export type SavedGame = components["schemas"]["SavedGame"];
export type Saves = components["schemas"]["Saves"];
export type SuspendedTable = components["schemas"]["SuspendedTable"];

/** The rules as the owner set them, until the server names them (GET /saves). */
export const SAVE_DAYS = 30;
export const SAVE_LIMIT = 5;

/** The rules a save stands under, each a sentence: told before a game is saved and over the list. */
export function saveRules(days = SAVE_DAYS, limit = SAVE_LIMIT): string[] {
  return [
    `A saved game waits ${days} days. After that it ends with no result, and nobody loses.`,
    `You can hold ${limit} saved games at once.`,
    "A save ends when the game is upgraded to a new version: a saved game can only be played on by the version that saved it.",
  ];
}

const ENDED: Record<string, string> = {
  expired: "The save ran out.",
  upgrade:
    "The game was upgraded to a new version, and a saved game can only be played on by the version that saved it.",
  unrecoverable: "The saved game could not be read back.",
};

/** Why a save ended, in a sentence; null for one its player ended. */
export function endedText(save: SavedGame): string | null {
  return (save.ended_reason && ENDED[save.ended_reason]) ?? null;
}

const dayFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

/** "in 12 days", and for the last day "today" or "tomorrow", with the date beside it. */
export function expiresText(iso: string, now = Date.now()): string {
  const days = Math.max(0, Math.floor((Date.parse(iso) - now) / 86_400_000));
  const when =
    days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return `${when} (${dayFormat.format(new Date(iso))})`;
}

/** The account's saved games; undefined until the first answer, null when the workflow is off. */
export function useSaves(enabled: boolean): {
  saves: Saves | null | undefined;
  refresh: () => Promise<void>;
} {
  const [saves, setSaves] = useState<Saves | null>();
  const asked = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) {
      setSaves(null);
      return;
    }
    const number = ++asked.current;
    const answer = await client.GET("/api/v1/saves").catch(() => undefined);
    if (number === asked.current) setSaves(answer?.data ?? null);
  }, [enabled]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { saves, refresh };
}

/**
 * "Save and leave" asked for from the table: what saving means, then the save itself. A refused
 * save says why and leaves the game as it was.
 */
export function SaveDialog({
  dialog,
  gameId,
  onSaved,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  gameId: string;
  /** The game is saved: the table is left for the list it waits in. */
  onSaved(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setRefusal(null);
    const { data, error } = await client
      .POST("/api/v1/games/{game_id}/save", {
        params: { path: { game_id: gameId } },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    setBusy(false);
    if (data) {
      dialog.current?.close();
      onSaved();
    } else setRefusal(describe(error));
  }

  return (
    <dialog
      ref={dialog}
      className={styles.confirm}
      aria-labelledby="save-game-title"
      onClose={() => setRefusal(null)}
    >
      <h2 id="save-game-title">Save this game and leave?</h2>
      <p>
        The game stops here and waits under Saved games on Your games. Resume it
        there to play on from this exact point.
      </p>
      <ul className={styles.saveRules}>
        {saveRules().map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      {refusal && (
        <p role="alert" className={styles.refusal}>
          {refusal}
        </p>
      )}
      <div className={styles.confirmButtons}>
        <button
          type="button"
          className={styles.secondaryButton}
          autoFocus
          onClick={() => dialog.current?.close()}
        >
          Keep playing
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save and leave"}
        </button>
      </div>
    </dialog>
  );
}

/**
 * The saved games on Your games: each to resume or discard, with when it runs out; the rules
 * they stand under; and, for a while, the saves that ended by themselves and why.
 */
export function SavedGames({
  saves,
  onChanged,
}: {
  saves: Saves;
  /** A save was resumed or discarded: the lists are asked for again. */
  onChanged(): void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<SavedGame | null>(null);
  const discardDialog = useRef<HTMLDialogElement>(null);

  async function resume(save: SavedGame) {
    setBusy(save.id);
    setRefusal(null);
    const { data, error } = await client
      .POST("/api/v1/saves/{save_id}/resume", {
        params: { path: { save_id: save.id } },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    setBusy(null);
    if (data) {
      window.location.hash = `#game/${data.id}`;
      return;
    }
    setRefusal(describe(error));
    onChanged();
  }

  async function discard(save: SavedGame) {
    setBusy(save.id);
    setRefusal(null);
    const { error } = await client
      .DELETE("/api/v1/saves/{save_id}", {
        params: { path: { save_id: save.id } },
      })
      .catch(() => ({ error: {} }));
    setBusy(null);
    if (error) setRefusal(describe(error));
    onChanged();
  }

  const tables = saves.tables ?? [];
  if (
    saves.saves.length === 0 &&
    saves.ended.length === 0 &&
    tables.length === 0
  )
    return null;
  const line = (save: SavedGame) => {
    const game = save.game;
    const players = game.seats
      .map((seat) =>
        seat.player === "bot" ? "Bot" : (seat.handle ?? "Player"),
      )
      .join(" · ");
    return (
      <>
        <strong>{formatNames[game.format]}</strong>{" "}
        {game.kings_table && game.your_seat !== null && (
          <span>{seatTitle(game.your_seat)} · </span>
        )}
        <span>{players}</span>
      </>
    );
  };

  return (
    <section aria-label="Saved games" className={styles.saved}>
      <div className={styles.gamesHead}>
        <h2>Saved games</h2>
        <span className={styles.hint}>
          {saves.held ?? saves.saves.length} of {saves.limit}
        </span>
      </div>
      {refusal && (
        <p role="alert" className={styles.refusal}>
          {refusal}
        </p>
      )}
      {saves.saves.length > 0 && (
        <ul className={styles.games}>
          {saves.saves.map((save) => (
            <li key={save.id} data-status="saved">
              <div>
                {line(save)}
                <small>
                  {save.turn !== null ? `Turn ${save.turn} · ` : ""}
                  saved {ago(save.saved_at)} · runs out{" "}
                  {expiresText(save.expires_at)}
                  {save.game.your_seat !== null &&
                    ` · ${deckName(save.game.seats.find((s) => s.seat === save.game.your_seat)?.deck)}`}
                </small>
              </div>
              <div className={styles.gameActions}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={busy !== null}
                  onClick={(event) => {
                    if (plainClick(event.nativeEvent)) {
                      void tableFullscreen();
                      getSoundEngine().unlock();
                    }
                    void resume(save);
                  }}
                >
                  {busy === save.id ? "Resuming…" : "Resume"}
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy !== null}
                  onClick={() => {
                    setDiscarding(save);
                    discardDialog.current?.showModal();
                  }}
                >
                  Discard
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {tables.length > 0 && (
        <ul className={styles.games} aria-label="Suspended tables">
          {tables.map((table) => {
            const needed = table.players.filter((player) => player.needed);
            return (
              <li key={table.code} data-status="saved">
                <div>
                  <strong>{formatNames[table.format]} table</strong>{" "}
                  <span>
                    {table.players
                      .map((player) => player.handle ?? "Player")
                      .join(" · ")}
                  </span>
                  <small>
                    {table.you_host
                      ? "You host it · "
                      : `Hosted by ${table.host ?? "a player"} · `}
                    {table.turn !== null ? `Turn ${table.turn} · ` : ""}
                    suspended {ago(table.saved_at)} · runs out{" "}
                    {expiresText(table.expires_at)} ·{" "}
                    {needed.filter((player) => player.ready).length} of{" "}
                    {needed.length} ready to play on
                  </small>
                </div>
                <div className={styles.gameActions}>
                  <a
                    className={styles.primaryButton}
                    href={`#tables/${table.code}`}
                  >
                    Go to the table
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {saves.ended.length > 0 && (
        <ul className={styles.games} aria-label="Saves that ended">
          {saves.ended.map((save) => (
            <li key={save.id} data-status="ended">
              <div>
                {line(save)}
                <small>
                  Saved {ago(save.saved_at)}, and not played on.{" "}
                  {endedText(save)} The game ended with no result.
                </small>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ul className={styles.saveRules}>
        {saveRules(saves.days, saves.limit).map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
        {tables.length > 0 && (
          <li>
            A suspended table&apos;s game is played on at its table, once every
            player still in it is back and ready. It counts as one of its
            host&apos;s saved games.
          </li>
        )}
      </ul>
      <dialog
        ref={discardDialog}
        className={styles.confirm}
        aria-labelledby="discard-save-title"
        onClose={() => setDiscarding(null)}
      >
        <h2 id="discard-save-title">Discard this saved game?</h2>
        <p>
          The game ends with no result and cannot be resumed. It counts for
          nothing: no win, no loss.
        </p>
        <form method="dialog" className={styles.confirmButtons}>
          <button type="submit" className={styles.secondaryButton} autoFocus>
            Keep it
          </button>
          <button
            type="submit"
            className={styles.dangerButton}
            onClick={() => discarding && void discard(discarding)}
          >
            Discard
          </button>
        </form>
      </dialog>
    </section>
  );
}
