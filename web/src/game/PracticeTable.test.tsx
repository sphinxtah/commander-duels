import { act, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { mockApi, reply } from "../decks/fixtures";
import type { components } from "../generated/api";
import { PracticeTable } from "./PracticeTable";

type DeckSummary = components["schemas"]["DeckSummary"];

const sysop = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "sysop",
  status: "active",
  onboarding: "complete",
  handle: "sysop",
  display_name: "SysOp",
  email: null,
  avatar: "tower",
  locale: "en",
  csrf_token: "token",
  permissions: ["games.play", "decks.edit", "cards.any"],
  roles: ["sysop"],
  preferences: { large_text: false, reduced_motion: false },
} as unknown as Me;

const options = {
  formats: [
    {
      id: "legacy",
      name: "Legacy",
      bots: [1],
      default_bots: 1,
      decks: ["legacy-mono-red-burn"],
    },
    {
      id: "commander",
      name: "Commander",
      bots: [1, 2, 3],
      default_bots: 3,
      decks: ["commander-mono-red-raiders"],
    },
  ],
  deck_lists: true,
  own_decks: true,
};

function summary(fields: Partial<DeckSummary>): DeckSummary {
  return {
    id: "deck-1",
    title: "Red deck",
    format: "legacy",
    visibility: "private",
    card_count: 60,
    legal: true,
    playable: true,
    collection_locked: false,
    needs: [],
    identity: "R",
    commanders: [],
    latest_revision: null,
    source: "import",
    archived: false,
    deleted_at: null,
    updated_at: "2026-10-20T10:00:00Z",
    ...fields,
  };
}

/** Lets every answer already given, and the renders it causes, land. */
async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/**
 * The address a "Play it" link leads to. jsdom fires hashchange later, as a task: waiting for it
 * keeps it (and the previous test's reset to "") from reaching the table after it has mounted,
 * which a browser never does and which would ask for the deck a second time.
 */
async function navigate(hash: string) {
  await new Promise<void>((resolve) => {
    const arrived = (event: HashChangeEvent) => {
      if (!event.newURL.endsWith(hash)) return;
      window.removeEventListener("hashchange", arrived);
      resolve();
    };
    window.addEventListener("hashchange", arrived);
    window.location.hash = hash;
  });
}

/**
 * The table in StrictMode (as `pnpm dev`, and so the browser journeys, render it), opened by a
 * deck builder's "Play it" link. StrictMode runs the mount effects twice, so the options are
 * asked for twice; `late` (1 or 2) is the answer held back until the deck has been chosen.
 */
async function openTable(deck: DeckSummary, late: 1 | 2) {
  await navigate(`#play?deck=${deck.id}`);
  const api = mockApi();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const now = () => reply(200, structuredClone(options));
  const later = () => held.then(now);
  api.on(
    "GET /api/v1/practice-games/options",
    ...(late === 1 ? [later, now] : [now, later]),
  );
  api.on("GET /api/v1/decks", () => reply(200, [deck]));
  api.on("GET /api/v1/games", () => reply(200, []));
  render(
    <StrictMode>
      <PracticeTable me={sysop} />
    </StrictMode>,
  );
  await settle();
  await act(async () => release());
  await settle();
  return api;
}

afterEach(() => vi.restoreAllMocks());

describe("the practice table", () => {
  it.each([1, 2] as const)(
    "keeps the Commander deck a Play it link chose when options answer %i lands last (CI run #44)",
    async (late) => {
      const api = await openTable(
        summary({ id: "deck-9", title: "Kenrith", format: "commander" }),
        late,
      );
      expect(
        api.calls.filter(
          (c) => c.route === "GET /api/v1/practice-games/options",
        ),
      ).toHaveLength(2);
      expect(screen.getByRole("radio", { name: /Commander/ })).toBeChecked();
      expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-9");
      expect(screen.getByLabelText("Bots")).toHaveValue("3");
    },
  );

  it("keeps the Legacy deck a Play it link chose when an options answer lands last", async () => {
    await openTable(summary({ id: "deck-7", title: "Burn" }), 2);
    expect(screen.getByRole("radio", { name: /Legacy/ })).toBeChecked();
    expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-7");
  });

  it("offers SysOp the engine's fixture decks beside its own", async () => {
    await openTable(summary({ id: "deck-7", title: "Burn" }), 2);
    const deck = screen.getByLabelText("Your deck");
    expect(
      within(deck).getByRole("option", { name: "Any free fixture deck" }),
    ).toBeInTheDocument();
    expect(deck.querySelector('optgroup[label="Your decks"]')).not.toBeNull();
    expect(
      deck.querySelector('optgroup[label="Fixture decks"] option'),
    ).toHaveValue("legacy-mono-red-burn");
  });

  it("still clears the deck and sets that format's bots when the format changes", async () => {
    await openTable(
      summary({ id: "deck-9", title: "Kenrith", format: "commander" }),
      2,
    );
    await act(async () =>
      screen.getByRole("radio", { name: /Legacy/ }).click(),
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("");
    expect(screen.queryByLabelText("Bots")).toBeNull();
    await act(async () =>
      screen.getByRole("radio", { name: /Commander/ }).click(),
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("");
    expect(screen.getByLabelText("Bots")).toHaveValue("3");
  });
});

describe("the practice table for a player (v0.3.1)", () => {
  const player = {
    ...sysop,
    kind: "player",
    handle: "pat",
    permissions: ["games.play", "decks.edit", "profile.edit"],
    roles: ["player"],
  } as unknown as Me;
  // The engine's fixture decks are SysOp's alone: a player's lists are empty.
  const playerOptions = {
    ...options,
    formats: options.formats.map((f) => ({ ...f, decks: [] })),
    deck_lists: false,
  };
  const starters = [
    summary({
      id: "deck-a",
      title: "Skyward Patrol",
      format: "commander",
      card_count: 100,
    }),
    summary({
      id: "deck-b",
      title: "Graveyard Shift",
      format: "commander",
      card_count: 100,
    }),
  ];

  async function sitDown(decks: DeckSummary[]) {
    await navigate("#play");
    const api = mockApi();
    api.on("GET /api/v1/practice-games/options", () =>
      reply(200, structuredClone(playerOptions)),
    );
    api.on("GET /api/v1/decks", () => reply(200, decks));
    api.on("GET /api/v1/games", () => reply(200, []));
    api.on("POST /api/v1/practice-games", () =>
      reply(503, { code: "games_busy", message: "Busy." }),
    );
    render(
      <StrictMode>
        <PracticeTable me={player} />
      </StrictMode>,
    );
    await settle();
    return api;
  }

  it("lists only their own decks, opens where they have one and plays the first", async () => {
    const api = await sitDown(starters);
    // Their only playable decks are the Commander starter decks.
    expect(screen.getByRole("radio", { name: /Commander/ })).toBeChecked();
    const deck = screen.getByLabelText("Your deck");
    expect(deck).toHaveValue("own:deck-a");
    expect(
      within(deck)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Skyward Patrol", "Graveyard Shift"]);
    // No empty group for the fixture decks, and no fixture deck to fall back on.
    expect(deck.querySelectorAll("optgroup")).toHaveLength(1);
    expect(screen.queryByText(/fixture deck/i)).toBeNull();
    // The bots' decks are the table's choice: Commander bots play the starter decks.
    const bot = screen.getByLabelText("Bot 1's deck");
    expect(bot).toHaveValue("");
    expect(
      within(bot).getByRole("option", { name: "Chosen by the table" }),
    ).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Start the game" }).click(),
    );
    await settle();
    const started = api.calls.find(
      (c) => c.route === "POST /api/v1/practice-games",
    )!;
    expect(started.options).toMatchObject({
      body: { format: "commander", deck_id: "deck-a", bots: [{}, {}, {}] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/busy/);
  });

  it("plays by casual rules unless the player chooses others (v0.4.5)", async () => {
    const api = await sitDown([
      summary({
        id: "deck-l",
        title: "Lotus Storm",
        format: "commander",
        needs: ["banned"],
      }),
      ...starters,
    ]);
    const deck = screen.getByLabelText("Your deck");
    expect(deck).toHaveValue("own:deck-l");
    await act(async () =>
      screen.getByRole("checkbox", { name: /^Banned cards/ }).click(),
    );
    expect(
      within(deck).getByRole("option", {
        name: "Lotus Storm (holds banned cards)",
      }),
    ).toBeDisabled();
    expect(deck).toHaveValue("own:deck-a");
    expect(
      screen.getByRole("checkbox", { name: /^Tournament rules/ }),
    ).not.toBeChecked();
    await act(async () =>
      screen.getByRole("button", { name: "Start the game" }).click(),
    );
    await settle();
    const started = api.calls.find(
      (c) => c.route === "POST /api/v1/practice-games",
    )!;
    expect(started.options).toMatchObject({
      body: { deck_id: "deck-a", rules: { banned: false, not_legal: true } },
    });
  });

  it("says which decks need cards the library does not hold", async () => {
    await sitDown([
      summary({ id: "deck-a", title: "Skyward Patrol", format: "commander" }),
      summary({
        id: "deck-b",
        title: "Borrowed Burn",
        format: "commander",
        playable: false,
        collection_locked: true,
      }),
    ]);
    const locked = within(screen.getByLabelText("Your deck")).getByRole(
      "option",
      { name: "Borrowed Burn (needs cards you don't own)" },
    );
    expect(locked).toBeDisabled();
  });

  it("is told to build or fix a deck when they have none to play", async () => {
    await sitDown([
      summary({ id: "deck-c", title: "Half built", playable: false }),
    ]);
    expect(screen.getByRole("radio", { name: /Legacy/ })).toBeChecked();
    expect(screen.queryByLabelText("Your deck")).toBeNull();
    expect(
      screen.getByText(/You have no playable Legacy deck yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Decks" })).toHaveAttribute(
      "href",
      "#decks",
    );
    expect(
      screen.getByRole("button", { name: "Start the game" }),
    ).toBeDisabled();
  });

  it("says so for the format they choose, too", async () => {
    await sitDown(starters);
    await act(async () =>
      screen.getByRole("radio", { name: /Legacy/ }).click(),
    );
    expect(
      screen.getByText(/You have no playable Legacy deck yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start the game" }),
    ).toBeDisabled();
    await act(async () =>
      screen.getByRole("radio", { name: /Commander/ }).click(),
    );
    expect(screen.getByLabelText("Your deck")).toHaveValue("own:deck-a");
    expect(
      screen.getByRole("button", { name: "Start the game" }),
    ).toBeEnabled();
  });
});
