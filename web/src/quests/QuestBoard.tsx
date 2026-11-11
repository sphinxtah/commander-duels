import { tokens } from "../tokens/tokens";
import {
  doneOf,
  levelOf,
  resetsIn,
  streakWords,
  type BoardView,
  type QuestView,
} from "./quests";
import styles from "./quests.module.css";

// One quest board (v0.9.5): its quests with their rewards and progress, how many are done, and
// the board's bonus with its streak. The Quests page shows both boards in full; the main menu,
// the daily board and a line for the week.

export function QuestCard({ quest }: { quest: QuestView }) {
  const done = Boolean(quest.completed_at);
  return (
    <li
      className={styles.quest}
      data-done={done || undefined}
      data-level={quest.step ?? quest.tier ?? undefined}
    >
      <span className={styles.questTop}>
        <span className={styles.level}>{levelOf(quest)}</span>
        <span className={styles.reward}>{tokens(quest.tokens)}</span>
      </span>
      <span className={styles.questName}>{quest.name}</span>
      {/* A way to it that its name leaves unsaid (v0.9.8): a table game can be played alone. */}
      {quest.hint && !done && <span className={styles.hint}>{quest.hint}</span>}
      <span
        className={styles.bar}
        role="progressbar"
        aria-label={`${quest.name}: progress`}
        aria-valuemin={0}
        aria-valuemax={quest.target}
        aria-valuenow={quest.progress}
        aria-valuetext={
          done ? "Complete" : `${quest.progress} of ${quest.target}`
        }
      >
        <span
          style={{
            width: `${Math.min(100, (quest.progress / quest.target) * 100)}%`,
          }}
        />
      </span>
      <span className={styles.questFoot}>
        {done ? (
          <span>
            <span aria-hidden="true">✓ </span>Complete, paid
          </span>
        ) : (
          <span>
            {quest.progress.toLocaleString()} of {quest.target.toLocaleString()}
          </span>
        )}
        {!quest.in_game && (
          <span className={styles.outside}>Outside games</span>
        )}
      </span>
    </li>
  );
}

/** The board's bonus and streak, as a strip above its quests. */
export function BonusStrip({ board }: { board: BoardView }) {
  const finished = Boolean(board.completed_at);
  const total = board.quests.length;
  const unit = board.board === "daily" ? "day" : "week";
  return (
    <div className={styles.bonus} data-done={finished || undefined}>
      <span className={styles.count}>
        <strong>{doneOf(board)}</strong> of {total} done
      </span>
      <span className={styles.bonusWords}>
        {finished ? (
          <>
            Board complete: <strong>{tokens(board.streak.bonus)}</strong> bonus
            paid
          </>
        ) : (
          <>
            Finish all {total} for <strong>{tokens(board.streak.bonus)}</strong>
          </>
        )}
      </span>
      <span className={styles.streak}>
        <span aria-hidden="true">🔥 </span>
        {streakWords(board)}
        {" · "}
        next {unit} {tokens(board.streak.next_bonus)}
        {board.streak.best > board.streak.current &&
          ` · best ${board.streak.best}`}
      </span>
    </div>
  );
}

export function QuestBoard({
  board,
  title,
  titleId,
  compact = false,
}: {
  board: BoardView;
  title: string;
  titleId: string;
  compact?: boolean;
}) {
  const what = board.board === "daily" ? "quests" : "goals";
  return (
    <section
      className={styles.board}
      data-board={board.board}
      aria-labelledby={titleId}
    >
      <header className={styles.head}>
        <h2 id={titleId}>{title}</h2>
        <span className={styles.resets}>
          New {what} {resetsIn(board.resets_at)}
        </span>
      </header>
      <BonusStrip board={board} />
      <ol
        className={[styles.list, compact ? styles.compact : undefined]
          .filter(Boolean)
          .join(" ")}
        data-board={board.board}
      >
        {board.quests.map((quest) => (
          <QuestCard key={quest.slot} quest={quest} />
        ))}
      </ol>
    </section>
  );
}
