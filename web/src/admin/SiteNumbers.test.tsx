import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { Admin } from "../Admin";
import { mockApi, reply } from "../decks/fixtures";
import { SiteNumbers } from "./SiteNumbers";

// Administration's Numbers tab (v1.0.0): the site's numbers, beginning with the games' record
// and how tables fit what they described, which is tallied here and shown nowhere else.

function gate(id: string, name: string, stage: string, changed?: string) {
  return {
    id,
    name,
    section: 23,
    stands_on: "events",
    stage,
    changed_at: changed ?? null,
  };
}
const GATES = [
  gate("save_resume", "Save and resume", "on", "2026-11-14T20:00:00Z"),
  gate("replays", "Replays and review", "off"),
];

function numbers(tableFit: unknown[] = [], workflows: unknown[] = GATES) {
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
    rollout: { workflows },
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
    expect(
      screen.queryByRole("table", {
        name: "How tables fit what they described",
      }),
    ).toBeNull();
    await act(async () =>
      screen.getByRole("button", { name: "Read again" }).click(),
    );
    await settle();
    expect(
      screen.getByRole("table", { name: "How tables fit what they described" }),
    ).toHaveTextContent("Learning game");
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

  it("shows an administrator every gate's stage and who reaches it, with nothing to set", async () => {
    const api = mockApi();
    api.on("GET /api/v1/admin/operations", () => reply(200, numbers()));
    render(<SiteNumbers />);
    await settle();
    const gates = within(screen.getByRole("table", { name: "The gates" }));
    expect(gates.getAllByRole("row").map((row) => row.textContent)).toEqual([
      "WorkflowStageWho reaches itSet",
      expect.stringMatching(
        /^Save and resume save_resumeonEveryoneNov 14, 2026/,
      ),
      "Replays and review replaysoffNobodyNever",
    ]);
    expect(gates.queryByRole("combobox")).toBeNull();
    expect(gates.queryByRole("button")).toBeNull();
    expect(screen.getByText(/SysOp sets a stage\./)).toBeInTheDocument();
  });

  it("lets SysOp choose a gate's stage and set it, in two steps", async () => {
    const api = mockApi();
    api.on("GET /api/v1/admin/operations", () => reply(200, numbers()));
    api.on("PUT /api/v1/admin/rollout/{workflow}", () =>
      reply(200, {
        workflows: [
          GATES[0],
          gate(
            "replays",
            "Replays and review",
            "staff",
            "2026-11-15T19:00:00Z",
          ),
        ],
      }),
    );
    render(<SiteNumbers canStage />);
    await settle();
    const gates = within(screen.getByRole("table", { name: "The gates" }));
    const stage = gates.getByRole("combobox", {
      name: "Stage of Replays and review",
    });
    expect(stage).toHaveValue("off");
    // Nothing to set while the choice is the stage it has.
    expect(
      gates.getByRole("button", { name: "Set Replays and review to off" }),
    ).toBeDisabled();
    fireEvent.change(stage, { target: { value: "staff" } });
    // Choosing sends nothing: the stage is set by its own button.
    expect(api.calls.some((call) => call.route.startsWith("PUT "))).toBe(false);
    await act(async () =>
      gates
        .getByRole("button", { name: "Set Replays and review to staff" })
        .click(),
    );
    await settle();
    expect(api.calls.at(-1)).toMatchObject({
      route: "PUT /api/v1/admin/rollout/{workflow}",
      options: {
        params: { path: { workflow: "replays" } },
        body: { stage: "staff" },
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Replays and review is staff now: SysOp and administrators reach it.",
    );
    expect(
      gates.getByRole("row", { name: /Replays and review/ }),
    ).toHaveTextContent("staffSysOp and administrators");
    expect(
      gates.getByRole("button", { name: "Set Replays and review to staff" }),
    ).toBeDisabled();
  });

  it("says why a stage was not set", async () => {
    const api = mockApi();
    api.on("GET /api/v1/admin/operations", () => reply(200, numbers()));
    api.on("PUT /api/v1/admin/rollout/{workflow}", () =>
      reply(403, { code: "forbidden", message: "Only SysOp sets a stage." }),
    );
    render(<SiteNumbers canStage />);
    await settle();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Stage of Replays and review" }),
      { target: { value: "on" } },
    );
    await act(async () =>
      screen
        .getByRole("button", { name: "Set Replays and review to on" })
        .click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Only SysOp sets a stage.",
    );
    expect(
      screen.getByRole("row", { name: /Replays and review/ }),
    ).toHaveTextContent("offNobody");
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
