import { useEffect, useState } from "react";
import { client, describe } from "../api";
import account from "../Account.module.css";
import { AchievementsPanel } from "./AchievementsPanel";
import { HistoryList } from "./HistoryList";
import { RecordTable } from "./RecordTable";
import type { Stats } from "./records";

// Profile's record (v0.5.0, PROG08): the account's totals, its achievements and its games one by
// one. Other players see the totals and the badges on the account's player page; the games are
// the account's own, and SysOp's to read.

export function RecordPanels() {
  const [stats, setStats] = useState<Stats>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/me/stats")
      .then(({ data, error: refused }) => {
        if (!active) return;
        if (data) setStats(data);
        else setError(describe(refused));
      })
      .catch(() => active && setError(describe(undefined)));
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <section className={account.panel} aria-labelledby="record-title">
        <h2 id="record-title">Your record</h2>
        {error && (
          <p role="alert" className={account.error}>
            {error}
          </p>
        )}
        {stats && <RecordTable stats={stats} label="Your record" />}
        <p className={account.fine}>
          Every game the server recorded counts: a win, a loss when another
          seat won or you conceded, a draw, or no result for a turn limit or a
          game that was closed. Every player who opens your profile sees these
          totals and your badges.
        </p>
      </section>
      <AchievementsPanel />
      <section className={account.panel} aria-labelledby="games-title">
        <h2 id="games-title">Your games</h2>
        <p className={account.fine}>
          Only you and SysOp see your games one by one. Other players' decks are
          never shown.
        </p>
        <HistoryList />
      </section>
    </>
  );
}
