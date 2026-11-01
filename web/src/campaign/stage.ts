import type { TierId } from "../api";
import { castOf, type PlayerFace, type Side } from "./cast";
import type { Line, Scene, Speaker } from "./script";
import type { SceneryId } from "./scenery/Scenery";

// A cut scene as a list of steps (v0.8.0), and the stage at each step: who stands on which side,
// who speaks, and the scenery. Pure, so the cut scene can jump to any step (a reload, Skip, the
// journal's replays) and the tests can read it.

export type Step =
  | { kind: "title"; kicker: string; title: string; sub?: string }
  | { kind: "narration"; text: string }
  | { kind: "line"; line: Line }
  | { kind: "seal"; number: number; name: string; tier: TierId }
  | {
      kind: "chapter";
      name: string;
      tier: TierId;
      rewards: string[];
      next: { name: string; tier: TierId } | null;
    }
  | { kind: "card"; kicker: string; title: string; text?: string }
  /** A warden's first defeat: their deck and tokens are the player's (the owner, v0.8.0). */
  | {
      kind: "spoils";
      opponent: string;
      deck: string;
      commander: string;
      tokens: number;
    };

/** The steps of a scene: its title card, its narration, its lines, then any extra steps (a seal
 * claimed, a chapter's rewards) and its closing narration. */
export function stepsOf(scene: Scene, extra: Step[] = []): Step[] {
  const steps: Step[] = [];
  if (scene.caption) steps.push({ kind: "title", ...scene.caption });
  if (scene.intro) steps.push({ kind: "narration", text: scene.intro });
  for (const line of scene.lines) steps.push({ kind: "line", line });
  const cards = extra.filter((step) => step.kind !== "card");
  steps.push(...cards);
  if (scene.outro) steps.push({ kind: "narration", text: scene.outro });
  steps.push(...extra.filter((step) => step.kind === "card"));
  return steps;
}

/** Portraits a side holds at once: the player's side has room for three, the other for two. */
export const SIDE_ROOM: Record<Side, number> = { left: 3, right: 2 };

export interface StageState {
  left: Speaker[];
  right: Speaker[];
  /** Who speaks now; null for a title, a narration or a card. */
  speaker: Speaker | null;
  scenery: SceneryId;
  phase: string | undefined;
  /** The High Priest's staff lights still burning (the ending puts them out). */
  staff: number;
  /** A portrait being severed from the stage at this step (Bolas, at the Sphinx's word). */
  severed: Speaker | null;
}

function enter(
  list: Speaker[],
  speaker: Speaker,
  room: number,
  keep: Speaker | null,
): Speaker[] {
  if (list.includes(speaker)) return list;
  const next = [...list, speaker];
  while (next.length > room) {
    const drop = next.findIndex((s) => s !== speaker && s !== keep);
    next.splice(drop < 0 ? 0 : drop, 1);
  }
  return next;
}

/** The stage at every step of the scene, in order. */
export function stagesOf(
  scene: Scene,
  steps: Step[],
  player: PlayerFace,
): StageState[] {
  let state: StageState = {
    left: [],
    right: [],
    speaker: null,
    scenery: scene.scenery,
    phase: scene.phase,
    staff: 5,
    severed: null,
  };
  const out: StageState[] = [];
  for (const step of steps) {
    // A portrait severed at the step before leaves the stage now.
    if (state.severed) {
      const gone = state.severed;
      state = {
        ...state,
        left: state.left.filter((s) => s !== gone),
        right: state.right.filter((s) => s !== gone),
        severed: null,
      };
    }
    if (step.kind !== "line") {
      state = { ...state, speaker: null };
      out.push(state);
      continue;
    }
    const line = step.line;
    let next: StageState = {
      ...state,
      speaker: line.speaker === "NARRATOR" ? null : line.speaker,
      scenery: line.scenery ?? state.scenery,
      phase: line.scenery ? line.phase : (line.phase ?? state.phase),
    };
    if (line.scenery && line.scenery !== state.scenery) {
      // A new place: the stage empties but for the speaker.
      next = { ...next, left: [], right: [] };
    }
    if (line.speaker !== "NARRATOR") {
      const member = castOf(line.speaker, scene.id, player);
      const other: Side = member.side === "left" ? "right" : "left";
      next = {
        ...next,
        [other]: next[other].filter((s) => s !== line.speaker),
        [member.side]: enter(
          next[member.side],
          line.speaker,
          SIDE_ROOM[member.side],
          state.speaker,
        ),
      };
    }
    if (line.fx === "staff-dims") next = { ...next, staff: 0 };
    if (line.fx === "sever") {
      const target =
        next.right.find((s) => s !== line.speaker) ??
        next.left.find((s) => s !== line.speaker && s !== "PLAYER") ??
        null;
      next = { ...next, severed: target };
    }
    state = next;
    out.push(state);
  }
  return out;
}

/** The words a step shows, for the reading time of automatic advance and the screen reader. */
export function wordsOf(step: Step): string {
  switch (step.kind) {
    case "title":
      return [step.kicker, step.title, step.sub].filter(Boolean).join(". ");
    case "narration":
      return step.text;
    case "line":
      return step.line.text;
    case "seal":
      return `Seal ${String(step.number).padStart(2, "0")}, ${step.name}, claimed.`;
    case "chapter":
      return `${step.name} complete. ${step.rewards.join(". ")}`;
    case "card":
      return [step.kicker, step.title, step.text].filter(Boolean).join(". ");
    case "spoils":
      return `${step.deck}, led by ${step.commander}, joins your decks, and ${step.tokens.toLocaleString("en-US")} tokens.`;
  }
}

/** How long automatic advance waits once a step's words are all shown. */
export function readingMs(step: Step): number {
  const words = wordsOf(step);
  const base = step.kind === "title" ? 1800 : 1300;
  return Math.min(9000, base + words.length * 38);
}
