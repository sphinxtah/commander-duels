import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CardButton,
  GameContext,
  PlayerHeader,
  type GameContextValue,
} from "./Board";
import { objectIndex, optionsByObject, optionsBySeat } from "./model";
import type {
  CardView,
  GameView,
  PlayerView,
  Prompt,
  PromptOption,
} from "./types";

const card: CardView = {
  id: "obj-1",
  hidden: false,
  name: "Soul Warden",
  mana_cost: "{W}",
  type_line: "Creature — Human Cleric",
  power: "1",
  toughness: "1",
  rules: [],
};

// Two triggers from one source: the card carries two options, so clicking it opens a menu.
const options: PromptOption[] = ["1", "2"].map((id) => ({
  id,
  action: "put_first",
  label: `Trigger ${id}`,
  object_id: card.id,
  seat: null,
  selected: false,
}));
const prompt: Prompt = {
  id: "p1",
  kind: "order_triggers",
  message: "Order the triggers",
  detail: null,
  options,
  amounts: null,
  piles: null,
  xmage_query: null,
};

function player(seat: number, name: string): PlayerView {
  return {
    seat,
    name,
    life: 20,
    counters: {},
    library_count: 40,
    hand_count: 7,
    graveyard: [],
    exile: [],
    mana_pool: { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 },
    lost: false,
    won: false,
    color_identity: null,
    command_zone: [],
    commanders: [],
  };
}
const view: GameView = {
  seat: 0,
  turn: 3,
  active_seat: 0,
  priority_seat: 0,
  phase: null,
  step: null,
  you: player(0, "Alice"),
  opponents: [player(1, "Bot 2")],
  hand: [card],
  battlefield: [],
  stack: [],
  combat: [],
  revealed: [],
  looked_at: [],
  messages: [],
  priority: null,
};

function context(change: Partial<GameContextValue> = {}): GameContextValue {
  return {
    view,
    prompt,
    index: objectIndex(view),
    byObject: optionsByObject(prompt),
    bySeat: optionsBySeat(prompt),
    canAnswer: true,
    observing: false,
    choose: vi.fn(),
    zoom: vi.fn(),
    preview: vi.fn(),
    ...change,
  };
}

function openMenu(value: GameContextValue) {
  render(
    <GameContext.Provider value={value}>
      <button type="button">Elsewhere</button>
      <CardButton card={card} />
    </GameContext.Provider>,
  );
  const cardButton = document.querySelector<HTMLElement>("[data-card]")!;
  fireEvent.click(cardButton);
  const items = screen.getAllByRole("menuitem");
  expect(document.activeElement).toBe(items[0]);
  return { cardButton, items };
}

describe("a card's option menu", () => {
  it("answers an item pressed in Safari, which blurs the focused item with nowhere to go", () => {
    const value = context();
    const { items } = openMenu(value);
    // Pressing an item must not move focus, or Safari clears it before the click.
    expect(fireEvent.mouseDown(items[1])).toBe(false);
    fireEvent.focusOut(items[0], { relatedTarget: null });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("menuitem")[1]);
    expect(value.choose).toHaveBeenCalledWith(options[1]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on a press outside it", () => {
    openMenu(context());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to the card", () => {
    const { cardButton, items } = openMenu(context());
    fireEvent.keyDown(items[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(cardButton);
  });

  it("closes when Tab leaves it", () => {
    const { items } = openMenu(context());
    fireEvent.focusOut(items[0], {
      relatedTarget: screen.getByRole("button", { name: "Elsewhere" }),
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("player headers", () => {
  it("name the seat's owner when SysOp observes their game", () => {
    const { rerender } = render(
      <GameContext.Provider value={context({ observing: true })}>
        <PlayerHeader player={view.you!} onZone={vi.fn()} />
      </GameContext.Provider>,
    );
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    rerender(
      <GameContext.Provider value={context()}>
        <PlayerHeader player={view.you!} onZone={vi.fn()} />
      </GameContext.Provider>,
    );
    expect(screen.getByText("You")).toBeInTheDocument();
  });
});
