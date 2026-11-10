import type { RefObject } from "react";
import { QuestBoard } from "./QuestBoard";
import styles from "./quests.module.css";
import { useQuestBoards } from "./useQuestBoards";

// The Quests page (v0.9.5, #quests): both boards in full, and their rules in a few lines.

export function QuestsPage({
  heading,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const { boards, error } = useQuestBoards();
  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <h1 ref={heading} tabIndex={-1}>
          Quests
        </h1>
        <p>
          Five quests a day, easiest to hardest, and twenty goals a week, most
          of them outside the games. Each pays once; finish a whole board for
          its bonus, which grows each day or week in a row.
        </p>
      </header>
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
            titleId="quests-page-daily"
          />
          <QuestBoard
            board={boards.weekly}
            title="This week's goals"
            titleId="quests-page-weekly"
          />
          <section className={styles.rules} aria-labelledby="quests-rules">
            <h2 id="quests-rules">How quests count</h2>
            <ul>
              <li>
                The day starts at midnight in Arizona, and the week at Sunday's
                midnight. What you did earlier in the day or week counts.
              </li>
              <li>
                Games count from what the server records: practice games against
                bots and tables alike. Daily quests can all be done against
                bots.
              </li>
              <li>
                Goals outside the games count real exchanges only: an auction
                won from another player at 50 tokens or more, a listing that
                stayed up an hour or sold, a pack bought with tokens, a new deck
                that is legal, complete and kept a day.
              </li>
              <li>
                A full daily board pays 400 tokens, 100 more each day in a row
                up to 1,000; a full weekly board pays 2,000, 200 more each week
                in a row up to 5,000. Miss one and the streak starts again.
              </li>
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
