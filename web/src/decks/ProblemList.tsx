import type { CardSummary } from "../catalog/catalog";
import { collectionLocked, type Problem, type Validation } from "./decks";
import styles from "./decks.module.css";

const kinds: Record<Problem["kind"], string> = {
  format_illegal: "Against the format's rules",
  not_released: "Not released yet",
  not_implemented: "Not playable here yet",
  collection_locked: "Needs cards you don't own",
  structure: "Needs fixing",
};

/** A padlock for what the player's library holds back (DECK08). Never announced: the words
 * beside it say so. */
export function LockIcon() {
  return (
    <svg
      className={styles.lock}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** The one line that says whether the deck can play, and if not, what kind of problem keeps it. */
export function verdict(validation: Validation): {
  state: "playable" | "locked" | "legal" | "draft";
  words: string;
} {
  if (validation.playable)
    return {
      state: "playable",
      words: "Ready to play: legal, and every card is playable here.",
    };
  const count = validation.errors.length;
  if (!validation.legal)
    return {
      state: "draft",
      words: `${count} problem${count === 1 ? "" : "s"} to fix before this deck can play.`,
    };
  // Legal, and held back: by the player's library, the engine, or both.
  if (collectionLocked(validation)) {
    const unsupported = validation.errors.some(
      (problem) => problem.kind === "not_implemented",
    );
    return {
      state: "locked",
      words: `Legal, but it needs cards you don't own${unsupported ? ", and some cards cannot be played here yet" : ""}: it cannot start a game until that is fixed.`,
    };
  }
  return {
    state: "legal",
    words: "Legal, but some cards cannot be played here yet.",
  };
}

/** What the server's validation found, each problem with its explanation and remedy. */
export function ProblemList({
  validation,
  cards,
  onSelect,
}: {
  validation: Validation;
  cards: Record<string, CardSummary>;
  onSelect?: (cardIds: string[]) => void;
}) {
  const summary = verdict(validation);
  return (
    <div className={styles.problems} aria-live="polite">
      <p className={styles.verdict} data-state={summary.state}>
        {summary.state === "locked" && <LockIcon />}
        {summary.words}
      </p>
      {validation.errors.length + validation.warnings.length > 0 && (
        <ul>
          {[...validation.errors, ...validation.warnings].map(
            (problem, index) => (
              <li
                key={`${problem.code}-${index}`}
                data-kind={problem.kind}
                data-warning={index >= validation.errors.length}
              >
                {index < validation.errors.length &&
                  problem.kind === "collection_locked" && <LockIcon />}
                <strong>
                  {index >= validation.errors.length
                    ? "Note"
                    : kinds[problem.kind]}
                  :
                </strong>{" "}
                {problem.message} <em>{problem.remedy}</em>
                {onSelect && (problem.card_ids ?? []).length > 0 && (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => onSelect(problem.card_ids ?? [])}
                  >
                    Show{" "}
                    {problem.card_ids?.length === 1
                      ? (cards[problem.card_ids[0]!]?.name ?? "the card")
                      : "the cards"}
                  </button>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
