import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GameContext, type GameContextValue } from "../Board";
import {
  fixtureInput,
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "./fixtures";
import { buildTableModel } from "./tableModel";
import type { TableModel, ZoneBrowserTarget } from "./types";
import { ZoneContents, zoneTitle } from "./ZoneContents";
import styles from "./table.module.css";

function modelOf(name: FixtureName | TableFixture): TableModel {
  return buildTableModel(
    fixtureInput(typeof name === "string" ? tableFixture(name) : name),
  );
}

function browse(f: FixtureName | TableFixture, target: ZoneBrowserTarget) {
  const fixture = typeof f === "string" ? tableFixture(f) : f;
  const input = fixtureInput(fixture);
  const model = buildTableModel(input);
  const game: GameContextValue = {
    ...input.context,
    choose: vi.fn(),
    zoom: vi.fn(),
    preview: vi.fn(),
  };
  render(
    <GameContext.Provider value={game}>
      <ZoneContents target={target} model={model} />
    </GameContext.Provider>,
  );
  return { model, game };
}

describe("zone browser titles", () => {
  it("say whose zone it is, with the curly apostrophe of visible titles", () => {
    const duel = modelOf("duel");
    expect(zoneTitle({ kind: "zone", seat: 0, zone: "graveyard" }, duel)).toBe(
      "Your graveyard",
    );
    expect(zoneTitle({ kind: "zone", seat: 1, zone: "exile" }, duel)).toBe(
      "Bot 2’s exile",
    );
    expect(zoneTitle({ kind: "zone", seat: 0, zone: "command" }, duel)).toBe(
      "Your command zone",
    );
    expect(zoneTitle({ kind: "battlefield", seat: 1 }, duel)).toBe(
      "Bot 2’s battlefield",
    );
    expect(zoneTitle({ kind: "stack" }, duel)).toBe("Stack");
    expect(zoneTitle({ kind: "hand" }, duel)).toBe("Your hand");
  });

  it("name the seat when the view has no such player (defect 7)", () => {
    expect(
      zoneTitle({ kind: "zone", seat: 4, zone: "graveyard" }, modelOf("duel")),
    ).toBe("Seat 5’s graveyard");
  });

  it("name the owner for SysOp observing", () => {
    const sysop = modelOf("sysop");
    expect(zoneTitle({ kind: "zone", seat: 0, zone: "graveyard" }, sysop)).toBe(
      "Alice’s graveyard",
    );
    expect(zoneTitle({ kind: "hand" }, sysop)).toBe("Alice's hand");
  });

  it("name a pile by its card and count", () => {
    const tokens = modelOf("tokens");
    const pile = tokens.anchored!.units.find((u) => u.cards.length === 7)!;
    expect(zoneTitle({ kind: "pile", unit: pile.key }, tokens)).toBe(
      "Soldier Token × 7",
    );
    const attachments = modelOf("attachments");
    const host = attachments.anchored!.units.find(
      (u) => u.kind === "host" && u.attachments.length === 6,
    )!;
    expect(zoneTitle({ kind: "pile", unit: host.key }, attachments)).toBe(
      "Serra Angel and what is attached to it",
    );
  });
});

describe("zone browsers", () => {
  it("list every card of the zone in a grid, answering as on the table", () => {
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
    const { game } = browse(f, { kind: "zone", seat: 0, zone: "graveyard" });
    expect(screen.getByText("2 cards")).toBeInTheDocument();
    const grid = screen.getByRole("group", { name: "Your graveyard" });
    expect(grid).toHaveClass(styles.zoneGrid);
    const cards = within(grid).getAllByRole("button");
    expect(cards.map((card) => card.dataset.card)).toEqual(
      f.snapshot.view!.you!.graveyard.map((card) => card.id),
    );
    fireEvent.click(cards[0]);
    expect(game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ id: "80" }),
    );
  });

  it("say so when the zone is empty", () => {
    browse("duel", { kind: "zone", seat: 0, zone: "exile" });
    expect(screen.getByText("0 cards")).toBeInTheDocument();
    expect(screen.getByText("Empty")).toBeInTheDocument();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("count one card as one", () => {
    browse("duel", { kind: "zone", seat: 1, zone: "exile" });
    expect(screen.getByText("1 card")).toBeInTheDocument();
  });

  it("show a whole pile", () => {
    const tokens = modelOf("tokens");
    const pile = tokens.anchored!.units.find((u) => u.cards.length === 7)!;
    browse("tokens", { kind: "pile", unit: pile.key });
    expect(
      screen.getAllByRole("button", {
        name: /^Soldier Token, .* of 7 grouped/,
      }),
    ).toHaveLength(7);
  });

  it("show every permanent of a board", () => {
    const { model } = browse("duel", { kind: "battlefield", seat: 1 });
    const count = model.opponents[0].units.reduce(
      (n, unit) => n + unit.cards.length + unit.attachments.length,
      0,
    );
    expect(
      within(
        screen.getByRole("group", { name: "Bot 2’s battlefield" }),
      ).getAllByRole("button"),
    ).toHaveLength(count);
  });

  it("show all of a long hand", () => {
    browse("hand25", { kind: "hand" });
    expect(
      within(screen.getByRole("group", { name: "Your hand" })).getAllByRole(
        "button",
      ),
    ).toHaveLength(25);
  });

  it("show the whole stack, top first, items past the sixth included", () => {
    const { model } = browse("stack", { kind: "stack" });
    const items = within(
      screen.getByRole("group", { name: "Stack" }),
    ).getAllByRole("button");
    expect(items.map((item) => item.dataset.card)).toEqual(
      model.stack.map((entry) => entry.id),
    );
    expect(items[0]).toHaveAccessibleName(/^Next: Counterspell/);
    expect(items[7]).toHaveAccessibleName(/^8: Dark Ritual/);
  });
});
