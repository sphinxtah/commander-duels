import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureInput, tableFixture } from "./fixtures";
import { layoutTable } from "./layout";
import { Magnifier, magnifierImageSize, PNG_DELAY_MS } from "./Magnifier";
import { stageFit } from "./stage";
import { TableContext } from "./TableContext";
import { buildTableModel } from "./tableModel";
import type { Painter, TableCard, TableUiSnapshot } from "./types";
import { createTableUi } from "./uiStore";

const fixture = tableFixture("duel");
const model = buildTableModel(fixtureInput(fixture));
const layout = layoutTable(model, { expandedSeat: null, textScale: 1 });
const view = fixture.snapshot.view;

function card(where: (card: TableCard) => boolean): TableCard {
  const found = [...model.cards.values()].find(where);
  if (!found) throw new Error("no such card in the fixture");
  return found;
}
const creature = card(
  (c) => c.zone === "battlefield" && c.card.power !== null && !c.card.hidden,
);
const inHand = card((c) => c.zone === "hand" && !c.card.hidden);

function show(
  state: Partial<TableUiSnapshot>,
  options: { k?: number; dpr?: number; painter?: Painter } = {},
) {
  const ui = createTableUi();
  ui.set(state);
  const fit = stageFit(
    1920 * (options.k ?? 1),
    1080 * (options.k ?? 1),
    options.dpr ?? 1,
  );
  const painter = options.painter ?? "webgl";
  const result = render(
    <TableContext.Provider
      value={{ painter, ui, layout, model, fit, drag: null }}
    >
      <Magnifier
        model={model}
        layout={layout}
        fit={fit}
        view={view}
        observing={false}
        painter={painter}
      />
    </TableContext.Provider>,
  );
  return { ...result, ui };
}

const images = (root: HTMLElement) =>
  [...root.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");

afterEach(() => vi.useRealTimers());

describe("the magnifier", () => {
  it("draws nothing until a card is magnified", () => {
    const { container } = show({});
    expect(container).toBeEmptyDOMElement();
  });

  it("draws the card large on its side, with what it is now, and never takes the pointer", () => {
    const { container } = show({
      magnified: { key: creature.key, side: "left", level: 1 },
    });
    const magnifier = container.querySelector("[data-magnifier]")!;
    expect(magnifier).toHaveAttribute("aria-hidden", "true");
    expect(magnifier).toHaveAttribute("data-magnifier", "left");
    // The left slot never crosses the table's middle.
    const picture = magnifier.firstElementChild as HTMLElement;
    expect(
      parseFloat(picture.style.left) + parseFloat(picture.style.width),
    ).toBeLessThanOrEqual(960);
    expect(images(container).every((src) => src.includes("size=large"))).toBe(
      true,
    );
    expect(magnifier).toHaveTextContent(creature.card.name!);
    expect(magnifier).toHaveTextContent(
      `Power and toughness ${creature.card.power}/${creature.card.toughness}`,
    );
    expect(magnifier.querySelector("button, a, [tabindex]")).toBeNull();
  });

  it("asks for the png only on screens that need it, and only after the card stays", () => {
    vi.useFakeTimers();
    expect(magnifierImageSize(1, 1, 1)).toBe("large");
    expect(magnifierImageSize(2, 1, 1)).toBe("large");
    expect(magnifierImageSize(2, 4 / 3, 1)).toBe("png");
    expect(magnifierImageSize(1, 2, 1)).toBe("png");
    const { container } = show(
      { magnified: { key: creature.key, side: "right", level: 1 } },
      { k: 2 },
    );
    expect(images(container).some((src) => src.includes("size=png"))).toBe(
      false,
    );
    act(() => void vi.advanceTimersByTime(PNG_DELAY_MS));
    expect(images(container).some((src) => src.includes("size=png"))).toBe(
      true,
    );
    // The large image stays beneath until the png has loaded.
    expect(images(container).some((src) => src.includes("size=large"))).toBe(
      true,
    );
  });

  it("shows a hidden card's back and asks for no image of it", () => {
    const hidden = [...model.cards.values()].find((c) => c.card.hidden);
    if (!hidden) return;
    const { container } = show({
      magnified: { key: hidden.key, side: "right", level: 1 },
    });
    expect(images(container).some((src) => src.includes("card-images"))).toBe(
      false,
    );
    expect(container).toHaveTextContent("A face-down card");
  });

  it("says whose hand a Two-Headed Giant teammate's card is in, and only theirs (v0.5.1)", () => {
    const giant = tableFixture("giant");
    const m = buildTableModel(fixtureInput(giant));
    const l = layoutTable(m, { expandedSeat: null, textScale: 1 });
    const ui = createTableUi();
    const fit = stageFit(1920, 1080, 1);
    const draw = (key: string) => {
      ui.set({ magnified: { key, side: "right", level: 1 } });
      return render(
        <TableContext.Provider
          value={{ painter: "webgl", ui, layout: l, model: m, fit, drag: null }}
        >
          <Magnifier
            model={m}
            layout={l}
            fit={fit}
            view={giant.snapshot.view}
            observing={false}
            painter="webgl"
          />
        </TableContext.Provider>,
      );
    };
    const theirs = draw(m.opponents[0].hand![0]).container;
    expect(theirs).toHaveTextContent("Lightning Bolt");
    expect(theirs).toHaveTextContent("In Bot 2’s hand");
    const yours = draw(m.hand[1]).container;
    expect(yours).not.toHaveTextContent(/In .+ hand/);
  });

  it("draws the risen hand card only when the DOM paints the table", () => {
    const risen = { risen: { key: inHand.key, source: "pointer" as const } };
    expect(
      show(risen).container.querySelector('[data-magnifier="risen"]'),
    ).toBeNull();
    const dom = show(risen, { painter: "dom" }).container;
    expect(dom.querySelector('[data-magnifier="risen"]')).not.toBeNull();
  });
});
