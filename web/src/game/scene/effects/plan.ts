import type { Seat } from "../../types";
import { BIG_GAIN, HEAVY_LOSS, isBigCreature } from "../../table/notable";
import type {
  EffectsLevel,
  Exit,
  ManaColour,
  TableDiff,
  TableModel,
} from "../../table/types";

// Which special effects one diff plays (v0.7.0). Like the animation and the sound, the effects
// come from the events alone, never from the log, so nothing a seat may not see can show in a
// burst or a slash. The plan is pure: the scene resolves each effect to a place on the stage and
// draws it. The thresholds that make a moment notable are in table/notable.ts.
//
// "subtle" keeps the marks and the rings (the slash, the bursts' rings, the shock ring, the
// shield shimmer, the shine) and leaves out every particle (sparks, ash, embers, glitter, shards,
// confetti). "off" plays nothing, and so does a baseline.

export type Fx =
  | { kind: "slash"; key: string }
  | { kind: "ash"; key: string }
  | {
      kind: "burst";
      at: { kind: "node"; key: string } | { kind: "exit"; to: Exit };
      colours: ManaColour[];
      commander: boolean;
      /** The spell's card is still flying from the stack: burst when it lands. */
      afterFlight: boolean;
    }
  | { kind: "stomp"; key: string; afterFlight: boolean }
  | { kind: "embers"; keys: string[] }
  | { kind: "shield"; keys: string[] }
  | { kind: "impact"; seat: Seat; heavy: boolean; yours: boolean }
  | { kind: "glitter"; seat: Seat }
  | { kind: "shatter"; seat: Seat }
  | { kind: "confetti" }
  | { kind: "ashfall" }
  | { kind: "shine" };

/** The most attackers that spark and blockers that shimmer in one diff. */
export const MAX_MARKED = 6;

function toGraveyard(to: Exit): boolean {
  return to.kind === "node"
    ? to.key.startsWith("graveyard:")
    : to.kind === "anchor" && to.anchor === "graveyard";
}

export function planEffects(
  diff: TableDiff,
  model: TableModel,
  level: EffectsLevel,
): Fx[] {
  if (level === "off" || diff.baseline) return [];
  const full = level === "full";
  const viewer = model.observing ? null : model.viewSeat;
  const yours = (seat: Seat) =>
    viewer !== null && (seat === viewer || seat === model.teammateSeat);
  const out: Fx[] = [];
  for (const event of diff.events)
    switch (event.type) {
      case "leave": {
        // A token that dies stops existing (no graveyard grows), so a vanishing creature has
        // died as far as the eye goes, as the sound already holds.
        const died =
          event.creature &&
          (toGraveyard(event.to) || event.to.kind === "vanish");
        if (!died) break;
        if (event.combat) out.push({ kind: "slash", key: event.key });
        else if (full) out.push({ kind: "ash", key: event.key });
        break;
      }
      case "cast":
        if (event.commander)
          out.push({
            kind: "burst",
            at: { kind: "node", key: event.key },
            colours: [],
            commander: true,
            afterFlight: event.from.kind !== "appear",
          });
        break;
      case "resolve":
        if (event.big)
          out.push({
            kind: "burst",
            at:
              event.to.kind === "node"
                ? { kind: "node", key: event.to.key }
                : { kind: "exit", to: event.to },
            colours: event.colours,
            commander: false,
            afterFlight: event.to.kind !== "vanish",
          });
        break;
      case "enter": {
        const card = model.cards.get(event.key)?.card;
        if (card && !card.hidden && isBigCreature(card))
          out.push({
            kind: "stomp",
            key: event.key,
            afterFlight: event.from.kind !== "appear",
          });
        break;
      }
      case "attack":
        if (full && event.keys.length > 0)
          out.push({ kind: "embers", keys: event.keys.slice(0, MAX_MARKED) });
        break;
      case "block":
        if (event.keys.length > 0)
          out.push({ kind: "shield", keys: event.keys.slice(0, MAX_MARKED) });
        break;
      case "life":
        if (event.delta <= -HEAVY_LOSS)
          out.push({
            kind: "impact",
            seat: event.seat,
            heavy: event.delta <= -2 * HEAVY_LOSS,
            yours: yours(event.seat),
          });
        else if (full && event.delta >= BIG_GAIN)
          out.push({ kind: "glitter", seat: event.seat });
        break;
      case "eliminated":
        out.push({ kind: "shatter", seat: event.seat });
        break;
      case "result":
        if (full && event.outcome === "victory") out.push({ kind: "confetti" });
        if (full && event.outcome === "defeat") out.push({ kind: "ashfall" });
        break;
      case "turn":
        if (event.yours ?? (viewer !== null && event.activeSeat === viewer))
          out.push({ kind: "shine" });
        break;
      default:
        break;
    }
  return out;
}
