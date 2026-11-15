import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameEvent } from "../timeline/events";
import type { TimelineSeat } from "../timeline/Timeline";
import { ReplayPlayer, WINDOW } from "./Replay";
import { ReplayPage, ReplaysPage, resultWords } from "./ReplayPage";
import { LINE_MS, type Replay } from "./replay";

// A replay's player (v1.0.0): the lines up to where it stands, the scoreboard beside them, play
// and pause, steps and turns, the search, the reader's own bookmarks and note, and sharing with
// a friend.

const api = vi.hoisted(() => ({
  GET: vi.fn(),
  PUT: vi.fn(),
  POST: vi.fn(),
  DELETE: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  client: api,
}));

const GAME = "11111111-2222-3333-4444-555555555555";
const ADA = "aaaaaaaa-0000-0000-0000-000000000001";
const CY = "cccccccc-0000-0000-0000-000000000003";
const SEATS: TimelineSeat[] = [
  { seat: 0, name: "ada", you: true },
  { seat: 1, name: "Bot 2" },
];

let seq = 0;
function event(type: string, rest: Partial<GameEvent> = {}): GameEvent {
  seq += 1;
  return {
    v: 2,
    seq,
    epoch: 0,
    turn: 1,
    step: "precombat_main",
    type,
    ...rest,
  };
}
const card = (name: string, ref: string, owner = 0) => ({ ref, name, owner });

/** A short duel: ada plays a Mountain and bolts Bot 2 on turn 1, Bot 2 draws on turn 2. */
function duel(): GameEvent[] {
  seq = 0;
  return [
    event("step", { active: 0 }),
    event("zone_change", {
      from: "hand",
      to: "battlefield",
      player: 0,
      object: card("Mountain", "o1"),
      tally: [
        [20, 6, 53, 0, 1],
        [20, 7, 53, 0, 0],
      ],
    }),
    event("cast", {
      player: 0,
      object: card("Lightning Bolt", "o2"),
      cost: { paid: "{R}" },
      tally: [
        [20, 5, 53, 0, 1],
        [20, 7, 53, 0, 0],
      ],
    }),
    event("life_lost", {
      player: 1,
      amount: 3,
      cause: card("Lightning Bolt", "o2"),
      tally: [
        [20, 5, 53, 0, 1],
        [17, 7, 53, 0, 0],
      ],
    }),
    event("step", { turn: 2, step: "draw", active: 1 }),
    event("zone_change", {
      turn: 2,
      step: "draw",
      from: "library",
      to: "hand",
      player: 1,
      object: { hidden: true, owner: 1 },
      tally: [
        [20, 5, 53, 0, 1],
        [17, 8, 52, 0, 0],
      ],
    }),
  ];
}

function header(more: Partial<Replay> = {}): Replay {
  return {
    game: {
      id: GAME,
      kind: "practice",
      format: "legacy",
      status: "finished",
      seats: [
        { seat: 0, player: "human", handle: "ada", deck: "custom" },
        { seat: 1, player: "bot", handle: null, deck: null },
      ],
      your_seat: 0,
      bot_skill: 3,
      turn_cap: 30,
      created_at: "2026-11-10T18:00:00Z",
      finished_at: "2026-11-10T18:20:00Z",
      result: {
        kind: "completed",
        turns: 2,
        winner_seat: 0,
        winner_seats: [0],
        conceded_seats: [],
        draw: false,
      },
    } as unknown as Replay["game"],
    through: { seat: 0, yours: true, shared_by: null, grant_id: null },
    deck: { title: "Burn", version: 3, deck_id: null },
    starting: [
      { seat: 0, life: 20, team: null, shared_life: false },
      { seat: 1, life: 20, team: null, shared_life: false },
    ],
    events: 6,
    turns: 2,
    kept_until: "2027-02-08T18:20:00Z",
    marks: [],
    note: "",
    shares: [],
    ...more,
  };
}

type Options = {
  params: { path?: Record<string, unknown>; query?: Record<string, unknown> };
};

/** The API as the player asks it: the events a page at a time, the friends, the list. */
function serve(events: GameEvent[], page = 500) {
  api.GET.mockImplementation(async (path: string, options?: Options) => {
    if (path === "/api/v1/games/{game_id}/replay/events") {
      const since = Number(options?.params.query?.since ?? 0);
      const after = events.filter((entry) => entry.seq > since);
      const found = after.slice(0, page);
      return {
        data: {
          game_id: GAME,
          perspective: "seat",
          seat: 0,
          events: found,
          next: found.at(-1)?.seq ?? since,
          first: found[0]?.seq ?? 0,
          more: after.length > page,
          turns: { "1": 0, "2": 1 },
        },
      };
    }
    if (path === "/api/v1/friends")
      return {
        data: {
          friends: [{ id: CY, handle: "cy" }],
          incoming: [],
          outgoing: [],
          waiting: [],
        },
      };
    return {
      data: undefined,
      error: { message: "unexpected" },
      response: { status: 500 },
    };
  });
}

function Player({ start }: { start: Replay }) {
  const [replay, setReplay] = useState(start);
  return <ReplayPlayer replay={replay} seats={SEATS} onReplay={setReplay} />;
}

const shown = () =>
  [...document.querySelectorAll("li[data-seq]")].map((line) =>
    line.querySelector("p")!.textContent!.trim(),
  );
const score = (name: string) => {
  const row = screen.getByRole("row", { name: new RegExp(`^${name}`) });
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
};

beforeEach(() => {
  api.GET.mockReset();
  api.PUT.mockReset();
  api.POST.mockReset();
  api.DELETE.mockReset();
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a replay's player", () => {
  it("stands at the first step and shows only what has been played", async () => {
    serve(duel());
    render(<Player start={header()} />);
    await waitFor(() => expect(shown()).toEqual(["ada played Mountain."]));
    // What comes next is not told before it is played.
    expect(screen.queryByText(/Lightning Bolt/)).toBeNull();
    expect(score("ada")).toEqual(["20", "6", "53", "1", "0"]);
    expect(score("Bot 2")).toEqual(["20", "7", "53", "0", "0"]);
    expect(screen.getByText(/Step 1 of 4 · turn 1 of 2/)).toBeTruthy();
    expect(
      document.querySelector("li[data-current]")?.getAttribute("aria-current"),
    ).toBe("step");
    // It is ada's turn, and said so in words.
    expect(
      within(screen.getByRole("row", { name: /^ada/ })).getByText("their turn"),
    ).toBeTruthy();
  });

  it("steps on and back, by turns too, and the scoreboard follows", async () => {
    serve(duel());
    render(<Player start={header()} />);
    await waitFor(() => expect(shown()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "One step on" }));
    fireEvent.click(screen.getByRole("button", { name: "One step on" }));
    expect(shown()).toEqual([
      "ada played Mountain.",
      "ada cast Lightning Bolt for R.",
      "Bot 2 lost 3 life, by Lightning Bolt.",
    ]);
    expect(score("Bot 2")[0]).toBe("17");
    expect(score("ada")[1]).toBe("5");
    // The step is said for a screen reader, with its turn.
    expect(
      screen
        .getAllByRole("status")
        .some((status) =>
          /Turn 1, ada\. .*Bot 2 lost 3 life, by Lightning Bolt\./.test(
            status.textContent ?? "",
          ),
        ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Next turn" }));
    expect(shown().at(-1)).toBe("Bot 2 drew a hidden card.");
    expect(score("Bot 2")).toEqual(["17", "8", "52", "0", "0"]);
    expect(screen.getByRole("button", { name: "Next turn" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Previous turn" }));
    expect(shown()).toHaveLength(1);
    expect(score("Bot 2")[0]).toBe("20");

    // By the keys, wherever in the player the focus is; and by the turn's own list.
    const region = screen.getByRole("region", { name: "The game so far" });
    fireEvent.keyDown(region, { key: "End" });
    expect(shown()).toHaveLength(4);
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(shown()).toHaveLength(3);
    fireEvent.keyDown(region, { key: "ArrowLeft", shiftKey: true });
    expect(shown()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Turn"), { target: { value: "2" } });
    expect(shown().at(-1)).toBe("Bot 2 drew a hidden card.");
    fireEvent.change(screen.getByLabelText("Place in the game"), {
      target: { value: "1" },
    });
    expect(shown()).toHaveLength(2);
  });

  it("plays at its speed, pauses, and stops at the game's end", async () => {
    serve(duel());
    render(<Player start={header()} />);
    await waitFor(() => expect(shown()).toHaveLength(1));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    act(() => void vi.advanceTimersByTime(LINE_MS - 1));
    expect(shown()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(shown()).toHaveLength(2);
    // Paused, it stays; at four times the speed a line stands a quarter as long.
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => void vi.advanceTimersByTime(LINE_MS * 3));
    expect(shown()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Speed"), {
      target: { value: "4" },
    });
    fireEvent.keyDown(screen.getByRole("region", { name: "The game so far" }), {
      key: "k",
    });
    act(() => void vi.advanceTimersByTime(LINE_MS / 4));
    expect(shown()).toHaveLength(3);
    act(() => void vi.advanceTimersByTime(LINE_MS / 4));
    expect(shown()).toHaveLength(4);
    // The end: it stops by itself, and Play starts it again from the first step.
    act(() => void vi.advanceTimersByTime(LINE_MS));
    expect(screen.getByRole("button", { name: "Play again" })).toBeTruthy();
    // At the end the game's result says who won: a duel's events only say who lost.
    expect(
      within(screen.getByRole("row", { name: /^ada/ })).getByText("won"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play again" }));
    expect(
      within(screen.getByRole("row", { name: /^ada/ })).queryByText("won"),
    ).toBeNull();
    expect(shown()).toHaveLength(1);
  });

  it("reads a long game a page at a time and lists the steps leading up to its place", async () => {
    seq = 0;
    const long: GameEvent[] = [event("step", { active: 0 })];
    for (let turn = 1; turn <= 130; turn++)
      long.push(
        event("zone_change", {
          turn,
          from: "hand",
          to: "battlefield",
          player: 0,
          object: card(`Land ${turn}`, `o${turn}`),
        }),
      );
    serve(long, 50);
    render(<Player start={header({ events: long.length, turns: 130 })} />);
    await waitFor(() => expect(screen.getByText(/Step 1 of 130/)).toBeTruthy());
    expect(
      api.GET.mock.calls
        .filter(([path]) => path === "/api/v1/games/{game_id}/replay/events")
        .map(([, options]) => (options as Options).params.query?.since),
    ).toEqual([0, 50, 100]);
    fireEvent.keyDown(screen.getByRole("region", { name: "The game so far" }), {
      key: "End",
    });
    expect(shown()).toHaveLength(WINDOW);
    expect(shown().at(-1)).toBe("ada played Land 130.");
    expect(screen.getByText(/Earlier steps are behind this one/)).toBeTruthy();
  });

  it("finds a word among the steps and goes to it", async () => {
    serve(duel());
    render(<Player start={header()} />);
    await waitFor(() => expect(shown()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Find a step"), {
      target: { value: "bolt" },
    });
    expect(screen.getByText("2 found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(shown()).toHaveLength(2);
    expect(screen.getByText("1 of 2 found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(shown()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(shown()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Find a step"), {
      target: { value: "counterspell" },
    });
    expect(
      screen.getByText(/Nothing found\. A card you were not shown/),
    ).toBeTruthy();
  });

  it("keeps the reader's bookmarks and note", async () => {
    serve(duel());
    const kept = header({
      marks: [
        {
          seq: 6,
          turn: 2,
          label: "The draw",
          note: "What was it?",
          updated_at: "2026-11-11T00:00:00Z",
        },
      ],
    });
    api.PUT.mockImplementation(
      async (
        _path: string,
        options: {
          params: { path: { seq: number } };
          body: { label: string; note: string };
        },
      ) => {
        const at = options.params.path.seq;
        return {
          data:
            at === 0
              ? { ...kept, note: options.body.note }
              : {
                  ...kept,
                  marks: [
                    {
                      seq: at,
                      turn: 1,
                      label: options.body.label,
                      note: options.body.note,
                      updated_at: "2026-11-11T00:00:00Z",
                    },
                    ...kept.marks,
                  ],
                },
        };
      },
    );
    api.DELETE.mockResolvedValue({ data: { ...kept, marks: [] } });
    render(<Player start={kept} />);
    await waitFor(() => expect(shown()).toHaveLength(1));

    // A bookmark kept before goes to its place, which is marked there.
    fireEvent.click(screen.getByRole("button", { name: "Turn 2 · The draw" }));
    expect(shown().at(-1)).toContain("Bot 2 drew a hidden card.");
    expect(shown().at(-1)).toContain("★ bookmarked");
    expect(screen.getByText("What was it?")).toBeTruthy();

    // A new one, at the step the replay stands at.
    fireEvent.keyDown(screen.getByRole("region", { name: "The game so far" }), {
      key: "Home",
    });
    fireEvent.click(screen.getByRole("button", { name: "One step on" }));
    fireEvent.click(screen.getByRole("button", { name: "Bookmark this step" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "The Bolt" },
    });
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Too early." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save bookmark" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Turn 1 · The Bolt" }),
      ).toBeTruthy(),
    );
    expect(api.PUT).toHaveBeenCalledWith(
      "/api/v1/games/{game_id}/replay/marks/{seq}",
      {
        params: { path: { game_id: GAME, seq: 3 }, query: {} },
        body: { label: "The Bolt", note: "Too early." },
      },
    );
    expect(
      screen.getByRole("button", { name: "Edit this step’s bookmark" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove the bookmark The draw" }),
    );
    await waitFor(() => expect(screen.getByText(/None yet/)).toBeTruthy());
    expect(api.DELETE).toHaveBeenCalledWith(
      "/api/v1/games/{game_id}/replay/marks/{seq}",
      { params: { path: { game_id: GAME, seq: 6 }, query: {} } },
    );

    // The note on the game as a whole is the mark at 0.
    fireEvent.change(screen.getByLabelText("Your note on this game"), {
      target: { value: "Mulligan next time." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(screen.getByText("Saved. Only you see it.")).toBeTruthy(),
    );
    expect(api.PUT).toHaveBeenLastCalledWith(
      "/api/v1/games/{game_id}/replay/marks/{seq}",
      {
        params: { path: { game_id: GAME, seq: 0 }, query: {} },
        body: { label: "", note: "Mulligan next time." },
      },
    );
  });

  it("shares with a friend and takes it back", async () => {
    serve(duel());
    const share = {
      id: "grant-1",
      player: { id: CY, handle: "cy" },
      shared_at: "2026-11-11T00:00:00Z",
    };
    api.POST.mockResolvedValue({
      data: header({ shares: [share] as Replay["shares"] }),
    });
    api.DELETE.mockResolvedValue({ response: { ok: true } });
    render(<Player start={header()} />);
    await waitFor(() => expect(shown()).toHaveLength(1));
    expect(screen.getByText("Only you can open this replay.")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Share with a friend" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/sees the game through your seat/),
    ).toBeTruthy();
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Share" }),
    );
    await waitFor(() =>
      expect(within(dialog).getByText(/· shared/)).toBeTruthy(),
    );
    expect(api.POST).toHaveBeenCalledWith(
      "/api/v1/games/{game_id}/replay/shares",
      {
        params: { path: { game_id: GAME } },
        body: { player_id: CY },
      },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Take back" }));
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Share" }),
      ).toBeTruthy(),
    );
    expect(api.DELETE).toHaveBeenCalledWith(
      "/api/v1/games/{game_id}/replay/shares/{grant_id}",
      { params: { path: { game_id: GAME, grant_id: "grant-1" } } },
    );
  });

  it("offers no sharing on a replay someone shared, and asks for its events as theirs", async () => {
    serve(duel());
    const theirs = header({
      through: {
        seat: 0,
        yours: false,
        shared_by: { id: ADA, handle: "ada", avatar: "sigil", alliance: null },
        grant_id: "grant-9",
      } as Replay["through"],
    });
    render(<Player start={theirs} />);
    await waitFor(() => expect(shown()).toHaveLength(1));
    expect(
      screen.queryByRole("button", { name: "Share with a friend" }),
    ).toBeNull();
    expect(api.GET).toHaveBeenCalledWith(
      "/api/v1/games/{game_id}/replay/events",
      {
        params: {
          path: { game_id: GAME },
          query: { since: 0, limit: 500, shared_by: ADA },
        },
      },
    );
  });

  it("says so when a game recorded before replays tells only life", async () => {
    const old = duel().map(({ tally: _tally, ...rest }) => ({ ...rest, v: 1 }));
    serve(old);
    render(<Player start={header()} />);
    await waitFor(() => expect(shown()).toHaveLength(1));
    fireEvent.keyDown(screen.getByRole("region", { name: "The game so far" }), {
      key: "End",
    });
    expect(score("Bot 2")).toEqual(["17", "–", "–", "–", "–"]);
    expect(screen.getByText(/recorded before replays/)).toBeTruthy();
  });
});

describe("a replay's page", () => {
  it("names the game, whose eyes, the deck's version and until when it is kept", async () => {
    serve(duel());
    api.GET.mockImplementationOnce(async () => ({
      data: header(),
      response: { status: 200 },
    }));
    const heading = createRef<HTMLHeadingElement>();
    render(<ReplayPage gameId={GAME} sharedBy={null} heading={heading} />);
    expect(await screen.findByText(/You won in 2 turns/)).toBeTruthy();
    expect(screen.getByText(/You see what your own seat saw/)).toBeTruthy();
    expect(screen.getByText(/Your deck: Burn, version 3\./)).toBeTruthy();
    expect(screen.getByText(/Kept until Feb 8, 2027/)).toBeTruthy();
    expect(api.GET).toHaveBeenCalledWith("/api/v1/games/{game_id}/replay", {
      params: { path: { game_id: GAME }, query: {} },
    });
  });

  it("says what a missing replay may be", async () => {
    api.GET.mockResolvedValue({
      data: undefined,
      error: {},
      response: { status: 404 },
    });
    render(<ReplayPage gameId={GAME} sharedBy={ADA} heading={createRef()} />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("No such replay"),
    );
  });

  it("words the result for the seat it is read through", () => {
    const game = header().game;
    const name = (seat: number) => SEATS[seat]!.name;
    expect(resultWords(game, 0, true, name)).toBe("You won in 2 turns");
    expect(resultWords(game, 1, true, name)).toBe("You lost in 2 turns");
    expect(resultWords(game, 0, false, name)).toBe("ada won in 2 turns");
    expect(resultWords(game, 1, false, name)).toBe("ada won in 2 turns");
    expect(
      resultWords(
        { ...game, status: "interrupted", result: null } as typeof game,
        0,
        true,
        name,
      ),
    ).toBe("Interrupted before it ended");
  });

  it("lists the account's replays and the ones shared with it", async () => {
    const mine = {
      game: header().game,
      through: header().through,
      kept_until: header().kept_until,
      turns: 2,
      marks: 2,
      noted: true,
      shares: 1,
    };
    const theirs = {
      ...mine,
      game: { ...header().game, your_seat: null },
      through: {
        seat: 0,
        yours: false,
        shared_by: { id: ADA, handle: "ada" },
        grant_id: "g",
      },
      marks: 0,
      noted: false,
      shares: 0,
    };
    api.GET.mockResolvedValue({
      data: { own: [mine], shared: [theirs], more: false },
    });
    render(<ReplaysPage heading={createRef()} />);
    const own = await screen.findByRole("region", { name: "Your games" });
    expect(
      within(own).getByText(
        /You won in 2 turns · 2 turns · 2 bookmarks, a note, shared with 1 friend/,
      ),
    ).toBeTruthy();
    expect(
      within(own).getByRole("link", { name: "Watch" }).getAttribute("href"),
    ).toBe(`#replay/${GAME}`);
    const shared = screen.getByRole("region", { name: "Shared with you" });
    expect(
      within(shared).getByText(/ada won in 2 turns · 2 turns · shared by ada/),
    ).toBeTruthy();
    expect(
      within(shared).getByRole("link", { name: "Watch" }).getAttribute("href"),
    ).toBe(`#replay/${GAME}/${ADA}`);
  });
});
