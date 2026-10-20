import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { DecksPage } from "./DecksPage";
import { deckDetail, mockApi, reply } from "./fixtures";

const player: Me = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "player",
  status: "active",
  onboarding: "complete",
  handle: "ann",
  display_name: "Ann",
  email: "ann@example.com",
  avatar: "tower",
  locale: "en",
  csrf_token: "token",
  permissions: ["games.play", "decks.edit"],
  roles: ["player"],
  preferences: { large_text: false, reduced_motion: false },
  session: {
    id: "session-2",
    kind: "google",
    authenticated_at: "2026-10-20T10:00:00Z",
    idle_expires_at: "2026-10-20T11:00:00Z",
    absolute_expires_at: "2026-10-20T22:00:00Z",
  },
};
const { draft: _draft, ...summary } = deckDetail({
  title: "Mono-Red Burn",
  card_count: 60,
  identity: "R",
});
const starter = {
  name: "legacy-red",
  title: "Red Aggro",
  format: "legacy",
  card_count: 60,
  commanders: [],
  playable: true,
};

afterEach(() => vi.restoreAllMocks());

describe("the decks page", () => {
  it("asks a visitor to sign in", () => {
    render(<DecksPage me={null} heading={createRef()} />);
    expect(screen.getByText("Sign in to build and save decks.")).toBeVisible();
  });

  it("lists the player's decks with their state, and archives one", async () => {
    const api = mockApi();
    api.on(
      "GET /api/v1/decks",
      () => reply(200, [summary]),
      () => reply(200, []),
    );
    api.on("GET /api/v1/decks/starters", () => reply(200, [starter]));
    api.on("POST /api/v1/decks/{deck_id}/archive", () => reply(200, summary));
    render(<DecksPage me={player} heading={createRef()} />);
    const row = (
      await screen.findByRole("link", { name: "Mono-Red Burn" })
    ).closest("li")!;
    expect(row).toHaveTextContent("Legacy");
    expect(row).toHaveTextContent("60 cards");
    expect(within(row).getByText("Ready to play")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    expect(
      await screen.findByText("Mono-Red Burn is archived."),
    ).toBeInTheDocument();
    expect(await screen.findByText(/No decks yet/)).toBeInTheDocument();
  });

  it("copies a starter deck and opens the copy", async () => {
    const api = mockApi();
    api.on("GET /api/v1/decks", () => reply(200, []));
    api.on("GET /api/v1/decks/starters", () => reply(200, [starter]));
    api.on("POST /api/v1/decks", () =>
      reply(201, deckDetail({ id: "deck-9" })),
    );
    render(<DecksPage me={player} heading={createRef()} />);
    const section = await screen.findByRole("region", {
      name: "Starter decks",
    });
    fireEvent.click(within(section).getByRole("button", { name: "Copy" }));
    await vi.waitFor(() => expect(window.location.hash).toBe("#deck/deck-9"));
    const create = api.calls.find(
      (call) => call.route === "POST /api/v1/decks",
    );
    expect(create?.options).toEqual({
      body: expect.objectContaining({
        title: "Red Aggro",
        format: "legacy",
        source: { kind: "starter", starter: "legacy-red" },
      }),
    });
  });
});
