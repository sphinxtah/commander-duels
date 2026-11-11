import { isPortraitId } from "../game/table/portrait";
import type { Speaker } from "./script";

// Who stands on the cut scene's stage (v0.8.0), as the handoff casts them: the wardens by their
// own portraits (the owner's art, web/public/portraits), Kaya by hers, the player by their ally's,
// The Sphinx veiled until the finale ("his full portrait, throne reveal and title are reserved for
// the finale"), and the High Priest, a survivor and a player without an ally as drawn figures.

export type Side = "left" | "right";
export type Figure = "high-priest" | "survivor" | "wayfarer";

export interface CastMember {
  speaker: Speaker;
  name: string;
  /** A roster portrait ID, or null for a drawn figure (or the narrator). */
  portrait: string | null;
  figure: Figure | null;
  side: Side;
  /** The Sphinx before the finale: a silhouette in gold light, nameless. */
  veiled: boolean;
}

const WARDENS: Partial<Record<Speaker, { name: string; portrait: string }>> = {
  KAYA: { name: "Kaya", portrait: "kaya" },
  TIBALT: { name: "Tibalt", portrait: "tibalt" },
  DARETTI: { name: "Daretti", portrait: "daretti" },
  DOMRI: { name: "Domri", portrait: "domri" },
  DOVIN: { name: "Dovin", portrait: "dovin" },
  OKO: { name: "Oko", portrait: "oko" },
  XENAGOS: { name: "Xenagos", portrait: "xenagos" },
  TEZZERET: { name: "Tezzeret", portrait: "tezzeret" },
  ARZAKON: { name: "Arzakon", portrait: "arzakon" },
  ASHIOK: { name: "Ashiok", portrait: "ashiok" },
  OB_NIXILIS: { name: "Ob Nixilis", portrait: "ob-nixilis" },
  DIHADA: { name: "Geyadrone Dihada", portrait: "geyadrone-dihada" },
  BOLAS: { name: "Nicol Bolas", portrait: "nicol-bolas" },
  LILIANA: { name: "Liliana", portrait: "liliana" },
  SPHINX: { name: "The Sphinx", portrait: "the-sphinx" },
};

/** Whether a scene belongs to the finale, where The Sphinx is seen at last. */
export function finaleScene(sceneId: string): boolean {
  return (
    sceneId.startsWith("FC.E14") ||
    sceneId.startsWith("FC.E15") ||
    sceneId.startsWith("FC.END") ||
    sceneId === "FC.ALLIANCE.SPHINX"
  );
}

/** Liliana stands with the player once her seal is won: from her victory scene on, except while
 * The Sphinx holds her to his court (v0.9.6: his flight from ward 14 and ward 15 itself). */
function lilianaAllied(sceneId: string): boolean {
  if (sceneId === "FC.E14.FLIGHT" || sceneId.startsWith("FC.E15")) return false;
  return (
    sceneId === "FC.E13.POST" || finaleScene(sceneId) || sceneId === "FC.REPLAY"
  );
}

export interface PlayerFace {
  name: string;
  /** The account's ally, whose portrait stands for it. */
  alliance: string | null;
}

export function castOf(
  speaker: Speaker,
  sceneId: string,
  player: PlayerFace,
): CastMember {
  const base = { speaker, figure: null, veiled: false } as const;
  switch (speaker) {
    case "NARRATOR":
      return { ...base, name: "", portrait: null, side: "left" };
    case "PLAYER":
      return isPortraitId(player.alliance)
        ? {
            ...base,
            name: player.name,
            portrait: player.alliance,
            side: "left",
          }
        : {
            ...base,
            name: player.name,
            portrait: null,
            figure: "wayfarer",
            side: "left",
          };
    case "KAYA":
      return { ...base, name: "Kaya", portrait: "kaya", side: "left" };
    case "SURVIVOR":
      return {
        ...base,
        name: "Survivor",
        portrait: null,
        figure: "survivor",
        side: "left",
      };
    case "HIGH_PRIEST":
      return {
        ...base,
        name: "High Priest",
        portrait: null,
        figure: "high-priest",
        side: "right",
      };
    case "SPHINX": {
      const seen = finaleScene(sceneId);
      return {
        ...base,
        name: seen ? "The Sphinx" : "A voice from the throne",
        portrait: "the-sphinx",
        side: "right",
        veiled: !seen,
      };
    }
    case "LILIANA":
      return {
        ...base,
        name: "Liliana",
        portrait: "liliana",
        side: lilianaAllied(sceneId) ? "left" : "right",
      };
    default: {
      const warden = WARDENS[speaker];
      return {
        ...base,
        name: warden?.name ?? speaker,
        portrait: warden?.portrait ?? null,
        side: "right",
      };
    }
  }
}

/** The speaker label shown on a bark at the table. */
export function speakerName(speaker: Speaker, finale: boolean): string {
  if (speaker === "SPHINX")
    return finale ? "The Sphinx" : "A voice from the throne";
  if (speaker === "HIGH_PRIEST") return "High Priest";
  return WARDENS[speaker]?.name ?? speaker;
}

/** A speaker's portrait for a bark: wardens, Kaya, Liliana and The Sphinx have one. */
export function speakerPortrait(speaker: Speaker): string | null {
  return WARDENS[speaker]?.portrait ?? null;
}
