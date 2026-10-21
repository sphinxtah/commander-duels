import { useCallback, useEffect, useRef, useState } from "react";
import { client, describe, type Planeswalker, type Progress } from "../api";

/**
 * The account's wins, tier and alliance, with the roster as its tier opens it (v0.3.1). Asked for
 * together when the account's page opens, and again on reload(): after its wins change, a tier
 * may open or close Planeswalkers.
 */
export function useStanding(accountId: string) {
  const [progress, setProgress] = useState<Progress>();
  const [roster, setRoster] = useState<Planeswalker[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Only the newest question may answer: a reload overtakes the first look.
  const latest = useRef(0);
  useEffect(() => {
    const ticket = ++latest.current;
    void Promise.all([
      client.GET("/api/v1/me/progress"),
      client.GET("/api/v1/planeswalkers"),
    ])
      .then(([mine, all]) => {
        if (ticket !== latest.current) return;
        if (!mine.data || !all.data)
          return setError(describe(mine.error ?? all.error));
        setError("");
        setProgress(mine.data);
        setRoster(all.data);
      })
      .catch(() => {
        if (ticket === latest.current) setError(describe(undefined));
      });
  }, [accountId, attempt]);
  useEffect(
    () => () => {
      // Nothing answers into a page that has gone.
      latest.current += 1;
    },
    [],
  );
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { progress, setProgress, roster, error, reload };
}
