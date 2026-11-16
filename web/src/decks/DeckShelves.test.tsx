import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { DecksPage } from "./DecksPage";
import type { DeckSummary } from "./decks";
import { deckDetail, mockApi, reply } from "./fixtures";

// The Decks page's shelves (v1.0.0, the deck workshop): the filter bar over the one list, a
// deck's folder and tags on its row, the way to its Workshop, and the batch organizer.

const player = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "player",
  status: "active",
  handle: "ann",
  permissions: ["games.play", "decks.edit"],
  roles: ["player"],
} as unknown as Me;

function deck(fields: Partial<DeckSummary>): DeckSummary {
  const { draft: _draft, ...summary } = deckDetail(fields as never);
  return { folder: null, tags: [], ...summary, ...fields } as DeckSummary;
}

const zombies = deck({
  id: "00000000-0000-4000-8000-0000000000d1",
  title: "Zombie Horde",
  commanders: ["Gisa and Geralf"],
  folder: "Tribal",
  tags: ["budget", "graveyard"],
});
const burn = deck({
  id: "00000000-0000-4000-8000-0000000000d2",
  title: "Burn",
  format: "legacy",
  folder: "Tournament",
  tags: ["budget"],
});
const fliers = deck({
  id: "00000000-0000-4000-8000-0000000000d3",
  title: "Azorius Fliers",
});

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function serve(decks: DeckSummary[] = [zombies, burn, fliers]) {
  const api = mockApi();
  const served = { decks };
  api.on("GET /api/v1/decks", () => reply(200, served.decks));
  api.on("GET /api/v1/decks/starters", () => reply(200, []));
  return { api, served };
}

/** The decks listed, by their titles: each row's own link to its editor. */
function listed(): string[] {
  return screen
    .queryAllByRole("link")
    .filter(
      (link) =>
        /^#deck\/[0-9a-f-]+$/.test(link.getAttribute("href") ?? "") &&
        link.textContent !== "Open",
    )
    .map((link) => link.textContent!);
}

afterEach(() => vi.restoreAllMocks());

describe("the Decks page's shelves", () => {
  it("shows each deck's folder and tags, and the way to its Workshop", async () => {
    serve();
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    const row = screen
      .getByRole("link", { name: "Zombie Horde" })
      .closest("li")!;
    expect(row).toHaveTextContent("In Tribal");
    expect(row).toHaveTextContent("Tag: budget");
    expect(row).toHaveTextContent("Tag: graveyard");
    expect(within(row).getByRole("link", { name: "Workshop" })).toHaveAttribute(
      "href",
      `#deck/${zombies.id}/workshop`,
    );
    // A deck in no folder and under no tag says nothing of either.
    expect(
      screen.getByRole("link", { name: "Azorius Fliers" }).closest("li"),
    ).not.toHaveTextContent(/In |Tag:/);
  });

  it("narrows the one list by a search, a folder and tags, and orders it", async () => {
    serve();
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    const bar = within(screen.getByRole("search", { name: "Find a deck" }));
    expect(listed()).toEqual(["Zombie Horde", "Burn", "Azorius Fliers"]);
    expect(screen.getByText("3 decks")).toBeInTheDocument();

    // The folders with their counts, and the decks in none.
    expect(
      within(bar.getByLabelText("Folder"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Every deck (3)",
      "Tournament (1)",
      "Tribal (1)",
      "In no folder (1)",
    ]);
    fireEvent.change(bar.getByLabelText("Folder"), {
      target: { value: "Tribal" },
    });
    expect(listed()).toEqual(["Zombie Horde"]);
    expect(screen.getByText("1 of 3 decks")).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("button", { name: "Show every deck" }).click(),
    );
    expect(listed()).toHaveLength(3);

    await act(async () =>
      bar.getByRole("checkbox", { name: /^budget/ }).click(),
    );
    expect(listed()).toEqual(["Zombie Horde", "Burn"]);
    await act(async () =>
      bar.getByRole("checkbox", { name: /^graveyard/ }).click(),
    );
    expect(listed()).toEqual(["Zombie Horde"]);
    await act(async () =>
      screen.getByRole("button", { name: "Show every deck" }).click(),
    );

    fireEvent.change(bar.getByLabelText("Search"), {
      target: { value: "gisa" },
    });
    expect(listed()).toEqual(["Zombie Horde"]);
    fireEvent.change(bar.getByLabelText("Search"), {
      target: { value: "no such deck" },
    });
    expect(listed()).toEqual([]);
    expect(
      screen.getByText(
        "No deck matches. Clear the search, the folder or the tags.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(bar.getByLabelText("Search"), { target: { value: "" } });

    fireEvent.change(bar.getByLabelText("Order"), {
      target: { value: "name" },
    });
    expect(listed()).toEqual(["Azorius Fliers", "Burn", "Zombie Horde"]);
  });

  it("organizes the decks ticked in one request, after saying what it will change", async () => {
    const { api, served } = serve();
    api.on("POST /api/v1/decks/organize", () => {
      served.decks = [
        { ...zombies, folder: "Kitchen table", tags: ["graveyard", "fun"] },
        { ...burn, folder: "Kitchen table", tags: ["fun"] },
        fliers,
      ];
      return reply(200, served.decks.slice(0, 2));
    });
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    // No deck is ticked, and nothing can be, until organizing is asked for.
    expect(screen.queryByRole("checkbox", { name: /^Organize / })).toBeNull();
    await act(async () =>
      screen.getByRole("button", { name: "Organize decks" }).click(),
    );
    expect(screen.getByText(/Tick the decks to organize/)).toBeInTheDocument();
    await act(async () =>
      screen.getByRole("checkbox", { name: "Organize Zombie Horde" }).click(),
    );
    await act(async () =>
      screen.getByRole("checkbox", { name: "Organize Burn" }).click(),
    );
    const organizer = within(
      screen.getByRole("region", { name: "Organize 2 decks" }),
    );
    // Nothing chosen yet: nothing to send.
    expect(
      organizer.getByRole("button", { name: "Organize 2 decks" }),
    ).toBeDisabled();
    expect(organizer.getByRole("status")).toHaveTextContent(
      "Name a folder or tags. Nothing changes until you do.",
    );
    fireEvent.change(organizer.getByLabelText("Move to a folder"), {
      target: { value: "Kitchen table" },
    });
    fireEvent.change(organizer.getByLabelText("Add tags"), {
      target: { value: "fun" },
    });
    // Only the tags the ticked decks carry are offered for removal.
    const removable = within(
      organizer.getByRole("group", { name: "Remove tags" }),
    );
    expect(
      removable
        .getAllByRole("checkbox")
        .map((box) => box.parentElement!.textContent),
    ).toEqual(["budget2", "graveyard1"]);
    await act(async () =>
      removable.getByRole("checkbox", { name: /^budget/ }).click(),
    );
    // What it will do, before anything is sent.
    expect(organizer.getByRole("status")).toHaveTextContent(
      "This changes 2 decks, all of them or none:",
    );
    expect(
      within(organizer.getByRole("status"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Move them into the folder “Kitchen table”.",
      "Add the tag “fun” to each.",
      "Remove the tag “budget” from each that has it.",
    ]);
    expect(
      api.calls.some((call) => call.route === "POST /api/v1/decks/organize"),
    ).toBe(false);

    await act(async () =>
      organizer.getByRole("button", { name: "Organize 2 decks" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/decks/organize")!.options,
    ).toEqual({
      body: {
        deck_ids: [zombies.id, burn.id],
        folder: "Kitchen table",
        unfile: false,
        add_tags: ["fun"],
        remove_tags: ["budget"],
      },
    });
    expect(screen.getByText("2 decks organized.")).toBeInTheDocument();
    // Organizing is over, and the list is read again.
    expect(screen.queryByRole("region", { name: /^Organize / })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Burn" }).closest("li"),
    ).toHaveTextContent("In Kitchen table");
  });

  it("ticks every deck shown, and takes decks out of their folders", async () => {
    const { api } = serve();
    api.on("POST /api/v1/decks/organize", () => reply(200, []));
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    fireEvent.change(screen.getByLabelText("Folder"), {
      target: { value: "Tribal" },
    });
    await act(async () =>
      screen.getByRole("button", { name: "Organize decks" }).click(),
    );
    await act(async () =>
      screen.getByRole("button", { name: "Tick all 1 shown" }).click(),
    );
    const organizer = within(
      screen.getByRole("region", { name: "Organize 1 deck" }),
    );
    await act(async () =>
      organizer
        .getByRole("checkbox", { name: "Take them out of their folders" })
        .click(),
    );
    expect(organizer.getByLabelText("Move to a folder")).toBeDisabled();
    await act(async () =>
      organizer.getByRole("button", { name: "Organize 1 deck" }).click(),
    );
    await settle();
    expect(
      api.calls.find((c) => c.route === "POST /api/v1/decks/organize")!.options,
    ).toMatchObject({ body: { deck_ids: [zombies.id], unfile: true } });
  });

  it("says why nothing was organized, and keeps the form", async () => {
    const { api } = serve();
    api.on("POST /api/v1/decks/organize", () =>
      reply(422, {
        code: "too_many_tags",
        message: "Zombie Horde would have more than 12 tags.",
      }),
    );
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "Organize decks" }).click(),
    );
    await act(async () =>
      screen.getByRole("checkbox", { name: "Organize Zombie Horde" }).click(),
    );
    fireEvent.change(screen.getByLabelText("Add tags"), {
      target: { value: "one more" },
    });
    await act(async () =>
      screen.getByRole("button", { name: "Organize 1 deck" }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Zombie Horde would have more than 12 tags. Nothing was changed.",
    );
    expect(screen.getByLabelText("Add tags")).toHaveValue("one more");
  });

  it("has no shelves in the trash", async () => {
    serve();
    render(<DecksPage me={player} heading={createRef()} />);
    await settle();
    await act(async () => screen.getByRole("tab", { name: "Trash" }).click());
    await settle();
    expect(screen.queryByRole("search", { name: "Find a deck" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Organize decks" })).toBeNull();
  });
});
