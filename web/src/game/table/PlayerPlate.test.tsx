import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GameContext, type GameContextValue } from "../Board";
import type { Seat } from "../types";
import {
  fixtureInput,
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "./fixtures";
import { layoutTable } from "./layout";
import { PlayerPlate } from "./PlayerPlate";
import { buildTableModel } from "./tableModel";
import { TableContext } from "./TableContext";
import type { Painter } from "./types";
import { createTableUi } from "./uiStore";
import styles from "./table.module.css";

function plate(
  f: TableFixture | FixtureName,
  seat: Seat,
  options: {
    painter?: Painter;
    expandedSeat?: Seat | null;
    canAnswer?: boolean;
  } = {},
) {
  const input = fixtureInput(typeof f === "string" ? tableFixture(f) : f, {
    canAnswer: options.canAnswer,
  });
  const model = buildTableModel(input);
  const layout = layoutTable(model, {
    expandedSeat: options.expandedSeat ?? null,
    textScale: 1,
  });
  const player = [model.anchored, ...model.opponents].find(
    (p) => p?.seat === seat,
  )!;
  const game: GameContextValue = {
    ...input.context,
    choose: vi.fn(),
    zoom: vi.fn(),
    preview: vi.fn(),
  };
  const ui = createTableUi();
  const painter = options.painter ?? "dom";
  const onBrowse = vi.fn();
  const onExpand = vi.fn();
  const view = render(
    <GameContext.Provider value={game}>
      <TableContext.Provider
        value={{ painter, ui, layout, model, fit: null, drag: null }}
      >
        <PlayerPlate
          player={player}
          node={layout.players.get(seat)!}
          tiles={layout.zones.filter((tile) => tile.seat === seat)}
          onBrowse={onBrowse}
          onExpand={onExpand}
        />
      </TableContext.Provider>
    </GameContext.Provider>,
  );
  return { ...view, game, ui, model, onBrowse, onExpand };
}

describe("a player's plate", () => {
  it("names you, titles you with your deck and says whose turn and priority it is", () => {
    plate("duel", 0);
    expect(screen.getByText("You")).toHaveAttribute("title", "You");
    expect(screen.getByText("Mono Green Creatures")).toBeInTheDocument();
    expect(screen.getByText("Active turn")).toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();
  });

  it("titles an opponent by what they are, and by their deck only for SysOp", () => {
    const { unmount } = plate("duel", 1);
    expect(screen.getByText("Bot 2")).toBeInTheDocument();
    expect(screen.getByText("Bot")).toBeInTheDocument();
    unmount();
    plate("sysop", 1);
    expect(screen.getByText("Mono Red Burn")).toBeInTheDocument();
  });

  it("marks a player who is out, and one who won", () => {
    plate("four", 3);
    expect(screen.getByText("Out")).toBeInTheDocument();
    const f = tableFixture("duel");
    f.snapshot.view!.opponents[0].won = true;
    plate(f, 1);
    expect(screen.getByText("Winner")).toBeInTheDocument();
  });

  it("gives life, hand and library in words, the graveyard by its tile", () => {
    plate("duel", 0);
    expect(screen.getByRole("img", { name: "18 life" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "7 cards in hand" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "46 cards in library" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Graveyard 2" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /graveyard/i })).toBeNull();
  });

  it("opens each zone's browser from its tile, marking a zone with something offered", () => {
    const f = tableFixture("duel");
    const spike = f.snapshot.view!.you!.graveyard[0];
    f.snapshot.prompt!.options.push({
      id: "80",
      action: "cast",
      label: null,
      object_id: spike.id,
      seat: null,
      selected: false,
    });
    const { onBrowse } = plate(f, 0);
    const graveyard = screen.getByRole("button", { name: "Graveyard 2" });
    expect(graveyard).toHaveAttribute("data-zone", "graveyard");
    expect(graveyard).toHaveAttribute("data-actionable");
    fireEvent.click(graveyard);
    expect(onBrowse).toHaveBeenCalledWith({
      kind: "zone",
      seat: 0,
      zone: "graveyard",
    });
    const exile = screen.getByRole("button", { name: "Exile 0" });
    expect(exile).not.toHaveAttribute("data-actionable");
    fireEvent.click(exile);
    expect(onBrowse).toHaveBeenLastCalledWith({
      kind: "zone",
      seat: 0,
      zone: "exile",
    });
  });

  it("opens the command zone, with the commander tax", () => {
    const { onBrowse } = plate("three", 0);
    fireEvent.click(screen.getByRole("button", { name: "Command 1 · Tax 2" }));
    expect(onBrowse).toHaveBeenCalledWith({
      kind: "zone",
      seat: 0,
      zone: "command",
    });
  });

  it("answers through the portrait, or is disabled when the tab cannot answer", () => {
    const { game, unmount } = plate("four", 1);
    const target = screen.getByRole("button", { name: /^Bot 2: 31 life\. / });
    expect(target).toHaveAttribute("data-player", "1");
    expect(target).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(target);
    expect(game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ seat: 1 }),
    );
    unmount();
    plate("four", 1, { canAnswer: false });
    expect(
      screen.getByRole("button", { name: /^Bot 2: 31 life/ }),
    ).toBeDisabled();
  });

  it("opens a menu above your own portrait when you are offered twice", () => {
    const f = tableFixture("four");
    f.snapshot.prompt!.options.push({
      id: "81",
      action: "choose",
      label: "You, again",
      object_id: null,
      seat: 0,
      selected: false,
    });
    const { game, ui } = plate(f, 0);
    fireEvent.click(screen.getByRole("button", { name: /^You: 27 life\. / }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("data-placement", "above");
    expect(ui.get().menu).toBe("player:0");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.dataset.option)).toEqual(["1", "81"]);
    fireEvent.click(items[1]);
    expect(game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ id: "81" }),
    );
    expect(ui.get().menu).toBeNull();
  });

  it("shows the mana pool, counters and commander damage taken", () => {
    const { unmount } = plate("duel", 0);
    const pool = screen.getByRole("img", { name: "Mana pool: 1 green" });
    expect(pool.querySelector('[data-symbol="G"]')).toHaveTextContent("1G");
    unmount();
    plate("duel", 1);
    expect(screen.getByText("2 poison")).toBeInTheDocument();
    const f = tableFixture("three");
    plate(f, 1);
    expect(
      screen.getByText("6 from your Krenko, Mob Boss"),
    ).toBeInTheDocument();
  });

  it("names whose commander damaged you", () => {
    plate("four", 0);
    expect(screen.getByText(/^4 from Bot 2’s Omnath/)).toBeInTheDocument();
  });

  it("lists the commanders for screen readers", () => {
    const { unmount } = plate("three", 0);
    expect(
      screen.getByText("Krenko, Mob Boss: command zone, tax 2, 6 to Bot 2"),
    ).toBeInTheDocument();
    unmount();
    plate("three", 2);
    expect(
      screen.getByText(/^Talrand, Sky Summoner: battlefield, tax 2$/),
    ).toBeInTheDocument();
  });

  it("shows your board and a lone opponent's in the browser", () => {
    const { onBrowse, unmount } = plate("duel", 0);
    fireEvent.click(screen.getByRole("button", { name: "Show your board" }));
    expect(onBrowse).toHaveBeenCalledWith({ kind: "battlefield", seat: 0 });
    unmount();
    const opponent = plate("duel", 1);
    fireEvent.click(screen.getByRole("button", { name: "Show Bot 2's board" }));
    expect(opponent.onBrowse).toHaveBeenCalledWith({
      kind: "battlefield",
      seat: 1,
    });
  });

  it("expands one of several opponents in place, and collapses it again", () => {
    const quiet = () => {
      const f = tableFixture("three");
      f.snapshot.prompt = null;
      return f;
    };
    const { onExpand, unmount } = plate(quiet(), 1);
    const expand = screen.getByRole("button", { name: "Expand Bot 2's board" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);
    expect(onExpand).toHaveBeenCalledWith(1);
    unmount();
    const expanded = plate(quiet(), 1, { expandedSeat: 1 });
    const collapse = screen.getByRole("button", {
      name: "Expand Bot 2's board",
    });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(expanded.onExpand).toHaveBeenCalledWith(null);
  });

  it("draws the sigil and the timer's bar itself only with the dom painter", () => {
    const running = {
      timer: {
        key: "p-duel|attack:7:declare_attackers",
        phase: "running" as const,
        remainingMs: 2000,
        totalMs: 8000,
        subject: null,
      },
    };
    const bars = () =>
      Array.from(document.querySelectorAll<HTMLElement>("span")).filter(
        (span) => span.style.width === "25%",
      );
    const { ui, unmount } = plate("duel", 0);
    expect(document.querySelector('svg[data-sigil="colour"]')).not.toBeNull();
    expect(bars()).toHaveLength(0);
    act(() => ui.set(running));
    expect(bars()).toHaveLength(1);
    act(() => ui.set({ timer: { ...running.timer, phase: "stopped" } }));
    expect(bars()).toHaveLength(0);
    unmount();
    const scene = plate("duel", 0, { painter: "webgl" });
    expect(document.querySelector("svg[data-sigil]")).toBeNull();
    act(() => scene.ui.set(running));
    expect(bars()).toHaveLength(0);
  });

  it("names the phase beside your portrait, as Magic Duels does", () => {
    const { unmount } = plate("duel", 0);
    expect(screen.getByText("First main")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    unmount();
    plate("three", 0);
    expect(screen.getByText("Combat")).toBeInTheDocument();
  });

  it("sizes life and the counts in rem, so Larger text enlarges them as it does names", () => {
    plate("duel", 0);
    const life = document.querySelector<HTMLElement>(`.${styles.numeral}`)!;
    expect(life).toHaveTextContent("18");
    expect(life.style.fontSize).toMatch(/^\d+(\.\d+)?rem$/);
    const counts = document.querySelectorAll<HTMLElement>(`.${styles.count}`);
    expect(counts.length).toBeGreaterThan(0);
    counts.forEach((count) =>
      expect(count.style.fontSize).toMatch(/^\d+(\.\d+)?rem$/),
    );
  });

  it("draws an opponent's sigil grey", () => {
    plate("duel", 1);
    expect(document.querySelector('svg[data-sigil="grey"]')).not.toBeNull();
  });
});

describe("a player's Planeswalker portrait (v0.3.1)", () => {
  /** The duel, with Alice allied with `mine` and seat 1 a human allied with `theirs`. */
  function allied(mine: string | null, theirs: string | null): TableFixture {
    const f = tableFixture("duel");
    f.summarySeats = [
      { ...f.summarySeats[0], portrait: mine },
      { seat: 1, player: "human", handle: "bob", deck: null, portrait: theirs },
    ];
    return f;
  }

  it("stands in your diamond instead of the sigil, in colour and named", () => {
    plate(allied("rowan", null), 0);
    const portrait = screen.getByRole("img", { name: "Rowan portrait" });
    expect(portrait).toHaveAttribute("data-portrait", "rowan");
    const picture = portrait.querySelector("img")!;
    expect(picture).toHaveAttribute("src", "/portraits/rowan-256.webp");
    expect(picture).toHaveAttribute("alt", "");
    expect(picture).not.toHaveAttribute("data-grey");
    expect(picture).toHaveClass(styles.picture);
    // Upright in front of the frame, never cut to it: not inside the sigil's clipped diamond.
    expect(portrait).not.toHaveClass(styles.portrait);
    expect(document.querySelector("svg[data-sigil]")).toBeNull();
    // Your life is still your life.
    expect(screen.getByRole("img", { name: "18 life" })).toBeInTheDocument();
  });

  it("is grey for an opponent, as their sigil is", () => {
    plate(allied(null, "chandra"), 1);
    const picture = screen
      .getByRole("img", { name: "Chandra portrait" })
      .querySelector("img")!;
    expect(picture).toHaveAttribute("data-grey");
  });

  it("keeps the sigil, still named, when the picture does not load", () => {
    plate(allied("the-sphinx", null), 0);
    const portrait = screen.getByRole("img", { name: "The Sphinx portrait" });
    fireEvent.error(portrait.querySelector("img")!);
    const fallback = screen.getByRole("img", { name: "The Sphinx portrait" });
    expect(fallback.querySelector("img")).toBeNull();
    expect(fallback.querySelector('svg[data-sigil="colour"]')).not.toBeNull();
  });

  it("keeps the sigil for anything that is not a roster ID, asking for nothing", () => {
    plate(allied("../api/v1/me", null), 0);
    expect(document.querySelector('img[src^="/portraits/"]')).toBeNull();
    expect(screen.queryByRole("img", { name: /portrait/ })).toBeNull();
    expect(document.querySelector('svg[data-sigil="colour"]')).not.toBeNull();
  });

  it("is only named with the webgl painter, which draws it on the canvas", () => {
    plate(allied("rowan", null), 0, { painter: "webgl" });
    expect(
      screen.getByRole("img", { name: "Rowan portrait" }),
    ).toBeInTheDocument();
    expect(document.querySelector('img[src^="/portraits/"]')).toBeNull();
    expect(document.querySelector("svg[data-sigil]")).toBeNull();
  });
});
