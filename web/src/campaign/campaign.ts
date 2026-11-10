import { client, type ApiError } from "../api";
import type { components } from "../generated/api";
import { STORY, type Scene } from "./script";
import type { Step } from "./stage";

// The campaign's API (v0.8.0, api/campaign.py) and the steps between its scenes.

export type CampaignState = components["schemas"]["CampaignState"];
export type CampaignEncounter = components["schemas"]["CampaignEncounter"];
export type CampaignChapter = components["schemas"]["CampaignChapter"];
export type CampaignRef = components["schemas"]["CampaignRef"];
export type Tier = CampaignEncounter["tier"];

export const CAMPAIGN_ROUTE = /^#campaign\/game\/([0-9a-f-]{36})$/i;

/** The game a #campaign/game/<id> address comes back from, to tell its story. */
export function returningGame(hash: string): string | undefined {
  return CAMPAIGN_ROUTE.exec(hash)?.[1]?.toLowerCase();
}

/** Where a campaign duel's table leads when it ends: back to the campaign, to its scene. */
export function campaignLink(gameId: string): string {
  return `#campaign/game/${gameId}`;
}

export async function loadCampaign(): Promise<CampaignState | null> {
  const { data } = await client.GET("/api/v1/campaign");
  return data ?? null;
}

export async function markSeen(scene: string): Promise<CampaignState | null> {
  const { data } = await client.POST("/api/v1/campaign/scenes", {
    body: { scene },
  });
  return data ?? null;
}

export async function changeTutorial(
  body: components["schemas"]["TutorialChange"],
): Promise<CampaignState | null> {
  const { data } = await client.PUT("/api/v1/campaign/tutorial", { body });
  return data ?? null;
}

export type StartChoice =
  | { kind: "learn" }
  | { kind: "loaner" }
  | { kind: "own"; deckId: string };

export async function startEncounter(
  number: number,
  choice: StartChoice,
  challenge = false,
): Promise<{ gameId?: string; error?: string }> {
  const { data, error } = await client.POST(
    "/api/v1/campaign/encounters/{number}/start",
    {
      params: { path: { number } },
      body: {
        deck_id: choice.kind === "own" ? choice.deckId : null,
        learn: choice.kind === "learn",
        loaner: choice.kind === "loaner",
        challenge,
      },
    },
  );
  if (data) return { gameId: data.id };
  const problem = error as ApiError | undefined;
  return {
    error:
      problem?.message ??
      "The duel could not start. Check your connection and try again.",
  };
}

/** The ward's name of a tier, as the map and the chapter cards say it. */
export const TIER_NAMES: Record<Tier, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  platinum: "Platinum",
  mythic: "Mythic",
  godlike: "The Throne",
};

/** The scene before an encounter's duel, with the alliance's own scene first where the handoff
 * asks for one: the Sphinx's sign before the finale, or an incarnation of the player's ally. */
export function scenesBefore(
  state: CampaignState,
  encounter: CampaignEncounter,
  alliance: string | null,
): Scene[] {
  const story = STORY.encounters[encounter.number];
  const scenes: Scene[] = [];
  const seen = new Set(state.progress.scenes_seen);
  if (encounter.number === 14 && alliance === "the-sphinx") {
    scenes.push(STORY.allianceSphinx);
  } else if (
    alliance &&
    alliance === encounter.opponent &&
    !seen.has(STORY.allianceMatch.id)
  ) {
    scenes.push(STORY.allianceMatch);
  }
  if (story) scenes.push(story.pre);
  return scenes;
}

/** The cards after a first victory: the seal claimed, and the chapter's rewards when the victory
 * completed it. */
export function stepsAfterWin(
  state: CampaignState,
  encounter: CampaignEncounter,
): Step[] {
  const steps: Step[] = [];
  if (encounter.number < 14)
    steps.push({
      kind: "seal",
      number: encounter.number,
      name: encounter.seal,
      tier: encounter.tier,
    });
  if (encounter.spoils.earned)
    steps.push({
      kind: "spoils",
      opponent: encounter.opponent,
      deck: encounter.spoils.deck,
      commander: encounter.spoils.commander,
      tokens: encounter.spoils.tokens,
    });
  const at = state.chapters.findIndex((chapter) =>
    chapter.encounters.includes(encounter.number),
  );
  const chapter = state.chapters[at];
  if (chapter?.complete) {
    const following = state.chapters[at + 1];
    steps.push({
      kind: "chapter",
      name: chapter.name,
      tier: chapter.tier,
      rewards: chapter.rewards.map((reward) => reward.name),
      next: following
        ? { name: TIER_NAMES[following.tier], tier: following.tier }
        : null,
    });
  }
  return steps;
}

/** Whether the finale's incarnation crossed into this duel, as its table saw (v0.8.0). The
 * ending's scene follows it: the standard ending, or the early one when the claim broke before
 * The Sphinx could cross. */
export function arrivedKey(gameId: string): string {
  return `cd.campaign.arrived.${gameId}`;
}

export function rememberArrival(gameId: string): void {
  try {
    sessionStorage.setItem(arrivedKey(gameId), "1");
  } catch {
    // Without storage the ending falls back to the standard one.
  }
}

export function arrived(gameId: string): boolean | null {
  try {
    return sessionStorage.getItem(arrivedKey(gameId)) === "1";
  } catch {
    return null;
  }
}
