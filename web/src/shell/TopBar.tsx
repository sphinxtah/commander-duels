import { useEffect, useId, useRef, useState } from "react";
import { avatars, useSignOut } from "../Account";
import { canAdminister } from "../Admin";
import { countsWords } from "../admin/counts";
import { Portrait } from "../alliance/Portrait";
import type { AdminCounts, Me } from "../api";
import { ReportDialog } from "../app/ReportProblem";
import { UpdateNotice } from "../app/UpdateNotice";
import { NotificationBell } from "../social/Notifications";
import { PlayerSearch } from "../social/PlayerSearch";
import type { Social } from "../social/presence";
import type { Hud } from "./hud";
import { selectSound } from "./menuSound";
import { Icon, type Page } from "./pages";
import styles from "./shell.module.css";

export type Connection = "loading" | "connected" | "unavailable";

/** What the connection's dot says, in words for screen readers and the account's menu. */
export function connectionWords(connection: Connection, online: boolean) {
  if (!online) return "Offline";
  return connection === "loading"
    ? "Connecting"
    : connection === "connected"
      ? "Service connected"
      : "Service unavailable";
}

function badge(count: number) {
  return count > 99 ? "99+" : String(count);
}

/**
 * The top bar (v0.4.5), as in Magic Duels' menus: the mark that leads home, the player search,
 * centred over the main menu's tiles, and the account's corner (its tokens, Friends, the bell and
 * its own menu). Its links to the main menu's six pages, and the phone's bar of them, went in
 * v0.6.1: the tiles lead to every page, and every other page's band back to them. Messages, beside
 * Friends until v0.5.1, are on the chat bar along the bottom of every page (chat/ChatBar.tsx).
 */
export function TopBar({
  me,
  shown,
  hud,
  social,
  counts,
  connection,
  online,
  onChange,
  onSignedOut,
}: {
  me: Me;
  shown: Page;
  hud: Hud;
  social: Social;
  counts: AdminCounts | null;
  connection: Connection;
  online: boolean;
  onChange: (me: Me) => void;
  /** This browser's session ended; the notice is what the sign-in page then says. */
  onSignedOut: (notice: string) => void;
}) {
  return (
    <header className={styles.topbar}>
      <a
        href="#home"
        className={styles.brand}
        aria-label="Commander Duels home"
        onClick={selectSound}
      >
        <img src="/brand/mark.webp" alt="" width={44} height={44} />
        <span className={styles.wordmark}>
          COMMANDER<strong>DUELS</strong>
        </span>
      </a>
      <PlayerSearch className={styles.search} />
      <div className={styles.corner}>
        <UpdateNotice className={styles.update} />
        <a
          href="#shop"
          className={styles.tokens}
          aria-label={
            hud.balance === undefined
              ? "Tokens"
              : `${hud.balance.toLocaleString("en-US")} tokens`
          }
          title="Your tokens"
        >
          <span aria-hidden="true" className={styles.coin} />
          <span aria-hidden="true">
            {hud.balance === undefined
              ? "—"
              : hud.balance.toLocaleString("en-US")}
          </span>
        </a>
        <a
          href="#friends"
          className={styles.iconLink}
          aria-current={shown === "Friends" ? "page" : undefined}
          aria-label="Friends"
          title="Friends"
        >
          <Icon name="friends" />
        </a>
        <NotificationBell social={social} className={styles.bell} />
        <AccountMenu
          me={me}
          shown={shown}
          hud={hud}
          counts={counts}
          connection={connection}
          online={online}
          onChange={onChange}
          onSignedOut={onSignedOut}
        />
      </div>
    </header>
  );
}

/**
 * The account's corner: its portrait (its ally's, else its avatar), handle and tier, with the
 * connection's dot, opening a menu of Profile, Settings, Administration, Report a problem and,
 * since v0.6.1, Sign out (on Profile before). What waits for Administration (v0.4.1) is counted
 * on it.
 */
function AccountMenu({
  me,
  shown,
  hud,
  counts,
  connection,
  online,
  onChange,
  onSignedOut,
}: {
  me: Me;
  shown: Page;
  hud: Hud;
  counts: AdminCounts | null;
  connection: Connection;
  online: boolean;
  onChange: (me: Me) => void;
  onSignedOut: (notice: string) => void;
}) {
  const { message, busy, signOut } = useSignOut(me, onChange, onSignedOut);
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const admin = canAdminister(me);
  const waiting = admin
    ? (counts?.pending_accounts ?? 0) + (counts?.unread_reports ?? 0)
    : 0;
  const words = connectionWords(connection, online);
  const name = me.handle ?? me.display_name;
  const standing =
    me.kind === "sysop"
      ? "Local administrator"
      : me.onboarding === "handle"
        ? "Choose your handle"
        : me.onboarding === "starters"
          ? "Choose your starter decks"
          : hud.progress
            ? `${hud.progress.tier.name} · ${hud.progress.wins.toLocaleString("en-US")} ${hud.progress.wins === 1 ? "win" : "wins"}`
            : "Signed in";

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    // Another page closes it.
    const leave = () => setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("hashchange", leave);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("hashchange", leave);
    };
  }, [open]);

  return (
    <div className={styles.account} ref={box}>
      <button
        type="button"
        ref={button}
        className={styles.accountButton}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Your account: ${name}${waiting > 0 ? `, ${countsWords(counts)}` : ""}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.accountPicture}>
          {me.alliance ? (
            <Portrait
              id={me.alliance}
              size={40}
              thumbnail
              decorative
              className={styles.accountPortrait}
            />
          ) : (
            <span className={styles.monogram} aria-hidden="true">
              {avatars[me.avatar]}
            </span>
          )}
          <span
            className={styles.statusDot}
            data-connected={connection === "connected" && online}
            aria-hidden="true"
          />
        </span>
        <span className={styles.accountWords} aria-hidden="true">
          <span>{name}</span>
          <small>{standing}</small>
        </span>
        {waiting > 0 && (
          <span className={styles.badge} aria-hidden="true">
            {badge(waiting)}
          </span>
        )}
      </button>
      {/* The connection, for screen readers: the dot on the portrait says it to the eye. */}
      <span
        role="status"
        aria-label="Connection status"
        className={styles.visuallyHidden}
      >
        {words}
      </span>
      <div id={id} className={styles.menu} hidden={!open}>
        <a
          href="#profile"
          aria-current={shown === "Profile" ? "page" : undefined}
        >
          Profile
        </a>
        <a
          href="#settings"
          aria-current={shown === "Settings" ? "page" : undefined}
        >
          Settings
        </a>
        {admin && (
          <a
            href="#admin"
            aria-current={shown === "Admin" ? "page" : undefined}
            aria-label={
              waiting > 0 ? `Administration, ${countsWords(counts)}` : undefined
            }
          >
            Administration
            {waiting > 0 && (
              <span className={styles.badge} aria-hidden="true">
                {badge(waiting)}
              </span>
            )}
          </a>
        )}
        {/* On every page of the app (v0.4.1); the table has its own, in the Game menu. */}
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => {
            // The dialog gives focus back to what held it when it opened: the account's button,
            // since this menu closes.
            button.current?.focus();
            setOpen(false);
            setReporting(true);
          }}
        >
          Report a problem
        </button>
        {/* aria-disabled, not disabled, as on Profile before: focus stays on it after a refusal. */}
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => void signOut(false)}
        >
          Sign out
        </button>
        {message && (
          <p role="alert" className={styles.menuError}>
            {message}
          </p>
        )}
        <p className={styles.menuNote}>
          <span
            className={styles.statusDot}
            data-connected={connection === "connected" && online}
            aria-hidden="true"
          />
          {words} · v{__APP_VERSION__}
        </p>
      </div>
      <ReportDialog open={reporting} onClose={() => setReporting(false)} />
    </div>
  );
}
