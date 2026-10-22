import { useEffect, useRef, useState } from "react";
import { client, type Me, type Progress } from "../api";

/** What the top bar shows of the account (v0.4.5): its tokens and its tier, with its wins. */
export interface Hud {
  balance?: number;
  progress?: Progress;
}

/**
 * The top bar's tokens and tier, asked for when the menus open and again on every change of page,
 * since a game, a purchase or SysOp's grant may have changed them. An answer that fails keeps
 * what was shown; only the newest question may answer.
 */
export function useHud(me: Me | null | undefined, page: string): Hud {
  const [hud, setHud] = useState<Hud>({});
  const latest = useRef(0);
  const account = me?.status === "active" ? me.id : null;
  const alliance = me?.alliance;
  useEffect(() => {
    const ticket = ++latest.current;
    if (!account) return setHud({});
    void Promise.allSettled([
      client.GET("/api/v1/me/tokens"),
      client.GET("/api/v1/me/progress"),
    ]).then(([tokens, progress]) => {
      if (ticket !== latest.current) return;
      setHud((current) => ({
        balance:
          tokens.status === "fulfilled" && tokens.value.data
            ? tokens.value.data.balance
            : current.balance,
        progress:
          progress.status === "fulfilled" && progress.value.data
            ? progress.value.data
            : current.progress,
      }));
    });
  }, [account, alliance, page]);
  useEffect(
    () => () => {
      // Nothing answers into a shell that has gone.
      latest.current += 1;
    },
    [],
  );
  return hud;
}
