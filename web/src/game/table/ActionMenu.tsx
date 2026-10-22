import { useEffect, useRef, type RefObject } from "react";
import gameStyles from "../game.module.css";
import styles from "./table.module.css";

// A small menu of actions (v0.4.4): a player's alliance on their plate, and a chat line's Report.
// It behaves as the prompt's option menus do (Board.tsx OptionMenu): focus starts on its first
// item, the arrow keys move between items, and Escape, a press outside or Tab away closes it.

export interface MenuAction {
  key: string;
  /** What the item says. */
  label: string;
  onSelect(): void;
}

export function ActionMenu({
  label,
  actions,
  onClose,
  toggle,
  placement = "below",
  align = "start",
}: {
  /** The menu's name: whose actions these are. */
  label: string;
  actions: MenuAction[];
  /** Closes the menu; true puts focus back on its button. */
  onClose(refocus: boolean): void;
  /** The button that opened it: a press there is left to its own click, which closes it. */
  toggle?: RefObject<HTMLElement | null>;
  placement?: "below" | "above";
  align?: "start" | "end";
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  // A press anywhere outside closes the menu (as OptionMenu: blur cannot be the signal in Safari).
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || toggle?.current?.contains(target))
        return;
      onClose(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [onClose, toggle]);
  return (
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      className={`${gameStyles.menu} ${styles.tableMenu}`}
      data-placement={placement}
      data-align={align}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose(true);
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = Array.from(
            menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          );
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "ArrowDown" ? at + 1 : at - 1;
          items[(next + items.length) % items.length]?.focus();
        }
      }}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !menu.current?.contains(event.relatedTarget as Node)
        )
          onClose(false);
      }}
    >
      {actions.map((action) => (
        <button
          key={action.key}
          role="menuitem"
          type="button"
          onClick={action.onSelect}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
