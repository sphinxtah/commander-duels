import { client, describe } from "../api";
import type { DeckSummary } from "./decks";

// The all-card practice sandbox (v1.0.0, docs/decks.md and docs/games.md), behind the gate
// sandbox. A sandbox deck is its own kind of deck (the owner's decision of 2026-11-16): built
// from every card in the game, listed apart, played only in the sandbox, and made a normal
// deck once its owner holds its cards. A sandbox game is started from the deck.

export const SANDBOX = "sandbox";

/** What a sandbox game earns, said wherever one is started or shown. */
export const NOTHING_EARNED =
  "A sandbox game earns nothing: no tokens, no progress towards your tier, no quest, no achievement, and it leaves nothing in your record.";

/** What a sandbox deck is, said where one is made and above the list of them. */
export const SANDBOX_DECK_WORDS =
  "A sandbox deck is built from every card in the game, whether you own it or not. It is played only in the sandbox, against bots, and nowhere a game counts.";

export interface SandboxSetup {
  /** The bots' decks, one a bot: null for a deck of the game's own, or one of the player's. */
  bots: (string | null)[];
  skill: number;
  /** The bots do nothing but draw, pass and discard (goldfishing). */
  passive: boolean;
}

/** How many bots a sandbox game of the format takes. */
export function botChoices(format: DeckSummary["format"]): number[] {
  return format === "legacy" ? [1] : [1, 2, 3];
}

/** A sandbox game's request: the practice game's, asked for as the sandbox's. */
export function sandboxRequest(deck: DeckSummary, setup: SandboxSetup) {
  return {
    format: deck.format,
    deck_id: deck.id,
    bots: setup.bots.map((chosen) => (chosen ? { deck_id: chosen } : {})),
    bot_skill: setup.skill,
    sandbox: true,
    passive: setup.passive,
  };
}

/** Starts a sandbox game: its id, or why it did not start. */
export async function startSandbox(
  deck: DeckSummary,
  setup: SandboxSetup,
): Promise<{ id?: string; error?: string }> {
  const answer = await client
    .POST("/api/v1/practice-games", {
      body: sandboxRequest(deck, setup) as never,
    })
    .catch(() => undefined);
  if (answer?.data) return { id: answer.data.id };
  return { error: describe(answer?.error) };
}

/** Makes a sandbox deck a normal one; why not, when its cards are not all owned. */
export async function convertDeck(deckId: string): Promise<string | undefined> {
  const answer = await client
    .POST("/api/v1/sandbox/decks/{deck_id}/convert", {
      params: { path: { deck_id: deckId } },
    })
    .catch(() => undefined);
  return answer?.data ? undefined : describe(answer?.error);
}

/** The decks a bot may play in a sandbox game of this deck's: the player's own of its format
 * that can start a game, sandbox or not, this one included. */
export function botDecks(deck: DeckSummary, decks: DeckSummary[]) {
  return decks.filter(
    (found) => found.format === deck.format && found.playable,
  );
}

/** How often, and how long apart, a restart asks again while the server has no room yet. */
const RESTART_TRIES = 15;
const RESTART_PAUSE_MS = 2000;
/** The refusals that pass by themselves: the closed game's end is still being written, or the
 * engine has not let go of it yet. */
const NOT_YET = new Set(["game_running", "games_busy"]);

/** Restarts a sandbox game: the running one is closed first, then its setup is played again
 * (the practice game's rematch, which replays the request kept with the game). The server may
 * refuse the new game for a moment after the old one closed (its place is not free yet): asked
 * again for half a minute before giving up, since the old game is already over by then. */
export async function restartSandbox(
  gameId: string,
  running: boolean,
  pause: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ id?: string; error?: string }> {
  const path = { params: { path: { game_id: gameId } } };
  if (running) {
    const closed = await client
      .POST("/api/v1/games/{game_id}/close", path)
      .catch(() => undefined);
    if (!closed?.data) return { error: describe(closed?.error) };
  }
  let refusal: unknown;
  for (let attempt = 0; attempt < RESTART_TRIES; attempt++) {
    const again = await client
      .POST("/api/v1/games/{game_id}/rematch", path)
      .catch(() => undefined);
    const next = again?.data?.game_id;
    if (next) return { id: next };
    refusal = again?.error;
    const code = (refusal as { code?: string } | undefined)?.code;
    if (!code || !NOT_YET.has(code)) break;
    await pause(RESTART_PAUSE_MS);
  }
  return { error: describe(refusal) };
}
