import { useCallback, useEffect, useRef, useState } from "react";
import { client, type Me } from "../api";
import type { NotificationItem } from "./social";

// The app's check-in (v0.4.3): every CHECK_IN_MS each open tab tells the server that the app is
// open, and whether its player has left it (the tab hidden, or untouched for IDLE_MS). That is
// all the browser says, and only about its own player: who is online, idle or in a game is the
// server's to work out. It runs on every screen, the table's too. The answer brings the unread
// count for the bell and any notification newer than the last one the page knew of, which the
// page shows for a moment. The API does not count check-ins as activity, so an open tab never
// keeps a session from its idle limit.

export const CHECK_IN_MS = 30_000;
export const IDLE_MS = 5 * 60_000;
// Coming back to a tab checks in at once, unless it did just now.
const AGAIN_MS = 10_000;
const EPOCH = "1970-01-01T00:00:00Z";

export type Social = {
  /** Unread notifications, for the bell. */
  unread: number;
  setUnread: (count: number) => void;
  /** Notifications that came since the last check-in, newest first, until dismissed. */
  toasts: NotificationItem[];
  dismiss: (id: string) => void;
  /** Checks in now, as after reading notifications elsewhere. */
  checkIn: () => void;
};

export function useSocial(me: Me | null | undefined): Social {
  const account = me?.status === "active" ? me.id : null;
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<NotificationItem[]>([]);
  const ask = useRef<() => void>(() => undefined);
  useEffect(() => {
    setUnread(0);
    setToasts([]);
    if (!account) return;
    let active = true;
    let lastInput = Date.now();
    let lastCheckIn = 0;
    let asking = false;
    // The newest notification the page knows of: the first answer sets it, so nothing that came
    // before the page opened pops up.
    let since: string | undefined;
    const used = () => {
      lastInput = Date.now();
    };
    const question = async () => {
      if (asking) return;
      asking = true;
      lastCheckIn = Date.now();
      const idle =
        document.visibilityState === "hidden" ||
        Date.now() - lastInput > IDLE_MS;
      try {
        const { data } = await client.POST("/api/v1/presence", {
          body: { idle, since: since ?? null },
        });
        if (active && data) {
          setUnread(data.unread);
          if (since !== undefined && data.fresh.length > 0)
            setToasts((shown) => [
              ...data.fresh,
              ...shown.filter(
                (old) => !data.fresh.some((item) => item.id === old.id),
              ),
            ]);
          // With none yet, every later one is new.
          since = data.newest ?? EPOCH;
        }
      } catch {
        // An unreachable service: the next check-in tries again.
      } finally {
        asking = false;
      }
    };
    const back = () => {
      if (
        document.visibilityState !== "hidden" &&
        Date.now() - lastCheckIn > AGAIN_MS
      )
        void question();
    };
    ask.current = () => void question();
    void question();
    const timer = window.setInterval(() => void question(), CHECK_IN_MS);
    const inputs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const name of inputs)
      window.addEventListener(name, used, { passive: true, capture: true });
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      active = false;
      ask.current = () => undefined;
      window.clearInterval(timer);
      for (const name of inputs)
        window.removeEventListener(name, used, { capture: true });
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [account]);
  const dismiss = useCallback(
    (id: string) =>
      setToasts((shown) => shown.filter((item) => item.id !== id)),
    [],
  );
  const checkIn = useCallback(() => ask.current(), []);
  return {
    unread: account ? unread : 0,
    setUnread,
    toasts: account ? toasts : [],
    dismiss,
    checkIn,
  };
}
