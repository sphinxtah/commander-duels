import { useEffect, useState } from "react";
import { client, describe } from "../api";
import { hudChanged } from "../shell/hud";
import { tokens } from "../tokens/tokens";
import { resetsIn, type DailyQuests as Quests, type QuestView } from "./quests";
import styles from "./quests.module.css";

// Today's quests on the main menu (v0.5.0): three, each with its reward and how far the
// account's wins today have come, and one swap a day for a quest not done yet. The server draws
// them at the day's first look and pays each once when a recorded game completes it; a look that
// finds wins from earlier today paid, so the top bar's tokens are asked for again.

function Quest({
  quest,
  canSwap,
  busy,
  onSwap,
}: {
  quest: QuestView;
  canSwap: boolean;
  busy: boolean;
  onSwap: (slot: number) => void;
}) {
  const done = Boolean(quest.completed_at);
  return (
    <li className={styles.quest} data-done={done || undefined}>
      <span className={styles.questTop}>
        <span className={styles.questName}>{quest.name}</span>
        <span className={styles.reward}>{tokens(quest.tokens)}</span>
      </span>
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
        <span style={{ width: `${(quest.progress / quest.target) * 100}%` }} />
      </span>
      <span className={styles.questFoot}>
        <span>
          {done ? (
            <>
              <span aria-hidden="true">✓ </span>Complete, paid
            </>
          ) : (
            `${quest.progress} of ${quest.target}${quest.swapped ? " · swapped in today" : ""}`
          )}
        </span>
        {canSwap && !done && (
          <button
            type="button"
            className={styles.swap}
            disabled={busy}
            aria-label={`Swap “${quest.name}” for another quest`}
            onClick={() => onSwap(quest.slot)}
          >
            Swap
          </button>
        )}
      </span>
    </li>
  );
}

export function DailyQuests() {
  const [quests, setQuests] = useState<Quests>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  // An account the service gives no quests to (signed out meanwhile) has no panel, as a tile
  // that cannot count stays plain.
  const [none, setNone] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/me/quests")
      .then(({ data, error: refused, response }) => {
        if (!active) return;
        if (response?.status === 401 || response?.status === 403)
          return setNone(true);
        if (!data) return setError(describe(refused));
        setQuests(data);
        if (data.paid > 0) hudChanged();
      })
      .catch(() => active && setError(describe(undefined)));
    return () => {
      active = false;
    };
  }, []);

  async function swap(slot: number) {
    setBusy(true);
    setError("");
    setSaid("");
    try {
      const { data, error: refused } = await client.POST(
        "/api/v1/me/quests/{slot}/swap",
        { params: { path: { slot } } },
      );
      if (!data) return setError(describe(refused));
      setQuests(data);
      if (data.paid > 0) hudChanged();
      const fresh = data.quests.find((quest) => quest.slot === slot);
      if (fresh) setSaid(`Swapped: your new quest is “${fresh.name}”.`);
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }

  if (none) return null;
  return (
    <section className={styles.panel} aria-labelledby="quests-title">
      <header className={styles.head}>
        <h2 id="quests-title">Today's quests</h2>
        {quests && (
          <span className={styles.resets}>
            New quests {resetsIn(quests.resets_at)}
          </span>
        )}
      </header>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!quests && !error && <p className={styles.fine}>Loading quests…</p>}
      {quests && (
        <>
          <ol className={styles.list}>
            {quests.quests.map((quest) => (
              <Quest
                key={quest.slot}
                quest={quest}
                canSwap={quests.can_swap}
                busy={busy}
                onSwap={(chosen) => void swap(chosen)}
              />
            ))}
          </ol>
          <p className={styles.fine}>
            Wins count from the games the server records, practice games against
            bots and tables alike, and each quest pays once.{" "}
            {quests.can_swap
              ? "You may swap one quest today."
              : "Today's swap is used."}
          </p>
        </>
      )}
      <p className={styles.said} role="status">
        {said}
      </p>
    </section>
  );
}
