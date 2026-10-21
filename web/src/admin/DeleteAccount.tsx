import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { client, describe, type AdminUser } from "../api";
import account from "../Account.module.css";
import styles from "./deleteAccount.module.css";

/** What an account without a handle asks to be typed. */
export const CONFIRM_WORD = "DELETE";

/**
 * "Delete account…" (v0.4.1): SysOp or an administrator deletes an account for good, when its
 * owner asks. The dialog says what goes and what stays, takes a reason for the audit log, and
 * lets the delete through only once the account's handle (or DELETE, when it has none) is typed.
 * Handles are unique whatever their case, so case does not matter, and a phone's capital letter
 * is no mistake.
 */
export function DeleteAccount({
  user,
  onDeleted,
  onClose,
}: {
  user: AdminUser;
  onDeleted: (deleted: AdminUser) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  useEffect(() => dialog.current?.showModal(), []);
  const word = user.handle ?? CONFIRM_WORD;
  const name = user.handle ?? user.display_name;
  const why = reason.trim();
  const confirmed = typed.trim().toLowerCase() === word.toLowerCase();
  const ready = confirmed && why.length >= 3 && why.length <= 200 && !busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: refused } = await client.POST(
        "/api/v1/admin/users/{user_id}/delete",
        {
          params: { path: { user_id: user.id } },
          body: { reason: why },
        },
      );
      if (!data) return setError(describe(refused));
      onDeleted(data);
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
        <h2 id={titleId}>Delete {name}'s account?</h2>
        <p className={styles.warning}>This cannot be undone.</p>
        <h3>Removed</h3>
        <ul>
          <li>The Google sign-in and the email address.</li>
          <li>The handle, the name, the picture and the settings.</li>
          <li>Every session: the account is signed out everywhere.</li>
          <li>Its roles.</li>
          <li>
            Its decks. A deck a game played keeps only its cards, for that
            game's record.
          </li>
          <li>Its seats at open tables. A table it hosts closes.</li>
          <li>Its bug reports.</li>
        </ul>
        <h3>Kept, as “Deleted player”</h3>
        <ul>
          <li>
            Its game results, wins, tokens, packs and cards, so other players'
            records stay whole.
          </li>
          <li>The audit log, with its addresses.</li>
        </ul>
        <p>
          If the same Google account signs in again, it is a new request for
          approval.
        </p>
        <label className={account.field}>
          <span>
            Reason (3–200 characters, for the audit log: describe the request,
            not the person)
          </span>
          <input
            value={reason}
            minLength={3}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>
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
            {busy ? "Deleting…" : "Delete the account"}
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
