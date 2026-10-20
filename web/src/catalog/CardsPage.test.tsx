import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { card, mockApi, reply } from "../decks/fixtures";
import { namesPlayability } from "./catalog";
import { CardsPage, resultWords } from "./CardsPage";

const player = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "player",
  status: "active",
  permissions: [],
  roles: ["player"],
} as unknown as Me;

const bolt = card("Lightning Bolt");
const unsupported = card("Temple of Khonshu", {
  status: "catalog_only",
  status_reason: "not_implemented",
  playable: false,
});

function page(items: ReturnType<typeof card>[]) {
  return {
    items,
    total: items.length,
    page: 1,
    page_size: 60,
    milliseconds: 1,
  };
}

/** The query of each card search the page sent, in order. */
function searches(api: ReturnType<typeof mockApi>) {
  return api.calls
    .filter((call) => call.route === "GET /api/v1/cards")
    .map(
      (call) =>
        (call.options as { params: { query: Record<string, unknown> } }).params
          .query,
    );
}

afterEach(() => vi.restoreAllMocks());

describe("the Cards page", () => {
  it("opens on playable cards only, and shows the others when asked", async () => {
    const api = mockApi();
    api.on("GET /api/v1/catalog", () => reply(404));
    api.on(
      "GET /api/v1/cards",
      () => reply(200, page([bolt])),
      () => reply(200, page([bolt, unsupported])),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    expect(await screen.findByText("1 playable card")).toBeInTheDocument();
    expect(searches(api)[0]).toMatchObject({ playable: true });
    expect(
      screen.queryByRole("button", { name: /^Temple of Khonshu/ }),
    ).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", {
      name: "Show cards not playable yet",
    });
    toggle.focus();
    fireEvent.click(toggle);
    expect(await screen.findByText("2 cards")).toBeInTheDocument();
    expect(searches(api).at(-1)).not.toHaveProperty("playable");
    // Shown with its badge, which says it cannot be played yet.
    const temple = screen
      .getByRole("button", { name: /^Temple of Khonshu, / })
      .closest("li")!;
    expect(temple).toHaveTextContent("Not playable");
    // The same button, still focused, now hides them again.
    expect(document.activeElement).toBe(toggle);
    expect(toggle).toHaveAccessibleName("Hide cards not playable yet");
  });

  it("names the cards the shown results hold while the next search runs", async () => {
    const api = mockApi();
    api.on("GET /api/v1/catalog", () => reply(404));
    let answer: (value: unknown) => void = () => {};
    api.on(
      "GET /api/v1/cards",
      () => reply(200, page([bolt])),
      () => new Promise((resolve) => (answer = resolve)),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 playable card");
    fireEvent.click(
      screen.getByRole("button", { name: "Show cards not playable yet" }),
    );
    // The old results are playable cards, and the line says so until the new ones arrive.
    expect(
      await screen.findByText("1 playable card · searching…"),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(searches(api)).toHaveLength(2));
    answer(reply(200, page([bolt, unsupported])));
    expect(await screen.findByText("2 cards")).toBeInTheDocument();
  });

  it("says the filter is set aside only once results answer that search", async () => {
    const api = mockApi();
    api.on("GET /api/v1/catalog", () => reply(404));
    let answer: (value: unknown) => void = () => {};
    api.on(
      "GET /api/v1/cards",
      () => reply(200, page([bolt])),
      () => new Promise((resolve) => (answer = resolve)),
    );
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 playable card");
    fireEvent.change(screen.getByLabelText("Search cards"), {
      target: { value: "status:catalog_only" },
    });
    expect(
      await screen.findByText("1 playable card · searching…"),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(searches(api)).toHaveLength(2));
    answer(reply(200, page([unsupported])));
    expect(
      await screen.findByText(/^1 card · your search names playability/),
    ).toBeInTheDocument();
  });

  it("lets a search that names playability decide it", async () => {
    const api = mockApi();
    api.on("GET /api/v1/catalog", () => reply(404));
    api.on("GET /api/v1/cards", () => reply(200, page([unsupported])));
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 playable card");
    fireEvent.change(screen.getByLabelText("Search cards"), {
      target: { value: "status:catalog_only" },
    });
    // Said in the live result line, so screen readers hear why the others appear.
    expect(
      await screen.findByText(
        "1 card · your search names playability, so the “Playable here” filter is set aside",
      ),
    ).toHaveAttribute("role", "status");
    expect(searches(api).at(-1)).toMatchObject({ q: "status:catalog_only" });
    expect(searches(api).at(-1)).not.toHaveProperty("playable");
    expect(
      screen.queryByRole("button", { name: /cards not playable yet/ }),
    ).not.toBeInTheDocument();
  });

  it("clears its filters back to playable cards only", async () => {
    const api = mockApi();
    api.on("GET /api/v1/catalog", () => reply(404));
    api.on("GET /api/v1/cards", () => reply(200, page([bolt])));
    render(<CardsPage me={player} heading={createRef()} />);
    await screen.findByText("1 playable card");
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByLabelText("Playable here"), {
      target: { value: "" },
    });
    expect(await screen.findByText("1 card")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("1 playable card")).toBeInTheDocument();
    expect(searches(api).at(-1)).toMatchObject({ playable: true });
  });
});

describe("the result line and playability terms", () => {
  it("says which cards it counts", () => {
    expect(resultWords(1, "true")).toBe("1 playable card");
    expect(resultWords(20123, "true")).toBe("20,123 playable cards");
    expect(resultWords(2, "")).toBe("2 cards");
    expect(resultWords(1, "false")).toBe("1 card not playable yet");
  });

  it("knows a query that sets playability itself", () => {
    for (const q of [
      "is:playable",
      "-is:unsupported t:elf",
      "t:elf (is:supported or c:g)",
      "STATUS:implemented",
      "status=suspended",
      'is:"unsupported"',
      "(t:elf)is:unsupported",
      "--is:unsupported",
    ])
      expect(namesPlayability(q), q).toBe(true);
    // Words, quoted phrases and exact names are not terms, as the server reads them.
    for (const q of [
      "",
      "playable",
      "o:status",
      "t:elf",
      "this:playable",
      'o:"draw status:x"',
      '"is:playable"',
      "!status:x",
    ])
      expect(namesPlayability(q), q).toBe(false);
  });
});
