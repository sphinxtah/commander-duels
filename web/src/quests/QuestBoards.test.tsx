import { act, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { board, quest, questBoards } from "../records/fixtures";
import { resetsIn, streakWords } from "./quests";
import { QuestsPage } from "./QuestsPage";
import { QuestsPanel } from "./QuestsPanel";

afterEach(() => vi.restoreAllMocks());

async function settle() {
  await act(() => new Promise((done) => setTimeout(done, 20)));
}

function ok(data: unknown) {
  return { data, response: new Response(null, { status: 200 }) } as never;
}

describe("the words for quest boards (v0.9.5)", () => {
  it("say when the next board comes, in days for the week", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(resetsIn("2026-11-11T07:00:00Z", now)).toBe("in 19 h");
    expect(resetsIn("2026-11-10T12:40:00Z", now)).toBe("in 40 min");
    expect(resetsIn("2026-11-15T07:00:00Z", now)).toBe("in 5 days");
  });
  it("name the streak", () => {
    expect(streakWords(board())).toBe("No streak yet");
    expect(
      streakWords(
        board({ streak: { current: 1, bonus: 500, next_bonus: 600, best: 1 } }),
      ),
    ).toBe("1 day in a row");
    expect(
      streakWords(
        board({
          board: "weekly",
          streak: { current: 3, bonus: 2_600, next_bonus: 2_800, best: 3 },
        }),
      ),
    ).toBe("3 weeks in a row");
  });
});

describe("the quest boards", () => {
  it("show today's five on the main menu, with the week's line", async () => {
    const shown = questBoards({
      daily: board({
        quests: [
          quest({ completed_at: "2026-11-10T18:00:00Z", progress: 1 }),
          ...board().quests.slice(1),
        ],
      }),
    });
    vi.spyOn(client, "GET").mockResolvedValue(ok(shown));
    render(<QuestsPanel />);
    await settle();
    const today = screen.getByRole("region", { name: "Today's quests" });
    expect(within(today).getAllByRole("listitem")).toHaveLength(5);
    expect(today.textContent).toContain("1 of 5 done");
    expect(within(today).getByText(/Finish all 5 for/)).toBeTruthy();
    expect(within(today).getByText("Complete, paid")).toBeTruthy();
    // Never "Step 5" (v0.9.7): the five are no steps, and complete in any order.
    expect(within(today).getByText("Quest 5")).toBeTruthy();
    expect(today.textContent).not.toContain("Step");
    const week = screen.getByRole("link", { name: /This week's goals/ });
    expect(week.getAttribute("href")).toBe("#quests");
    expect(week.textContent).toContain("2 weeks in a row");
  });

  it("show both boards in full on the Quests page", async () => {
    vi.spyOn(client, "GET").mockResolvedValue(ok(questBoards()));
    render(<QuestsPage heading={createRef()} />);
    await settle();
    expect(
      screen.getByRole("heading", { level: 1, name: "Quests" }),
    ).toBeTruthy();
    const week = screen.getByRole("region", { name: "This week's goals" });
    expect(within(week).getAllByRole("listitem")).toHaveLength(20);
    expect(within(week).getAllByText("Outside games").length).toBeGreaterThan(
      0,
    );
    expect(within(week).getAllByText("Hard")).toHaveLength(5);
    expect(screen.getByText(/Do them in any order/)).toBeTruthy();
  });

  it("say how a table goal is played alone, until it is done (v0.9.8)", async () => {
    const hint =
      "Alone? Open a King's Table table and give every other seat to a bot.";
    const week = questBoards().weekly;
    const shown = questBoards({
      weekly: {
        ...week,
        quests: [
          { ...week.quests[0]!, name: "Finish a game at a table", hint },
          {
            ...week.quests[1]!,
            name: "Finish three games at a table",
            hint,
            completed_at: "2026-11-10T18:00:00Z",
          },
          ...week.quests.slice(2),
        ],
      },
    });
    vi.spyOn(client, "GET").mockResolvedValue(ok(shown));
    render(<QuestsPage heading={createRef()} />);
    await settle();
    const goals = within(
      screen.getByRole("region", { name: "This week's goals" }),
    ).getAllByRole("listitem");
    expect(within(goals[0]!).getByText(hint)).toBeTruthy();
    // A goal already done needs no way to it; a goal without one shows none.
    expect(within(goals[1]!).queryByText(hint)).toBeNull();
    expect(screen.getAllByText(hint)).toHaveLength(1);
  });

  it("show a harder quest complete while the easier ones are open", async () => {
    const five = board().quests;
    const shown = questBoards({
      daily: board({
        quests: [
          ...five.slice(0, 4),
          { ...five[4]!, completed_at: "2026-11-10T18:00:00Z", progress: 1 },
        ],
      }),
    });
    vi.spyOn(client, "GET").mockResolvedValue(ok(shown));
    render(<QuestsPanel />);
    await settle();
    const today = screen.getByRole("region", { name: "Today's quests" });
    const cards = within(today).getAllByRole("listitem");
    expect(cards.map((card) => card.hasAttribute("data-done"))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(within(cards[4]!).getByText("Complete, paid")).toBeTruthy();
    expect(today.textContent).toContain("1 of 5 done");
  });

  it("show nothing to an account given no quests", async () => {
    vi.spyOn(client, "GET").mockResolvedValue({
      error: { code: "forbidden", message: "No." },
      response: new Response(null, { status: 403 }),
    } as never);
    const { container } = render(<QuestsPanel />);
    await settle();
    expect(container.textContent).toBe("");
  });
});
