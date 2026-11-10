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
    challenge: { name: "Apex Unbound", open: true, earned },
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
