import { useEffect, useState } from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";
import styles from "../Account.module.css";
import admin from "./admin.module.css";

// Administration's Numbers tab (v1.0.0): the site's numbers (docs/operations.md), read from
// `GET /api/v1/admin/operations`, for SysOp and administrators (admin.audit.read). Counts,
// codes and ids, and nothing concealed. It begins with the games' record and with how tables
// fit what they described (Rule Zero, the owner's decision 25): the players' answers are tallied
// here and shown nowhere else, to no player and no host.

type Operations = components["schemas"]["Operations"];
type FitCount = components["schemas"]["FitCount"];

/** The kinds of game a table's profile names, as the API does. */
const INTENT_NAMES: Record<string, string> = {
  learning: "Learning game",
  precon: "Preconstructed decks",
  upgraded: "Upgraded casual",
  high_power: "High power",
  competitive: "Competitive",
  custom: "Custom",
};

function when(value: string) {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function answers(count: FitCount): number {
  return count.as_described + count.stronger + count.weaker;
}

/** A share of the answers, in whole percent. */
function share(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "–";
}

export function SiteNumbers() {
  const [numbers, setNumbers] = useState<Operations | null>(null);
  const [message, setMessage] = useState("");
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/admin/operations")
      .catch(() => ({ data: undefined, error: undefined }))
      .then(({ data, error }) => {
        if (!active) return;
        setBusy(false);
        if (data) {
          setNumbers(data);
          setMessage("");
        } else setMessage(describe(error));
      });
    return () => {
      active = false;
    };
  }, [asked]);

  const fit = numbers?.table_fit ?? [];
  const total = fit.reduce((sum, count) => sum + answers(count), 0);
  return (
    <section className={styles.panel} aria-labelledby="numbers-title">
      <h2 id="numbers-title">The site&apos;s numbers</h2>
      <p className={styles.fine}>
        Counts, codes and ids: no hand, deck list, library or chat is read here.{" "}
        {numbers &&
          `Version ${numbers.version}, migration ${numbers.migration}, as of ${when(numbers.now)}.`}
      </p>
      <button
        type="button"
        className={styles.secondary}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setAsked((n) => n + 1);
        }}
      >
        {busy ? "Reading…" : "Read again"}
      </button>
      {message && (
        <p role="alert" className={styles.error}>
          {message}
        </p>
      )}
      {numbers && (
        <>
          <h3 className={admin.numbersHead}>Games</h3>
          <dl className={admin.standing}>
            <div>
              <dt>Running now</dt>
              <dd>{numbers.games.running}</dd>
            </div>
            <div>
              <dt>Recorded as running</dt>
              <dd>{numbers.games.active}</dd>
            </div>
            <div>
              <dt>Finished, last day</dt>
              <dd>{numbers.games.last_day.finished}</dd>
            </div>
            <div>
              <dt>Interrupted, last day</dt>
              <dd>{numbers.games.last_day.interrupted}</dd>
            </div>
            <div>
              <dt>Finished, last week</dt>
              <dd>{numbers.games.last_week.finished}</dd>
            </div>
            <div>
              <dt>Interrupted, last week</dt>
              <dd>{numbers.games.last_week.interrupted}</dd>
            </div>
          </dl>

          <h3 className={admin.numbersHead} id="fit-title">
            How tables fit what they described
          </h3>
          <p className={styles.fine}>
            After a game at a table that described itself, each of its players
            may say whether it was as described, stronger or weaker. The answers
            are counted here by the kind of game the table named, and shown
            nowhere else: no player and no host sees one, and nothing rates a
            player, a host or a deck.
          </p>
          {total === 0 ? (
            <p className={styles.fine}>No player has answered yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.audit} aria-labelledby="fit-title">
                <thead>
                  <tr>
                    <th scope="col">Described as</th>
                    <th scope="col">Answers</th>
                    <th scope="col">As described</th>
                    <th scope="col">Stronger</th>
                    <th scope="col">Weaker</th>
                  </tr>
                </thead>
                <tbody>
                  {fit.map((count) => {
                    const all = answers(count);
                    return (
                      <tr key={count.intent}>
                        <th scope="row">
                          {INTENT_NAMES[count.intent] ?? count.intent}
                        </th>
                        <td>{all}</td>
                        <td>
                          {count.as_described} ({share(count.as_described, all)}
                          )
                        </td>
                        <td>
                          {count.stronger} ({share(count.stronger, all)})
                        </td>
                        <td>
                          {count.weaker} ({share(count.weaker, all)})
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
