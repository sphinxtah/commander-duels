import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignState, SavedDuel } from "./campaign";
import {
  SavedDuels as List,
  savedLine,
  savedTitle,
  useResuming,
} from "./SavedDuels";

const api = vi.hoisted(() => ({ POST: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  client: api,
}));

const NOW = Date.parse("2026-11-15T12:00:00Z");

function duel(change: Partial<SavedDuel> = {}): SavedDuel {
  return {
    save: "s1",
    game: "g1",
    encounter: 3,
    challenge: false,
    turn: 7,
    saved_at: new Date(NOW - 3_600_000).toISOString(),
    expires_at: new Date(NOW + 29.5 * 86_400_000).toISOString(),
    table: null,
    ...change,
  };
}

function campaign(saved: SavedDuel[]): CampaignState {
  return {
    encounters: [
      { number: 3, title: "The Ember Gate" },
      { number: 15, title: "The Unbound Court" },
    ],
    challenge: { name: "Apex Unbound", open: true, earned: false, at: 14 },
    saved,
  } as unknown as CampaignState;
}

/** The list as the map holds it: with the map's own way of playing a duel on. */
function SavedDuels({
  state,
  onChanged,
}: {
  state: CampaignState;
  onChanged: () => void;
}) {
  return <List state={state} resuming={useResuming(onChanged)} />;
}

beforeEach(() => {
  api.POST.mockReset();
  window.location.hash = "#campaign";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a saved duel's words", () => {
  it("names the ward, or the challenge", () => {
    const state = campaign([]);
    expect(savedTitle(state, duel())).toBe("The Ember Gate");
    expect(savedTitle(state, duel({ encounter: 14, challenge: true }))).toBe(
      "Apex Unbound",
    );
    expect(savedTitle(state, duel({ encounter: 9 }))).toBe("Ward 9");
  });

  it("says the turn and when the save runs out", () => {
    expect(savedLine(duel(), NOW)).toMatch(
      /^Saved on turn 7 · runs out in 29 days \(.+\)$/,
    );
    expect(savedLine(duel({ turn: null }), NOW)).toMatch(
      /^Saved · runs out in 29 days/,
    );
    expect(savedLine(duel({ table: "ABCD23" }), NOW)).toMatch(
      /^Suspended on turn 7 · runs out/,
    );
  });
});

describe("the map's saved duels", () => {
  it("shows nothing while no duel is saved", () => {
    const { container } = render(
      <SavedDuels state={campaign([])} onChanged={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each saved duel and plays one on", async () => {
    api.POST.mockResolvedValue({ data: { id: "g1" } });
    render(
      <SavedDuels
        state={campaign([
          duel(),
          duel({ save: "s2", game: "g2", encounter: 14, challenge: true }),
        ])}
        onChanged={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Saved duels" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The Ember Gate")).toBeInTheDocument();
    expect(screen.getByText("Apex Unbound")).toBeInTheDocument();
    expect(screen.getAllByText(/Saved on turn 7 · runs out/)).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Your games" })).toHaveAttribute(
      "href",
      "#play/games",
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Resume.*The Ember Gate/ }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#game/g1"));
    expect(api.POST).toHaveBeenCalledWith("/api/v1/saves/{save_id}/resume", {
      params: { path: { save_id: "s1" } },
    });
  });

  it("sends a court its players suspended to its table", () => {
    render(
      <SavedDuels
        state={campaign([duel({ encounter: 15, table: "ABCD23" })])}
        onChanged={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Saved duel" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Go to its table.*The Unbound Court/ }),
    ).toHaveAttribute("href", "#tables/ABCD23");
    expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
    expect(screen.getByText(/Suspended on turn 7/)).toBeInTheDocument();
  });

  it("says why a duel could not be played on, and asks for the campaign again", async () => {
    api.POST.mockResolvedValue({
      error: {
        code: "save_ended",
        message: "The game was upgraded since this was saved.",
      },
    });
    const onChanged = vi.fn();
    const { rerender } = render(
      <SavedDuels state={campaign([duel()])} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The game was upgraded since this was saved.",
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#campaign");
    // The campaign, asked for again, no longer has the save: the reason stays, the list goes.
    rerender(<SavedDuels state={campaign([])} onChanged={onChanged} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The game was upgraded since this was saved.",
    );
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("link", { name: "Your games" })).toBeNull();
  });
});
