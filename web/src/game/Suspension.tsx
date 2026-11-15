import { useState, type RefObject } from "react";
import { client, describe } from "../api";
import type { GameState } from "./connection";
import { saveRules } from "./saves";
import type { Seat } from "./types";
import away from "./away.module.css";
import styles from "./game.module.css";

// Suspending a private table's game (v1.0.0, api/saves.py; docs/tables.md): the multiplayer
// "Save and leave". Never one player's word: any player still in the game proposes, every player
// still in it who is present must agree, and one who declines ends the proposal. A player away
// for two minutes or longer does not vote, so a table can pause when someone drops. The save is
// the host's, and the game is played on at the table once everyone still in it is back and ready.

/** What a suspension is, each a sentence: told before it is proposed. */
export function suspensionRules(): string[] {
  return [
    "Every player still in the game who is here must agree. A player away for 2 minutes or longer is not asked.",
    "The game is played on at its table, once every player still in it is back and ready.",
    "It counts as one of the host's saved games, and the host alone can discard it.",
    ...saveRules().filter((rule) => !rule.startsWith("You can hold")),
  ];
}

async function vote(code: string, agree: boolean): Promise<string | null> {
  const { error } = await (
    agree
      ? client.POST("/api/v1/tables/{code}/suspension", {
          params: { path: { code } },
        })
      : client.DELETE("/api/v1/tables/{code}/suspension", {
          params: { path: { code } },
        })
  ).catch(() => ({ error: {} }));
  return error ? describe(error) : null;
}

/** "Suspend the game" asked for from the Game menu: what it means, then the proposal. */
export function SuspendDialog({
  dialog,
  code,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  code: string;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function propose() {
    setBusy(true);
    setRefusal(null);
    const refused = await vote(code, true);
    setBusy(false);
    if (refused) setRefusal(refused);
    else dialog.current?.close();
  }

  return (
    <dialog
      ref={dialog}
      className={styles.confirm}
      aria-labelledby="suspend-game-title"
      onClose={() => setRefusal(null)}
    >
      <h2 id="suspend-game-title">Propose to suspend this game?</h2>
      <p>
        The game stops where it is and waits for all of you to play it on later,
        from this exact point. The other players are asked to agree.
      </p>
      <ul className={styles.saveRules}>
        {suspensionRules().map((rule) => (
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
          onClick={() => void propose()}
        >
          {busy ? "Proposing…" : "Propose to suspend"}
        </button>
      </div>
    </dialog>
  );
}

function listed(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The proposal on the table, in the prompt column beside the away players: who proposed it, who
 * agreed, who is still asked, and this player's own answer. And, once, how the last one ended.
 */
export function SuspensionVote({
  state,
  code,
  name,
}: {
  state: GameState;
  /** The table's code; null where the game names no table. */
  code: string | null;
  name: (seat: Seat) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const proposal = state.suspension;
  const ended = state.suspensionEnded;
  if (!proposal && !ended) return null;

  async function answer(agree: boolean) {
    if (!code) return;
    setBusy(true);
    setRefusal(null);
    const refused = await vote(code, agree);
    setBusy(false);
    setRefusal(refused);
  }

  if (!proposal)
    return (
      <section className={away.away} aria-labelledby="suspension-title">
        <h2 id="suspension-title">Suspending the game</h2>
        <p role="status">
          {ended?.refused
            ? `The game could not be suspended. ${ended.refused}`
            : ended?.declinedBy === state.seat
              ? "You ended the proposal to suspend the game. It goes on."
              : `${ended?.declinedBy != null ? name(ended.declinedBy as Seat) : "A player"} declined to suspend the game. It goes on.`}
        </p>
      </section>
    );

  const mine = state.seat;
  const asked = mine !== null && proposal.needed.includes(mine);
  const agreed = mine !== null && proposal.agreed.includes(mine);
  const waiting = proposal.needed.filter(
    (seat) => !proposal.agreed.includes(seat),
  );
  const who = (seat: number) => (seat === mine ? "you" : name(seat as Seat));
  return (
    <section className={away.away} aria-labelledby="suspension-title">
      <h2 id="suspension-title">Suspending the game</h2>
      <p role="status">
        {proposal.proposedBy === mine
          ? "You propose"
          : `${name(proposal.proposedBy as Seat)} proposes`}{" "}
        to suspend this game and play it on later.{" "}
        {waiting.length > 0
          ? `Waiting for ${listed(waiting.map(who))}.`
          : "Everyone agreed: suspending…"}
      </p>
      <small>
        {proposal.agreed.length} of {proposal.needed.length} agreed. A player
        away for 2 minutes or longer is not asked.
      </small>
      {asked && code && (
        <span className={away.buttons}>
          {!agreed && (
            <button
              type="button"
              className={away.wait}
              disabled={busy}
              onClick={() => void answer(true)}
            >
              Agree to suspend
            </button>
          )}
          <button
            type="button"
            className={away.remove}
            disabled={busy}
            onClick={() => void answer(false)}
          >
            {agreed ? "Withdraw" : "Decline"}
          </button>
        </span>
      )}
      {refusal && (
        <p role="alert" className={away.refusal}>
          {refusal}
        </p>
      )}
    </section>
  );
}
