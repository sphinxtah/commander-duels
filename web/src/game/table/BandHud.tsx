import {
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { boxStyle } from "../Board";
import type { GameState } from "../connection";
import { BAND, diamond, diamondBox } from "./geometry";
import { GAME_MENU_ID } from "./GameMenu";
import { Icon } from "./Icon";
import type { IconName } from "./diamonds";
import type {
  BandLayout,
  Diamond,
  DrawerId,
  FullscreenState,
  TableLayout,
} from "./types";
import gameStyles from "../game.module.css";
import styles from "./screen.module.css";

// The band's HUD (design §8.2, §9.1): the diamond buttons at its left (the Game menu, the log,
// the priority controls, full screen, SysOp's inspection, at a human table the chat and, since
// v0.5.1, at every table the chat bar's friends and messages), the turn and step line, and the
// connection's status chip. The scene draws the band itself, its step icons and phase pips.

/** The step's caption on the band; the live turn line says the step in the site's own words. */
const CAPTIONS: Record<string, string> = {
  precombat_main: "First main",
  postcombat_main: "Second main",
  first_combat_damage: "First strike damage",
  end_turn: "End step",
};

/** The smallest a turn line is drawn to fit its box, of its own size. */
const LEAST_FIT = 0.7;

/** The HUD before the table's first layout (still connecting): the Game menu is there at once. */
const HUD: BandLayout["hud"] = {
  menu: diamond(BAND.hud.menu, BAND.y, BAND.hud.side),
  log: diamond(BAND.hud.log, BAND.y, BAND.hud.side),
  timeline: diamond(BAND.hud.timeline, BAND.y, BAND.hud.side),
  priority: diamond(BAND.hud.priority, BAND.y, BAND.hud.side),
  fullscreen: diamond(BAND.hud.fullscreen, BAND.y, BAND.hud.side),
  inspection: diamond(BAND.hud.inspection, BAND.y, BAND.hud.side),
};

export interface TurnLine {
  /** "Turn 7 · Bot 2’s turn" */
  turn: string;
  /** The step in words, as the turn line has always said it: "Declare attackers". */
  step: string | null;
  /** The view's step (or phase) id, for the band's caption. */
  stepId: string | null;
}

function HudButton({
  at,
  icon,
  label,
  children,
  ...rest
}: {
  at: Diamond;
  icon: IconName;
  label: string;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      className={styles.hud}
      style={boxStyle(diamondBox(at))}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} className={styles.hudIcon} />
      {children}
    </button>
  );
}

export function BandHud({
  layout,
  sysop,
  drawer,
  onDrawer,
  menuOpen,
  onMenu,
  fullscreen,
  turnLine,
  statusText,
  statusPhase,
  chat = null,
  friends = null,
  timeline = false,
}: {
  layout: TableLayout | null;
  sysop: boolean;
  drawer: DrawerId | null;
  onDrawer(drawer: DrawerId | null): void;
  menuOpen: boolean;
  onMenu(open: boolean): void;
  fullscreen: FullscreenState;
  turnLine: TurnLine | null;
  statusText: string;
  statusPhase: GameState["phase"];
  /** At a human table (v0.4.4): the chat's diamond, with the lines not read yet. */
  /** The chat's drawer: the table's, or for a spectator (v1.0.0) the spectators' own. */
  chat?: { unread: number; name?: string } | null;
  /** At every table (v0.5.1): the diamond that brings out the chat bar (chat/ChatBar.tsx), with
   * the friends' messages not read yet. */
  friends?: { unread: number; open: boolean; onToggle(): void } | null;
  /** The game has a timeline (v1.0.0): its diamond stands beside the log's. A scripted game has
   * none, and the diamonds after it close the gap. */
  timeline?: boolean;
}) {
  const band = layout?.band ?? null;
  const hud = band?.hud ?? HUD;
  // The chat and the chat bar take the inspection's slot, which only SysOp uses, and the ones
  // after it, in turn; the turn line moves over by each slot taken past the inspection's.
  const step = BAND.hud.inspection - BAND.hud.fullscreen;
  // Without the timeline's diamond everything after its place stands one step to the left.
  const back = timeline ? 0 : step;
  const moved = (at: Diamond): Diamond =>
    back ? { ...at, cx: at.cx - back } : at;
  let slots = sysop ? 1 : 0;
  const slot = () =>
    diamond(BAND.hud.inspection - back + slots++ * step, BAND.y, BAND.hud.side);
  const chatAt = chat ? slot() : null;
  const friendsAt = friends ? slot() : null;
  const shift = Math.max(0, slots - 1) * step - back;
  // While connected the status chip is hidden, and the turn line takes its place too (v0.5.1): a
  // long line ("Turn 12 · Your team’s turn") stays whole.
  const connected = statusText === "Connected";
  const status = band?.status ?? BAND.status;
  const shown = band && {
    ...band.turnText,
    w: connected ? status.x + status.w - band.turnText.x : band.turnText.w,
  };
  const turnText =
    shown && shift !== 0
      ? { ...shown, x: shown.x + shift, w: shown.w - shift }
      : shown;
  // A line longer than its box is drawn smaller until it fits whole (v0.5.1), whatever the font
  // and the text size: with every diamond on the band (SysOp at a Two-Headed Giant human table:
  // the inspection, the table chat and the chat bar's) "Turn 12 · Other team’s turn" outgrows
  // the 224 units left (268 before v1.0.0's timeline diamond; the line is 309 wide). Measured before it is painted, at its own size, for each line and width.
  const turnBox = useRef<HTMLSpanElement>(null);
  const fitKey = `${turnLine?.turn ?? ""}\n${turnText?.w ?? 0}`;
  const [fit, setFit] = useState({ key: "", scale: 1 });
  const scale = fit.key === fitKey ? fit.scale : 1;
  useLayoutEffect(() => {
    const element = turnBox.current;
    if (!element || fit.key === fitKey) return;
    let next = 1;
    element.style.setProperty("--fit", "1");
    while (element.scrollWidth > element.clientWidth && next > LEAST_FIT) {
      next = Math.max(
        LEAST_FIT,
        Math.min(
          next - 0.02,
          (next * element.clientWidth) / element.scrollWidth,
        ),
      );
      element.style.setProperty("--fit", String(next));
    }
    setFit({ key: fitKey, scale: next });
  }, [fitKey, fit.key]);
  const toggle = (id: DrawerId) => ({
    "aria-expanded": drawer === id,
    "aria-controls": `drawer-${id}`,
    "data-drawer-toggle": id,
    onClick: () => onDrawer(drawer === id ? null : id),
  });
  const caption = turnLine?.stepId
    ? (CAPTIONS[turnLine.stepId] ?? turnLine.step)
    : turnLine?.step;
  return (
    <div className={styles.band}>
      <HudButton
        at={hud.menu}
        icon="menu"
        label="Game menu"
        aria-expanded={menuOpen}
        aria-controls={GAME_MENU_ID}
        data-menu-toggle=""
        onClick={() => onMenu(!menuOpen)}
      />
      <HudButton at={hud.log} icon="log" label="Game log" {...toggle("log")} />
      {timeline && (
        <HudButton
          at={hud.timeline}
          icon="timeline"
          label="Timeline"
          {...toggle("timeline")}
        />
      )}
      <HudButton
        at={moved(hud.priority)}
        icon="priority"
        label="Priority controls"
        {...toggle("priority")}
      />
      {fullscreen.available && (
        <HudButton
          at={moved(hud.fullscreen)}
          icon="fullscreen"
          label="Full screen"
          aria-pressed={fullscreen.active}
          aria-keyshortcuts="F"
          onClick={() => fullscreen.toggle()}
        />
      )}
      {sysop && hud.inspection && (
        <HudButton
          at={moved(hud.inspection)}
          icon="inspect"
          label="Inspection"
          {...toggle("inspection")}
        />
      )}
      {chat && chatAt && (
        <HudButton
          at={chatAt}
          icon="chat"
          label={
            chat.unread > 0
              ? `${chat.name ?? "Table chat"}, ${chat.unread} unread`
              : (chat.name ?? "Table chat")
          }
          {...toggle("chat")}
        >
          {chat.unread > 0 && (
            <span className={styles.hudCount} aria-hidden="true">
              {chat.unread > 99 ? "99+" : chat.unread}
            </span>
          )}
        </HudButton>
      )}
      {friends && friendsAt && (
        <HudButton
          at={friendsAt}
          icon="friends"
          label={
            friends.unread > 0
              ? `Friends and messages, ${friends.unread} unread`
              : "Friends and messages"
          }
          aria-expanded={friends.open}
          aria-controls="chat-bar"
          data-chat-toggle=""
          onClick={friends.onToggle}
        >
          {friends.unread > 0 && (
            <span
              className={styles.hudCount}
              data-tone="friends"
              aria-hidden="true"
            >
              {friends.unread > 99 ? "99+" : friends.unread}
            </span>
          )}
        </HudButton>
      )}
      {turnLine && band && turnText && (
        <p className={styles.turnLine} aria-live="polite">
          <span
            ref={turnBox}
            className={styles.turnText}
            style={{ ...boxStyle(turnText), "--fit": scale } as CSSProperties}
          >
            {turnLine.turn}
          </span>
          {turnLine.step && (
            <>
              <span className={gameStyles.visuallyHidden}>
                {" · "}
                {turnLine.step}
              </span>
              <span
                className={styles.stepText}
                style={boxStyle(band.stepText)}
                aria-hidden="true"
              >
                {caption}
              </span>
            </>
          )}
        </p>
      )}
      <span
        className={styles.status}
        style={boxStyle(status)}
        role="status"
        data-phase={statusPhase}
        data-connected={connected || undefined}
      >
        {statusText}
      </span>
    </div>
  );
}
