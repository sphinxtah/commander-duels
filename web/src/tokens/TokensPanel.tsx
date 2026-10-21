import { useEffect, useState } from "react";
import { client, describe, type Tokens } from "../api";
import account from "../Account.module.css";
import { change, lineWords, tokens } from "./tokens";
import styles from "./tokens.module.css";

/** The newest entries shown before "Show more"; the server sends up to 50. */
const FIRST = 8;

function when(value: string) {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** The account's tokens on its profile: the balance, where it came from, and the latest entries. */
export function TokensPanel({ refresh = 0 }: { refresh?: number }) {
  const [shown, setShown] = useState<Tokens>();
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/me/tokens")
      .then(({ data, error: refused }) => {
        if (!active) return;
        if (data) {
          setShown(data);
          setError("");
        } else setError(describe(refused));
      })
      .catch(() => active && setError(describe(undefined)));
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    <section className={account.panel} aria-labelledby="tokens-title">
      <h2 id="tokens-title">Your tokens</h2>
      {error && (
        <p role="alert" className={account.error}>
          {error}
        </p>
      )}
      {shown && (
        <>
          <p className={styles.balance}>
            <strong>{shown.balance.toLocaleString("en-US")}</strong>
            <span>{Math.abs(shown.balance) === 1 ? "token" : "tokens"}</span>
          </p>
          <p className={account.fine}>
            {tokens(shown.earned)} won in games · {tokens(shown.given)} given ·{" "}
            {tokens(shown.spent)} spent in Leng's card shop
          </p>
          <p className={account.fine}>
            A win pays 5 to 20 tokens for each bot you beat, by its skill, and
            50 to 500 for each player you beat, by how many games they have won.
            Wins over the same player pay for the first three each day.
          </p>
          {shown.entries.length > 0 && (
            <>
              <ul className={styles.ledger} aria-label="Latest tokens">
                {(all ? shown.entries : shown.entries.slice(0, FIRST)).map(
                  (line, i) => (
                    <li key={i}>
                      <span
                        className={styles.amount}
                        data-sign={Math.sign(line.amount)}
                      >
                        {change(line.amount)}
                      </span>
                      <span>
                        {lineWords(line)}
                        {line.reason && line.kind !== "pack" && (
                          <small>{line.reason}</small>
                        )}
                      </span>
                      <time dateTime={line.created_at}>
                        {when(line.created_at)}
                      </time>
                    </li>
                  ),
                )}
              </ul>
              {!all && shown.entries.length > FIRST && (
                <button
                  type="button"
                  className={account.secondary}
                  onClick={() => setAll(true)}
                >
                  Show more
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
