import { useState, type FormEvent } from "react";
import { client, describe, type Tokens } from "../api";
import account from "../Account.module.css";
import shell from "../App.module.css";
import { tokens } from "./tokens";
import styles from "./tokens.module.css";

// The API's own limit (api/economy.py, TokenGrant).
const MAX_GRANT = 100_000_000;

/**
 * SysOp gives tokens to an account, or takes them back with a negative amount (v0.4.0): any
 * player's from Administration, its own from Profile. The reason is required; the server keeps
 * grants apart from tokens won, never lets a balance go below zero, and audits each one.
 */
export function GiveTokens({
  userId,
  subject,
  onGiven,
  onCancel,
}: {
  userId: string;
  /** Whose tokens, as the form's name says them: "your", or an account's handle. */
  subject: string;
  onGiven: (tokens: Tokens) => void;
  onCancel?: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const own = subject === "your";
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = Number(amount);
    if (
      amount.trim() === "" ||
      !Number.isInteger(value) ||
      value === 0 ||
      Math.abs(value) > MAX_GRANT
    )
      return setError(
        "Give a whole number of tokens up to 100,000,000; a negative number takes them back.",
      );
    const why = reason.trim();
    if (why.length < 3 || why.length > 200)
      return setError("Give a reason of 3 to 200 characters.");
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const { data, error: refused } = await client.POST(
        "/api/v1/admin/users/{user_id}/tokens",
        {
          params: { path: { user_id: userId } },
          body: { amount: value, reason: why },
        },
      );
      if (!data) return setError(describe(refused));
      setAmount("");
      setReason("");
      setSaved(
        `${own ? "Your" : `${subject}'s`} balance is now ${tokens(data.balance)}.`,
      );
      onGiven(data);
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      aria-label={own ? "Give yourself tokens" : `Give tokens to ${subject}`}
    >
      <div className={styles.fields}>
        <label className={account.field}>
          <span>Tokens (negative takes back)</span>
          <input
            type="number"
            inputMode="numeric"
            min={-MAX_GRANT}
            max={MAX_GRANT}
            step={1}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
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
          Give tokens
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
