import { describe, expect, it } from "vitest";
import type {
  GameView,
  PlayerView,
  PriorityControls,
  Prompt,
  PromptKind,
  PromptOption,
  StackItem,
} from "../types";
import {
  RESUME_FLOOR_MS,
  TIMER_IDLE,
  timerAnnouncement,
  timerKey,
  timerReducer,
  timerSubject,
  timerView,
  type TimerAction,
  type TimerState,
} from "./timer";
import type { TimerInput } from "./types";

const controls: PriorityControls = {
  passing: null,
  your_turn: ["main1", "main2"],
  opponent_turn: ["end_of_turn"],
  stop_on_new_stack_objects: true,
  stop_on_attackers: true,
  stop_on_blockers: true,
  pass_after_casting: false,
  full_control: false,
};

function player(seat: number, name: string): PlayerView {
  return {
    seat,
    name,
    life: 20,
    counters: {},
    library_count: 40,
    hand_count: 7,
    graveyard: [],
    exile: [],
    mana_pool: { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 },
    lost: false,
    won: false,
    color_identity: null,
    command_zone: [],
    commanders: [],
  };
}

function spell(
  id: string,
  seat: number,
  fields: Partial<StackItem> = {},
): StackItem {
  return {
    id,
    kind: "spell",
    controller_seat: seat,
    name: "Lightning Bolt",
    text: "Lightning Bolt deals 3 damage to any target.",
    hidden: false,
    targets: [],
    ...fields,
  };
}

function view(fields: Partial<GameView> = {}): GameView {
  return {
    seat: 0,
    turn: 3,
    active_seat: 1,
    priority_seat: 0,
    phase: "precombat_main",
    step: "precombat_main",
    you: player(0, "Alice"),
    opponents: [player(1, "Bot 1")],
    hand: [],
    battlefield: [],
    stack: [spell("s1", 1)],
    combat: [],
    revealed: [],
    looked_at: [],
    messages: [],
    priority: controls,
    ...fields,
  };
}

/** The opponent's attack, seen by the defender during the declare steps. */
const attack: Partial<GameView> = {
  stack: [],
  step: "declare_attackers",
  phase: "combat",
  combat: [
    {
      attackers: ["c1"],
      defender: { kind: "player", seat: 0, object_id: null, label: null },
      blockers: [],
      blocked: false,
    },
  ],
};

function option(id: string, action: PromptOption["action"]): PromptOption {
  return {
    id,
    action,
    label: null,
    object_id: null,
    seat: null,
    selected: false,
  };
}

function prompt(
  id = "p1",
  kind: PromptKind = "priority",
  options = [option("o1", "pass"), option("o2", "pass_until_next_turn")],
): Prompt {
  return {
    id,
    kind,
    message: "Respond?",
    detail: null,
    options,
    amounts: null,
    piles: null,
    xmage_query: null,
  };
}

function input(fields: Partial<TimerInput> = {}): TimerInput {
  return {
    prompt: prompt(),
    revision: 10,
    view: view(),
    status: "your_prompt",
    canAnswer: true,
    observing: false,
    role: "controller",
    phase: "open",
    pending: false,
    controls,
    seconds: 8,
    hidden: false,
    blurred: false,
    settledRevision: null,
    armCapMs: 1200,
    ...fields,
  };
}

function run(state: TimerState, ...actions: TimerAction[]): TimerState {
  return actions.reduce(timerReducer, state);
}

const at = (now: number, fields: Partial<TimerInput> = {}): TimerAction => ({
  type: "input",
  input: input(fields),
  now,
});
const tick = (now: number): TimerAction => ({ type: "tick", now });

/** A timer that started running at 1200 ms and expires at 9200 ms. */
function running(): TimerState {
  return run(TIMER_IDLE, at(0), tick(1200));
}

describe("the response timer's eligibility", () => {
  it("never runs for a choice made for the player whose turn you control (v0.5.1)", () => {
    // Bot 1's turn is Alice's to play (Mindslaver): its priority is in her prompt column.
    const controlled = view({
      opponents: [{ ...player(1, "Bot 1"), controlled_by: 0 }],
      stack: [spell("s1", 0)],
    });
    const theirs = { ...prompt(), for_seat: 1 };
    expect(timerKey(input({ prompt: theirs, view: controlled }))).toBeNull();
    // Her own priority in that turn still answers an opponent's spell, as ever.
    const bolt = view({
      opponents: [{ ...player(1, "Bot 1"), controlled_by: 0 }],
      stack: [spell("s2", 1)],
    });
    expect(timerKey(input({ view: bolt }))).toBe("p1|s2");
    // An attack she declared for Bot 1 is not one she answers in a hurry.
    const declared = view({
      ...attack,
      opponents: [{ ...player(1, "Bot 1"), controlled_by: 0 }],
    });
    expect(timerKey(input({ view: declared }))).toBeNull();
  });

  it("runs for an opponent's spell or ability on top of the stack", () => {
    expect(timerKey(input())).toBe("p1|s1");
    const ability = view({ stack: [spell("s9", 1, { kind: "ability" })] });
    expect(timerKey(input({ view: ability }))).toBe("p1|s9");
  });

  it("runs for an opponent's attack in the declare steps", () => {
    expect(timerKey(input({ view: view(attack) }))).toBe(
      "p1|attack:3:declare_attackers",
    );
    const blocks = view({ ...attack, step: "declare_blockers" });
    expect(timerKey(input({ view: blocks }))).toBe(
      "p1|attack:3:declare_blockers",
    );
    // In Two-Headed Giant the other team's attack is an opponent's (v0.5.1).
    const giant = view({
      ...attack,
      active_seat: 2,
      you: { ...player(0, "Alice"), team: 0 },
      opponents: [
        { ...player(1, "Bram"), team: 0 },
        { ...player(2, "Cara"), team: 1 },
      ],
    });
    expect(timerKey(input({ view: giant }))).toBe(
      "p1|attack:3:declare_attackers",
    );
  });

  it.each<[string, Partial<TimerInput>]>([
    ["there is no prompt", { prompt: null }],
    ["there is no view", { view: null }],
    [
      "the primary is not a pass",
      { prompt: prompt("p1", "priority", [option("o3", "cast")]) },
    ],
    ["the status is not the seat's prompt", { status: "waiting" }],
    ["the tab cannot answer", { canAnswer: false }],
    ["SysOp is observing", { observing: true }],
    ["the tab is watching", { role: "observer" }],
    ["the timer is off", { seconds: 0 }],
    ["full control is on", { controls: { ...controls, full_control: true } }],
    [
      "a pass is running",
      { controls: { ...controls, passing: "until_next_turn" } },
    ],
    ["there are no priority controls", { controls: null }],
    [
      "the seat's own spell is on top",
      { view: view({ stack: [spell("s2", 0)] }) },
    ],
    ["the stack is empty outside combat", { view: view({ stack: [] }) }],
    [
      "the attack is the seat's own",
      { view: view({ ...attack, active_seat: 0 }) },
    ],
    [
      "the attack is the seat's Two-Headed Giant team's, its teammate holding the turn",
      {
        view: view({
          ...attack,
          active_seat: 1,
          you: { ...player(0, "Alice"), team: 0 },
          opponents: [
            { ...player(1, "Bram"), team: 0 },
            { ...player(2, "Cara"), team: 1 },
          ],
        }),
      },
    ],
    ["nobody attacks", { view: view({ ...attack, combat: [] }) }],
    [
      "the step is not a declare step",
      { view: view({ ...attack, step: "combat_damage" }) },
    ],
  ])("does not run when %s", (_, fields) => {
    expect(timerKey(input(fields))).toBeNull();
  });

  it.each<PromptKind>([
    "mulligan",
    "choose_target",
    "choose_defender",
    "choose_mode",
    "choose_amount",
    "assign_amounts",
    "choose_pile",
    "order_triggers",
    "pay_mana",
    "declare_attackers",
    "declare_blockers",
    "yes_no",
  ])("never runs on a %s prompt", (kind) => {
    expect(timerKey(input({ prompt: prompt("p1", kind) }))).toBeNull();
  });

  it("looks past a pending command or a closed socket, which pause it instead", () => {
    expect(timerKey(input({ canAnswer: false, pending: true }))).toBe("p1|s1");
    expect(timerKey(input({ canAnswer: false, phase: "reconnecting" }))).toBe(
      "p1|s1",
    );
  });

  it("says what it is for, keeping hidden spells hidden", () => {
    expect(timerSubject(input())).toBe("Bot 1's Lightning Bolt");
    const hidden = view({
      stack: [spell("s1", 1, { hidden: true, name: null, text: null })],
    });
    expect(timerSubject(input({ view: hidden }))).toBe("Bot 1's hidden spell");
    expect(timerSubject(input({ view: view(attack) }))).toBe("Bot 1's attack");
    const state = run(TIMER_IDLE, at(0));
    const shown = timerView(state);
    expect(shown && timerAnnouncement(shown)).toBe(
      "Bot 1's Lightning Bolt. Continuing in 8 seconds. Press Space or T to stop the timer.",
    );
  });
});

describe("the response timer", () => {
  it("arms for a new moment and runs once the table has drawn it", () => {
    const armed = run(TIMER_IDLE, at(0));
    expect(armed).toMatchObject({
      key: "p1|s1",
      phase: "arming",
      armedAt: 0,
      totalMs: 8000,
      remainingMs: 8000,
    });
    const settled = run(armed, at(300, { settledRevision: 10 }));
    expect(settled).toMatchObject({ phase: "running", endsAt: 8300 });
  });

  it("runs after the arming cap when the table never settles", () => {
    const armed = run(TIMER_IDLE, at(0));
    expect(run(armed, tick(1199)).phase).toBe("arming");
    expect(run(armed, tick(1200))).toMatchObject({
      phase: "running",
      endsAt: 9200,
    });
    // With no motion, or the plain table, there is nothing to wait for.
    expect(run(TIMER_IDLE, at(0, { armCapMs: 0 }))).toMatchObject({
      phase: "running",
      endsAt: 8000,
    });
  });

  it("writes the time left on every tick and expires once", () => {
    const started = running();
    expect(run(started, tick(5200)).remainingMs).toBe(4000);
    const expired = run(started, tick(9200));
    expect(expired).toMatchObject({
      phase: "expired",
      firedKey: "p1|s1",
      remainingMs: 0,
    });
    expect(run(expired, tick(9300))).toBe(expired);
    expect(run(expired, at(9400, { revision: 11 }))).toBe(expired);
  });

  it("carries on across revisions of the same moment", () => {
    const started = running();
    const later = run(
      started,
      at(3000, { revision: 11 }),
      at(4000, { revision: 12 }),
    );
    expect(later).toMatchObject({ phase: "running", endsAt: 9200 });
  });

  it("starts again for a new object on top or a new prompt", () => {
    const started = running();
    const response = view({
      stack: [spell("s2", 1, { name: "Shock" }), spell("s1", 1)],
    });
    expect(run(started, at(5000, { view: response }))).toMatchObject({
      key: "p1|s2",
      phase: "arming",
      armedAt: 5000,
      remainingMs: 8000,
      subject: "Bot 1's Shock",
    });
    expect(run(started, at(5000, { prompt: prompt("p2") }))).toMatchObject({
      key: "p2|s1",
      phase: "arming",
    });
  });

  it("stays stopped for its key", () => {
    for (const type of ["stop", "engage"] as const) {
      const stopped = run(running(), { type });
      expect(stopped).toMatchObject({ phase: "stopped", stoppedKey: "p1|s1" });
      expect(run(stopped, tick(20000))).toBe(stopped);
      expect(run(stopped, at(21000, { revision: 11 })).phase).toBe("stopped");
      // Even when the moment comes back after something else.
      const back = run(stopped, at(22000, { seconds: 0 }), at(23000));
      expect(back).toMatchObject({ key: "p1|s1", phase: "stopped" });
    }
    const arming = run(TIMER_IDLE, at(0), { type: "engage" });
    expect(arming.phase).toBe("stopped");
  });

  it("ignores a stop with nothing running", () => {
    expect(run(TIMER_IDLE, { type: "stop" })).toBe(TIMER_IDLE);
    const expired = run(running(), tick(9200));
    expect(run(expired, { type: "engage" })).toBe(expired);
  });

  it.each<[string, Partial<TimerInput>]>([
    ["the tab is hidden", { hidden: true }],
    ["the window loses focus", { blurred: true }],
    ["a command is pending", { pending: true, canAnswer: false }],
    ["the socket is not open", { phase: "reconnecting", canAnswer: false }],
  ])("pauses while %s and resumes with at least 2 s", (_, hold) => {
    const paused = run(running(), at(8700, hold));
    expect(paused).toMatchObject({
      phase: "paused",
      remainingMs: 500,
      endsAt: null,
    });
    // Nothing expires while paused, however late the ticks come.
    expect(run(paused, tick(60000))).toBe(paused);
    expect(run(paused, at(60000))).toMatchObject({
      phase: "running",
      remainingMs: RESUME_FLOOR_MS,
      endsAt: 60000 + RESUME_FLOOR_MS,
    });
    const early = run(running(), at(4200, hold), at(10000));
    expect(early).toMatchObject({ phase: "running", endsAt: 15000 });
  });

  it("holds an armed timer that is paused before it runs", () => {
    const paused = run(TIMER_IDLE, at(0, { blurred: true }));
    expect(paused).toMatchObject({ phase: "paused", remainingMs: 8000 });
    expect(run(paused, at(5000))).toMatchObject({
      phase: "running",
      endsAt: 13000,
    });
  });

  it("never fires for a prompt that changed before its end", () => {
    const next = run(running(), at(9199, { prompt: prompt("p2") }), tick(9200));
    expect(next).toMatchObject({
      key: "p2|s1",
      phase: "arming",
      firedKey: null,
    });
  });

  it("goes idle when the moment ends, and forgets an expiry when the lease goes", () => {
    const answered = run(running(), at(5000, { view: view({ stack: [] }) }));
    expect(answered).toMatchObject({ key: null, phase: "idle" });
    expect(timerView(answered)).toBeNull();

    const expired = run(running(), tick(9200));
    expect(run(expired, at(9300, { seconds: 0 }), at(9400)).phase).toBe(
      "expired",
    );
    // After "Play here", a prompt still open gets a fresh full timer.
    const regained = run(expired, at(9300, { role: "observer" }), at(9400));
    expect(regained).toMatchObject({ phase: "arming", remainingMs: 8000 });
    // A stop survives the lease dropping for a reconnect.
    const stopped = run(running(), { type: "stop" });
    const reconnected = run(stopped, at(9300, { role: "observer" }), at(9400));
    expect(reconnected.phase).toBe("stopped");
  });
});
