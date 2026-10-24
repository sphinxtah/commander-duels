import { useEffect, useId, useRef, useState } from "react";
import { avatars } from "../Account";
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
import { hoverSound, selectSound } from "./menuSound";
import { Icon, mainPages, pageHref, type IconName, type Page } from "./pages";
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
 * The top bar (v0.4.5), as in Magic Duels' menus: the mark that leads home, the main menu's six
 * pages, the player search, and the account's corner (its tokens, Friends, the bell and its own
 * menu). On a phone the six pages move to a bar at the bottom of the window. Messages, beside
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
}: {
  me: Me;
  shown: Page;
  hud: Hud;
  social: Social;
  counts: AdminCounts | null;
  connection: Connection;
  online: boolean;
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
      <nav aria-label="Main navigation" className={styles.nav}>
        {mainPages.map((page) => (
          <a
            key={page}
            href={pageHref(page)}
            aria-current={shown === page ? "page" : undefined}
            className={shown === page ? styles.active : undefined}
            onPointerEnter={() => hoverSound()}
            onClick={selectSound}
          >
            <Icon name={page.toLowerCase() as IconName} />
            <span>{page}</span>
          </a>
        ))}
      </nav>
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
        />
      </div>
    </header>
  );
}

/** The six main pages again, along the bottom of a phone's window. The chat bar's list or a
 * conversation, open, covers it (v0.5.1): it is out of reach meanwhile. */
export function PhoneBar({
  shown,
  covered = false,
}: {
  shown: Page;
  covered?: boolean;
}) {
  return (
    <nav
      aria-label="Main navigation on a phone"
      className={styles.phoneBar}
      inert={covered || undefined}
    >
      {mainPages.map((page) => (
        <a
          key={page}
          href={pageHref(page)}
          aria-current={shown === page ? "page" : undefined}
          className={shown === page ? styles.active : undefined}
          onClick={selectSound}
        >
          <Icon name={page.toLowerCase() as IconName} />
          <span>{page}</span>
        </a>
      ))}
    </nav>
  );
}

/**
 * The account's corner: its portrait (its ally's, else its avatar), handle and tier, with the
 * connection's dot, opening a menu of Profile, Settings, Administration and Report a problem.
 * What waits for Administration (v0.4.1) is counted on it.
 */
function AccountMenu({
  me,
  shown,
  hud,
  counts,
  connection,
  online,
}: {
  me: Me;
  shown: Page;
  hud: Hud;
  counts: AdminCounts | null;
  connection: Connection;
  online: boolean;
}) {
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
