import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameView } from "../game/types";
import { boardDelta, boardOf, latestLarge } from "./chip";
import type { GameEvent, Thing } from "./events";
import { RULES } from "./events";
import { Timeline, type TimelineSeat } from "./Timeline";
import { seatsOf, TIMELINE_ROUTE } from "./TimelinePage";

// The timeline's screen (v1.0.0): the events as lines by turn and step, a card's picture under
// its line, rules linked into How to play, the narrowing asked of the server, the game followed
// as it goes on, earlier events on demand, and "What changed?".

const api = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  client: api,
}));

const GAME = "11111111-2222-3333-4444-555555555555";
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
function card(name: string, ref: string, owner = 0, more: object = {}): Thing {
  return { ref, name, owner, ...more };
}

function game(): GameEvent[] {
  seq = 0;
  const bears = card("Grizzly Bears", "o10", 1);
  return [
    event("step", { active: 0 }),
    event("zone_change", {
      from: "hand",
      to: "stack",
      player: 0,
      object: card("Lightning Bolt", "o2", 0, { was: "o1" }),
    }),
    event("cast", {
      player: 0,
      object: card("Lightning Bolt", "o2", 0, { mana_cost: "{R}" }),
      cost: {
        paid: "{1}{R}",
        changes: [{ how: "more", by: card("Sphere of Resistance", "o3", 1) }],
      },
    }),
    event("target", {
      player: 0,
      cause: card("Lightning Bolt", "o2"),
      target: bears,
    }),
    event("resolve", { player: 0, object: card("Lightning Bolt", "o2") }),
    event("damage", {
      target: bears,
      amount: 3,
      cause: card("Lightning Bolt", "o2"),
    }),
    event("zone_change", {
      from: "battlefield",
      to: "graveyard",
      player: 1,
      object: card("Grizzly Bears", "o11", 1, { was: "o10" }),
      why: "lethal_damage",
    }),
    event("step", { turn: 2, step: "declare_attackers", active: 1 }),
    event("attack", {
      turn: 2,
      step: "declare_attackers",
      player: 1,
      object: { hidden: true, owner: 1 },
      target: { seat: 0 },
    }),
  ];
}

type Query = Record<string, string | number | undefined>;
/** Answers as the API does, from `events`: after `since`, or the last ones `before`. */
function serve(events: () => GameEvent[]) {
  api.GET.mockImplementation(
    async (_path: string, options: { params: { query: Query } }) => {
      const query = options.params.query;
      const limit = Number(query.limit);
      let found = events();
      if (query.type) {
        const types = String(query.type).split(",");
        found = found.filter((entry) => types.includes(entry.type));
      }
      let more = false;
      if (query.before !== undefined) {
        found = found.filter((entry) => entry.seq < Number(query.before));
        more = found.length > limit;
        found = found.slice(-limit);
      } else {
        found = found.filter((entry) => entry.seq > Number(query.since ?? 0));
        more = found.length > limit;
        found = found.slice(0, limit);
      }
      // Whose turn each of the page's turns was, from the game's steps, as the API tells it.
      const turns: Record<string, number> = {};
      for (const entry of events())
        if (
          entry.type === "step" &&
          typeof entry.active === "number" &&
          found.some((shown) => shown.turn === entry.turn)
        )
          turns[entry.turn] = entry.active;
      return {
        data: {
          game_id: GAME,
          perspective: "seat",
          seat: 0,
          turns,
          events: found,
          next: found.at(-1)?.seq ?? Number(query.since ?? 0),
          first: found[0]?.seq ?? 0,
          more,
        },
      };
    },
  );
}
const queries = () =>
  api.GET.mock.calls.map(
    (call) => (call[1] as { params: { query: Query } }).params.query,
  );

beforeEach(() => {
  api.GET.mockReset();
});

describe("the timeline", () => {
  it("tells the game by turn and step, with what explains each line", async () => {
    const events = game();
    serve(() => events);
    render(<Timeline gameId={GAME} seats={SEATS} live={false} />);

    const first = await screen.findByRole("region", { name: "Turn 1 · ada" });
    const second = screen.getByRole("region", { name: "Turn 2 · Bot 2" });
    expect(
      within(first).getByRole("heading", { name: "Main phase" }),
    ).toBeTruthy();
    expect(
      within(second).getByRole("heading", { name: "Declare attackers" }),
    ).toBeTruthy();
    // The newest page is asked for, from the game's end.
    expect(queries()[0]).toMatchObject({ before: 2147483647, limit: 300 });

    const lines = within(first)
      .getAllByRole("listitem")
      .filter((item) => item.hasAttribute("data-seq"));
    expect(lines.map((line) => line.querySelector("p")?.textContent)).toEqual([
      "ada cast Lightning Bolt for 1R.",
      "Lightning Bolt targets Grizzly Bears.",
      "Lightning Bolt resolved.",
      "Lightning Bolt dealt 3 damage to Grizzly Bears.",
      "Grizzly Bears died.",
    ]);
    // The cost is drawn as mana, and said in words to a screen reader.
    expect(
      within(lines[0]).getAllByRole("img")[0].getAttribute("aria-label"),
    ).toBeTruthy();
    expect(lines[0].textContent).toContain(
      "Its cost was raised by Sphere of Resistance.",
    );
    expect(lines[4].textContent).toContain("Lethal damage");
    expect(lines[4].textContent).toContain(
      "It had been dealt 3 damage this turn, by Lightning Bolt.",
    );
    // A rule is a link into How to play, by its number.
    const rule = within(lines[4]).getByRole("link", {
      name: `Rule ${RULES.lethalDamage}, in How to play`,
    });
    expect(rule.getAttribute("href")).toBe(
      `#how-to-play/rules/${RULES.lethalDamage}`,
    );
    expect(rule.getAttribute("target")).toBeNull();
    // A card the reader was not shown is not named, and is no button.
    expect(within(second).getByText("A hidden card")).toBeTruthy();
    expect(within(second).queryByRole("button")).toBeNull();
    // The reader's own seat is marked.
    expect(within(lines[0]).getByText("ada").hasAttribute("data-you")).toBe(
      true,
    );
  });

  it("shows a card's picture under its line, and bookkeeping only when asked", async () => {
    const events = game();
    serve(() => events);
    render(<Timeline gameId={GAME} seats={SEATS} live={false} />);
    await screen.findByRole("region", { name: "Turn 1 · ada" });
    const died = document.querySelector<HTMLElement>('li[data-seq="7"]')!;
    expect(died.querySelector("p")?.textContent).toBe("Grizzly Bears died.");
    const name = within(died).getByRole("button", { name: "Grizzly Bears" });
    expect(name.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("true");
    const picture = died.querySelector("figure img")!;
    expect(picture.getAttribute("src")).toContain("Grizzly%20Bears");
    expect(document.getElementById(name.getAttribute("aria-controls")!)).toBe(
      picture.closest("div"),
    );
    fireEvent.click(within(died).getByRole("button", { name: "Close" }));
    expect(died.querySelector("figure")).toBeNull();

    expect(screen.queryByText(/was put onto the stack/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Every event, bookkeeping too"));
    expect(
      screen.getByText(/was put onto the stack/).closest("li")?.dataset.quiet,
    ).toBe("true");
  });

  it("opens rules in a tab of their own at a table", async () => {
    const events = game();
    serve(() => events);
    render(<Timeline gameId={GAME} seats={SEATS} live={false} newTab />);
    const rule = await screen.findByRole("link", {
      name: `Rule ${RULES.lethalDamage}, in How to play (opens a new tab)`,
    });
    expect(rule.getAttribute("href")).toBe(
      `/#how-to-play/rules/${RULES.lethalDamage}`,
    );
    expect(rule.getAttribute("target")).toBe("_blank");
  });

  it("asks the server for the kinds, the player and the card it is narrowed to", async () => {
    const events = game();
    serve(() => events);
    render(<Timeline gameId={GAME} seats={SEATS} live={false} />);
    await screen.findByRole("region", { name: "Turn 1 · ada" });

    const combat = screen.getByRole("button", { name: "Combat" });
    expect(combat.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(combat);
    expect(combat.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() =>
      expect(queries().at(-1)).toMatchObject({
        type: "attack,block",
        before: 2147483647,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Turn 1 · ada" })).toBeNull(),
    );
    expect(screen.getByRole("region", { name: "Turn 2 · Bot 2" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Player"), {
      target: { value: "1" },
    });
    await waitFor(() => expect(queries().at(-1)).toMatchObject({ seat: 1 }));

    fireEvent.change(screen.getByLabelText("Find a card"), {
      target: { value: "  Bolt " },
    });
    await waitFor(
      () =>
        expect(queries().at(-1)).toMatchObject({
          q: "Bolt",
          seat: 1,
          type: "attack,block",
        }),
      { timeout: 2000 },
    );
  });

  it("says when nothing matches, and that a hidden card is found by no name", async () => {
    serve(() => []);
    render(<Timeline gameId={GAME} seats={SEATS} live={false} />);
    expect(
      await screen.findByText(/This game has no events to show/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Combat" }));
    expect(
      await screen.findByText(
        /Nothing in this game matches\. A card you were not shown is found by no name\./,
      ),
    ).toBeTruthy();
  });

  it("says when the timeline cannot be read, and tries again", async () => {
    api.GET.mockResolvedValueOnce({
      error: { message: "The server is restarting." },
    });
    render(<Timeline gameId={GAME} seats={SEATS} live={false} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The timeline could not be read.");
    const events = game();
    serve(() => events);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("region", { name: "Turn 1 · ada" }),
    ).toBeTruthy();
  });

  it("follows a running game, and reads it again once the engine took it up anew", async () => {
    const events = game();
    serve(() => events);
    const view = render(
      <Timeline gameId={GAME} seats={SEATS} live pulse={1} />,
    );
    await screen.findByRole("region", { name: "Turn 2 · Bot 2" });
    const asked = queries().length;

    events.push(
      event("damage", {
        turn: 2,
        step: "combat_damage",
        target: { seat: 0 },
        amount: 2,
        combat: true,
        cause: { hidden: true, owner: 1 },
      }),
    );
    view.rerender(<Timeline gameId={GAME} seats={SEATS} live pulse={2} />);
    expect(
      await screen.findByText(/dealt 2 combat damage to/, undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
    expect(queries()[asked]).toMatchObject({ since: 9 });

    // Taken up again: the engine made the events after its checkpoint anew, under a new epoch.
    events.splice(8);
    events.push(
      event("attack", {
        seq: 9,
        epoch: 1,
        turn: 2,
        step: "declare_attackers",
        player: 1,
        object: card("Runeclaw Bear", "o40", 1),
        target: { seat: 0 },
      }),
      event("won", { seq: 10, epoch: 1, turn: 2, step: "end_turn", player: 0 }),
      event("won", { seq: 11, epoch: 1, turn: 2, step: "end_turn", player: 0 }),
    );
    view.rerender(<Timeline gameId={GAME} seats={SEATS} live pulse={3} />);
    expect(
      await screen.findByText("Runeclaw Bear", undefined, { timeout: 3000 }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByText(/dealt 2 combat damage to/)).toBeNull(),
    );
  });

  it("shows earlier events on demand", async () => {
    seq = 0;
    const events = Array.from({ length: 450 }, (_, index) =>
      event("life_lost", {
        turn: 1 + Math.floor(index / 100),
        player: 0,
        amount: 1,
      }),
    );
    serve(() => events);
    render(<Timeline gameId={GAME} seats={SEATS} live={false} />);
    const earlier = await screen.findByRole("button", {
      name: "Show earlier events",
    });
    expect(document.querySelector('[data-seq="151"]')).toBeTruthy();
    expect(document.querySelector('[data-seq="150"]')).toBeNull();
    fireEvent.click(earlier);
    await waitFor(() =>
      expect(document.querySelector('[data-seq="1"]')).toBeTruthy(),
    );
    expect(queries().at(-1)).toMatchObject({ before: 151 });
    expect(
      screen.queryByRole("button", { name: "Show earlier events" }),
    ).toBeNull();
  });

  it("offers What changed? after a large resolution, opened when asked for", async () => {
    seq = 0;
    const events = [
      event("step", { active: 0 }),
      event("resolve", { player: 0, object: card("Wrath of God", "o1") }),
      ...[
        "Grizzly Bears",
        "Runeclaw Bear",
        "Savannah Lions",
        "Elvish Mystic",
      ].map((name, at) =>
        event("zone_change", {
          from: "battlefield",
          to: "graveyard",
          player: 1,
          object: card(name, `o2${at}`, 1),
          why: "destroyed",
          cause: card("Wrath of God", "o1"),
        }),
      ),
    ];
    serve(() => events);
    render(<Timeline gameId={GAME} seats={SEATS} live={false} focus={2} />);
    const summary = await screen.findByText("What changed?");
    const details = summary.closest("details")!;
    await waitFor(() => expect(details.open).toBe(true));
    expect(details.textContent).toContain(
      "4 permanents went to the graveyard: Grizzly Bears, Runeclaw Bear, Savannah Lions, Elvish Mystic.",
    );
    // Only the resolution's own line carries it.
    expect(screen.getAllByText("What changed?")).toHaveLength(1);
  });

  it("says so of a game recorded before the events told why", async () => {
    seq = 0;
    serve(() => [
      event("step", { v: 1, active: 0 }),
      event("zone_change", {
        v: 1,
        from: "battlefield",
        to: "graveyard",
        player: 1,
        object: card("Grizzly Bears", "o11", 1),
      }),
    ]);
    render(<Timeline gameId={GAME} seats={SEATS} live={false} />);
    expect(
      await screen.findByText(
        /recorded before the timeline could ask the game why/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("The game recorded no reason.")).toBeTruthy();
  });
});

describe("the timeline's page", () => {
  it("has its own address and names its seats", () => {
    expect(TIMELINE_ROUTE.exec(`#timeline/${GAME}`)?.[1]).toBe(GAME);
    expect(TIMELINE_ROUTE.test(`#game/${GAME}`)).toBe(false);
    const seats = seatsOf({
      seats: [
        { seat: 0, player: "human", handle: "ada" },
        { seat: 1, player: "bot", handle: null },
        { seat: 2, player: "human", handle: null },
      ],
      your_seat: 0,
    } as unknown as Parameters<typeof seatsOf>[0]);
    expect(seats).toEqual([
      { seat: 0, name: "ada", you: true },
      { seat: 1, name: "Bot 2", you: false },
      { seat: 2, name: "Player 3", you: false },
    ]);
  });
});

describe("the table's What changed? chip", () => {
  function board(ids: string[], lives: number[]): GameView {
    return {
      battlefield: ids.map((id) => ({ id })),
      you: { seat: 0, life: lives[0] },
      opponents: lives.slice(1).map((life, at) => ({ seat: at + 1, life })),
    } as unknown as GameView;
  }

  it("counts how much of the board changed at once", () => {
    const before = boardOf(board(["a", "b", "c", "d"], [20, 20]))!;
    expect(boardOf(null)).toBeNull();
    expect(
      boardDelta(before, boardOf(board(["a", "b", "c", "d"], [20, 20]))!),
    ).toBe(0);
    // A creature came, a life total changed: two.
    expect(
      boardDelta(before, boardOf(board(["a", "b", "c", "d", "e"], [20, 17]))!),
    ).toBe(2);
    // A board wipe.
    expect(boardDelta(before, boardOf(board([], [20, 20]))!)).toBe(4);
  });

  it("offers the latest large resolution only while it is the latest thing", () => {
    seq = 0;
    const events = [
      event("resolve", { player: 0, object: card("Wrath of God", "o1") }),
      ...[0, 1, 2, 3].map((at) =>
        event("zone_change", {
          from: "battlefield",
          to: "graveyard",
          player: 1,
          object: card(`Bear ${at}`, `o2${at}`, 1),
          why: "destroyed",
        }),
      ),
    ];
    expect(latestLarge(events, 0)).toEqual({ seq: 1, source: "Wrath of God" });
    // Offered once.
    expect(latestLarge(events, 1)).toBeNull();
    // Much has happened since: the chip would point at old news.
    const later = [
      ...events,
      event("cast", { player: 1, object: card("Shock", "o50", 1) }),
      ...Array.from({ length: 13 }, () =>
        event("life_lost", { player: 0, amount: 1 }),
      ),
    ];
    expect(latestLarge(later, 0)).toBeNull();
    expect(latestLarge([], 0)).toBeNull();
  });
});
