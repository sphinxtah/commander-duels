import { passingText } from "../PriorityPanel";
import type { PriorityControls } from "../types";
import gameStyles from "../game.module.css";
import styles from "./screen.module.css";

/** A pass in progress, at the top of the prompt column (UI07): what the engine passes until,
 * and Stop passing, which Escape also does from anywhere on the table. Since v0.9.12 also what
 * the seat yields to, when it is in no pass. */
export function PassingNotice({
  passing,
  yields = [],
  disabled,
  onStop,
}: {
  passing: PriorityControls["passing"];
  yields?: string[];
  disabled: boolean;
  onStop(): void;
}) {
  if (!passing && yields.length === 0) return null;
  return (
    <p className={styles.passingNotice} role="status">
      <span>
        {passing ? passingText(passing) : `Passing for ${yields.join(", ")}.`}
      </span>
      <button
        type="button"
        className={gameStyles.primaryButton}
        disabled={disabled}
        aria-keyshortcuts="Escape"
        onClick={onStop}
      >
        Stop passing
      </button>
    </p>
  );
}
