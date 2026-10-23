import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CardButton,
  CardRow,
  GameContext,
  type GameContextValue,
} from "../Board";
import { cardLabel } from "../Card";
import { optionText } from "../model";
import type { PromptOption } from "../types";
import { DomLayer } from "./DomLayer";
import {
  FIXTURE_NAMES,
  fixtureInput,
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "./fixtures";
import { createDragController } from "./dnd";
import { centre, contains } from "./geometry";
import { layoutTable, validateHits } from "./layout";
import { HOVER_DWELL_MS } from "./pointer";
import { stageFit } from "./stage";
import { buildTableModel } from "./tableModel";
import { TableContext } from "./TableContext";
import type { MoreNode, Painter, TableModel } from "./types";
import { createTableUi } from "./uiStore";
import gameStyles from "../game.module.css";
import styles from "./table.module.css";

// The DOM layer drawn from the layout's fixtures with no WebGL (jsdom): the dom painter paints
// faces, the webgl painter leaves its buttons clear for the scene.

function setup(
  f: TableFixture,
  painter: Painter = "dom",
  options: {
    expandedSeat?: number | null;
    /** The stage at scale 1, and a drag controller answering through the game's choose. */
    live?: boolean;
    /** What the screen draws beside the layer: the prompt column, a drawer. */
    beside?: (model: TableModel, game: GameContextValue) => ReactNode;
  } = {},
) {
  const input = fixtureInput(f);
  const model = buildTableModel(input);
  const layout = layoutTable(model, {
    expandedSeat: options.expandedSeat ?? null,
    textScale: 1,
  });
  const game: GameContextValue = {
    ...input.context,
    choose: vi.fn(),
    zoom: vi.fn(),
    preview: vi.fn(),
  };
  const ui = createTableUi();
  const fit = options.live ? stageFit(1920, 1080, 1) : null;
  const status = vi.fn();
  const drag = options.live
    ? createDragController(() => ({
        layout,
        fit,
        ui,
        promptKey: `${model.promptId}|${model.revision}`,
        choose: game.choose,
        openMenu: (key) => ui.set({ menu: key }),
        status,
        model,
      }))
    : null;
  const onBrowse = vi.fn();
  const onExpand = vi.fn();
  const view = render(
    <GameContext.Provider value={game}>
      <TableContext.Provider value={{ painter, ui, layout, model, fit, drag }}>
        <DomLayer
          model={model}
          layout={layout}
          painter={painter}
          onBrowse={onBrowse}
          onExpand={onExpand}
        />
        {options.beside?.(model, game)}
      </TableContext.Provider>
    </GameContext.Provider>,
  );
  return { ...view, model, layout, game, ui, status, onBrowse, onExpand };
}
const fixture = (name: FixtureName) => setup(tableFixture(name));
const placed = (key: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-node]")).filter(
    (element) => element.dataset.node === key,
  );
const option = (
  id: string,
  change: Partial<Omit<PromptOption, "id">>,
): PromptOption => ({
  id,
  action: "choose",
  label: null,
  object_id: null,
  seat: null,
  selected: false,
  ...change,
});

/** The module's stylesheet, with its class names as the components get them in tests. */
function withTableCss() {
  const raw = readFileSync("src/game/table/table.module.css", "utf8");
  const css = raw.replace(
    /\.([a-zA-Z][\w-]*)/g,
    (_, name: string) => `.${(styles as Record<string, string>)[name]}`,
  );
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  return () => style.remove();
}

afterEach(() => {
  document.head.querySelectorAll("style").forEach((style) => style.remove());
});

describe("the table's DOM layer", () => {
  // Every fixture with the dom painter, which jsdom gets; a few with the webgl painter's clear
  // buttons, which are the same buttons.
  const webgl: FixtureName[] = ["duel", "four", "stack", "hand25", "tokens"];
  it.each([
    ...FIXTURE_NAMES.map((name) => `${name} dom`),
    ...webgl.map((name) => `${name} webgl`),
  ])(
    "puts one button at every hit of the %s fixture, and a '+N' for the rest",
    (which) => {
      const [name, painter] = which.split(" ") as [FixtureName, Painter];
      const errors = vi.spyOn(console, "error");
      const { model, layout } = setup(tableFixture(name), painter);
      // React has nothing to say: no repeated keys, however crowded the board.
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
      // The layout counts every object once, with a hit or under a "+N" (WP1's invariant)...
      expect(validateHits(layout, model)).toEqual([]);
      // ...and the layer puts exactly one button at each hit.
      const buttons = new Map<string, HTMLElement[]>();
      for (const element of document.querySelectorAll<HTMLElement>(
        "[data-node]",
      ))
        buttons.set(element.dataset.node!, [
          ...(buttons.get(element.dataset.node!) ?? []),
          element,
        ]);
      for (const node of layout.nodes.values()) {
        const at = buttons.get(node.key) ?? [];
        if (!node.hit) {
          expect(at).toHaveLength(0);
          continue;
        }
        expect(at).toHaveLength(1);
        if (node.kind === "card") expect(at[0].dataset.card).toBe(node.id);
        else expect(at[0]).toHaveAttribute("data-more");
      }
      const ids = Array.from(
        document.querySelectorAll<HTMLElement>("[data-card]"),
      ).map((button) => button.dataset.card);
      expect(new Set(ids).size).toBe(ids.length);
      const mores = [...layout.nodes.values()].filter(
        (node): node is MoreNode => node.kind === "more",
      );
      expect(document.querySelectorAll("[data-more]")).toHaveLength(
        mores.length,
      );
    },
  );

  it("names every card as the screen always has: its label, then its options", () => {
    const { model, game } = fixture("duel");
    let checked = 0;
    for (const button of document.querySelectorAll<HTMLElement>(
      "[data-node][data-card]",
    )) {
      const card = model.cards.get(button.dataset.node!)!;
      expect(button).toHaveAccessibleName(card.label);
      if (card.zone === "stack" || button.dataset.group) continue;
      const options = card.offered
        .map((o) => optionText(o, game.index, game.view, game.observing))
        .join("; ");
      expect(button).toHaveAccessibleName(
        cardLabel(card.card, card.located) +
          (options ? `. Options: ${options}` : ""),
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
    // A pile's members say where they stand in it.
    expect(
      screen.getAllByRole("button", { name: /^Forest, .*, 2 of 3 grouped/ }),
    ).toHaveLength(1);
  });

  it("labels the regions, articles and rows as before", () => {
    fixture("duel");
    const opponents = screen.getByRole("region", { name: "Opponents" });
    const bot = within(opponents).getByRole("article", {
      name: "Bot 2, seat 2",
    });
    for (const row of [
      "Bot 2's battlefield: creatures and other permanents",
      "Bot 2's battlefield: lands",
    ])
      expect(within(bot).getByRole("group", { name: row })).toBeInTheDocument();
    const yours = screen.getByRole("region", {
      name: "Your side of the table",
    });
    for (const row of [
      "Your battlefield: creatures and other permanents",
      "Your battlefield: lands",
      "Your hand",
    ])
      expect(
        within(yours).getByRole("group", { name: row }),
      ).toBeInTheDocument();
    expect(
      within(yours).getByRole("heading", { name: "Your hand 7" }),
    ).toBeInTheDocument();
  });

  it("gives three articles to four players, and your command zone its row", () => {
    fixture("four");
    expect(
      within(screen.getByRole("region", { name: "Opponents" })).getAllByRole(
        "article",
      ),
    ).toHaveLength(3);
    expect(
      screen.getByRole("article", { name: "Bot 4, seat 4" }),
    ).toHaveAttribute("data-lost");
    const command = screen.getByRole("group", { name: "Your command zone" });
    expect(within(command).getAllByRole("button")).toHaveLength(2);
  });

  it("names the owner when SysOp observes, and says nothing of 'Your hand'", () => {
    fixture("sysop");
    expect(
      screen.getByRole("region", { name: "Alice's side of the table" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Alice's hand" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Alice's hand/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Your hand")).toBeNull();
    expect(screen.queryByRole("group", { name: /^Your/ })).toBeNull();
  });

  it("anchors a spectator's lowest seat below, its hand as a count only", () => {
    const { model } = fixture("spectator");
    const side = screen.getByRole("region", {
      name: "Bot 1's side of the table",
    });
    expect(within(side).getByRole("heading")).toHaveTextContent(
      `Bot 1's hand ${model.handBacks}`,
    );
    expect(within(side).queryByRole("group", { name: /hand/ })).toBeNull();
    expect(
      within(side).getByRole("img", { name: "6 cards in hand" }),
    ).toBeInTheDocument();
  });

  it("moves along a row with the arrow keys, its '+N' included", () => {
    const { onBrowse } = fixture("hand25");
    const hand = screen.getByRole("group", { name: "Your hand" });
    const items = Array.from(
      hand.querySelectorAll<HTMLElement>("[data-card],[data-roving]"),
    );
    expect(items).toHaveLength(20);
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([items[0]]);
    items[0].focus();
    fireEvent.keyDown(items[0], { key: "End" });
    const more = items[19];
    expect(document.activeElement).toBe(more);
    expect(more).toHaveAccessibleName(
      "Show all 25 cards in your hand (6 more)",
    );
    expect(more.tabIndex).toBe(0);
    fireEvent.keyDown(more, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(items[18]);
    fireEvent.click(more);
    expect(onBrowse).toHaveBeenCalledWith({ kind: "hand" });
  });

  it("opens the pile browser from a pile's '+N'", () => {
    const { onBrowse, model } = fixture("tokens");
    fireEvent.click(
      screen.getByRole("button", { name: "Show all 7 Soldier Token" }),
    );
    const pile = model.anchored!.units.find(
      (unit) => unit.kind === "tokens" && unit.cards.length === 7,
    )!;
    expect(onBrowse).toHaveBeenCalledWith({ kind: "pile", unit: pile.key });
  });

  it("paints faces with the dom painter and leaves the webgl painter's buttons clear", () => {
    const placedCards = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-node][data-card]"),
      );
    const { unmount } = setup(tableFixture("duel"), "webgl");
    expect(placedCards().length).toBeGreaterThan(10);
    for (const button of placedCards())
      expect(button.querySelector("img")).toBeNull();
    expect(document.querySelector("svg[data-sigil]")).toBeNull();
    unmount();
    setup(tableFixture("duel"), "dom");
    for (const button of placedCards())
      expect(button.querySelector("img")).not.toBeNull();
    // Your sigil in colour, the opponent's grey.
    expect(
      Array.from(document.querySelectorAll("svg[data-sigil]")).map((svg) =>
        svg.getAttribute("data-sigil"),
      ),
    ).toEqual(["grey", "colour"]);
  });

  it("answers a player offered once, and opens a menu for one offered twice", () => {
    const f = tableFixture("four");
    f.snapshot.prompt!.options.push(
      option("90", { seat: 1, label: "Bot 2 again" }),
    );
    const { game } = setup(f);
    fireEvent.click(document.querySelector('[data-player="2"]')!);
    expect(game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ id: "3", seat: 2 }),
    );
    const twice = document.querySelector<HTMLElement>('[data-player="1"]')!;
    expect(twice).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(twice);
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => item.dataset.option)).toEqual(["2", "90"]);
    fireEvent.click(items[1]);
    expect(game.choose).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "90" }),
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(twice);
  });

  it("answers, opens a menu or zooms from a stack item", () => {
    const f = tableFixture("stack");
    const stack = f.snapshot.view!.stack;
    f.snapshot.prompt!.options.push(
      option("91", { object_id: stack[2].id, label: "The hidden one again" }),
    );
    const { game } = setup(f);
    const button = (id: string) =>
      document.querySelector<HTMLElement>(`[data-card="${id}"]`)!;
    // The top item, offered once: a press answers.
    expect(button(stack[0].id)).toHaveAccessibleName(
      /^Next: Counterspell, spell, controlled by Bot 2\. .*Options: /,
    );
    fireEvent.click(button(stack[0].id));
    expect(game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ object_id: stack[0].id }),
    );
    // Offered twice: a menu whose items carry their options' ids.
    fireEvent.click(button(stack[2].id));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.slice(0, 2).map((item) => item.dataset.option)).toEqual([
      "2",
      "91",
    ]);
    fireEvent.keyDown(items[0], { key: "Escape" });
    // Not offered: the zoom shows the spell (defect 3).
    fireEvent.click(button(stack[1].id));
    expect(game.zoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Lightning Bolt" }),
      expect.objectContaining({ zone: "stack", stack: stack[1] }),
    );
    // Items past the sixth are under the "+N".
    expect(document.querySelector(`[data-card="${stack[6].id}"]`)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show the whole stack (2 more)" }),
    ).toBeInTheDocument();
  });

  it("keeps the stack to one tab stop, top first", () => {
    const { model } = fixture("stack");
    const region = screen.getByRole("region", {
      name: "Stack top resolves first",
    });
    const items = Array.from(
      region.querySelectorAll<HTMLElement>("[data-card],[data-roving]"),
    );
    expect(items).toHaveLength(7);
    expect(items[0].dataset.card).toBe(model.stack[0].id);
    expect(items.filter((item) => item.tabIndex === 0)).toEqual([items[0]]);
  });

  it("keeps the combat in words for screen readers", () => {
    fixture("blockers");
    const combat = screen.getByRole("region", { name: "Combat" });
    expect(combat).toHaveClass(gameStyles.visuallyHidden);
    expect(combat).toHaveTextContent(
      "Goblin Guide → You, blocked by Grizzly Bears",
    );
  });

  it("takes pointer events only on its leaves", () => {
    withTableCss();
    fixture("three");
    const regions = [
      document.querySelector(`.${styles.layer}`)!,
      ...screen.getAllByRole("region"),
      ...screen.getAllByRole("article"),
      ...screen.getAllByRole("group"),
      ...document.querySelectorAll(`.${styles.slot}, .${styles.plate}`),
    ];
    expect(regions.length).toBeGreaterThan(20);
    for (const region of regions)
      expect(getComputedStyle(region).pointerEvents).toBe("none");
    const leaves = document.querySelectorAll(
      "[data-node], [data-player], [data-zone], [aria-expanded], [data-more]",
    );
    expect(leaves.length).toBeGreaterThan(20);
    for (const leaf of leaves)
      expect(getComputedStyle(leaf).pointerEvents).toBe("auto");
  });

  it("answers a card's one option when it is pressed", () => {
    const { game, model } = fixture("duel");
    const forest = model.hand.find(
      (key) => model.cards.get(key)!.card.name === "Forest",
    )!;
    fireEvent.click(placed(forest)[0]);
    expect(game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "play_land" }),
    );
  });
});

describe("a Two-Headed Giant teammate's hand (v0.5.1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the teammate's cards in their article, after their board, each named and never offered", () => {
    const { model, game } = fixture("giant");
    const mate = screen.getByRole("article", {
      name: "Bot 2, seat 2, your teammate",
    });
    const rows = within(mate)
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(rows).toEqual([
      "Bot 2's battlefield: creatures and other permanents",
      "Bot 2's battlefield: lands",
      "Bot 2's hand",
    ]);
    const hand = within(mate).getByRole("group", { name: "Bot 2's hand" });
    const cards = within(hand).getAllByRole("button");
    expect(cards.map((button) => button.getAttribute("aria-label"))).toEqual(
      model.opponents[0].hand!.map((key) => {
        const card = model.cards.get(key)!;
        return cardLabel(card.card, card.located);
      }),
    );
    expect(cards[0]).toHaveAccessibleName("Lightning Bolt, Instant");
    for (const button of cards) {
      expect(button).toHaveAttribute("data-role", "teammate-hand");
      expect(button).not.toHaveAttribute("data-actionable");
      expect(button).not.toHaveAttribute("aria-haspopup");
      // The dom painter paints each face.
      expect(button.querySelector("img")).not.toBeNull();
    }
    // Pressing one only shows it: nothing is played.
    fireEvent.click(cards[0]);
    expect(game.choose).not.toHaveBeenCalled();
    expect(game.zoom).toHaveBeenCalledWith(
      model.cards.get(model.opponents[0].hand![0])!.card,
      model.cards.get(model.opponents[0].hand![0])!.located,
    );
    // No other article holds a hand.
    for (const name of [
      "Bot 3, seat 3, the other team",
      "Bot 4, seat 4, the other team",
    ])
      expect(
        within(screen.getByRole("article", { name })).queryByRole("group", {
          name: /hand/,
        }),
      ).toBeNull();
  });

  it("is one tab stop, the arrow keys moving along it", () => {
    fixture("giant");
    const hand = screen.getByRole("group", { name: "Bot 2's hand" });
    const cards = within(hand).getAllByRole("button");
    expect(cards.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    cards[0].focus();
    fireEvent.keyDown(cards[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(cards[1], { key: "End" });
    expect(document.activeElement).toBe(cards.at(-1));
  });

  it("magnifies a teammate's card on hover and on keyboard focus, at the side away from it", () => {
    vi.useFakeTimers();
    const s = setup(tableFixture("giant"), "webgl", { live: true });
    const key = s.model.opponents[0].hand![2];
    const hit = s.layout.nodes.get(key)!.hit!;
    fireEvent.pointerMove(placed(key)[0], {
      clientX: hit.x + hit.w / 2,
      clientY: hit.y + hit.h / 2,
    });
    vi.advanceTimersByTime(HOVER_DWELL_MS);
    expect(s.ui.get().magnified).toEqual({ key, side: "right", level: 1 });
    // Hovering never lifts it as your own hand's cards are lifted.
    expect(s.ui.get().risen).toBeNull();
    s.ui.set({ magnified: null, hover: null });
    // Focus from the keyboard (the page tells it by the key pressed before it).
    act(() => placed(key)[0].focus());
    const other = s.model.opponents[0].hand![4];
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => placed(other)[0].focus());
    expect(s.ui.get()).toMatchObject({
      focus: other,
      focusVisible: true,
      risen: null,
      magnified: { key: other, side: "right", level: 1 },
    });
  });
});

describe("the layer under the pointer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The duel on a live stage: the first hand card (a Forest), and a land under its picture. */
  function live() {
    const s = setup(tableFixture("duel"), "webgl", { live: true });
    const hand = s.model.hand[0];
    const risen = s.layout.risen.get(hand)!;
    const land = [...s.layout.nodes.values()].find(
      (node) =>
        node.kind === "card" &&
        node.role !== "hand" &&
        node.hit !== null &&
        contains(risen, centre(node.hit)),
    )!;
    const slice = s.layout.nodes.get(hand)!.hit!;
    return {
      ...s,
      hand,
      land: land.key,
      handAt: { x: slice.x + slice.w / 2, y: slice.y + 40 },
      landAt: centre(land.hit!),
    };
  }
  const at = (p: { x: number; y: number }) => ({ clientX: p.x, clientY: p.y });

  it("shows a hovered card in the magnifier once the pointer rests on it", () => {
    vi.useFakeTimers();
    const s = live();
    fireEvent.pointerMove(placed(s.land)[0], at(s.landAt));
    expect(s.ui.get().hover).toBeNull();
    vi.advanceTimersByTime(HOVER_DWELL_MS);
    expect(s.ui.get().hover).toBe(s.land);
    expect(s.ui.get().magnified).toMatchObject({ key: s.land, level: 1 });
    fireEvent.wheel(placed(s.land)[0], { deltaY: -120, ...at(s.landAt) });
    expect(s.ui.get().magnified).toMatchObject({ key: s.land, level: 2 });
  });

  it("gives a click under the risen hand card to it, once the pointer has dwelt there", () => {
    const s = live();
    const forest = placed(s.hand)[0];
    fireEvent.pointerMove(forest, at(s.handAt));
    expect(s.ui.get().risen).toEqual({ key: s.hand, source: "pointer" });
    for (let i = 1; i <= 6; i++)
      fireEvent.pointerMove(
        placed(s.land)[0],
        at({
          x: s.handAt.x + ((s.landAt.x - s.handAt.x) * i) / 6,
          y: s.handAt.y + ((s.landAt.y - s.handAt.y) * i) / 6,
        }),
      );
    fireEvent.click(placed(s.land)[0], { ...at(s.landAt), detail: 1 });
    expect(s.game.choose).toHaveBeenCalledTimes(1);
    expect(s.game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "play_land" }),
    );
  });

  it("leaves a single move and click to the land", () => {
    const s = live();
    fireEvent.pointerMove(placed(s.land)[0], at(s.landAt));
    fireEvent.click(placed(s.land)[0], { ...at(s.landAt), detail: 1 });
    expect(s.game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "activate_mana" }),
    );
  });

  it("plays a hand card dragged onto your side, and swallows the click its release makes", () => {
    const s = live();
    const forest = placed(s.hand)[0];
    const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };
    fireEvent.pointerDown(forest, { ...mouse, ...at(s.handAt) });
    fireEvent.pointerMove(window, { ...mouse, clientX: 900, clientY: 800 });
    expect(s.ui.get().drag?.key).toBe(s.hand);
    fireEvent.pointerUp(window, { ...mouse, clientX: 1000, clientY: 700 });
    fireEvent.click(forest, { detail: 1, clientX: 1000, clientY: 700 });
    expect(s.game.choose).toHaveBeenCalledTimes(1);
    expect(s.game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "play_land" }),
    );
    expect(s.ui.get().drag).toBeNull();
  });

  it("opens the card's menu when a drop could mean several answers", () => {
    const f = tableFixture("duel");
    const bolt = f.snapshot.view!.hand[1];
    f.snapshot.prompt!.options.push({
      ...option("70", { object_id: bolt.id, label: "Cast it another way" }),
      action: "cast",
    });
    const s = setup(f, "webgl", { live: true });
    const key = `hand:${bolt.id}`;
    const button = placed(key)[0];
    const slice = s.layout.nodes.get(key)!.hit!;
    const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };
    fireEvent.pointerDown(button, {
      ...mouse,
      clientX: slice.x + 20,
      clientY: slice.y + 40,
    });
    fireEvent.pointerMove(window, { ...mouse, clientX: 900, clientY: 800 });
    act(() => {
      fireEvent.pointerUp(window, { ...mouse, clientX: 1000, clientY: 700 });
    });
    expect(s.game.choose).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.dataset.option)
        .filter(Boolean),
    ).toHaveLength(2);
    expect(s.ui.get().menu).toBe(key);
  });

  it("gives a click on the bare table inside the risen picture to the risen card", () => {
    const s = live();
    const risen = s.layout.risen.get(s.hand)!;
    // Up from the Forest's slice to the stone above it, where no control takes the pointer.
    const stone = { x: s.handAt.x, y: risen.y + 20 };
    fireEvent.pointerMove(placed(s.hand)[0], at(s.handAt));
    for (let i = 1; i <= 6; i++)
      fireEvent.pointerMove(
        s.container,
        at({
          x: stone.x,
          y: s.handAt.y + ((stone.y - s.handAt.y) * i) / 6,
        }),
      );
    expect(s.ui.get().risen).toEqual({ key: s.hand, source: "pointer" });
    fireEvent.click(s.container, { ...at(stone), detail: 1 });
    expect(s.game.choose).toHaveBeenCalledTimes(1);
    expect(s.game.choose).toHaveBeenCalledWith(
      expect.objectContaining({ action: "play_land" }),
    );
  });

  it("raises nothing and hovers nothing while a card is carried", () => {
    vi.useFakeTimers();
    const s = live();
    const forest = placed(s.hand)[0];
    const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };
    fireEvent.pointerMove(forest, at(s.handAt));
    vi.advanceTimersByTime(HOVER_DWELL_MS);
    expect(s.ui.get()).toMatchObject({
      hover: s.hand,
      risen: { key: s.hand, source: "pointer" },
    });
    fireEvent.pointerDown(forest, { ...mouse, ...at(s.handAt) });
    fireEvent.pointerMove(window, { ...mouse, clientX: 900, clientY: 800 });
    expect(s.ui.get().drag?.key).toBe(s.hand);
    // The captured pointer's moves name the carried card, wherever the pointer is.
    fireEvent.pointerMove(forest, { ...mouse, clientX: 1000, clientY: 700 });
    vi.advanceTimersByTime(HOVER_DWELL_MS);
    expect(s.ui.get()).toMatchObject({ hover: null, risen: null });
  });

  it("magnifies the prompt's revealed cards and a drawer's, away from the pointer", () => {
    vi.useFakeTimers();
    const s = setup(tableFixture("revealed"), "webgl", {
      live: true,
      beside: (model, game) => (
        <>
          {/* As PromptPanel lists them: no table card, only where the card is. */}
          <CardRow label="Bot 2's hand">
            {game.view!.revealed[0].cards.map((card) => (
              <CardButton
                key={card.id}
                card={card}
                located={game.index.get(card.id)}
                small
              />
            ))}
          </CardRow>
          {/* As the battlefield browser lists them, with their table cards. */}
          <CardRow label="Bot 2's battlefield">
            {[...model.cards.values()]
              .filter((c) => c.zone === "battlefield" && c.ownerSeat === 1)
              .map((c) => (
                <CardButton
                  key={c.key}
                  card={c.card}
                  located={c.located}
                  table={c}
                />
              ))}
          </CardRow>
        </>
      ),
    });
    const revealed = within(
      screen.getByRole("group", { name: "Bot 2's hand" }),
    ).getAllByRole("button")[0];
    const key = `revealed:${revealed.dataset.card}`;
    expect(revealed.dataset.hover).toBe(key);
    // The prompt column lies at the stage's left.
    const column = { x: 200, y: 600 };
    fireEvent.pointerMove(revealed, at(column));
    vi.advanceTimersByTime(HOVER_DWELL_MS);
    expect(s.ui.get().magnified).toEqual({ key, side: "right", level: 1 });
    fireEvent.wheel(revealed, { deltaY: -120, ...at(column) });
    expect(s.ui.get().magnified).toEqual({ key, side: "right", level: 2 });
    // A drawer at the stage's right: its card opens on the left, wherever it lies on the table.
    const listed = within(
      screen.getByRole("group", { name: "Bot 2's battlefield" }),
    ).getAllByRole("button")[0];
    fireEvent.pointerMove(listed, at({ x: 1600, y: 500 }));
    vi.advanceTimersByTime(HOVER_DWELL_MS);
    expect(s.ui.get().magnified).toEqual({
      key: listed.dataset.hover,
      side: "left",
      level: 1,
    });
  });
});
