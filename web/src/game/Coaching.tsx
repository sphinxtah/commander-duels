import { useEffect, useState } from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";
import { presenceRank, type PlayerSummary } from "../social/social";
import styles from "./game.module.css";

// Coaching (v1.0.0, docs/games.md): a player lets one friend see what they see while they play,
// their hand included. The coach cannot act, and advises in the friends' chat. Against bots and
// at a private table only, where every player is told the seat has a coach; the player ends it
// whenever they like, and so may the coach. Behind the gate `coaching`.

/** The workflow's id, as the rollout knows it (docs/operations.md). */
export const COACHING = "coaching";

export type Coaching = components["schemas"]["Coaching"];
export type CoachView = components["schemas"]["CoachView"];

/** Ends a coach's access: the player's own coach, or the coach themselves leaving. */
export async function endCoaching(
  gameId: string,
  coachId: string,
): Promise<{ coaching?: Coaching; error?: string }> {
  const { data, error } = await client
    .DELETE("/api/v1/games/{game_id}/coaches/{player_id}", {
      params: { path: { game_id: gameId, player_id: coachId } },
    })
    .catch(() => ({ data: undefined, error: undefined }));
  return data ? { coaching: data } : { error: describe(error) };
}

/** "Coach": the player's dialog at the table. With no coach, a friend to choose; with one, who
 * it is and the way to end it; where nobody may be coached, why. Asked for as it opens. */
export function CoachDialog({
  open,
  gameId,
  onClose,
}: {
  open: boolean;
  gameId: string;
  onClose(): void;
}) {
  const [coaching, setCoaching] = useState<Coaching | null>(null);
  const [friends, setFriends] = useState<PlayerSummary[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [element, setElement] = useState<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (!element) return;
    if (open && !element.open) element.showModal?.();
    if (!open && element.open) element.close();
  }, [open, element]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setCoaching(null);
    setFriends(null);
    setChosen("");
    setError("");
    void client
      .GET("/api/v1/games/{game_id}/coaches", {
        params: { path: { game_id: gameId } },
      })
      .then(({ data, error: failure }) => {
        if (!active) return;
        if (data) setCoaching(data);
        else setError(describe(failure));
      })
      .catch(() => active && setError(describe(undefined)));
    void client
      .GET("/api/v1/friends")
      .then(({ data }) => {
        if (!active) return;
        setFriends(
          [...(data?.friends ?? [])].sort(
            (one, other) =>
              presenceRank(one.presence) - presenceRank(other.presence) ||
              one.handle.localeCompare(other.handle),
          ),
        );
      })
      .catch(() => active && setFriends([]));
    return () => {
      active = false;
    };
  }, [open, gameId]);

  const mine = coaching?.coaches.find((coach) => coach.yours) ?? null;

  async function invite() {
    if (!chosen || busy) return;
    setBusy(true);
    setError("");
    const { data, error: failure } = await client
      .POST("/api/v1/games/{game_id}/coaches", {
        params: { path: { game_id: gameId } },
        body: { player: chosen },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    setBusy(false);
    if (data) setCoaching(data);
    else setError(describe(failure));
  }

  async function end(coach: CoachView) {
    setBusy(true);
    setError("");
    const answer = await endCoaching(gameId, coach.coach.id);
    setBusy(false);
    if (answer.coaching) setCoaching(answer.coaching);
    else setError(answer.error ?? "");
  }

  return (
    <dialog
      ref={setElement}
      className={styles.confirm}
      aria-labelledby="coach-title"
      onClose={onClose}
    >
      <h2 id="coach-title">A coach for this game</h2>
      <p>
        A coach is one friend who sees what you see while you play: the table
        and your hand. They cannot act for you, and advise you in your chat with
        them. Everyone at the game is told that you have a coach, and you end it
        whenever you like.
      </p>
      {!coaching && !error && <p role="status">Asking the table…</p>}
      {mine && (
        <p data-coach>
          <strong>{mine.coach.handle}</strong> is your coach, and sees your hand
          from now until you end it or the game does.
        </p>
      )}
      {coaching && !mine && coaching.reason && (
        <p className={styles.hint}>{coaching.reason}</p>
      )}
      {coaching?.can_invite &&
        (friends === null ? (
          <p role="status">Looking for your friends…</p>
        ) : friends.length === 0 ? (
          <p className={styles.hint}>
            You have no friends yet: a coach is a friend of yours. Find players
            in <a href="#friends">Friends</a>.
          </p>
        ) : (
          <label className={styles.field}>
            <span>Your coach</span>
            <select
              value={chosen}
              onChange={(event) => setChosen(event.target.value)}
            >
              <option value="">Choose a friend</option>
              {friends.map((friend) => (
                <option key={friend.id} value={friend.id}>
                  {friend.handle}
                  {friend.presence?.state === "offline" ? " (offline)" : ""}
                </option>
              ))}
            </select>
          </label>
        ))}
      {error && (
        <p role="alert" className={styles.refusal}>
          {error}
        </p>
      )}
      <div className={styles.confirmButtons}>
        <button
          type="button"
          className={styles.secondaryButton}
          autoFocus
          onClick={onClose}
        >
          {mine ? "Keep playing" : "Close"}
        </button>
        {mine && (
          <button
            type="button"
            className={styles.dangerButton}
            disabled={busy}
            onClick={() => void end(mine)}
          >
            {busy ? "Ending…" : "End coaching"}
          </button>
        )}
        {coaching?.can_invite && (friends?.length ?? 0) > 0 && (
          <button
            type="button"
            className={styles.primaryButton}
            disabled={busy || !chosen}
            onClick={() => void invite()}
          >
            {busy ? "Asking…" : "Show them my hand"}
          </button>
        )}
      </div>
    </dialog>
  );
}
