import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CardButton, CardRow, useGameContext } from "./Board";
import type { GameState } from "./connection";
import {
  objectName,
  optionText,
  playerName,
  primaryOption,
  words,
} from "./model";
import { duelsLabel } from "./table/diamonds";
import { Icon } from "./table/Icon";
import { useTableContext } from "./table/TableContext";
import { timerLive } from "./table/timer";
import type { PromptTimerProps } from "./table/types";
import { useTableUi } from "./table/uiStore";
import type { Prompt, PromptOption } from "./types";
import styles from "./game.module.css";
import screenStyles from "./table/screen.module.css";

// The open prompt (UI04, UI08): every option the engine offers, and nothing it does not. Options
// tied to a card or a player are also answered on the board; this panel lists them all, so the
// keyboard reaches every one. As in Magic Duels (v0.3.0, design §10), the moment's main choices
// lead as big diamonds with an icon and a word: the primary (Continue, Attack, Keep Hand…),
// Attack With All when it is offered, and Stop Timer while the response timer runs.

const groups: { title: string; actions: PromptOption["action"][] }[] = [
  { title: "Play and cast", actions: ["play_land", "cast"] },
  { title: "Abilities", actions: ["activate", "activate_mana", "use_ability"] },
  { title: "Mana", actions: ["tap_source", "use_pool", "special_payment"] },
  {
    title: "Combat",
    actions: ["toggle_attacker", "all_attack", "toggle_blocker"],
  },
  {
    // UI07: the engine passes for the seat until the chosen point, or until something stops it.
    title: "Keep passing",
    actions: [
      "pass_until_stack_resolved",
      "pass_until_next_main",
      "pass_until_end_of_turn",
      "pass_until_next_turn",
      "pass_until_end_step_before_my_turn",
      "pass_until_my_turn",
    ],
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
  // The form is keyed by the prompt's ID, so each prompt starts from its own suggestion, and a new
  // revision of the same prompt keeps what the player typed.
  const [values, setValues] = useState(() =>
    amounts.entries.map((entry) => entry.suggested),
  );
  // The checks walk the prompt's entries, never the values, so a mismatch cannot read past them.
  const total = amounts.entries.reduce(
    (sum, _, i) => sum + (values[i] ?? Number.NaN),
    0,
  );
  const outOfRange =
    values.length !== amounts.entries.length ||
    amounts.entries.some((entry, i) => {
      const value = values[i];
      return !Number.isInteger(value) || value < entry.min || value > entry.max;
    });
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
  timer = null,
  onStopTimer,
}: {
  state: GameState;
  onAnswer: (payload: { option_id: string } | { amounts: number[] }) => void;
  onTakeControl: () => void;
  onConcede: () => void;
} & Partial<PromptTimerProps>) {
  const game = useGameContext();
  const panel = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const snapshot = state.snapshot;
  const prompt = snapshot?.prompt ?? null;
  const view = snapshot?.view ?? null;
  const busy = state.pending !== null;
  const disabled = !game.canAnswer;
  const primary = primaryOption(prompt);
  const promptId = prompt?.id;
  const timing = Boolean(timer && timerLive(timer.phase) && onStopTimer);

  // Stopping the timer takes its button away: focus that was on it goes to the first diamond.
  const onStop = useRef(false);
  useLayoutEffect(() => {
    if (timing || !onStop.current) return;
    onStop.current = false;
    const active = document.activeElement;
    if (!active || active === document.body)
      panel.current?.querySelector<HTMLElement>("[data-first]")?.focus();
  }, [timing]);

  // Keyboard players keep their place: when a new prompt opens while they work in this panel,
  // focus moves to its first control. Where focus is when it opens cannot tell: answering disables
  // the focused button and the waiting state removes it, so focus has already dropped to the page.
  // So the panel remembers that the player was here until focus or a press goes elsewhere.
  const working = useRef(false);
  const last = useRef<{ prompt: string; option: string | null } | null>(null);
  useEffect(() => {
    const press = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node))
        working.current = false;
    };
    document.addEventListener("pointerdown", press);
    return () => document.removeEventListener("pointerdown", press);
  }, []);
  useEffect(() => {
    const element = panel.current;
    if (!element || !working.current) return;
    const active = document.activeElement;
    if (!promptId || disabled) {
      // Sending, or waiting: focus rests on the panel's heading instead of the page.
      if (!element.contains(active))
        title.current?.focus({ preventScroll: true });
      return;
    }
    const same = last.current?.prompt === promptId;
    if (same && active !== title.current && element.contains(active)) return;
    // The same prompt again (after a refusal): back to the control the player was on.
    const option = same ? last.current?.option : null;
    const previous = Array.from(
      element.querySelectorAll<HTMLElement>("[data-option]:not(:disabled)"),
    ).find((control) => option && control.dataset.option === option);
    (
      previous ??
      element.querySelector<HTMLElement>(
        "[data-first]:not(:disabled), button:not(:disabled), input:not(:disabled)",
      )
    )?.focus();
  }, [promptId, disabled]);

  let body: ReactNode;
  if (!snapshot) body = <p role="status">Connecting to the table…</p>;
  else if (snapshot.result) body = <p>The game is over.</p>;
  else if (snapshot.status === "eliminated")
    body = game.observing ? (
      <p>
        {playerName(view, view?.seat ?? null, true)} is out of this game. The
        others play on.
      </p>
    ) : (
      <p>You are out of this game. The others play on.</p>
    );
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
          : `Waiting for ${playerName(view, view?.priority_seat ?? view?.active_seat ?? null, game.observing)}…`}
      </p>
    );
  else {
    const allAttack = prompt.options.find(
      (option) => option.action === "all_attack",
    );
    const others = prompt.options.filter(
      (option) => option !== primary && option !== allAttack,
    );
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
              key={prompt.id}
              prompt={prompt}
              disabled={disabled}
              onSubmit={(amounts) => onAnswer({ amounts })}
            />
          )}
        {(primary || allAttack || timing) && (
          <div className={screenStyles.leads}>
            {primary && (
              <Lead
                option={primary}
                prompt={prompt}
                first
                disabled={disabled}
                ring={timing && primary.action === "pass"}
              />
            )}
            {allAttack && (
              <Lead option={allAttack} prompt={prompt} disabled={disabled} />
            )}
            {timing && (
              <button
                type="button"
                className={screenStyles.lead}
                data-timer-stop
                aria-keyshortcuts="Space T"
                onFocus={() => {
                  onStop.current = true;
                }}
                onBlur={(event) => {
                  if (event.relatedTarget) onStop.current = false;
                }}
                onClick={() => {
                  onStop.current = true;
                  onStopTimer?.();
                }}
              >
                <span className={screenStyles.leadDiamond} aria-hidden="true">
                  <Icon name="hourglass" />
                </span>
                <span className={screenStyles.leadLabel}>Stop Timer</span>
                <kbd aria-hidden="true">T</kbd>
              </button>
            )}
          </div>
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
      data-yours={(prompt && !state.takenOver && !game.observing) || undefined}
      // The prompt and revision on screen: an answer is only sent for these, so the browser tests
      // wait for them before they act.
      data-prompt={promptId}
      data-revision={snapshot?.revision}
      onFocus={(event) => {
        working.current = true;
        if (promptId && event.target !== title.current)
          last.current = {
            prompt: promptId,
            option: event.target.getAttribute("data-option"),
          };
      }}
      onBlur={(event) => {
        // Focus that goes nowhere (a control disabled or removed) still counts as here.
        const next = event.relatedTarget;
        if (next && !panel.current?.contains(next)) working.current = false;
      }}
    >
      <h2 id="prompt-title" ref={title} tabIndex={-1}>
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

/** A lead diamond: a big black diamond with a white icon, its word beside it. */
function Lead({
  option,
  prompt,
  first = false,
  disabled,
  ring = false,
}: {
  option: PromptOption;
  prompt: Prompt;
  first?: boolean;
  disabled: boolean;
  ring?: boolean;
}) {
  const game = useGameContext();
  const text = optionText(option, game.index, game.view, game.observing);
  const { label, icon, hidden } = duelsLabel(option, prompt, text);
  return (
    <button
      type="button"
      className={screenStyles.lead}
      data-first={first || undefined}
      data-option={option.id}
      data-action={option.action}
      disabled={disabled}
      aria-keyshortcuts={first ? "P" : undefined}
      onClick={() => game.choose(option)}
    >
      <span className={screenStyles.leadDiamond} aria-hidden="true">
        <Icon name={icon} />
        {ring && <TimerRing />}
      </span>
      <span className={screenStyles.leadLabel}>
        {label}
        {/* The space stays outside the hidden words, so the name reads "Continue (Pass priority)". */}
        {hidden && " "}
        {hidden && <span className={styles.visuallyHidden}>({hidden})</span>}
      </span>
      {first && <kbd aria-hidden="true">P</kbd>}
    </button>
  );
}

/** The countdown around Continue: the share of the response timer left, read from the table's
 * store ten times a second without drawing the panel again. With reduced motion, the seconds. */
function TimerRing() {
  const { ui } = useTableContext();
  const timer = useTableUi(ui, (s) => s.timer);
  if (!timer || !timerLive(timer.phase) || timer.totalMs <= 0) return null;
  const left =
    timer.phase === "arming"
      ? 1
      : Math.max(0, Math.min(1, timer.remainingMs / timer.totalMs));
  return (
    <span
      className={screenStyles.ring}
      style={{ "--timer-progress": left } as CSSProperties}
      data-phase={timer.phase}
    >
      <svg viewBox="0 0 100 100" focusable="false">
        <polygon
          points="50,3 97,50 50,97 3,50"
          pathLength={100}
          strokeDasharray="100"
          strokeDashoffset={100 * (1 - left)}
        />
      </svg>
      <span className={screenStyles.ringSeconds}>
        {Math.ceil(timer.remainingMs / 1000)}
      </span>
    </span>
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
            data-action={option.action}
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
            {optionText(option, game.index, game.view, game.observing)}
            {option.selected && !option.action.startsWith("toggle_") && (
              <span className={styles.visuallyHidden}> (chosen)</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
