import { vi } from "vitest";
import { client } from "../api";
import type { CardSummary } from "../catalog/catalog";
import type {
  DeckDetail,
  DeckEntry,
  Problem,
  StarterDeck,
  Validation,
} from "./decks";

/** A catalog card for tests; anything not given is a playable, colorless artifact, as an account
 * that builds from the whole catalog sees it (`owned` null). */
export function card(
  name: string,
  fields: Partial<CardSummary> = {},
): CardSummary {
  return {
    id: `card-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
    name,
    layout: "normal",
    mana_cost: "{1}",
    mana_value: 1,
    type_line: "Artifact",
    oracle_text: "",
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    colors: [],
    color_identity: [],
    keywords: [],
    produced_mana: [],
    faces: [],
    rarity: "common",
    set_code: "tst",
    released_at: "2026-01-01",
    status: "certified",
    status_reason: null,
    status_detail: null,
    playable: true,
    text_differs: false,
    legalities: { legacy: "legal", commander: "legal" },
    commander: false,
    partner: null,
    companion: false,
    copy_limit: 4,
    edhrec_rank: null,
    image: null,
    owned: null,
    ...fields,
  };
}

/** One of the ten Commander starter decks (v0.3.1), not one the player chose. */
export function starterDeck(fields: Partial<StarterDeck> = {}): StarterDeck {
  return {
    name: "starter_wu_v1",
    title: "Skyward Patrol",
    format: "commander",
    card_count: 100,
    commanders: ["Kangee, Sky Warden"],
    playable: true,
    colors: "WU",
    color_names: "White / Blue",
    guild: "Azorius",
    description: "A flock of flyers.",
    how_to_play: "Develop mana and two or three flyers.",
    teaches: "Flying and attack triggers.",
    commander_card_id: null,
    commander_printing_id: null,
    chosen: false,
    ...fields,
  };
}

/** A validation problem: a collection-locked one unless told otherwise. */
export function problem(fields: Partial<Problem> = {}): Problem {
  return {
    code: "collection.locked",
    kind: "collection_locked",
    message:
      "This deck holds 2 copies of Stand-in Golem; your library has 1 copy.",
    remedy: "Remove 1, or wait until your library holds more.",
    card_ids: [],
    quantity: 2,
    ...fields,
  };
}

export function entry(
  item: CardSummary,
  quantity: number,
  location: DeckEntry["location"] = "main",
): DeckEntry {
  return { card_id: item.id, printing_id: null, quantity, location };
}

export function validation(fields: Partial<Validation> = {}): Validation {
  return {
    format: "legacy",
    format_version: 1,
    legal: true,
    playable: true,
    errors: [],
    warnings: [],
    counts: {
      main: 60,
      sideboard: 0,
      commander: 0,
      companion: 0,
      maybeboard: 0,
    },
    ...fields,
  };
}

export function deckDetail(fields: Partial<DeckDetail> = {}): DeckDetail {
  return {
    id: "deck-1",
    title: "Red deck",
    format: "legacy",
    visibility: "private",
    card_count: 0,
    legal: true,
    playable: true,
    identity: "R",
    commanders: [],
    latest_revision: null,
    source: "empty",
    archived: false,
    deleted_at: null,
    updated_at: "2026-10-20T10:00:00Z",
    notes: "",
    share_code: null,
    draft: { version: 1, entries: [] },
    validation: validation(),
    revisions: [],
    cards: {},
    ...fields,
  };
}

/** The API answered route by route, as "METHOD /path"; each route takes its answers in order
 * and keeps the last. `calls` records each request with its options. */
export function mockApi() {
  const queues = new Map<string, (() => unknown)[]>();
  const calls: { route: string; options: unknown }[] = [];
  const serve = (method: string) =>
    (async (path: string, options: unknown) => {
      const route = `${method} ${path}`;
      calls.push({ route, options });
      const queue = queues.get(route);
      if (!queue?.length) throw new Error(`No answer for ${route}`);
      return (queue.length > 1 ? queue.shift()! : queue[0]!)();
    }) as never;
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  return {
    calls,
    on(route: string, ...answers: (() => unknown)[]) {
      queues.set(route, answers);
    },
  };
}

export function reply(status: number, body?: unknown) {
  const response = new Response(null, { status });
  return response.ok ? { data: body, response } : { error: body, response };
}

export function openDialogs() {
  // jsdom draws <dialog> but may not open it modally.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}
