import { useEffect, useRef, useState } from "react";
import { client, type Me, type Progress } from "../api";

/** What the top bar shows of the account (v0.4.5): its tokens and its tier, with its wins. */
export interface Hud {
  balance?: number;
  progress?: Progress;
}

const HUD_CHANGED = "cd:hud-changed";

/**
 * Tells the top bar that the account's tokens or tier changed on the page it is showing (a pack
 * or deck bought, SysOp's grant), so it asks again at once rather than at the next change of page
 * (v0.5.0: the owner's report that the tokens stayed the same after buying a pack).
 */
export function hudChanged(): void {
  window.dispatchEvent(new Event(HUD_CHANGED));
}

/**
 * The top bar's tokens and tier, asked for when the menus open, again on every change of page,
 * since a game may have changed them, and whenever a page says it changed them (`hudChanged`).
 * An answer that fails keeps what was shown; only the newest question may answer.
 */
export function useHud(me: Me | null | undefined, page: string): Hud {
  const [hud, setHud] = useState<Hud>({});
  const [changes, setChanges] = useState(0);
  const latest = useRef(0);
  const account = me?.status === "active" ? me.id : null;
  const alliance = me?.alliance;
  useEffect(() => {
    const again = () => setChanges((count) => count + 1);
    window.addEventListener(HUD_CHANGED, again);
    return () => window.removeEventListener(HUD_CHANGED, again);
  }, []);
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
  }, [account, alliance, page, changes]);
  useEffect(
    () => () => {
      // Nothing answers into a shell that has gone.
      latest.current += 1;
    },
    [],
  );
  return hud;
}
