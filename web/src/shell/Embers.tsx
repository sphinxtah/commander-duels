import type { CSSProperties } from "react";
import styles from "./shell.module.css";

/**
 * Sparks drifting up the window behind the main menu and the title screen, as embers rose over
 * Magic Duels' menus (v0.4.5). Decoration only; still under Reduce motion.
 */
export function Embers({ count = 18 }: { count?: number }) {
  return (
    <div className={styles.embers} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          style={
            {
              "--x": `${(i * 37) % 100}%`,
              "--d": `${9 + ((i * 7) % 8)}s`,
              "--w": `${-((i * 13) % 17)}s`,
              "--s": `${2 + (i % 3)}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
