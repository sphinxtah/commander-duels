import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

  it("keeps the Archived tab's list when the list asked for after an archive answers last", async () => {
    const api = mockApi();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.on(
      "GET /api/v1/decks",
      () => reply(200, [summary]),
      // The active list after the archive is slow; the Archived tab's answers first.
      () => held.then(() => reply(200, [])),
      () => reply(200, [{ ...summary, archived: true }]),
    );
    api.on("GET /api/v1/decks/starters", () => reply(200, [starter]));
    api.on("POST /api/v1/decks/{deck_id}/archive", () => reply(200, summary));
    render(<DecksPage me={player} heading={createRef()} />);
    const row = (
      await screen.findByRole("link", { name: "Mono-Red Burn" })
    ).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    expect(
      await screen.findByText("Mono-Red Burn is archived."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.route === "GET /api/v1/decks"),
      ).toHaveLength(3),
    );
    await act(async () => release());
    const archived = (
      await screen.findByRole("link", { name: "Mono-Red Burn" })
    ).closest("li")!;
    expect(
      within(archived).getByRole("button", { name: "Unarchive" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No archived decks.")).toBeNull();
  });

  it("asks for the Archived tab's list when an archive answers after the switch to it", async () => {
    const api = mockApi();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const old = { ...summary, id: "deck-old", title: "Old Elves" };
    // Each list after the first follows the tab it was asked for.
    api.on(
      "GET /api/v1/decks",
      () => reply(200, [summary]),
      () => {
        const last = api.calls.at(-1)!.options as {
          params: { query: { view: string } };
        };
        return reply(
          200,
          last.params.query.view === "archived"
            ? [old, { ...summary, archived: true }]
            : [],
        );
      },
    );
    api.on("GET /api/v1/decks/starters", () => reply(200, [starter]));
    api.on("POST /api/v1/decks/{deck_id}/archive", () =>
      held.then(() => reply(200, summary)),
    );
    render(<DecksPage me={player} heading={createRef()} />);
    const row = (
      await screen.findByRole("link", { name: "Mono-Red Burn" })
    ).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    // The player moves to Archived while the archive is on its way.
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(
      await screen.findByRole("link", { name: "Old Elves" }),
    ).toBeInTheDocument();
    await act(async () => release());
    await screen.findByText("Mono-Red Burn is archived.");
    // The list the archive asks for afterwards is the Archived tab's, so it stays on screen.
    const views = api.calls
      .filter((call) => call.route === "GET /api/v1/decks")
      .map(
        (call) =>
          (call.options as { params: { query: { view: string } } }).params.query
            .view,
      );
    expect(views.at(-1)).toBe("archived");
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Old Elves" }),
      ).toBeInTheDocument(),
    );
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
