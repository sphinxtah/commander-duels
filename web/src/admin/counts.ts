import { useCallback, useEffect, useRef, useState } from "react";
import { answerTimeout, client, type AdminCounts, type Me } from "../api";

// What waits for Administration (v0.4.1): accounts to approve and unread problem reports. SysOp
// and administrators see the counts on Admin in the navigation, on Administration's tabs and in
// the browser tab's title. The page asks every minute while it is shown, and again when the
// window regains focus or is shown again; a hidden page waits. The API does not count these
// questions as activity, so they never keep a session from its idle limit.

export const COUNTS_MS = 60_000;

/** Whether the account sees either count: it approves accounts or reads reports. */
export function watchesCounts(me: Me | null | undefined): boolean {
  return Boolean(
    me &&
    me.status === "active" &&
    (me.permissions.includes("admin.users.manage") ||
      me.permissions.includes("reports.manage")),
  );
}

export function countsTotal(counts: AdminCounts | null | undefined): number {
  return (counts?.pending_accounts ?? 0) + (counts?.unread_reports ?? 0);
}

export function pendingWords(count: number): string {
  return count === 1
    ? "1 account waiting for approval"
    : `${count} accounts waiting for approval`;
}

export function unreadWords(count: number): string {
  return count === 1 ? "1 unread report" : `${count} unread reports`;
}

/** "2 accounts waiting for approval, 1 unread report"; empty when nothing waits. */
export function countsWords(counts: AdminCounts | null | undefined): string {
  const words: string[] = [];
  if (counts?.pending_accounts)
    words.push(pendingWords(counts.pending_accounts));
  if (counts?.unread_reports) words.push(unreadWords(counts.unread_reports));
  return words.join(", ");
}

/**
 * The counts for an account that watches them, else null; and `refresh`, which asks at once, as
 * after an approval or a report opened.
 */
export function useAdminCounts(me: Me | null | undefined): {
  counts: AdminCounts | null;
  refresh: () => void;
} {
  const watching = watchesCounts(me);
  const account = watching ? me!.id : null;
  const [counts, setCounts] = useState<AdminCounts | null>(null);
  const ask = useRef<() => void>(() => undefined);
  useEffect(() => {
    setCounts(null);
    if (!account) return;
    let active = true;
    // One question at a time; one asked for meanwhile follows it.
    let asking = false;
    let again = false;
    const question = async () => {
      if (asking) {
        again = true;
        return;
      }
      asking = true;
      const timeout = answerTimeout();
      try {
        const { data } = await client.GET("/api/v1/admin/counts", {
          signal: timeout.signal,
        });
        if (active && data) setCounts(data);
      } catch {
        // An unreachable service: the counts stay as they were.
      } finally {
        timeout.done();
        asking = false;
      }
      if (active && again) {
        again = false;
        void question();
      }
    };
    const shown = () => {
      if (document.visibilityState !== "hidden") void question();
    };
    ask.current = () => void question();
    shown();
    const timer = window.setInterval(shown, COUNTS_MS);
    window.addEventListener("focus", shown);
    document.addEventListener("visibilitychange", shown);
    return () => {
      active = false;
      ask.current = () => undefined;
      window.clearInterval(timer);
      window.removeEventListener("focus", shown);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [account]);
  const refresh = useCallback(() => ask.current(), []);
  return { counts: account ? counts : null, refresh };
}

const PREFIX = /^\(\d+\) /;

/**
 * Puts "(3) " before the browser tab's title while the total is not zero, whatever page set the
 * title (the game screen sets its own), and takes it away again.
 */
export function useCountTitle(total: number) {
  useEffect(() => {
    const apply = () => {
      const plain = document.title.replace(PREFIX, "");
      const wanted = total > 0 ? `(${total}) ${plain}` : plain;
      if (document.title !== wanted) document.title = wanted;
    };
    apply();
    if (total <= 0) return;
    const title = document.querySelector("title");
    if (!title) return;
    // A page that sets its own title replaces the text; the count goes back in front of it.
    const watcher = new MutationObserver(apply);
    watcher.observe(title, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      watcher.disconnect();
      document.title = document.title.replace(PREFIX, "");
    };
  }, [total]);
}
