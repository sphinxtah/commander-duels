import { act, render, screen } from "@testing-library/react";
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
