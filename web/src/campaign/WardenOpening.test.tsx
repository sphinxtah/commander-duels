import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import {
  asOpening,
  WardenOpening,
  type WardenOpeningView,
} from "./WardenOpening";

afterEach(() => vi.restoreAllMocks());

async function settle() {
  await act(() => new Promise((done) => setTimeout(done, 20)));
}

function card(position: number, name: string, extra: object = {}) {
  return {
    position,
    card_id: `00000000-0000-4000-8000-${String(position).padStart(12, "0")}`,
    printing_id: `00000000-0000-4000-9000-${String(position).padStart(12, "0")}`,
    name,
    mana_cost: null,
    type_line: "Creature",
    rarity: "common",
    set_code: "TST",
    set_name: "Test",
    released_at: null,
    collector_number: String(position),
    finish: "nonfoil" as const,
    sheet: "",
    new: true,
    faces: 0,
    stand_in: false,
    extra: false,
    commander: false,
    custom: false,
    ...extra,
  };
}

const VIEW: WardenOpeningView = {
  id: "11111111-1111-4111-8111-111111111111",
  encounter: 1,
  opponent: "tibalt",
  opponent_name: "Tibalt",
  deck_title: "Tibalt's Deck",
  deck_id: null,
  cards: 3,
  created_at: "2026-11-10T18:00:00Z",
  opened_at: null,
  pulled: [
    card(0, "Mountain"),
    card(1, "Lightning Bolt", { rarity: "uncommon" }),
    card(2, "Karlach, Fury of Avernus", { rarity: "mythic", commander: true }),
  ],
};

describe("opening a warden's deck (v0.9.5)", () => {
  it("is the shop's pack opening, the warden's deck as its product", () => {
    const opening = asOpening(VIEW);
    expect(opening.product.name).toBe("Tibalt's Deck");
    expect(opening.cards.map((found) => found.name).at(-1)).toBe(
      "Karlach, Fury of Avernus",
    );
  });

  it("tears open the deck box and marks it opened at the first look", async () => {
    vi.spyOn(client, "GET").mockResolvedValue({
      data: VIEW,
      response: new Response(null, { status: 200 }),
    } as never);
    const post = vi
      .spyOn(client, "POST")
      .mockResolvedValue({ data: { ...VIEW, opened_at: "now" } } as never);
    const done = vi.fn();
    render(<WardenOpening id={VIEW.id} onDone={done} />);
    await settle();
    expect(post).toHaveBeenCalledWith(
      "/api/v1/campaign/openings/{opening_id}/open",
      { params: { path: { opening_id: VIEW.id } } },
    );
    const box = screen.getByRole("button", {
      name: "Tear open the Tibalt's Deck",
    });
    expect(box.querySelector("img")?.getAttribute("src")).toContain("tibalt");
    fireEvent.click(box);
    await settle();
  });
});
