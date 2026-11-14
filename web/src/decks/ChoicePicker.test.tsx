import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChoicePicker } from "./DeckEditor";
import {
  choiceWords,
  combine,
  differences,
  merge,
  rowKey,
  takesChoice,
} from "./decks";
import { card, entry } from "./fixtures";

// v0.9.12: Cryptic Spires's two colours are circled as the deck is built, and go with each copy.

const spires = card("Cryptic Spires", { type_line: "Land" });

describe("a copy's choice", () => {
  it("tells apart two copies with different colours circled", () => {
    const blue = { ...entry(spires, 2), choice: "WU" };
    const red = { ...entry(spires, 1), choice: "BR" };
    expect(rowKey(blue)).not.toBe(rowKey(red));
    // Copies with the same colours are one row; with others, their own.
    const merged = merge([blue, red, { ...entry(spires, 1), choice: "WU" }]);
    expect(merged.map((item) => [item.choice, item.quantity])).toEqual([
      ["WU", 3],
      ["BR", 1],
    ]);
    // A draft saved elsewhere with other colours differs, and both are kept when combined.
    expect(differences([blue], [red]).map((item) => item.entry.choice)).toEqual(
      ["WU", "BR"],
    );
    expect(combine([blue], [red])).toHaveLength(2);
    expect(takesChoice(spires)).toBe(true);
    expect(takesChoice(card("Forest"))).toBe(false);
    expect(choiceWords("WU")).toBe("White and Blue");
  });

  it("keeps two colours pressed, and is a choice only with two", () => {
    const chosen = vi.fn();
    render(<ChoicePicker choice={null} onChoose={chosen} />);
    const press = (name: string) =>
      fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
    const pressed = () =>
      screen
        .getAllByRole("button", { pressed: true })
        .map((button) => button.textContent);
    expect(screen.getByRole("status").textContent).toContain("Choose two");
    press("Green");
    // One colour is not yet a choice the deck keeps.
    expect(chosen).toHaveBeenLastCalledWith(null);
    press("White");
    // Written in WUBRG order, whatever the order pressed.
    expect(chosen).toHaveBeenLastCalledWith("WG");
    expect(pressed()).toEqual(["✓ White", "✓ Green"]);
    expect(screen.getByRole("status").textContent).toBe(
      "Taps for White and Green.",
    );
    // A third lets go of the earlier of the two.
    press("Blue");
    expect(chosen).toHaveBeenLastCalledWith("WU");
    expect(pressed()).toEqual(["✓ White", "✓ Blue"]);
    // Pressing one again lets go of it.
    press("White");
    expect(chosen).toHaveBeenLastCalledWith(null);
    expect(pressed()).toEqual(["✓ Blue"]);
  });

  it("shows the colours a copy already has", () => {
    render(<ChoicePicker choice="BR" onChoose={() => undefined} />);
    expect(
      screen
        .getAllByRole("button", { pressed: true })
        .map((button) => button.textContent),
    ).toEqual(["✓ Black", "✓ Red"]);
  });
});
