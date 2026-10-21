import { passingText } from "../PriorityPanel";
import type { PriorityControls } from "../types";
import gameStyles from "../game.module.css";
import styles from "./screen.module.css";

/** A pass in progress, at the top of the prompt column (UI07): what the engine passes until,
 * and Stop passing, which Escape also does from anywhere on the table. */
export function PassingNotice({
  passing,
  disabled,
  onStop,
}: {
  passing: PriorityControls["passing"];
  disabled: boolean;
  onStop(): void;
}) {
  if (!passing) return null;
  return (
    <p className={styles.passingNotice} role="status">
      <span>{passingText(passing)}</span>
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
