import { useLayoutEffect, useRef, type ReactNode } from "react";
import { boxStyle } from "../Board";
import { REGIONS } from "./geometry";
import type { DrawerId } from "./types";
import gameStyles from "../game.module.css";
import styles from "./screen.module.css";

// The drawers at the table's right (design §6.1, §9.1): the priority controls, SysOp's
// inspection, the game log, the table options and the zone browser, one open at a time. A drawer
// is part of the page, never a dialog: the table stays live beside it. A closed drawer is
// hidden, except the log, which is only visually hidden so that its role=log keeps announcing.
//
// A drawer whose contents are a named section of their own (the priority panel, the inspection,
// the log) adds no landmark around them; the others are a section named by the drawer's title.

export function Drawer({
  id,
  name,
  titled = false,
  open,
  closed,
  onClose,
  children,
}: {
  id: DrawerId;
  /** What the drawer holds: the close button's name, and the title of a titled drawer. */
  name: string;
  titled?: boolean;
  open: boolean;
  closed: "hidden" | "visually-hidden";
  onClose(): void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Opening a drawer takes focus into it, as following a link to a section does.
  useLayoutEffect(() => {
    if (open) box.current?.focus({ preventScroll: true });
  }, [open]);
  const titleId = `drawer-${id}-title`;
  const close = open && (
    <button
      type="button"
      className={styles.drawerClose}
      aria-label={`Close ${name}`}
      onClick={onClose}
    >
      <span aria-hidden="true">×</span>
    </button>
  );
  const className = [
    styles.drawer,
    !open && closed === "visually-hidden" ? gameStyles.visuallyHidden : "",
  ].join(" ");
  const shared = {
    id: `drawer-${id}`,
    className,
    style: open ? boxStyle(REGIONS.drawer) : undefined,
    "data-drawer": id,
    "data-open": open || undefined,
    hidden: !open && closed === "hidden",
  };
  return titled ? (
    <section {...shared} aria-labelledby={titleId}>
      <div ref={box} className={styles.drawerScroll} tabIndex={-1}>
        <div className={styles.drawerHead}>
          <h2 id={titleId}>{name}</h2>
          {close}
        </div>
        {children}
      </div>
    </section>
  ) : (
    <div {...shared}>
      <div ref={box} className={styles.drawerScroll} tabIndex={-1}>
        {close && <div className={styles.drawerHead}>{close}</div>}
        {children}
      </div>
    </div>
  );
}
