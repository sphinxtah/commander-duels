import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, reply } from "./fixtures";
import { SleevePicker } from "./SleevePicker";

// v0.9.0: a deck keeps a sleeve that doesn't show (removed by a moderator, or a campaign back no
// longer earned), and the picker says its tables show the default.

afterEach(() => vi.restoreAllMocks());

const removed = {
  id: "5b6f0c1e-0000-4000-8000-000000000001",
  name: "Rude",
  url: "/api/v1/sleeves/5b6f0c1e-0000-4000-8000-000000000001/image",
  created_at: "2026-11-07T00:00:00Z",
  removed: true,
};

function serve(backs: string[]) {
  const api = mockApi();
  api.on("GET /api/v1/me/sleeves", () =>
    reply(200, { defaults: [], sleeves: [removed], limit: 20, backs }),
  );
  api.on("GET /api/v1/me/cosmetics", () =>
    reply(200, {
      card_back: null,
      title: null,
      card_backs: [
        { id: "broken-writ", name: "Broken Writ", earned: backs.length > 0 },
      ],
      titles: [],
    }),
  );
  return api;
}

describe("the sleeve picker", () => {
  it("says a removed sleeve the deck wears shows the default until restored", async () => {
    serve([]);
    render(
      <SleevePicker
        deckId="deck"
        current={`sleeve:${removed.id}`}
        onChange={() => {}}
      />,
    );
    expect(
      await screen.findByText(/wears Rude, which a moderator removed/),
    ).toBeTruthy();
  });

  it("says a campaign back no longer earned shows the default until earned again", async () => {
    serve([]);
    render(
      <SleevePicker
        deckId="deck"
        current="back:broken-writ"
        onChange={() => {}}
      />,
    );
    expect(
      await screen.findByText(/wears Broken Writ, a campaign card back/),
    ).toBeTruthy();
  });

  it("says nothing of an earned back", async () => {
    serve(["broken-writ"]);
    render(
      <SleevePicker
        deckId="deck"
        current="back:broken-writ"
        onChange={() => {}}
      />,
    );
    await screen.findByRole("list", { name: "Sleeves" });
    expect(screen.queryByText(/haven't earned/)).toBeNull();
  });
});
