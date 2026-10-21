import { useState, type FormEvent } from "react";
import { client, describe, type Progress } from "../api";
import account from "../Account.module.css";
import shell from "../App.module.css";
import styles from "./admin.module.css";

// The API's own limits (api/progression.py, WinsChange).
const MAX_WINS = 10_000_000;

/**
 * SysOp sets an account's wins, and so its tier (v0.3.1): any player's from Administration, its
 * own from Profile. The reason is required; the server keeps the setting apart from the wins
 * counted from games, and audits it.
 */
export function SetWins({
  userId,
  subject,
  wins,
  onSet,
  onCancel,
}: {
  userId: string;
  /** Whose wins, as the form's name says them: "your", or an account's handle. */
  subject: string;
  /** The account's wins now, the field's first value. */
  wins?: number;
  onSet: (progress: Progress) => void;
  onCancel?: () => void;
}) {
  const [count, setCount] = useState(wins === undefined ? "" : String(wins));
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  // The first value arrives with the account's progress, which may come after the form.
  const [seen, setSeen] = useState(wins);
  if (wins !== seen) {
    setSeen(wins);
    if (count === "" && wins !== undefined) setCount(String(wins));
  }
  const own = subject === "your";
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = Number(count);
    if (
      count.trim() === "" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > MAX_WINS
    )
      return setError("Wins are a whole number from 0 to 10,000,000.");
    const why = reason.trim();
    if (why.length < 3 || why.length > 200)
      return setError("Give a reason of 3 to 200 characters.");
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const { data, error: refused } = await client.POST(
        "/api/v1/admin/users/{user_id}/wins",
        {
          params: { path: { user_id: userId } },
          body: { wins: value, reason: why },
        },
      );
      if (!data) return setError(describe(refused));
      setReason("");
      setCount(String(data.wins));
      setSaved(
        `${own ? "Your" : `${subject}'s`} wins are now ${data.wins.toLocaleString("en-US")}: ${data.tier.name} tier.`,
      );
      onSet(data);
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.setWins}
      onSubmit={submit}
      aria-label={own ? "Set your wins" : `Set wins for ${subject}`}
    >
      <div className={styles.winsFields}>
        <label className={account.field}>
          <span>Wins</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_WINS}
            step={1}
            value={count}
            onChange={(event) => setCount(event.target.value)}
            required
          />
        </label>
        <label className={account.field}>
          <span>Reason (3–200 characters, for the audit log)</span>
          <input
            value={reason}
            minLength={3}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>
      </div>
      <p role="status" className={account.fine}>
        {saved}
      </p>
      {error && (
        <p role="alert" className={account.error}>
          {error}
        </p>
      )}
      {/* aria-disabled, as elsewhere: a disabled button loses keyboard focus. */}
      <div className={account.actions}>
        <button type="submit" className={shell.primary} aria-disabled={busy}>
          Save wins
        </button>
        {onCancel && (
          <button
            type="button"
            className={account.secondary}
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
