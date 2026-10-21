import { useEffect, useRef } from "react";
import { boxStyle } from "../Board";
import { REGIONS } from "./geometry";
import type { FullscreenState } from "./types";
import styles from "./screen.module.css";

// The Game menu (design §9.1): a popover above the band's menu diamond with the way back to the
// Table, Full screen, Mute, the table options, Report a problem (v0.4.1) and Concede. It is a
// list of ordinary links and buttons that Tab moves through, never a dialog: the game goes on
// behind it. Escape closes it (the table's Escape chain), and so does a press anywhere else.

export const GAME_MENU_ID = "game-menu";

export function GameMenu({
  open,
  onClose,
  fullscreen,
  muted,
  onMute,
  onOptions,
  onReport,
  onConcede,
  concedeDisabled,
  onLeave,
}: {
  open: boolean;
  onClose(refocus: boolean): void;
  fullscreen: FullscreenState;
  muted: boolean;
  onMute(muted: boolean): void;
  onOptions(): void;
  /** Opens "Report a problem" with this game and its turn. */
  onReport(): void;
  onConcede(): void;
  concedeDisabled: boolean;
  onLeave(): void;
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
        <li>
          <a href="#play" onClick={onLeave}>
            <span aria-hidden="true">←</span> Table
          </a>
        </li>
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
        <li>
          <button
            type="button"
            className={styles.danger}
            disabled={concedeDisabled}
            onClick={onConcede}
          >
            Concede
          </button>
        </li>
      </ul>
    </div>
  );
}
