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
import {
  deckDetail,
  mockApi,
  problem,
  reply,
  starterDeck,
  validation,
} from "./fixtures";

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
// An administrator builds from the whole catalog (v0.3.1), so every starter deck can play.
const administrator: Me = {
  ...player,
  roles: ["player", "administrator"],
  permissions: [...player.permissions, "library.unlimited"],
};
const starter = starterDeck({
  name: "starter_rg_v1",
  title: "Wild Stampede",
  colors: "RG",
  color_names: "Red / Green",
  guild: "Gruul",
  commanders: ["Targ Nar, Demon-Fang Gnoll"],
});
/** The deck's address in a GET for one deck, to answer each deck with its own. */
function asked(api: ReturnType<typeof mockApi>): string {
  return (
    api.calls.at(-1)!.options as { params: { path: { deck_id: string } } }
  ).params.path.deck_id;
}

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
    render(<DecksPage me={administrator} heading={createRef()} />);
    const section = await screen.findByRole("region", {
      name: "Starter decks",
    });
    // An administrator's copy plays: nothing says otherwise.
    expect(section).not.toHaveTextContent("Needs cards you don't own");
    fireEvent.click(
      within(section).getByRole("button", { name: "Copy Wild Stampede" }),
    );
    await vi.waitFor(() => expect(window.location.hash).toBe("#deck/deck-9"));
    const create = api.calls.find(
      (call) => call.route === "POST /api/v1/decks",
    );
    expect(create?.options).toEqual({
      body: expect.objectContaining({
        title: "Wild Stampede",
        format: "commander",
        source: { kind: "starter", starter: "starter_rg_v1" },
      }),
    });
  });

  it("lists the player's two starter decks first, and says the others need cards they don't own", async () => {
    const api = mockApi();
    api.on("GET /api/v1/decks", () => reply(200, []));
    api.on("GET /api/v1/decks/starters", () =>
      reply(200, [
        starterDeck({ playable: false }),
        { ...starter, chosen: true },
        starterDeck({
          name: "starter_gu_v1",
          title: "Tides of Growth",
          chosen: true,
        }),
      ]),
    );
    render(<DecksPage me={player} heading={createRef()} />);
    const section = await screen.findByRole("region", {
      name: "Starter decks",
    });
    expect(section).toHaveTextContent(/The two you chose are among your decks/);
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(
      ["Wild Stampede", "Tides of Growth", "Skyward Patrol"],
    );
    expect(rows[0]).toHaveTextContent("One of your two");
    expect(rows[0]).toHaveTextContent("Gruul (Red / Green)");
    expect(rows[0]).toHaveTextContent("Targ Nar, Demon-Fang Gnoll");
    expect(rows[0]).not.toHaveTextContent("Needs cards you don't own");
    expect(rows[2]).not.toHaveTextContent("One of your two");
    expect(rows[2]).toHaveTextContent("Needs cards you don't own");
    // It may still be copied.
    expect(
      within(rows[2]!).getByRole("button", { name: "Copy Skyward Patrol" }),
    ).toBeEnabled();
    // How to play it, folded away until asked for.
    expect(within(rows[2]!).getByText("How to play it")).toBeInTheDocument();
    expect(screen.getByText(/from your card library/)).toBeInTheDocument();
  });

  it("tags a deck that only tables allowing its cards take (v0.4.5)", async () => {
    const api = mockApi();
    const lotus = {
      ...summary,
      id: "deck-lotus",
      title: "Lotus Storm",
      format: "commander" as const,
      needs: ["banned" as const, "not_legal" as const],
    };
    api.on("GET /api/v1/decks", () => reply(200, [lotus]));
    api.on("GET /api/v1/decks/starters", () => reply(200, []));
    render(<DecksPage me={player} heading={createRef()} />);
    const row = (
      await screen.findByRole("link", { name: "Lotus Storm" })
    ).closest("li")!;
    expect(row).toHaveTextContent("Ready to play");
    expect(row).toHaveTextContent("Casual tables only:");
    expect(within(row).getByText("Banned cards")).toBeInTheDocument();
    expect(within(row).getByText("Not legal in Commander")).toBeInTheDocument();
  });

  it("tells a deck the library holds back from one the engine cannot play yet", async () => {
    const api = mockApi();
    const locked = {
      ...summary,
      id: "deck-locked",
      title: "Borrowed Elves",
      playable: false,
      collection_locked: true,
    };
    const unsupported = {
      ...summary,
      id: "deck-engine",
      title: "Odd Wizards",
      playable: false,
    };
    api.on("GET /api/v1/decks", () =>
      reply(200, [summary, locked, unsupported]),
    );
    api.on("GET /api/v1/decks/starters", () => reply(200, []));
    render(<DecksPage me={player} heading={createRef()} />);
    const row = (name: string) =>
      screen.getByRole("link", { name }).closest("li")!;
    await screen.findByRole("link", { name: "Borrowed Elves" });
    expect(row("Borrowed Elves")).toHaveTextContent(
      "Needs cards you don't own",
    );
    expect(row("Odd Wizards")).toHaveTextContent("Legal, not playable yet");
    expect(row("Mono-Red Burn")).toHaveTextContent("Ready to play");
    expect(row("Mono-Red Burn")).not.toHaveTextContent("Casual tables only");
    // The list says so itself (collection_locked): no deck is asked for.
    expect(
      api.calls.filter((call) => call.route === "GET /api/v1/decks/{deck_id}"),
    ).toEqual([]);
  });
});
