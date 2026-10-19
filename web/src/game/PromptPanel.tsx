import { useEffect, useRef, useState, type ReactNode } from "react";
import { CardButton, CardRow, useGameContext } from "./Board";
import type { GameState } from "./connection";
import {
  objectName,
  optionText,
  playerName,
  primaryOption,
  words,
} from "./model";
import type { Prompt, PromptOption } from "./types";
import styles from "./game.module.css";

// The open prompt (UI04, UI08): every option the engine offers, and nothing it does not. Options
// tied to a card or a player are also answered on the board; this panel lists them all, so the
// keyboard reaches every one.

const groups: { title: string; actions: PromptOption["action"][] }[] = [
  { title: "Play and cast", actions: ["play_land", "cast"] },
  { title: "Abilities", actions: ["activate", "activate_mana", "use_ability"] },
  { title: "Mana", actions: ["tap_source", "use_pool"] },
  {
    title: "Combat",
    actions: ["toggle_attacker", "all_attack", "toggle_blocker"],
  },
];

function AmountForm({
  prompt,
  disabled,
  onSubmit,
}: {
  prompt: Prompt;
  disabled: boolean;
  onSubmit: (amounts: number[]) => void;
}) {
  const amounts = prompt.amounts!;
  const [values, setValues] = useState(() =>
    amounts.entries.map((entry) => entry.suggested),
  );
  useEffect(() => {
    setValues(amounts.entries.map((entry) => entry.suggested));
  }, [prompt.id, amounts.entries]);
  const total = values.reduce((sum, value) => sum + value, 0);
  const outOfRange = values.some(
    (value, i) =>
      !Number.isInteger(value) ||
      value < amounts.entries[i].min ||
      value > amounts.entries[i].max,
  );
  const totalWrong = total < amounts.total_min || total > amounts.total_max;
  return (
    <form
      className={styles.amounts}
      onSubmit={(event) => {
        event.preventDefault();
        if (!outOfRange && !totalWrong) onSubmit(values);
      }}
    >
      {amounts.entries.map((entry, i) => (
        <label key={i}>
          <span>
            {entry.label}{" "}
            <small>
              {entry.min}–{entry.max}
            </small>
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={entry.min}
            max={entry.max}
            value={Number.isNaN(values[i]) ? "" : values[i]}
            onChange={(event) =>
              setValues((current) =>
                current.map((value, j) =>
                  j === i ? event.target.valueAsNumber : value,
                ),
              )
            }
          />
        </label>
      ))}
      <p className={styles.hint} aria-live="polite">
        Total {Number.isNaN(total) ? "—" : total}
        {amounts.entries.length > 1 &&
          ` (between ${amounts.total_min} and ${amounts.total_max})`}
        {totalWrong && !Number.isNaN(total) && " — adjust the amounts."}
      </p>
      <button
        type="submit"
        data-amounts
        className={styles.primaryButton}
        disabled={disabled || outOfRange || totalWrong}
      >
        Confirm amounts
      </button>
    </form>
  );
}

export function PromptPanel({
  state,
  onAnswer,
  onTakeControl,
  onConcede,
}: {
  state: GameState;
  onAnswer: (payload: { option_id: string } | { amounts: number[] }) => void;
  onTakeControl: () => void;
  onConcede: () => void;
}) {
  const game = useGameContext();
  const panel = useRef<HTMLElement>(null);
  const snapshot = state.snapshot;
  const prompt = snapshot?.prompt ?? null;
  const view = snapshot?.view ?? null;
  const busy = state.pending !== null;
  const disabled = !game.canAnswer;
  const primary = primaryOption(prompt);

  // Keyboard players keep their place: when a new prompt opens while focus is in this panel,
  // focus moves to its first control.
  const promptId = prompt?.id;
  useEffect(() => {
    if (!promptId || !panel.current?.contains(document.activeElement)) return;
    panel.current
      .querySelector<HTMLElement>("[data-first], button:not([disabled]), input")
      ?.focus();
  }, [promptId]);

  let body: ReactNode;
  if (!snapshot) body = <p role="status">Connecting to the table…</p>;
  else if (snapshot.result) body = <p>The game is over.</p>;
  else if (snapshot.status === "eliminated")
    body = <p>You are out of this game. The others play on.</p>;
  else if (
    snapshot.status === "unsupported_prompt" ||
    prompt?.kind === "unsupported"
  )
    body = (
      <>
        <p>
          The rules engine asked for a choice the table cannot show yet (
          {prompt?.xmage_query ?? "unknown"}). The game waits here.
        </p>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onConcede}
        >
          Concede this game
        </button>
      </>
    );
  else if (!prompt)
    body = (
      <p role="status" className={styles.waiting}>
        {snapshot.status === "starting"
          ? "Shuffling up…"
          : `Waiting for ${playerName(view, view?.priority_seat ?? view?.active_seat ?? null)}…`}
      </p>
    );
  else {
    const others = prompt.options.filter((option) => option !== primary);
    const grouped = groups
      .map((group) => ({
        ...group,
        options: others.filter((option) =>
          group.actions.includes(option.action),
        ),
      }))
      .filter((group) => group.options.length > 0);
    const rest = others.filter(
      (option) =>
        !groups.some((group) => group.actions.includes(option.action)),
    );
    const piles = prompt.piles;
    body = (
      <>
        <p className={styles.promptMessage} id="prompt-message">
          {prompt.message}
        </p>
        {prompt.detail && (
          <p className={styles.promptDetail}>{prompt.detail}</p>
        )}
        {piles && (
          <div className={styles.piles}>
            {piles.map((pile, i) => (
              <div key={i}>
                <strong>Pile {i + 1}</strong>
                <span>
                  {pile.length === 0
                    ? "empty"
                    : pile
                        .map((id) => objectName(game.index.get(id)) ?? "a card")
                        .join(", ")}
                </span>
              </div>
            ))}
          </div>
        )}
        {prompt.amounts &&
          (prompt.kind === "assign_amounts" ||
            prompt.kind === "choose_amount") && (
            <AmountForm
              prompt={prompt}
              disabled={disabled}
              onSubmit={(amounts) => onAnswer({ amounts })}
            />
          )}
        {primary && (
          <button
            type="button"
            data-first
            data-option={primary.id}
            className={styles.primaryButton}
            disabled={disabled}
            onClick={() => game.choose(primary)}
            aria-keyshortcuts="P"
          >
            {optionText(primary, game.index, view)}
            <kbd aria-hidden="true">P</kbd>
          </button>
        )}
        {grouped.map((group) => (
          <div key={group.title} className={styles.optionGroup}>
            <h3>{group.title}</h3>
            <OptionList options={group.options} disabled={disabled} />
          </div>
        ))}
        {rest.length > 0 && <OptionList options={rest} disabled={disabled} />}
      </>
    );
  }

  return (
    <section
      ref={panel}
      className={styles.prompt}
      aria-labelledby="prompt-title"
      aria-busy={busy || undefined}
      data-yours={(prompt && !state.takenOver) || undefined}
    >
      <h2 id="prompt-title">
        {prompt ? words(prompt.kind) : "Table"}
        {view && (
          <span>
            Turn {view.turn} · {words(view.step ?? view.phase)}
          </span>
        )}
      </h2>
      {state.role !== "controller" &&
        state.seat !== null &&
        state.phase === "open" && (
          <div className={styles.lease} role="status">
            <span>
              {state.controlled
                ? "Another tab is playing this seat."
                : "This tab is watching."}
            </span>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onTakeControl}
            >
              Play here
            </button>
          </div>
        )}
      {state.seat === null && state.phase === "open" && (
        <p className={styles.hint}>You are observing this game.</p>
      )}
      {body}
      {busy && (
        <p role="status" className={styles.hint}>
          Sending…
        </p>
      )}
      {state.refusal && (
        <p role="alert" className={styles.refusal}>
          {state.refusal}
        </p>
      )}
      {view && view.messages.length > 0 && (
        <ul className={styles.messages}>
          {view.messages.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ul>
      )}
      {view &&
        [
          ...view.revealed.map((g) => ({ ...g, kind: "Revealed" })),
          ...view.looked_at.map((g) => ({ ...g, kind: "Looking at" })),
        ].map(
          (group, i) =>
            group.cards.length > 0 && (
              <div key={i} className={styles.revealed}>
                <h3>
                  {group.kind}: {group.name}
                </h3>
                <CardRow label={`${group.kind}: ${group.name}`}>
                  {group.cards.map((card) => (
                    <CardButton
                      key={card.id}
                      card={card}
                      located={game.index.get(card.id)}
                      small
                    />
                  ))}
                </CardRow>
              </div>
            ),
        )}
    </section>
  );
}

function OptionList({
  options,
  disabled,
}: {
  options: PromptOption[];
  disabled: boolean;
}) {
  const game = useGameContext();
  return (
    <ul className={styles.options}>
      {options.map((option) => (
        <li key={option.id}>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={
              option.action.startsWith("toggle_") ? option.selected : undefined
            }
            data-selected={option.selected || undefined}
            data-option={option.id}
            onClick={() => game.choose(option)}
            onMouseEnter={() => {
              const located = option.object_id
                ? game.index.get(option.object_id)
                : undefined;
              if (located?.card) game.preview(located.card, located);
            }}
          >
            {option.selected && !option.action.startsWith("toggle_") && (
              <span aria-hidden="true">✓ </span>
            )}
            {optionText(option, game.index, game.view)}
            {option.selected && !option.action.startsWith("toggle_") && (
              <span className={styles.visuallyHidden}> (chosen)</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
