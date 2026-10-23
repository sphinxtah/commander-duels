import type { ButtonHTMLAttributes, ReactNode } from "react";
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
// the priority controls, full screen, SysOp's inspection and, at a human table, the chat), the
// turn and step line, and the connection's status chip. The scene draws the band itself, its
// step icons and phase pips.

/** The step's caption on the band; the live turn line says the step in the site's own words. */
const CAPTIONS: Record<string, string> = {
  precombat_main: "First main",
  postcombat_main: "Second main",
  first_combat_damage: "First strike damage",
  end_turn: "End step",
};

/** The HUD before the table's first layout (still connecting): the Game menu is there at once. */
const HUD: BandLayout["hud"] = {
  menu: diamond(BAND.hud.menu, BAND.y, BAND.hud.side),
  log: diamond(BAND.hud.log, BAND.y, BAND.hud.side),
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
  chat?: { unread: number } | null;
}) {
  const band = layout?.band ?? null;
  const hud = band?.hud ?? HUD;
  // The chat takes the inspection's slot, which only SysOp uses; beside SysOp's inspection it
  // takes the next one, and the turn line moves over by one.
  const step = BAND.hud.inspection - BAND.hud.fullscreen;
  const chatAt =
    chat &&
    diamond(BAND.hud.inspection + (sysop ? step : 0), BAND.y, BAND.hud.side);
  // While connected the status chip is hidden, and the turn line takes its place too (v0.5.1): a
  // long line ("Turn 12 · Your team’s turn") stays whole.
  const connected = statusText === "Connected";
  const status = band?.status ?? BAND.status;
  const shown = band && {
    ...band.turnText,
    w: connected ? status.x + status.w - band.turnText.x : band.turnText.w,
  };
  const turnText =
    shown && chat && sysop
      ? { ...shown, x: shown.x + step, w: shown.w - step }
      : shown;
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
      <HudButton
        at={hud.priority}
        icon="priority"
        label="Priority controls"
        {...toggle("priority")}
      />
      {fullscreen.available && (
        <HudButton
          at={hud.fullscreen}
          icon="fullscreen"
          label="Full screen"
          aria-pressed={fullscreen.active}
          aria-keyshortcuts="F"
          onClick={() => fullscreen.toggle()}
        />
      )}
      {sysop && hud.inspection && (
        <HudButton
          at={hud.inspection}
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
            chat.unread > 0 ? `Table chat, ${chat.unread} unread` : "Table chat"
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
      {turnLine && band && turnText && (
        <p className={styles.turnLine} aria-live="polite">
          <span className={styles.turnText} style={boxStyle(turnText)}>
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
