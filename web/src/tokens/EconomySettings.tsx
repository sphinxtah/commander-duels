import { useEffect, useState, type FormEvent } from "react";
import { client, describe, type EconomySettings as Settings } from "../api";
import account from "../Account.module.css";
import shell from "../App.module.css";
import { tokens } from "./tokens";
import styles from "./tokens.module.css";

// The API's own limit (api/economy.py, EconomySettings).
const MAX_CAP = 100_000;

/**
 * The economy's rules and SysOp's setting (v0.4.0, PROG05): an optional daily cap on the tokens
 * bots pay one account. Administrators read it; SysOp changes it, and the audit log records each
 * change.
 */
export function EconomySettings({ canChange }: { canChange: boolean }) {
  const [settings, setSettings] = useState<Settings>();
  const [capped, setCapped] = useState(false);
  const [cap, setCap] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/admin/economy")
      .then(({ data, error: refused }) => {
        if (!active) return;
        if (!data) return setError(describe(refused));
        setSettings(data);
        setCapped(data.bot_daily_cap !== null);
        setCap(data.bot_daily_cap === null ? "" : String(data.bot_daily_cap));
      })
      .catch(() => active && setError(describe(undefined)));
    return () => {
      active = false;
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = Number(cap);
    if (capped && (!Number.isInteger(value) || value < 1 || value > MAX_CAP))
      return setError("The cap is a whole number of tokens from 1 to 100,000.");
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const { data, error: refused } = await client.PUT(
        "/api/v1/admin/economy",
        { body: { bot_daily_cap: capped ? value : null } },
      );
      if (!data) return setError(describe(refused));
      setSettings(data);
      setSaved(
        data.bot_daily_cap === null
          ? "Bots pay without a daily cap."
          : `Bots now pay each account at most ${tokens(data.bot_daily_cap)} a day.`,
      );
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={account.panel} aria-labelledby="economy-title">
      <h2 id="economy-title">Tokens</h2>
      <p className={account.fine}>
        A win pays its winner for each seat beaten: 5, 8, 11, 14, 17 or 20
        tokens for a bot of skill 1 to 6, and 50 + 90 × log₁₀(1 + wins) tokens,
        at most 500, for a player with that many wins. Wins over the same player
        pay for the first 3 each day (Arizona time). Every account started with
        1,000 tokens. Only SysOp gives or takes back tokens, from each account's
        row.
      </p>
      {error && (
        <p role="alert" className={account.error}>
          {error}
        </p>
      )}
      {settings &&
        (canChange ? (
          <form className={styles.form} onSubmit={submit}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={capped}
                onChange={(event) => setCapped(event.target.checked)}
              />
              Cap the tokens bots pay each account in a day
            </label>
            {capped && (
              <label className={account.field}>
                <span>Daily cap in tokens</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_CAP}
                  step={1}
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                  required
                />
              </label>
            )}
            <p role="status" className={account.fine}>
              {saved}
            </p>
            <div className={account.actions}>
              <button
                type="submit"
                className={shell.primary}
                aria-disabled={busy}
              >
                Save
              </button>
            </div>
          </form>
        ) : (
          <p className={account.fine}>
            {settings.bot_daily_cap === null
              ? "Bots pay without a daily cap."
              : `Bots pay each account at most ${tokens(settings.bot_daily_cap)} a day.`}
          </p>
        ))}
    </section>
  );
}
