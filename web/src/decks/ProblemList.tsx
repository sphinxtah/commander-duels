import type { CardSummary } from "../catalog/catalog";
import type { Problem, Validation } from "./decks";
import styles from "./decks.module.css";

const kinds: Record<Problem["kind"], string> = {
  format_illegal: "Against the format's rules",
  not_released: "Not released yet",
  not_implemented: "Not playable here yet",
  collection_locked: "Not in your collection",
  structure: "Needs fixing",
};

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
  const summary = validation.playable
    ? "Ready to play: legal, and every card is playable here."
    : validation.legal
      ? "Legal, but some cards cannot be played here yet."
      : `${validation.errors.length} problem${validation.errors.length === 1 ? "" : "s"} to fix before this deck can play.`;
  return (
    <div className={styles.problems} aria-live="polite">
      <p
        className={styles.verdict}
        data-state={
          validation.playable
            ? "playable"
            : validation.legal
              ? "legal"
              : "draft"
        }
      >
        {summary}
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
