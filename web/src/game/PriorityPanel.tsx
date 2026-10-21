import { useEffect, useRef } from "react";
import type { GameState } from "./connection";
import type { PriorityControls, PrioritySettings, Step } from "./types";
import styles from "./game.module.css";

// Priority controls (UI07). The "pass until" choices are options of the priority prompt itself;
// this panel shows a pass in progress with its cancel, and the stops: where the engine gives this
// seat priority when the stack is empty, in its own turns and the others'. Full control stops at
// every step; holding priority after a spell is the default. No timer is involved anywhere: the
// engine waits for the seat's answer however long it takes.

const steps: { id: Step; name: string }[] = [
  { id: "upkeep", name: "Upkeep" },
  { id: "draw", name: "Draw" },
  { id: "main1", name: "First main phase" },
  { id: "before_combat", name: "Beginning of combat" },
  { id: "end_of_combat", name: "End of combat" },
  { id: "main2", name: "Second main phase" },
  { id: "end_of_turn", name: "End step" },
];

const passingUntil: Record<NonNullable<PriorityControls["passing"]>, string> = {
  until_stack_resolved: "until the stack resolves",
  until_next_main: "until the next main phase",
  until_end_of_turn: "until the end of the turn",
  until_next_turn: "until the next turn",
  until_end_step_before_my_turn: "until the end step before your turn",
  until_my_turn: "until your next turn",
};

/** A pass in progress in words: "Passing until the end of the turn." */
export function passingText(
  passing: NonNullable<PriorityControls["passing"]>,
): string {
  return `Passing ${passingUntil[passing]}.`;
}

export function PriorityPanel({
  state,
  onSet,
  showPassing = true,
}: {
  state: GameState;
  onSet: (settings: PrioritySettings) => boolean | undefined;
  /** The game screen shows a pass in progress at the top of its prompt column instead
   * (PassingNotice); Escape still stops it from here. */
  showPassing?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controls = state.priority ?? state.snapshot?.view?.priority ?? null;
  const disabled =
    state.role !== "controller" ||
    state.pending !== null ||
    Boolean(state.snapshot?.result);
  const inPass = Boolean(controls?.passing) && state.seat !== null;
  // Escape stops a pass from anywhere on the screen (UI07's emergency cancel), unless it is
  // closing a menu, which stops it there, or a dialog.
  useEffect(() => {
    if (!inPass || disabled) return;
    const stop = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      onSet({ cancel_passes: true });
    };
    window.addEventListener("keydown", stop);
    return () => window.removeEventListener("keydown", stop);
  }, [inPass, disabled, onSet]);
  if (!controls || state.seat === null) return null;
  const toggle = (list: Step[], step: Step) =>
    list.includes(step)
      ? list.filter((item) => item !== step)
      : [...list, step];
  return (
    <section className={styles.priority} aria-labelledby="priority-title">
      <h2 id="priority-title">Priority</h2>
      {showPassing && controls.passing && (
        <p className={styles.passing} role="status">
          {passingText(controls.passing)}{" "}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={disabled}
            aria-keyshortcuts="Escape"
            onClick={() => onSet({ cancel_passes: true })}
          >
            Stop passing
          </button>
        </p>
      )}
      <label className={styles.switch}>
        <input
          type="checkbox"
          checked={controls.full_control}
          disabled={disabled}
          onChange={(event) => onSet({ full_control: event.target.checked })}
        />
        <span>Full control: stop at every step</span>
      </label>
      <label className={styles.switch}>
        <input
          type="checkbox"
          checked={!controls.pass_after_casting}
          disabled={disabled}
          onChange={(event) =>
            onSet({ pass_after_casting: !event.target.checked })
          }
        />
        <span>Hold priority after casting, to respond to my own spells</span>
      </label>
      <button
        type="button"
        className={styles.secondaryButton}
        onClick={() => dialog.current?.showModal()}
      >
        Stops…
      </button>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="stops-title"
      >
        <h2 id="stops-title">Where to stop</h2>
        <p className={styles.hint}>
          With nothing on the stack, the game gives you priority only in the
          steps you choose. Something new on the stack, and the combat steps you
          choose, always stop a pass.
        </p>
        <div className={styles.stops}>
          {(["your_turn", "opponent_turn"] as const).map((turn) => (
            <fieldset key={turn}>
              <legend>
                {turn === "your_turn"
                  ? "Your turns"
                  : "The other players' turns"}
              </legend>
              {steps.map((step) => (
                <label key={step.id} className={styles.switch}>
                  <input
                    type="checkbox"
                    checked={controls[turn].includes(step.id)}
                    disabled={disabled}
                    onChange={() =>
                      onSet({ [turn]: toggle(controls[turn], step.id) })
                    }
                  />
                  <span>{step.name}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <label className={styles.switch}>
          <input
            type="checkbox"
            checked={controls.stop_on_new_stack_objects}
            disabled={disabled}
            onChange={(event) =>
              onSet({ stop_on_new_stack_objects: event.target.checked })
            }
          />
          <span>Stop whenever something new is put on the stack</span>
        </label>
        <label className={styles.switch}>
          <input
            type="checkbox"
            checked={controls.stop_on_attackers}
            disabled={disabled}
            onChange={(event) =>
              onSet({ stop_on_attackers: event.target.checked })
            }
          />
          <span>Stop when attackers are declared</span>
        </label>
        <label className={styles.switch}>
          <input
            type="checkbox"
            checked={controls.stop_on_blockers}
            disabled={disabled}
            onChange={(event) =>
              onSet({ stop_on_blockers: event.target.checked })
            }
          />
          <span>Stop when blockers are declared</span>
        </label>
        <div className={styles.dialogActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled}
            onClick={() => onSet({ full_control: false })}
          >
            Back to the default stops
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => dialog.current?.close()}
          >
            Done
          </button>
        </div>
      </dialog>
    </section>
  );
}
