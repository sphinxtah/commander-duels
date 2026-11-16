import { act, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { Admin } from "../Admin";
import { mockApi, reply } from "../decks/fixtures";
import { SiteNumbers } from "./SiteNumbers";

// Administration's Numbers tab (v1.0.0): the site's numbers, beginning with the games' record
// and how tables fit what they described, which is tallied here and shown nowhere else.

function numbers(tableFit: unknown[] = []) {
  return {
    version: "1.0.0",
    migration: "0054_table_fit",
    since: "2026-11-15T08:00:00Z",
    now: "2026-11-15T18:30:00Z",
    counts: [],
    games: {
      running: 2,
      active: 3,
      last_day: { finished: 14, interrupted: 1 },
      last_week: { finished: 90, interrupted: 4 },
    },
    access: {},
    rollout: { workflows: [] },
    jobs: [],
    table_fit: tableFit,
    engine: null,
  };
}

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

afterEach(() => vi.restoreAllMocks());

describe("the site's numbers", () => {
  it("tallies how tables fit by the kind of game, with each answer's share", async () => {
    const api = mockApi();
    api.on("GET /api/v1/admin/operations", () =>
      reply(
        200,
        numbers([
          { intent: "upgraded", as_described: 6, stronger: 3, weaker: 1 },
          { intent: "competitive", as_described: 2, stronger: 0, weaker: 0 },
        ]),
      ),
    );
    render(<SiteNumbers />);
    await settle();
    const panel = within(
      screen.getByRole("region", { name: "The site's numbers" }),
    );
    expect(
      panel.getByText(/Version 1\.0\.0, migration 0054_table_fit/),
    ).toBeInTheDocument();
    expect(panel.getByText("Running now").nextSibling).toHaveTextContent("2");
    expect(
      panel.getByText("Interrupted, last week").nextSibling,
    ).toHaveTextContent("4");
    // Who sees the answers is said beside them.
    expect(
      panel.getByText(/no player and no host sees one/),
    ).toBeInTheDocument();
    const rows = within(
      panel.getByRole("table", { name: "How tables fit what they described" }),
    ).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Described asAnswersAs describedStrongerWeaker",
      "Upgraded casual106 (60%)3 (30%)1 (10%)",
      "Competitive22 (100%)0 (0%)0 (0%)",
    ]);
  });

  it("says when no player has answered, and reads again when asked", async () => {
    const api = mockApi();
    api.on(
      "GET /api/v1/admin/operations",
      () => reply(200, numbers()),
      () =>
        reply(
          200,
          numbers([
            { intent: "learning", as_described: 1, stronger: 0, weaker: 0 },
          ]),
        ),
    );
    render(<SiteNumbers />);
    await settle();
    expect(screen.getByText("No player has answered yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    await act(async () =>
      screen.getByRole("button", { name: "Read again" }).click(),
    );
    await settle();
    expect(screen.getByRole("table")).toHaveTextContent("Learning game");
  });

  it("says when the numbers could not be read", async () => {
    const api = mockApi();
    api.on("GET /api/v1/admin/operations", () =>
      reply(403, { code: "forbidden", message: "You may not read this." }),
    );
    render(<SiteNumbers />);
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You may not read this.",
    );
  });

  it("is a tab of Administration for who reads the audit log", async () => {
    const api = mockApi();
    api.on("GET /api/v1/admin/audit", () =>
      reply(200, { items: [], next_cursor: null }),
    );
    api.on("GET /api/v1/admin/operations", () => reply(200, numbers()));
    const auditor = {
      id: "00000000-0000-4000-8000-0000000000a9",
      kind: "player",
      status: "active",
      handle: "ops",
      permissions: ["admin.audit.read"],
      roles: ["administrator"],
    } as unknown as Me;
    render(<Admin me={auditor} heading={createRef()} />);
    await settle();
    await act(async () => screen.getByRole("tab", { name: "Numbers" }).click());
    await settle();
    expect(screen.getByRole("tab", { name: "Numbers" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: "The site's numbers" }),
    ).toBeInTheDocument();
  });
});
