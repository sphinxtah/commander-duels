import { playerName, primaryOption } from "../model";
import type { TimerInput, TimerKey, TimerPhase, TimerView } from "./types";

// The response timer (design §12). When the seat gets priority only to answer an opponent's spell,
// ability or attack, a short countdown runs and then continues for the player, as Magic Duels does;
// Stop Timer, T, Space or anything else the player does stops it for that moment. Everything here
// is pure: useResponseTimer.ts feeds it inputs, clock ticks and engagements. The timer only ever
// asks for the prompt's pass, and that answer goes through the screen's ordinary answer path.

/** How often a running timer writes its progress to the table's store (10 Hz). */
export const TIMER_TICK_MS = 100;
/** The longest an armed timer waits for the scene to draw the moment: TimerInput.armCapMs, or 0
 * with motion "none" and the plain table, where there is nothing to wait for. */
export const ARM_CAP_MS = 1200;
/** A paused timer that resumes always has at least this long left, so it never passes at once. */
export const RESUME_FLOOR_MS = 2000;

const COMBAT_STEPS = new Set(["declare_attackers", "declare_blockers"]);

/** The moment the timer is for, or null when it may not run. The key is the prompt and what it
 * answers: the top of the stack, or the attack. A republish of the same prompt keeps its key, so the
 * countdown carries on; a new spell on top is a new key, so it starts again. */
export const timerKey: TimerKey = (input) => {
  const { prompt, view, controls } = input;
  if (!prompt || !view || !controls) return null;
  // Only a priority prompt whose primary is the pass: never a forced choice (mulligan, targets,
  // modes, amounts, piles, ordering, payment, attackers or blockers).
  if (prompt.kind !== "priority" || primaryOption(prompt)?.action !== "pass")
    return null;
  if (input.status !== "your_prompt") return null;
  // Never in a watching tab or for SysOp observing another player's game.
  if (input.observing || input.role !== "controller") return null;
  // canAnswer is also false while a command is pending or the socket is not open. Those pause the
  // timer rather than end it, so they are looked past here.
  if (!input.canAnswer && !input.pending && input.phase === "open") return null;
  if (input.seconds <= 0) return null;
  // Passing and full control are the player's own choices about priority; the timer stays out.
  if (controls.full_control || controls.passing !== null) return null;
  const top = view.stack[0];
  if (top)
    // The seat's own object on top is holding priority, not a response.
    return top.controller_seat !== view.seat ? `${prompt.id}|${top.id}` : null;
  const attacked =
    view.active_seat !== view.seat &&
    view.step !== null &&
    COMBAT_STEPS.has(view.step) &&
    view.combat.some((group) => group.attackers.length > 0);
  return attacked ? `${prompt.id}|attack:${view.turn}:${view.step}` : null;
};

/** What the timer is for, in words: "Bot 1's Lightning Bolt", "Bot 2's attack". A hidden spell
 * stays hidden. Read only for an eligible input, so the subject is always an opponent's. */
export function timerSubject(input: TimerInput): string | null {
  const view = input.view;
  if (!view) return null;
  const top = view.stack[0];
  if (top) {
    const what = top.hidden
      ? "hidden spell"
      : (top.name ?? (top.kind === "ability" ? "ability" : "spell"));
    return `${playerName(view, top.controller_seat)}'s ${what}`;
  }
  return `${playerName(view, view.active_seat)}'s attack`;
}

/** The polite announcement made once per key when its countdown starts. */
export function timerAnnouncement(view: TimerView): string {
  const seconds = Math.round(view.totalMs / 1000);
  const lead = view.subject ? `${view.subject}. ` : "";
  return `${lead}Continuing in ${seconds} seconds. Press Space or T to stop the timer.`;
}

export interface TimerState {
  key: string | null;
  phase: TimerPhase;
  /** Running: when it expires (ms on the clock the actions carry). */
  endsAt: number | null;
  remainingMs: number;
  totalMs: number;
  armedAt: number | null;
  /** The key the player stopped: it stays stopped however often it is republished. */
  stoppedKey: string | null;
  /** The key that expired: it never fires twice. */
  firedKey: string | null;
  /** The arming cap from the latest input, for the ticks between inputs. */
  armCapMs: number;
  subject: string | null;
}

export type TimerAction =
  | { type: "input"; input: TimerInput; now: number }
  | { type: "tick"; now: number }
  | { type: "stop" }
  | { type: "engage" };

export const TIMER_IDLE: TimerState = {
  key: null,
  phase: "idle",
  endsAt: null,
  remainingMs: 0,
  totalMs: 0,
  armedAt: null,
  stoppedKey: null,
  firedKey: null,
  armCapMs: 0,
  subject: null,
};

/** Arming, running or paused: the phases a stop or an engagement ends. */
export function timerLive(phase: TimerPhase): boolean {
  return phase === "arming" || phase === "running" || phase === "paused";
}

/** What the screen shows: null while idle. */
export function timerView(state: TimerState): TimerView | null {
  if (state.key === null || state.phase === "idle") return null;
  return {
    key: state.key,
    phase: state.phase,
    remainingMs: state.remainingMs,
    totalMs: state.totalMs,
    subject: state.subject,
  };
}

/** One step of the timer. It returns the same state object when nothing changed, so the hook can
 * skip every write and render that would change nothing. */
export function timerReducer(
  state: TimerState,
  action: TimerAction,
): TimerState {
  switch (action.type) {
    case "input":
      return onInput(state, action.input, action.now);
    case "tick":
      return onTick(state, action.now);
    case "stop":
    case "engage":
      // Stopped for this key, for good: a republish of the same prompt stays stopped.
      return timerLive(state.phase)
        ? { ...state, phase: "stopped", endsAt: null, stoppedKey: state.key }
        : state;
  }
}

function onInput(
  state: TimerState,
  input: TimerInput,
  now: number,
): TimerState {
  const key = timerKey(input);
  if (key === null) {
    // Losing the lease forgets what expired, so after "Play here" a prompt still open gets a fresh
    // full timer. A stop is kept: a reconnect also drops the lease for a moment, and the prompt the
    // player stopped must not start counting again behind their back.
    const firedKey = input.role === "controller" ? state.firedKey : null;
    if (state.phase === "idle" && state.firedKey === firedKey) return state;
    return { ...TIMER_IDLE, stoppedKey: state.stoppedKey, firedKey };
  }
  if (key !== state.key) {
    const totalMs = input.seconds * 1000;
    const fresh: TimerState = {
      ...state,
      key,
      subject: timerSubject(input),
      totalMs,
      remainingMs: totalMs,
      endsAt: null,
      armedAt: null,
      armCapMs: input.armCapMs,
    };
    if (key === state.stoppedKey) return { ...fresh, phase: "stopped" };
    if (key === state.firedKey)
      return { ...fresh, phase: "expired", remainingMs: 0 };
    return advance({ ...fresh, phase: "arming", armedAt: now }, input, now);
  }
  return advance(state, input, now);
}

/** The same key with a newer input: start once the table has drawn it, pause and resume. */
function advance(
  state: TimerState,
  input: TimerInput,
  now: number,
): TimerState {
  const hold =
    input.hidden || input.blurred || input.pending || input.phase !== "open";
  switch (state.phase) {
    case "arming": {
      if (hold) return { ...state, phase: "paused", armCapMs: input.armCapMs };
      // Arming waits for the scene to settle the revision that brought the moment (the spell has
      // landed on the stack), or for the cap, whichever comes first.
      const settled =
        input.settledRevision !== null &&
        input.revision !== null &&
        input.settledRevision >= input.revision;
      if (settled || now - (state.armedAt ?? now) >= input.armCapMs)
        return run(state, now, state.remainingMs);
      return state.armCapMs === input.armCapMs
        ? state
        : { ...state, armCapMs: input.armCapMs };
    }
    case "running":
      if (!hold) return state;
      return {
        ...state,
        phase: "paused",
        endsAt: null,
        remainingMs: Math.max(0, (state.endsAt ?? now) - now),
      };
    case "paused":
      return hold
        ? state
        : run(state, now, Math.max(state.remainingMs, RESUME_FLOOR_MS));
    default:
      return state;
  }
}

function onTick(state: TimerState, now: number): TimerState {
  if (state.phase === "arming")
    return now - (state.armedAt ?? now) >= state.armCapMs
      ? run(state, now, state.remainingMs)
      : state;
  if (state.phase !== "running" || state.endsAt === null) return state;
  // Only a tick expires the timer, never an input: an input that changes the prompt or holds the
  // timer is applied first, so nothing fires after a prompt change or while a command is pending.
  if (now >= state.endsAt)
    return {
      ...state,
      phase: "expired",
      endsAt: null,
      remainingMs: 0,
      firedKey: state.key,
    };
  const remainingMs = state.endsAt - now;
  return remainingMs === state.remainingMs ? state : { ...state, remainingMs };
}

function run(state: TimerState, now: number, ms: number): TimerState {
  return { ...state, phase: "running", endsAt: now + ms, remainingMs: ms };
}
