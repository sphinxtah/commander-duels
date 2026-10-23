import { useEffect, useState } from "react";
import { client, describe } from "../api";
import { Badge } from "./Badge";
import { HistoryList } from "./HistoryList";
import { RecordTable } from "./RecordTable";
import type { PlayerBadges, Stats } from "./records";
import styles from "./records.module.css";

// A player's record on their page (#player/<id>, v0.5.0): the badges they pinned, every badge
// they earned and their totals, for whoever may open the page. Their games one by one show only
// on their own page and to SysOp, as the server's answer says (Stats.history).

export function PlayerRecord({
  playerId,
  handle,
}: {
  playerId: string;
  handle: string;
}) {
  const [stats, setStats] = useState<Stats>();
  const [badges, setBadges] = useState<PlayerBadges>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const path = { params: { path: { player_id: playerId } } };
    setStats(undefined);
    setBadges(undefined);
    setError("");
    void Promise.all([
      client.GET("/api/v1/players/{player_id}/stats", path),
      client.GET("/api/v1/players/{player_id}/achievements", path),
    ])
      .then(([found, earned]) => {
        if (!active) return;
        if (found.data) setStats(found.data);
        if (earned.data) setBadges(earned.data);
        if (!found.data || !earned.data)
          setError(describe(found.error ?? earned.error));
      })
      .catch(() => active && setError(describe(undefined)));
    return () => {
      active = false;
    };
  }, [playerId]);

  return (
    <>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {badges && (
        <section
          className={styles.section}
          aria-labelledby="player-badges-title"
        >
          <h2 id="player-badges-title">Badges</h2>
          {badges.pinned.length > 0 ? (
            <ul className={styles.pinned} aria-label="Pinned badges">
              {badges.pinned.map((badge) => (
                <li key={badge.id} title={badge.description}>
                  <Badge group={badge.group} earned size={72} />
                  <strong>{badge.name}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.fine}>{handle} has pinned no badges yet.</p>
          )}
          <p className={styles.fine}>
            {badges.earned.length} of {badges.total} achievements earned.
          </p>
          {badges.earned.length > 0 && (
            <ul className={styles.earned} aria-label="Badges earned">
              {badges.earned.map((badge) => (
                <li
                  key={badge.id}
                  title={`${badge.name}: ${badge.description}`}
                >
                  <Badge
                    group={badge.group}
                    earned
                    size={40}
                    label={badge.name}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {stats && (
        <section
          className={styles.section}
          aria-labelledby="player-record-title"
        >
          <h2 id="player-record-title">Record</h2>
          <RecordTable stats={stats} label={`${handle}'s record`} />
        </section>
      )}
      {stats?.history && (
        <section
          className={styles.section}
          aria-labelledby="player-games-title"
        >
          <h2 id="player-games-title">Games</h2>
          <p className={styles.fine}>
            Only {handle} and SysOp see these games one by one.
          </p>
          <HistoryList playerId={playerId} />
        </section>
      )}
    </>
  );
}
