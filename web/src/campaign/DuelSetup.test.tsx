import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, openDialogs, reply } from "../decks/fixtures";
import type { CampaignEncounter, CampaignState } from "./campaign";
import { DuelSetup } from "./DuelSetup";

const finale = {
  number: 14,
  opponent: "the-sphinx",
  name: "The Sphinx",
  title: "The Throne of Concordance",
  tier: "godlike",
  location: "The throne",
  seal: "Authorship",
  commander: null,
  skill: 6,
  status: "won",
  spoils: {
    tokens: 8192000,
    deck: "The Sphinx's deck",
    commander: "High Priest",
    decks: [
      {
        title: "The Sphinx's deck",
        commander: "High Priest",
        opponent: "the-sphinx",
      },
    ],
    earned: true,
  },
} as unknown as CampaignEncounter;

function campaign(earned: boolean): CampaignState {
  return {
    loaner: "Adeline's Vanguard",
    loaner_commander: "Adeline, Resplendent Cathar",
    progress: {
      tutorial: { complete: true, hints: false, skipped: true, lessons: [] },
    },
    challenge: { name: "Apex Unbound", open: true, earned, at: 14 },
  } as unknown as CampaignState;
}

describe("Apex Unbound's setup (v0.9.3)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the challenge and its badge, and starts the finale as the challenge", async () => {
    openDialogs();
    const api = mockApi();
    api.on("GET /api/v1/decks", () => reply(200, []));
    api.on("POST /api/v1/campaign/encounters/{number}/start", () =>
      reply(409, { message: "Win the finale first." }),
    );
    render(
      <DuelSetup
        state={campaign(false)}
        encounter={finale}
        lostBefore
        canUseOwnDecks={false}
        challenge
        onClose={() => {}}
        onState={() => {}}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Apex Unbound" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The post-campaign challenge")).toBeInTheDocument();
    expect(screen.getByText(/Apex Unbound badge, once/)).toBeInTheDocument();
    // No spoils line and no Learn Commander here.
    expect(screen.queryByText(/8,192,000 tokens/)).toBeNull();
    expect(screen.queryByText("Learn Commander")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Use the loaner/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Win the finale first.",
    );
    const started = api.calls.find(
      (call) =>
        call.route === "POST /api/v1/campaign/encounters/{number}/start",
    )!.options as { body: Record<string, unknown> };
    expect(started.body).toMatchObject({ loaner: true, challenge: true });
  });
});

describe("the court's setup (v0.9.6)", () => {
  afterEach(() => vi.restoreAllMocks());

  const court = {
    ...finale,
    number: 15,
    title: "The Unbound Court",
    status: "open",
    spoils: {
      tokens: 16384000,
      deck: "Nicol Bolas's Gift",
      commander: "Nicol Bolas, the Ravager",
      decks: [
        {
          title: "Nicol Bolas's Gift",
          commander: "Nicol Bolas, the Ravager",
          opponent: "nicol-bolas",
        },
        {
          title: "Liliana's Gift",
          commander: "Liliana, Heretical Healer",
          opponent: "liliana",
        },
      ],
      earned: false,
    },
    court: {
      player_seat: 1,
      ally_seats: [0, 2],
      opponents: [],
      helper_tokens: 10000,
      kings_table: {
        deck_format: "commander",
        life: "all_40",
        king_attacks_anyone: true,
        guarded_kings: true,
      },
      turn_cap: 240,
    },
  } as unknown as CampaignEncounter;

  it("offers bots or friends as Generals, and opens the court's table for friends", async () => {
    openDialogs();
    const api = mockApi();
    api.on("GET /api/v1/decks", () =>
      reply(200, [
        {
          id: "deck-1",
          title: "My Court Deck",
          format: "commander",
          playable: true,
          archived: false,
          deleted_at: null,
          commanders: ["Kenrith, the Returned King"],
        },
      ]),
    );
    api.on("GET /api/v1/friends", () =>
      reply(200, {
        friends: [
          {
            id: "friend-1",
            handle: "bob",
            alliance: null,
            presence: "online",
          },
        ],
      }),
    );
    api.on("POST /api/v1/campaign/encounters/{number}/court", () =>
      reply(409, { message: "Finish your running game first." }),
    );
    render(
      <DuelSetup
        state={campaign(false)}
        encounter={court}
        lostBefore={false}
        canUseOwnDecks
        onClose={() => {}}
        onState={() => {}}
      />,
    );
    expect(screen.getByText("The court · King's Table")).toBeInTheDocument();
    // The court's rules as its settings give them (v0.9.7): the house rule with its guard, and
    // 40 turns for each of the six players.
    expect(screen.getByText(/^The Sphinx is King B/)).toHaveTextContent(
      "A King's creatures may attack any opposing General, and the other King once one of that King's Generals is defeated; every player starts at 40 life. The court ends with no result after 240 turns, 40 for each player. Lose the court and you return to the throne’s ward.",
    );
    expect(
      screen.getByText("Nicol Bolas's Gift and Liliana's Gift"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /with bots as your Generals/ }),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("checkbox", { name: /bob/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Open the court for 1 friend/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Finish your running game first.",
    );
    const opened = api.calls.find(
      (call) =>
        call.route === "POST /api/v1/campaign/encounters/{number}/court",
    )!.options as { body: Record<string, unknown> };
    expect(opened.body).toMatchObject({
      deck_id: "deck-1",
      friends: ["friend-1"],
      challenge: false,
    });
  });
});
