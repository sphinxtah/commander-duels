// The table's shared contract (v0.3.0): what the table model, its layout, the PixiJS scene, the
// DOM layer, the response timer, the sound and the app's services agree on. Types and constants
// only; every package builds against it, so a change here is a change to all of them.
import type {
  CardView,
  CombatGroup,
  GameView,
  ObjectId,
  PlayerView,
  PriorityControls,
  Prompt,
  PromptOption,
  Seat,
  Snapshot,
  StackItem,
} from "../types";
import type { Located, Zone } from "../model";
import type { GameState } from "../connection";
import type { GameContextValue } from "../Board";

/* ---------- stage units ---------- */
export const STAGE_W = 1920;
export const STAGE_H = 1080;
/** Stage unit: 1 su = 1 CSS px of the 1920×1080 stage at scale 1. */
export type SU = number;
export interface Point {
  x: SU;
  y: SU;
}
export interface Rect {
  x: SU;
  y: SU;
  w: SU;
  h: SU;
}
export interface Diamond {
  cx: SU;
  cy: SU;
  side: SU;
} // a square turned 45°; bounding box side·√2

export type Arrangement = "duel" | "three" | "four";
/** offered: purple glow + ◆; playable: hand card with an answerable play/cast (pink + ◆);
 *  selected: teal ring + ✓. Marks follow what is offered, not canAnswer (C2). */
export type Mark = "none" | "offered" | "playable" | "selected";
export type Painter = "webgl" | "dom";
export type MotionLevel = "none" | "normal" | "fast" | "faster";
export type CardImageSize = "normal" | "large" | "png";
export type ZoneName = "graveyard" | "exile" | "command";
export type DragKind = "play" | "attack" | "block";

/* ---------- table model ---------- */
export interface TableCard {
  key: string; // `${zone}:${id}`, stable while the object stays in its zone
  id: ObjectId; // the DOM button's data-card value (card id, or stack item id)
  card: CardView; // stack items get a synthesised CardView; hidden ⇒ { id, hidden: true }
  located: Located;
  zone: Zone;
  ownerSeat: Seat | null;
  controllerSeat: Seat | null;
  offered: PromptOption[]; // C1: byObject(card.id) ∪ byObject(permanent.id)
  mark: Mark;
  label: string; // C3 accessible name, plus ", 2 of 5 grouped" for pile members
  drag: DragKind | null; // a drop could answer one of this card's options now
}
export type UnitKind = "single" | "lands" | "tokens" | "host";
export interface TableUnit {
  key: string; // group key, or the single card's key
  kind: UnitKind;
  cards: string[]; // TableCard keys, bottom → top (top drawn last, gets the full hit)
  attachments: string[]; // kind "host": drawn behind, peeking right
  row: "front" | "back-lands" | "back-other";
  tapped: boolean;
}
export interface CommanderInfo {
  name: string;
  zone: string;
  objectId: ObjectId | null;
  tax: number;
  damageDealt: { seat: Seat; damage: number }[];
}
export interface TablePlayer {
  seat: Seat;
  player: PlayerView;
  anchored: boolean; // drawn on the bottom half (you, or the spectator's lowest seat)
  name: string; // "You" or the name (P1, L7 observer wording)
  title: string | null; // your deck name for yourself; "Bot"/"Player" otherwise; deck name only for SysOp
  kind: "human" | "bot" | null;
  sigil: { seed: string; grey: boolean }; // seed: `handle:<h>` | `bot:<seat>` | `seat:<seat>`
  active: boolean;
  priority: boolean;
  lost: boolean;
  won: boolean;
  offered: PromptOption[]; // bySeat (P3)
  mark: Mark;
  targetLabel: string; // P3 "<name>: N life. <options>" (or "N life" when no options)
  sideLabel: string | null; // anchored: "Your side of the table" | "<name>'s side of the table"
  articleLabel: string | null; // opponents: "<name>, seat N"
  battlefieldLabel: string; // "Your battlefield" | "<name>'s battlefield"
  units: TableUnit[]; // battlefield units in row order
  graveyard: string[];
  exile: string[];
  command: string[]; // card keys, top last
  commanders: CommanderInfo[];
  commanderDamageTaken: { fromSeat: Seat; commander: string; damage: number }[];
}
export interface TableStackEntry {
  key: string;
  id: ObjectId;
  item: StackItem;
  position: number; // 0 = next to resolve (top)
  offered: PromptOption[];
  mark: Mark;
  label: string;
  targets: (
    | { kind: "player"; seat: Seat }
    | { kind: "object"; key: string | null; label: string }
  )[];
}
export interface LineModel {
  key: string;
  kind: "cast" | "target" | "attack" | "block";
  from: { seat: Seat } | { key: string };
  to: { seat: Seat } | { key: string };
  owner: "viewer" | "opponent";
  emphasis: "always" | "hover";
}
export interface TableModel {
  gameId: string;
  revision: number;
  promptId: string | null;
  promptKind: Prompt["kind"] | null;
  arrangement: Arrangement;
  commander: boolean;
  viewSeat: Seat | null;
  observing: boolean;
  canAnswer: boolean;
  turn: number;
  phase: string | null;
  step: string | null;
  activeSeat: Seat | null;
  prioritySeat: Seat | null;
  anchored: TablePlayer | null;
  opponents: TablePlayer[]; // left → right: turn order after the anchored seat
  hand: string[];
  handTitle: string;
  handBacks: number; // backs only for a spectator's anchored player
  stack: TableStackEntry[];
  combat: CombatGroup[];
  lines: LineModel[];
  cards: Map<string, TableCard>; // by key (an id can appear twice: hand and revealed)
}
export interface SummarySeat {
  seat: Seat;
  player: "human" | "bot";
  handle: string | null;
  deck: string | null;
}
export interface BuildInput {
  gameId: string;
  snapshot: Snapshot;
  context: Pick<
    GameContextValue,
    | "view"
    | "prompt"
    | "index"
    | "byObject"
    | "bySeat"
    | "canAnswer"
    | "observing"
  >;
  viewSeat: Seat | null; // state.seat
  summarySeats: SummarySeat[] | null;
  selfHandle: string | null; // me.handle
  sysop: boolean; // games.view_concealed
}
export type BuildTableModel = (input: BuildInput) => TableModel;

/* ---------- layout ---------- */
export interface TagPlacement {
  rect: Rect;
  text: string;
  tone: "normal" | "buffed" | "hurt" | "loyalty";
}
export interface PipPlacement {
  centre: Point;
  side: SU;
  counter: string;
  count: number;
  colour: "cyan" | "red" | "violet";
}
export interface BadgePlacement {
  centre: Point;
  side: SU;
  glyph: "offered" | "selected" | "attack" | "block" | "sick" | "count";
  text?: string;
}
export interface CardNode {
  kind: "card";
  key: string;
  id: ObjectId;
  unit: string;
  role:
    "battlefield" | "hand" | "command" | "stack" | "pile-member" | "attachment";
  face: Rect; // upright image rect before rotation (may leave the stage: the hand)
  rotation: number; // 0, 90 (tapped), or the hand-fan angle in degrees
  footprint: Rect; // rotated bounding box
  hit: Rect | null; // DOM button rect; null = drawn only (overflowed, behind a pile cap)
  z: number;
  faceUp: boolean;
  tag: TagPlacement | null;
  pips: PipPlacement[];
  badges: BadgePlacement[];
  mark: Mark;
  drawHeight: SU; // drawn height, for texture tier choice
  menu: "below" | "above";
  member?: { index: number; size: number };
}
export type ZoneBrowserTarget =
  | { kind: "zone"; seat: Seat; zone: ZoneName }
  | { kind: "battlefield"; seat: Seat }
  | { kind: "pile"; unit: string }
  | { kind: "stack" }
  | { kind: "hand" };
export interface MoreNode {
  kind: "more";
  key: string;
  hit: Rect;
  count: number;
  label: string;
  opens: ZoneBrowserTarget;
}
export interface ZoneTile {
  key: string;
  seat: Seat;
  zone: ZoneName | "library";
  card: Rect; // the top card / pile picture
  hit: Rect | null; // library: null (count only)
  pedestal: { top: Rect; front: Rect } | null;
  label: string; // "Graveyard 4", "Exile 0", "Command 1 · Tax 2"
  topKey: string | null; // top card shown (graveyard, exile), for the scene and the magnifier
  count: number;
}
export interface PlayerNode {
  seat: Seat;
  chip: boolean; // chip: a collapsed opponent while another is expanded
  area: Rect; // article/section box (pointer-events: none)
  portrait: Diamond;
  life: Diamond;
  counts: { hand: Diamond; graveyard: Diamond; library: Diamond };
  target: Rect; // the player button: portrait + life
  name: { anchor: Point; align: "left" | "right"; size: SU; maxWidth: SU };
  title: {
    anchor: Point;
    align: "left" | "right";
    size: SU;
    maxWidth: SU;
  } | null;
  pills: Rect;
  statusRow: Rect; // mana pool, counters, commander damage taken
  expand: Diamond; // Expand (compact) or "Show the board" (duel, you)
  phase: { caption: Rect; bar: Rect } | null; // anchored player only
}
export interface RowLayout {
  key: string;
  seat: Seat | null;
  label: string;
  nodes: string[];
} // DOM order = x order
export interface BandLayout {
  rect: Rect;
  hud: {
    menu: Diamond;
    log: Diamond;
    priority: Diamond;
    fullscreen: Diamond;
    inspection: Diamond | null;
  };
  turnText: Rect;
  status: Rect;
  stepText: Rect;
  combatIcons: [Diamond, Diamond, Diamond];
  phases: Diamond[];
  emblem: Diamond;
  emblemCaption: Rect;
}
export interface CurvePlacement {
  key: string;
  kind: LineModel["kind"];
  p0: Point;
  c: Point;
  p1: Point;
  owner: LineModel["owner"];
  emphasis: LineModel["emphasis"];
}
export type DropZone =
  | { kind: "battlefield"; rect: Rect }
  | { kind: "attack"; rect: Rect; seat: Seat | null } // null: the whole opponents' half (duel)
  | { kind: "card"; key: string; rect: Rect };
export interface MagnifierSlot {
  card: Rect;
  panel: Rect;
}
export interface Regions {
  column: Rect; // the prompt column's scroll box
  drawer: Rect;
  gameMenu: Rect;
  alerts: Rect;
  magnifier: Record<"left" | "right", Record<1 | 2, MagnifierSlot>>;
}
export interface TableLayout {
  arrangement: Arrangement;
  expandedSeat: Seat | null;
  nodes: Map<string, CardNode | MoreNode>;
  players: Map<Seat, PlayerNode>;
  zones: ZoneTile[];
  rows: RowLayout[];
  band: BandLayout;
  stackLane: Rect;
  hand: { area: Rect; step: SU };
  risen: Map<string, Rect>; // a hand card's risen picture
  curves: CurvePlacement[];
  drops: DropZone[];
  regions: Regions;
  table: {
    quad: [Point, Point, Point, Point];
    grooves: [Point, Point][];
    sockets: Diamond[];
  };
}
export interface LayoutOptions {
  expandedSeat: Seat | null;
  textScale: 1 | 1.25;
}
export type LayoutTable = (
  model: TableModel,
  options: LayoutOptions,
) => TableLayout;
/** [] when valid; otherwise one message per violated invariant (§8.11). */
export type ValidateHits = (layout: TableLayout) => string[];

/* ---------- stage fit ---------- */
export interface StageFit {
  cssW: number;
  cssH: number;
  dpr: number;
  k: number; // min(cssW/1920, cssH/1080), floor 1/4
  ox: number;
  oy: number; // CSS px of the stage origin, rounded to device pixels
  designW: SU;
  designH: SU; // the viewport in su (wider than 1920 on ultrawide)
  resolution: number; // device px per su, capped (§7)
  small: boolean; // viewport below 1280×720
}

/* ---------- interface state (external store; no React re-render on pointer moves) ---------- */
export type DrawerId = "log" | "priority" | "inspection" | "options" | "zone";
export type TimerPhase =
  "idle" | "arming" | "running" | "paused" | "stopped" | "expired";
export interface TimerView {
  key: string;
  phase: TimerPhase;
  remainingMs: number;
  totalMs: number;
  subject: string | null; // "Bot 1's Lightning Bolt" | "Bot 2's attack"
}
export interface DragView {
  key: string;
  point: Point;
  over: DropZone | null;
  valid: DropZone[];
}
export interface TableUiSnapshot {
  hover: string | null; // node, tile or player key under the pointer (after dwell)
  focus: string | null;
  focusVisible: boolean;
  pointer: Point | null; // stage units
  risen: { key: string; source: "pointer" | "focus" } | null;
  magnified: { key: string; side: "left" | "right"; level: 1 | 2 } | null;
  menu: string | null; // key whose OptionMenu is open
  drawer: DrawerId | null;
  drag: DragView | null;
  timer: TimerView | null;
}
export interface TableUiStore {
  get(): TableUiSnapshot;
  set(patch: Partial<TableUiSnapshot>): void;
  subscribe(listener: () => void): () => void;
}

/* ---------- events (UI09, sound): derived from committed views only, never from the log ---------- */
export type Anchor =
  "library" | "hand" | "graveyard" | "exile" | "command" | "band";
export type Origin =
  | { kind: "node"; key: string } // a previous node's drawn pose
  | { kind: "anchor"; anchor: Anchor; seat: Seat; faceDown: boolean }
  | { kind: "appear" };
export type Exit =
  | { kind: "node"; key: string }
  | { kind: "anchor"; anchor: Anchor; seat: Seat }
  | { kind: "vanish" };
export type TableEvent =
  | { type: "draw"; seat: Seat; keys: string[]; count: number } // keys empty for an opponent
  | { type: "cast"; key: string; controllerSeat: Seat; from: Origin }
  | { type: "resolve"; key: string; to: Exit }
  | { type: "enter"; key: string; from: Origin; land: boolean; token: boolean }
  | { type: "leave"; key: string; to: Exit; creature: boolean }
  | { type: "tap"; key: string; tapped: boolean }
  | {
      type: "counters";
      key: string | null;
      seat: Seat | null;
      counter: string;
      delta: number;
    }
  | { type: "damage"; key: string; amount: number }
  | { type: "life"; seat: Seat; delta: number }
  | { type: "commanderDamage"; seat: Seat; fromSeat: Seat; delta: number }
  | { type: "attack"; keys: string[] }
  | { type: "block"; keys: string[] }
  | { type: "turn"; turn: number; activeSeat: Seat | null }
  | {
      type: "step";
      phase: string | null;
      step: string | null;
      emblem: "turn" | "attack" | "block" | null;
    }
  | { type: "eliminated"; seat: Seat }
  | { type: "result"; outcome: "victory" | "defeat" | "draw" | "over" };
export interface TableDiff {
  baseline: boolean;
  events: TableEvent[];
}
export interface DeriveContext {
  baseline: boolean;
  hidden: boolean;
}
export type DeriveEvents = (
  prev: TableModel | null,
  next: TableModel,
  ctx: DeriveContext,
) => TableDiff;

/* ---------- scene ---------- */
export interface SceneFrame {
  model: TableModel;
  layout: TableLayout;
  diff: TableDiff;
}
export interface SceneStatus {
  renderer: "starting" | "webgl" | "failed" | "lost";
  webgl: 1 | 2 | null;
  drawnRevision: number | null; // first frame of that revision rendered
  settledRevision: number | null; // no tween left for that revision
}
export interface SceneStats {
  frames: number;
  applyMs: number;
  textures: number;
  textureBytes: number;
  pending: number;
}
export interface TableScene {
  commit(frame: SceneFrame): void; // called in useLayoutEffect; renders one frame synchronously
  resize(fit: StageFit): void;
  setMotion(motion: MotionLevel): void;
  status(): SceneStatus;
  subscribe(listener: (status: SceneStatus) => void): () => void;
  readonly stats: SceneStats;
  destroy(): void;
}
export type CreateTableScene = (
  canvas: HTMLCanvasElement,
  init: { fit: StageFit; motion: MotionLevel; ui: TableUiStore },
) => Promise<TableScene>;
export interface SceneHostProps {
  frame: SceneFrame | null;
  fit: StageFit;
  motion: MotionLevel;
  ui: TableUiStore;
  create?: CreateTableScene; // injectable for tests; default lazy-imports createTableScene
  onStatus(status: SceneStatus): void;
}

/* ---------- component contracts between packages ---------- */
export interface TableContextValue {
  painter: Painter;
  ui: TableUiStore;
  layout: TableLayout | null;
  model: TableModel | null;
  fit: StageFit | null;
  drag: DragController | null;
}
export interface DragController {
  onPointerDown(event: PointerEvent, card: TableCard): void;
  consumeClick(id: ObjectId): boolean; // true once after a drag: swallow that click
  cancel(): void;
  readonly active: boolean;
}
export interface DomLayerProps {
  model: TableModel;
  layout: TableLayout;
  painter: Painter;
  onBrowse(target: ZoneBrowserTarget): void;
  onExpand(seat: Seat | null): void;
}
export interface MagnifierProps {
  model: TableModel;
  layout: TableLayout;
  fit: StageFit;
  view: GameView | null;
  observing: boolean;
  painter: Painter;
}
export interface PromptTimerProps {
  timer: TimerView | null;
  onStopTimer(): void;
}
export interface ZoneContentsProps {
  target: ZoneBrowserTarget;
  model: TableModel;
}

/* ---------- timer ---------- */
export interface TimerInput {
  prompt: Prompt | null;
  revision: number | null;
  view: GameView | null;
  status: Snapshot["status"] | null;
  canAnswer: boolean;
  observing: boolean;
  role: GameState["role"];
  phase: GameState["phase"];
  pending: boolean;
  controls: PriorityControls | null;
  seconds: number; // 0 = off
  hidden: boolean;
  blurred: boolean;
  settledRevision: number | null;
  armCapMs: number; // 1200, 0 with motion "none" or the dom painter
}
export type TimerKey = (input: TimerInput) => string | null; // null = not eligible
export interface ResponseTimer {
  view: TimerView | null; // React state; changes only on phase changes
  stop(): void; // Stop Timer, T, Space
  engage(): void; // any other engagement (§12)
}
export type UseResponseTimer = (
  input: TimerInput,
  ui: TableUiStore,
  onExpire: (key: string) => void,
) => ResponseTimer;

/* ---------- sound ---------- */
export type UseTableSound = (a: {
  diff: TableDiff | null;
  layout: TableLayout | null;
  settings: TableSettings;
  viewSeat: Seat | null;
  refusal: string | null;
  timer: TimerView | null;
}) => void;

/* ---------- settings (device-local) ---------- */
export interface TableSettings {
  fullscreenOnStart: boolean;
  responseTimerSeconds: 0 | 5 | 8 | 15 | 30 | 90;
  animationSpeed: "normal" | "fast" | "faster";
  effectsVolume: number; // 0–100
  muted: boolean;
  painter: "auto" | "dom";
}
export const TABLE_SETTINGS_KEY = "cd.table.v1";
export const DEFAULT_TABLE_SETTINGS: TableSettings = {
  fullscreenOnStart: true,
  responseTimerSeconds: 8,
  animationSpeed: "normal",
  effectsVolume: 70,
  muted: false,
  painter: "auto",
};

/* ---------- app services used by the game screen ---------- */
export interface FullscreenState {
  available: boolean;
  active: boolean;
  escapeLocked: boolean;
  enteredByUs: boolean;
  toggle(): void; // calls requestFullscreen synchronously inside the gesture
}
export type UpdateState =
  "none" | "available" | "deferred" | "applying" | "applied";
export interface LiveGameApi {
  holdLiveGame(gameId: string): () => void; // Web Lock `cd-live-game:<id>` while live
  markIntendedLeave(): void; // in-game links call this before navigating away
}
