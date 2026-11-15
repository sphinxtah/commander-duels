import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { forgetRollout } from "../app/rollout";
import type { Me } from "../api";
import { GamesList } from "./GamesList";
import { expiresText, saveRules, type SavedGame, type Saves } from "./saves";
import type { GameSummary } from "./practice";

const api = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  DELETE: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  client: api,
}));
vi.mock("./sound/engine", () => ({
  getSoundEngine: () => ({ unlock: vi.fn() }),
}));

const me = { id: "u1", kind: "player", permissions: [] } as unknown as Me;

function game(id: string, change: Partial<GameSummary> = {}): GameSummary {
  return {
    id,
    kind: "practice",
    format: "commander",
    status: "saved",
    seats: [
      {
        seat: 0,
        player: "human",
        handle: "alice",
        portrait: null,
        deck: "commander-mono-red-raiders",
        left: null,
      },
      {
        seat: 1,
        player: "bot",
        handle: null,
        portrait: null,
        deck: null,
        left: null,
      },
    ],
    your_seat: 0,
    bot_skill: 4,
    turn_cap: 80,
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    finished_at: null,
    result: null,
    ...change,
  } as GameSummary;
}

function save(id: string, change: Partial<SavedGame> = {}): SavedGame {
  return {
    id,
    game: game(`g-${id}`),
    saved_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    expires_at: new Date(Date.now() + 12.5 * 86_400_000).toISOString(),
    turn: 7,
    ended_at: null,
    ended_reason: null,
    ...change,
  };
}

/** What the server holds: the saves, the games, and whether save and resume is open. */
let saves: Saves;
let games: GameSummary[];
let open: boolean;

beforeAll(() => {
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  forgetRollout();
  open = true;
  saves = { saves: [], ended: [], limit: 5, days: 30, ends_at_upgrade: true };
  games = [];
  api.GET.mockReset();
  api.POST.mockReset();
  api.DELETE.mockReset();
  api.GET.mockImplementation(async (path: string) =>
    path === "/api/v1/rollout"
      ? { data: { workflows: [{ id: "save_resume", available: open }] } }
      : path === "/api/v1/saves"
        ? open
          ? { data: saves }
          : { error: { code: "http_404", message: "Not Found" } }
        : path === "/api/v1/games"
          ? { data: games }
          : { data: undefined },
  );
});
afterEach(() => {
  window.location.hash = "";
});

describe("what a save is told as", () => {
  it("names the days, the limit and what an upgrade does", () => {
    expect(saveRules(30, 5)).toEqual([
      "A saved game waits 30 days. After that it ends with no result, and nobody loses.",
      "You can hold 5 saved games at once.",
      expect.stringContaining("A save ends when the game is upgraded"),
    ]);
  });

  it("says when a save runs out by the day", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(expiresText("2026-11-14T20:00:00Z", now)).toMatch(/^today \(/);
    expect(expiresText("2026-11-15T20:00:00Z", now)).toMatch(/^tomorrow \(/);
    expect(expiresText("2026-12-14T12:00:00Z", now)).toMatch(/^in 30 days \(/);
    // Past its time it is not shown as some days ago.
    expect(expiresText("2026-11-13T12:00:00Z", now)).toMatch(/^today \(/);
  });
});

describe("saved games on Your games (v1.0.0)", () => {
  it("lists each save with when it runs out, apart from the other games, and resumes one", async () => {
    saves.saves = [save("s1")];
    games = [
      saves.saves[0].game,
      game("g2", {
        status: "interrupted",
        finished_at: "2026-11-13T10:00:00Z",
      }),
    ];
    api.POST.mockResolvedValue({ data: { id: "g-s1", status: "active" } });
    render(<GamesList me={me} />);

    const saved = await screen.findByRole("region", { name: "Saved games" });
    expect(saved).toHaveTextContent("1 of 5");
    expect(saved).toHaveTextContent("Commander");
    expect(saved).toHaveTextContent("alice · Bot");
    expect(saved).toHaveTextContent("Turn 7");
    expect(saved).toHaveTextContent("runs out in 12 days");
    expect(saved).toHaveTextContent("Mono-red raiders");
    // The rules stand under the list.
    expect(saved).toHaveTextContent("A saved game waits 30 days");
    expect(saved).toHaveTextContent("A save ends when the game is upgraded");
    // The saved game is not also among the running and recent ones.
    const others = screen
      .getAllByRole("listitem")
      .filter((item) => item.dataset.status === "interrupted");
    expect(others).toHaveLength(1);
    expect(
      screen
        .getAllByRole("listitem")
        .filter((item) => item.dataset.status === "saved"),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith("/api/v1/saves/{save_id}/resume", {
        params: { path: { save_id: "s1" } },
      }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#game/g-s1"));
  });

  it("says why a save could not be resumed, and asks for the lists again", async () => {
    saves.saves = [save("s1")];
    api.POST.mockResolvedValue({
      error: {
        code: "game_limit",
        message:
          "Finish, save or close your running game before resuming this one.",
      },
    });
    render(<GamesList me={me} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Finish, save or close your running game",
    );
    expect(window.location.hash).toBe("");
    expect(
      api.GET.mock.calls.filter(([path]) => path === "/api/v1/saves").length,
    ).toBeGreaterThan(1);
  });

  it("discards a save only after asking, and says that nobody loses", async () => {
    saves.saves = [save("s1"), save("s2")];
    api.DELETE.mockImplementation(async () => {
      saves = { ...saves, saves: saves.saves.slice(1) };
      return { data: undefined };
    });
    render(<GamesList me={me} />);
    const buttons = await screen.findAllByRole("button", { name: "Discard" });
    fireEvent.click(buttons[0]);
    const dialog = screen.getByRole("dialog", {
      name: "Discard this saved game?",
    });
    expect(dialog).toHaveTextContent("no win, no loss");
    expect(api.DELETE).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" }).at(-1)!);
    await waitFor(() =>
      expect(api.DELETE).toHaveBeenCalledWith("/api/v1/saves/{save_id}", {
        params: { path: { save_id: "s1" } },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Saved games" }),
      ).toHaveTextContent("1 of 5"),
    );
  });

  it("tells what became of a save that ended by itself", async () => {
    saves.ended = [
      save("s1", {
        ended_at: new Date().toISOString(),
        ended_reason: "upgrade",
        game: game("g1", { status: "interrupted" }),
      }),
      save("s2", {
        ended_at: new Date().toISOString(),
        ended_reason: "expired",
        game: game("g2", { status: "interrupted" }),
      }),
    ];
    render(<GamesList me={me} />);
    const ended = await screen.findByRole("list", {
      name: "Saves that ended",
    });
    expect(ended).toHaveTextContent(
      "The game was upgraded to a new version, and a saved game can only be played on by the version that saved it.",
    );
    expect(ended).toHaveTextContent("The save ran out.");
    expect(ended).toHaveTextContent("The game ended with no result.");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("shows nothing of saves where the workflow is closed", async () => {
    open = false;
    games = [game("g1", { status: "interrupted" })];
    render(<GamesList me={me} />);
    await screen.findByText("Interrupted", { exact: false });
    expect(screen.queryByRole("region", { name: "Saved games" })).toBeNull();
    expect(
      api.GET.mock.calls.filter(([path]) => path === "/api/v1/saves"),
    ).toHaveLength(0);
  });
});
