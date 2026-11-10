import { tokens } from "../tokens/tokens";
import { QuestBoard } from "./QuestBoard";
import { doneOf, QUESTS_ROUTE, resetsIn, streakWords } from "./quests";
import styles from "./quests.module.css";
import { useQuestBoards } from "./useQuestBoards";

// The quest boards on the main menu (v0.9.5): today's five quests in full, and a line for the
// week's twenty goals, both leading to the Quests page.

export function QuestsPanel() {
  const { boards, error, none } = useQuestBoards();
  if (none) return null;
  return (
    <section className={styles.panel} aria-label="Quests">
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!boards && !error && <p className={styles.fine}>Loading quests…</p>}
      {boards && (
        <>
          <QuestBoard
            board={boards.daily}
            title="Today's quests"
            titleId="quests-daily-title"
            compact
          />
          <a className={styles.weekLine} href={QUESTS_ROUTE}>
            <span className={styles.weekTitle}>This week's goals</span>
            <span>
              <strong>{doneOf(boards.weekly)}</strong> of{" "}
              {boards.weekly.quests.length} done
            </span>
            <span>
              {boards.weekly.completed_at
                ? `Board complete: ${tokens(boards.weekly.streak.bonus)} bonus paid`
                : `Finish all for ${tokens(boards.weekly.streak.bonus)}`}
            </span>
            <span>{streakWords(boards.weekly)}</span>
            <span className={styles.resets}>
              New goals {resetsIn(boards.weekly.resets_at)}
            </span>
            <span className={styles.weekGo} aria-hidden="true">
              All quests →
            </span>
          </a>
        </>
      )}
    </section>
  );
}
