// The engine's seat view and SysOp's inspection, as the API passes them through unchanged.
// Hand-written from contracts/engine-seat-view.schema.json and engine-inspection.schema.json;
// keep the two in step.

export type Seat = number;
export type ObjectId = string;

export type PromptKind =
  | "priority"
  | "mulligan"
  | "yes_no"
  | "choose_target"
  | "choose_defender"
  | "choose_ability"
  | "choose_choice"
  | "choose_name"
  | "choose_mode"
  | "choose_amount"
  | "order_triggers"
  | "choose_pile"
  | "pay_mana"
  | "declare_attackers"
  | "declare_blockers"
  | "assign_amounts"
  | "unsupported";

export type PassMode =
  | "pass_until_stack_resolved"
  | "pass_until_next_main"
  | "pass_until_end_of_turn"
  | "pass_until_next_turn"
  | "pass_until_end_step_before_my_turn"
  | "pass_until_my_turn";

export type OptionAction =
  | "pass"
  | PassMode
  | "cast"
  | "play_land"
  | "activate"
  | "activate_mana"
  | "mulligan"
  | "keep"
  | "yes"
  | "no"
  | "choose"
  | "done"
  | "tap_source"
  | "use_pool"
  | "special_payment"
  | "cancel"
  | "toggle_attacker"
  | "all_attack"
  | "toggle_blocker"
  | "suggested"
  | "use_ability"
  | "choose_mode"
  | "put_first"
  | "choose_pile";

export interface PromptOption {
  id: string;
  action: OptionAction;
  label: string | null;
  object_id: ObjectId | null;
  seat: Seat | null;
  selected: boolean;
}

export interface AmountEntry {
  label: string;
  min: number;
  max: number;
  suggested: number;
}

export interface Prompt {
  id: string;
  kind: PromptKind;
  message: string;
  detail: string | null;
  options: PromptOption[];
  amounts: {
    total_min: number;
    total_max: number;
    entries: AmountEntry[];
  } | null;
  piles: [ObjectId[], ObjectId[]] | null;
  xmage_query: string | null;
}

/** A card face. A hidden card (face down, for instance) carries its id and nothing else. */
export interface CardView {
  id: ObjectId;
  hidden: boolean;
  name: string | null;
  mana_cost: string | null;
  type_line: string | null;
  power: string | null;
  toughness: string | null;
  rules: string[];
}

export interface PermanentView {
  id: ObjectId;
  controller_seat: Seat;
  owner_seat: Seat;
  card: CardView;
  tapped: boolean;
  summoning_sick: boolean;
  damage: number;
  counters: Record<string, number>;
  attacking: boolean;
  blocking: boolean;
  attached_to: ObjectId | null;
}

export interface TargetRef {
  kind: "player" | "object";
  seat: Seat | null;
  object_id: ObjectId | null;
  label: string | null;
}

export interface StackItem {
  id: ObjectId;
  kind: "spell" | "ability";
  controller_seat: Seat;
  name: string | null;
  text: string | null;
  hidden: boolean;
  targets: TargetRef[];
}

export interface CombatGroup {
  attackers: ObjectId[];
  defender: TargetRef | null;
  blockers: ObjectId[];
  blocked: boolean;
}

export interface CardGroup {
  name: string;
  cards: CardView[];
}

export interface CommanderView {
  name: string;
  zone:
    | "command"
    | "battlefield"
    | "stack"
    | "graveyard"
    | "exile"
    | "hand"
    | "library"
    | "hidden"
    | "outside";
  object_id: ObjectId | null;
  cast_count: number;
  tax: number;
  damage_dealt: { seat: Seat; damage: number }[];
}

export interface ManaPool {
  white: number;
  blue: number;
  black: number;
  red: number;
  green: number;
  colorless: number;
}

export interface PlayerView {
  seat: Seat;
  name: string;
  life: number;
  counters: Record<string, number>;
  library_count: number;
  hand_count: number;
  graveyard: CardView[];
  exile: CardView[];
  mana_pool: ManaPool;
  lost: boolean;
  won: boolean;
  color_identity: string | null;
  command_zone: CardView[];
  commanders: CommanderView[];
}

export interface GameView {
  seat: Seat | null;
  turn: number;
  active_seat: Seat | null;
  priority_seat: Seat | null;
  phase: string | null;
  step: string | null;
  you: PlayerView | null;
  opponents: PlayerView[];
  hand: CardView[];
  battlefield: PermanentView[];
  stack: StackItem[];
  combat: CombatGroup[];
  revealed: CardGroup[];
  looked_at: CardGroup[];
  messages: string[];
  /** The seat's priority controls; null for spectators. */
  priority: PriorityControls | null;
}

export type Step =
  | "upkeep"
  | "draw"
  | "main1"
  | "before_combat"
  | "end_of_combat"
  | "main2"
  | "end_of_turn";

export interface PriorityControls {
  passing:
    | null
    | "until_stack_resolved"
    | "until_next_main"
    | "until_end_of_turn"
    | "until_next_turn"
    | "until_end_step_before_my_turn"
    | "until_my_turn";
  your_turn: Step[];
  opponent_turn: Step[];
  stop_on_new_stack_objects: boolean;
  stop_on_attackers: boolean;
  stop_on_blockers: boolean;
  pass_after_casting: boolean;
  full_control: boolean;
}

/** A change to the priority controls; what is left out stays as it is. */
export interface PrioritySettings {
  your_turn?: Step[];
  opponent_turn?: Step[];
  stop_on_new_stack_objects?: boolean;
  stop_on_attackers?: boolean;
  stop_on_blockers?: boolean;
  pass_after_casting?: boolean;
  full_control?: boolean;
  cancel_passes?: boolean;
}

export interface GameResultView {
  kind:
    | "completed"
    | "turn_limit"
    | "closed"
    | "idle_timeout"
    | "humans_eliminated"
    | "error";
  winner_seat: Seat | null;
  draw: boolean;
  conceded_seats: Seat[];
  turns: number;
  error: string | null;
}

export interface LogLine {
  index: number;
  turn: number;
  active_seat: Seat | null;
  step: string | null;
  text: string;
}

export interface SeatSettings {
  format: "legacy" | "commander";
  rules_profile: string;
  seats: { seat: Seat; player: "human" | "bot"; deck: string | null }[];
  skill: number;
  turn_cap: number;
  idle_timeout_seconds: number;
  spectator_delay_seconds: number;
}

export type SnapshotStatus =
  | "starting"
  | "your_prompt"
  | "unsupported_prompt"
  | "waiting"
  | "eliminated"
  | "spectating"
  | "finished";

export interface Snapshot {
  game_id: string;
  revision: number;
  status: SnapshotStatus;
  seat: Seat | null;
  settings: SeatSettings;
  prompt: Prompt | null;
  view: GameView | null;
  result: GameResultView | null;
  log_count: number;
  log_from: number;
  log: LogLine[];
}

/** SysOp's inspection: the public view plus every hand and library in order, top first. */
export interface Inspection {
  game_id: string;
  version: number;
  status: "live" | "finished";
  settings: SeatSettings;
  view: GameView;
  players: {
    seat: Seat;
    name: string | null;
    hand: CardView[];
    library: CardView[];
  }[];
  result: GameResultView | null;
}

/** A command in the engine's envelope; the API forwards it with the seat's token. */
export interface CommandEnvelope {
  v: 1;
  game_id: string;
  action_id: string;
  expected_revision: number;
  prompt_id?: string;
  type: "submit_choice" | "concede" | "set_priority";
  payload:
    | { option_id: string }
    | { amounts: number[] }
    | { text: string }
    | PrioritySettings
    | Record<string, never>;
}

export interface CommandResult {
  type: "command_result";
  action_id: string | null;
  status: number;
  body: { status?: string; code?: string; message?: string; revision?: number };
}

/** A player's seat at a human table (v0.4.0): whether a tab of theirs is connected, how long
 * none has been, whether it is out of the game, and the votes on removing it while away. */
export interface PresenceSeat {
  seat: Seat;
  connected: boolean;
  away_seconds: number | null;
  left: "conceded" | "removed" | "eliminated" | null;
  /** Away long enough to be voted on. */
  removable: boolean;
  /** The seats that voted to remove it, and those that voted to wait. */
  yes: Seat[];
  no: Seat[];
  /** Yes votes that remove it: a majority of the other players still in the game. */
  needed: number;
}

export interface Presence {
  /** Seconds without a tab before a player may be voted out. */
  away_after: number;
  seats: PresenceSeat[];
}

/** A line of a human table's chat (v0.4.4, docs/chat.md): a player's text or emote, or an
 * alliance's start or end. */
export interface ChatLine {
  id: string;
  channel: "table" | "allies";
  kind: "text" | "emote" | "event";
  /** The sender's seat: null for SysOp watching, and for an event nobody caused. */
  seat: Seat | null;
  sender: { id: string; handle: string | null } | null;
  /** A text's words, an emote's name, or an event's: "allied" or "alliance_ended". */
  body: string;
  /** An allies-only line's recipients besides the sender; an event's two players. */
  seats: Seat[];
  client_id: string | null;
  created_at: string;
}

/** Every alliance at the table, and the offers this connection's seat made or received (all of
 * them for SysOp). */
export interface Alliances {
  alliances: [Seat, Seat][];
  offers: { from: Seat; to: Seat }[];
}

export type AllianceAction =
  "offer" | "accept" | "decline" | "withdraw" | "end";

export type EmoteName =
  | "hello"
  | "good_luck"
  | "your_turn"
  | "thinking"
  | "nice_play"
  | "thanks"
  | "oops"
  | "sorry"
  | "good_game";

export type ServerMessage =
  | ({ type: "presence" } & Presence)
  | { type: "chat_history"; messages: ChatLine[] }
  | { type: "chat"; message: ChatLine }
  | ({ type: "alliances" } & Alliances)
  | {
      type: "welcome";
      game_id: string;
      connection_id: string;
      seat: Seat | null;
      role: "controller" | "observer";
      controlled: boolean;
    }
  | { type: "snapshot"; snapshot: Snapshot }
  | CommandResult
  | {
      type: "lease";
      role: "controller" | "observer";
      controlled: boolean;
      reason: "granted" | "taken_over" | "released" | "disconnected";
    }
  | { type: "inspection"; inspection: Inspection }
  | { type: "interrupted"; game_id: string }
  | { type: "pong" }
  | {
      type: "error";
      code: string;
      message?: string;
      /** The vote's or the alliance's other seat. */
      seat?: Seat;
      /** The chat message or emote refused. */
      client_id?: string | null;
      /** chat_limited: the seconds to wait. */
      retry_after?: number;
    };
