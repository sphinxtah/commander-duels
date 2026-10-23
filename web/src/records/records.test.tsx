import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { AchievementsPanel } from "./AchievementsPanel";
import { Badge } from "./Badge";
import {
  achievement,
  achievements,
  badges,
  game,
  history,
  stats,
  totals,
} from "./fixtures";
import { HistoryList } from "./HistoryList";
import { PlayerRecord } from "./PlayerRecord";
import { RecordTable } from "./RecordTable";
import { duration, formatName, opponentsWords, winRate } from "./records";

const ADA = "00000000-0000-4000-8000-0000000000ad";

afterEach(() => vi.restoreAllMocks());

async function settle() {
  await act(() => new Promise((done) => setTimeout(done, 20)));
}

function ok(data: unknown) {
  return { data, response: new Response(null, { status: 200 }) } as never;
}

/** The client's GET, answered by path. */
function answer(routes: Record<string, unknown>) {
  return vi.spyOn(client, "GET").mockImplementation((async (path: string) => {
    if (!(path in routes)) throw new Error(`No answer for ${path}`);
    return ok(routes[path]);
  }) as never);
}

describe("the words for a record (v0.5.0)", () => {
  it("name the opponents, the length and the share won", () => {
    expect(opponentsWords(game().opponents)).toBe("two skill-3 bots");
    expect(
      opponentsWords([
        {
          seat: 1,
          bot: false,
          player: { id: ADA, handle: "bob", avatar: "moon", alliance: null },
          bot_skill: null,
          won: true,
          teammate: false,
        },
        {
          seat: 2,
          bot: true,
          player: null,
          bot_skill: 5,
          won: false,
          teammate: false,
        },
      ]),
    ).toBe("bob and a skill-5 bot");
    expect(
      opponentsWords([
        {
          seat: 1,
          bot: false,
          player: null,
          bot_skill: null,
          won: false,
          teammate: false,
        },
      ]),
    ).toBe("a player who has left");
    expect([duration(30), duration(24 * 60), duration(65 * 60)]).toEqual([
      "under a minute",
      "24 min",
      "1 h 05 min",
    ]);
    expect(winRate(totals({ games: 8, wins: 5 }))).toBe("63%");
    expect(winRate(totals())).toBe("–");
    expect([formatName("commander"), formatName("some_new_format")]).toEqual([
      "Commander",
      "some new format",
    ]);
    // A Two-Headed Giant teammate (v0.5.1) played beside the player, not against them.
    expect(formatName("two_headed_giant")).toBe("Two-Headed Giant");
    expect(
      opponentsWords([
        {
          seat: 0,
          bot: true,
          player: null,
          bot_skill: 4,
          won: true,
          teammate: true,
        },
        {
          seat: 2,
          bot: true,
          player: null,
          bot_skill: 4,
          won: false,
          teammate: false,
        },
        {
          seat: 3,
          bot: true,
          player: null,
          bot_skill: 4,
          won: false,
          teammate: false,
        },
      ]),
    ).toBe("two skill-4 bots, with a skill-4 bot");
  });

  it("draw each group's badge, labelled when asked", () => {
    render(<Badge group="commander" earned label="Commander Victor" />);
    expect(
      screen.getByRole("img", { name: "Commander Victor" }),
    ).toHaveAttribute("data-earned", "true");
  });
});

describe("a record's table (v0.5.0)", () => {
  it("counts the games by format and by opponent", () => {
    render(
      <RecordTable
        label="Your record"
        stats={stats({
          totals: totals({ games: 8, wins: 5, losses: 2, no_result: 1 }),
          formats: [
            {
              format: "commander",
              ...totals({ games: 8, wins: 5, losses: 2, no_result: 1 }),
            },
          ],
          against_bots: totals({ games: 8, wins: 5, losses: 2, no_result: 1 }),
          against_players: totals(),
        })}
      />,
    );
    expect(
      screen.getByRole("list", { name: "Your record in short" }),
    ).toHaveTextContent("5wins2losses63%won");
    const table = screen.getByRole("table", { name: "Your record" });
    const rows = within(table).getAllByRole("row");
    // The header, all games, Commander and against bots: no games against players, no row.
    expect(rows.map((row) => row.textContent)).toEqual([
      "GamesPlayedWonLostDrawnNo result",
      "All games85201",
      "Commander85201",
      "Against bots85201",
    ]);
  });

  it("counts best-of-three matches once each, beside their games", () => {
    render(
      <RecordTable
        label="Your record"
        stats={stats({
          totals: totals({ games: 5, wins: 3, losses: 2 }),
          formats: [
            { format: "legacy", ...totals({ games: 5, wins: 3, losses: 2 }) },
          ],
          against_players: totals({ games: 5, wins: 3, losses: 2 }),
          matches: totals({ games: 2, wins: 1, losses: 1 }),
        })}
      />,
    );
    const rows = within(
      screen.getByRole("table", { name: "Your record" }),
    ).getAllByRole("row");
    expect(rows.at(-1)).toHaveTextContent("Best-of-three matches21100");
  });

  it("says when there is nothing to count", () => {
    render(<RecordTable label="Your record" stats={stats()} />);
    expect(screen.getByText("No games finished yet.")).toBeInTheDocument();
  });
});

describe("Profile's achievements (v0.5.0)", () => {
  const earned = (id: string, name: string, pin: number | null = null) =>
    achievement({
      id,
      name,
      earned_at: "2026-10-22T18:00:00Z",
      progress: 1,
      pin,
    });

  it("show every achievement by group, and pin up to three in order", async () => {
    const list = [
      earned("first-win", "First Victory", 1),
      achievement({
        id: "wins-10",
        name: "Seasoned Planeswalker",
        description: "Win 10 games.",
        target: 10,
        progress: 4,
        tokens: 200,
      }),
      earned("commander-win", "Commander Victor"),
      earned("legacy-win", "Legacy Victor", 2),
      earned("win-red", "Paragon of Red", 3),
    ];
    list[2]!.group = "commander";
    list[2]!.addition = true;
    answer({ "/api/v1/me/achievements": achievements(list) });
    const put = vi
      .spyOn(client, "PUT")
      .mockResolvedValue(
        ok(
          achievements([
            earned("first-win", "First Victory"),
            list[1]!,
            list[2]!,
            earned("legacy-win", "Legacy Victor", 1),
            earned("win-red", "Paragon of Red", 2),
          ]),
        ),
      );
    render(<AchievementsPanel />);
    await settle();
    const panel = screen.getByRole("region", { name: "Achievements" });
    expect(panel).toHaveTextContent("4 of 5 earned.");
    expect(
      within(
        within(panel).getByRole("list", { name: "Commander" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(panel).toHaveTextContent("Commander and Legacy addition");
    expect(
      within(panel).getByRole("progressbar", {
        name: "Seasoned Planeswalker: progress",
      }),
    ).toHaveAttribute("aria-valuenow", "4");
    expect(panel).toHaveTextContent("4 of 10 · Pays 200 tokens");
    // Three pinned: a fourth waits for one to be unpinned.
    expect(
      screen.getByRole("button", { name: "Pin Commander Victor" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Unpin First Victory" }),
    );
    await settle();
    expect(put).toHaveBeenCalledWith("/api/v1/me/achievements/pinned", {
      body: { achievements: ["legacy-win", "win-red"] },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "First Victory is no longer pinned.",
    );
    expect(
      screen.getByRole("button", { name: "Pin Commander Victor" }),
    ).toBeEnabled();
  });

  it("asks the top bar again when the look earned something", async () => {
    answer({
      "/api/v1/me/achievements": achievements([achievement()], 100),
    });
    const changed = vi.fn();
    window.addEventListener("cd:hud-changed", changed);
    render(<AchievementsPanel />);
    await settle();
    window.removeEventListener("cd:hud-changed", changed);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("the games one by one (v0.5.0)", () => {
  it("list a page at a time, newest first", async () => {
    const older = game({
      game_id: "00000000-0000-4000-8000-0000000000a2",
      outcome: "loss",
      format: "legacy",
      deck: "Burn",
      revision: null,
      turns: 1,
      seconds: 20,
      opponents: [
        {
          seat: 1,
          bot: false,
          player: { id: ADA, handle: "bob", avatar: "moon", alliance: null },
          bot_skill: null,
          won: true,
          teammate: false,
        },
      ],
    });
    const get = vi
      .spyOn(client, "GET")
      .mockResolvedValueOnce(ok(history([game()], "next-page")))
      .mockResolvedValueOnce(ok(history([older])));
    render(<HistoryList />);
    await settle();
    const list = screen.getByRole("list", { name: "Games, newest first" });
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(
      "WonCommander against two skill-3 botsRed Test, revision 2 · 9 turns · 24 minOct 22, 2026",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show older games" }));
    await settle();
    expect(get).toHaveBeenLastCalledWith("/api/v1/me/history", {
      params: { query: { cursor: "next-page" } },
    });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent(
      "LostLegacy against bobBurn · 1 turn · under a minute",
    );
    expect(
      screen.queryByRole("button", { name: "Show older games" }),
    ).toBeNull();
  });

  it("say when there are none", async () => {
    vi.spyOn(client, "GET").mockResolvedValue(ok(history()));
    render(<HistoryList playerId={ADA} />);
    await settle();
    expect(screen.getByText("No games finished yet.")).toBeInTheDocument();
  });
});

describe("a player's record on their page (v0.5.0)", () => {
  const pinned = {
    id: "beat-skill-6",
    name: "Machine Breaker",
    description: "Beat a skill-6 bot.",
    group: "bots" as const,
    addition: false,
    tokens: 200,
    earned_at: "2026-10-22T18:00:00Z",
  };

  it("shows the badges and the totals, and no games to another player", async () => {
    const get = answer({
      "/api/v1/players/{player_id}/stats": stats({
        totals: totals({ games: 3, wins: 2, losses: 1 }),
        against_bots: totals({ games: 3, wins: 2, losses: 1 }),
      }),
      "/api/v1/players/{player_id}/achievements": badges({
        pinned: [pinned],
        earned: [pinned, { ...pinned, id: "first-win", name: "First Victory" }],
      }),
    });
    render(<PlayerRecord playerId={ADA} handle="ada" />);
    await settle();
    const shown = screen.getByRole("list", { name: "Pinned badges" });
    expect(shown).toHaveTextContent("Machine Breaker");
    expect(
      screen.getByText("2 of 29 achievements earned."),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Badges earned" })).getAllByRole(
        "img",
      ),
    ).toHaveLength(2);
    expect(
      screen.getByRole("table", { name: "ada's record" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Games" })).toBeNull();
    expect(get).not.toHaveBeenCalledWith(
      "/api/v1/players/{player_id}/history",
      expect.anything(),
    );
  });

  it("shows the games to SysOp and on one's own page", async () => {
    answer({
      "/api/v1/players/{player_id}/stats": stats({ history: true }),
      "/api/v1/players/{player_id}/achievements": badges(),
      "/api/v1/players/{player_id}/history": history([game()]),
    });
    render(<PlayerRecord playerId={ADA} handle="ada" />);
    await settle();
    expect(
      screen.getByText("ada has pinned no badges yet."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Games" })).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Games, newest first" }),
    ).toHaveTextContent("Commander against two skill-3 bots");
  });
});
