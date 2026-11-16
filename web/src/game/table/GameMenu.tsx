import { useEffect, useRef } from "react";
import { boxStyle } from "../Board";
import { REGIONS } from "./geometry";
import type { FullscreenState } from "./types";
import styles from "./screen.module.css";

// The Game menu (design §9.1): a popover above the band's menu diamond with the way back to the
// Table, Save and leave (v1.0.0, a game against the bots), Full screen, Mute, Mute music (v0.7.2), the table options, Report a problem (v0.4.1) and
// Concede. It is a
// list of ordinary links and buttons that Tab moves through, never a dialog: the game goes on
// behind it. Escape closes it (the table's Escape chain), and so does a press anywhere else. At
// King's Table (v0.8.7) it starts with the game's settings, fixed for the whole game.

export const GAME_MENU_ID = "game-menu";

export function GameMenu({
  open,
  onClose,
  fullscreen,
  muted,
  onMute,
  musicMuted,
  onMuteMusic,
  onOptions,
  onReport,
  onConcede,
  concedeDisabled,
  onConcedeMatch,
  onSave,
  onSuspend,
  onRestart,
  onCoach,
  onStopCoaching,
  onLeave,
  rules = null,
  watching = null,
}: {
  open: boolean;
  onClose(refocus: boolean): void;
  fullscreen: FullscreenState;
  muted: boolean;
  onMute(muted: boolean): void;
  /** The gameplay music alone (v0.7.2); Mute silences it too. */
  musicMuted: boolean;
  onMuteMusic(muted: boolean): void;
  onOptions(): void;
  /** Opens "Report a problem" with this game and its turn. */
  onReport(): void;
  onConcede(): void;
  concedeDisabled: boolean;
  /** In a best-of-three match (v0.5.0): concede the whole match, not only this game. */
  onConcedeMatch?: () => void;
  /** A game against the bots, where its player may save it (v1.0.0): "Save and leave". */
  onSave?: () => void;
  /** A private table's game (v1.0.0): propose to its players to suspend it together. */
  onSuspend?: () => void;
  /** A sandbox game (v1.0.0): end it and start the same setup again. */
  onRestart?: () => void;
  /** A player, where coaching is theirs to reach (v1.0.0): take a friend as coach, or end it. */
  onCoach?: () => void;
  /** A coach (v1.0.0): stop coaching and leave. A coach has no Concede either. */
  onStopCoaching?: () => void;
  onLeave(): void;
  /** King's Table's settings in a line (v0.8.7): the decks, the life and the house rule. */
  rules?: string | null;
  /** A spectator's menu (v1.0.0): the players to watch from behind, and no Concede. */
  watching?: {
    players: { seat: number; name: string }[];
    behind: number | null;
    onBehind(seat: number): void;
  } | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // Opening the menu takes focus to its first item; a press outside it closes it.
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>("a, button")?.focus();
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        box.current?.contains(target) ||
        target?.closest?.(`[aria-controls="${GAME_MENU_ID}"]`)
      )
        return;
      close.current(false);
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [open]);

  return (
    <div
      ref={box}
      id={GAME_MENU_ID}
      className={styles.gameMenu}
      style={boxStyle(REGIONS.gameMenu)}
      hidden={!open}
      aria-label="Game menu"
      role="group"
    >
      <ul>
        {rules && (
          <li className={styles.menuRules}>
            <span>King&apos;s Table</span> {rules}
          </li>
        )}
        <li>
          <a href={watching ? "#tables" : "#play"} onClick={onLeave}>
            <span aria-hidden="true">←</span> {watching ? "Tables" : "Table"}
          </a>
        </li>
        {watching && watching.players.length > 1 && (
          <li className={styles.menuLabel}>Watch from behind</li>
        )}
        {watching &&
          watching.players.length > 1 &&
          watching.players.map((player) => (
            <li key={player.seat}>
              <button
                type="button"
                aria-pressed={player.seat === watching.behind}
                aria-label={`Watch from behind ${player.name}`}
                onClick={() => watching.onBehind(player.seat)}
              >
                {player.name}
              </button>
            </li>
          ))}
        {onSave && (
          <li>
            <button type="button" aria-haspopup="dialog" onClick={onSave}>
              Save and leave
            </button>
          </li>
        )}
        {onRestart && (
          <li>
            <button type="button" aria-haspopup="dialog" onClick={onRestart}>
              Restart
            </button>
          </li>
        )}
        {onSuspend && (
          <li>
            <button type="button" aria-haspopup="dialog" onClick={onSuspend}>
              Suspend the game
            </button>
          </li>
        )}
        {onCoach && (
          <li>
            <button type="button" aria-haspopup="dialog" onClick={onCoach}>
              Coach
            </button>
          </li>
        )}
        {onStopCoaching && (
          <li>
            <button type="button" onClick={onStopCoaching}>
              Stop coaching
            </button>
          </li>
        )}
        {fullscreen.available && (
          <li>
            <button
              type="button"
              aria-pressed={fullscreen.active}
              aria-keyshortcuts="F"
              onClick={() => fullscreen.toggle()}
            >
              Full screen <kbd aria-hidden="true">F</kbd>
            </button>
          </li>
        )}
        <li>
          <button
            type="button"
            aria-pressed={muted}
            onClick={() => onMute(!muted)}
          >
            Mute
          </button>
        </li>
        <li>
          <button
            type="button"
            aria-pressed={musicMuted}
            onClick={() => onMuteMusic(!musicMuted)}
          >
            Mute music
          </button>
        </li>
        <li>
          <button
            type="button"
            aria-controls="drawer-options"
            onClick={onOptions}
          >
            Table options
          </button>
        </li>
        <li>
          <button type="button" aria-haspopup="dialog" onClick={onReport}>
            Report a problem
          </button>
        </li>
        {!watching && !onStopCoaching && (
          <li>
            <button
              type="button"
              className={styles.danger}
              disabled={concedeDisabled}
              onClick={onConcede}
            >
              {onConcedeMatch ? "Concede the game" : "Concede"}
            </button>
          </li>
        )}
        {onConcedeMatch && (
          <li>
            <button
              type="button"
              className={styles.danger}
              aria-haspopup="dialog"
              disabled={concedeDisabled}
              onClick={onConcedeMatch}
            >
              Concede the match
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
