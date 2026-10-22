import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { client, describe, type AccountReset, type AdminUser } from "../api";
import account from "../Account.module.css";
import styles from "./deleteAccount.module.css";

/** What an account without a handle asks to be typed. */
export const RESET_WORD = "RESET";

function count(value: number, one: string, many: string) {
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}

/** The result, for the accounts list's message: what the reset cleared, by the counts. */
export function resetWords(name: string, reset: AccountReset): string {
  return (
    `${name}'s account is new again: ${count(reset.decks, "deck", "decks")} moved to the ` +
    `trash, ${count(reset.cards, "card", "cards")} and ` +
    `${count(reset.packs, "unopened pack", "unopened packs")} cleared, ` +
    `${count(reset.wins, "win", "wins")} set back to 0 and ` +
    `${count(reset.tokens, "token", "tokens")} to 1,000.`
  );
}

/**
 * "Reset account…" (v0.4.5): SysOp gives a player a fresh start, so the setup wizard runs again
 * as a new player sees it. The dialog says what is cleared and what stays, and lets the reset
 * through only once the account's handle (or RESET, when it has none) is typed, whatever its case,
 * as "Delete account…" does, whose look it shares.
 */
export function ResetAccount({
  user,
  onReset,
  onClose,
}: {
  user: AdminUser;
  onReset: (reset: AccountReset) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  useEffect(() => dialog.current?.showModal(), []);
  const word = user.handle ?? RESET_WORD;
  const name = user.handle ?? user.display_name;
  const confirmed = typed.trim().toLowerCase() === word.toLowerCase();
  const ready = confirmed && !busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: refused } = await client.POST(
        "/api/v1/admin/users/{user_id}/reset",
        { params: { path: { user_id: user.id } } },
      );
      if (!data) return setError(describe(refused));
      onReset(data);
      dialog.current?.close();
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <h2 id={titleId}>Reset {name}'s account?</h2>
        <p className={styles.warning}>This cannot be undone.</p>
        <p>
          The account becomes a new one again. The setup wizard welcomes the
          player as it welcomes a new player: a handle, two free starter decks
          and an alliance. They stay signed in.
        </p>
        <h3>Cleared</h3>
        <ul>
          <li>The handle, which anyone may then take, and the alliance.</li>
          <li>
            The library: the starter decks, the cards from packs and every other
            card it held for good. Each starter deck can be chosen or bought
            again.
          </li>
          <li>Unopened packs, and the list of packs opened.</li>
          <li>
            Wins, back to 0, and tokens, back to the 1,000 every new account
            gets. The ledgers keep their history, with “Account reset by SysOp”.
          </li>
          <li>
            Its decks go to the trash, from which the player can restore them.
          </li>
        </ul>
        <h3>Kept</h3>
        <ul>
          <li>
            The Google sign-in, the name, the picture, the settings, the privacy
            settings and the sessions.
          </li>
          <li>
            Friends, requests and blocks, conversations, table chats,
            notifications and bug reports.
          </li>
          <li>Game results, and the audit log, which records the reset.</li>
        </ul>
        <p>
          An account that is playing a game, or seated at an open table, cannot
          be reset until the game ends or it leaves the table.
        </p>
        <label className={account.field}>
          <span>
            Type <strong>{word}</strong> to confirm
          </span>
          <input
            value={typed}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className={account.error}>
            {error}
          </p>
        )}
        {/* aria-disabled, as elsewhere: a disabled button loses keyboard focus. */}
        <div className={account.actions}>
          <button
            type="submit"
            className={account.danger}
            aria-disabled={!ready}
          >
            {busy ? "Resetting…" : "Reset the account"}
          </button>
          <button
            type="button"
            className={account.secondary}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
