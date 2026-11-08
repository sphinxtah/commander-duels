import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { card, opening } from "./fixtures";
import { PackOpening, TIMING } from "./PackOpening";

const sound = vi.hoisted(() => ({
  unlock: vi.fn(),
  play: vi.fn(),
  setVolume: vi.fn(),
  setMuted: vi.fn(),
}));
vi.mock("../game/sound/engine", () => ({ getSoundEngine: () => sound }));
// The card's details are CardViews' own tests; here the dialog only has to name the card, and
// since v0.5.0 the one edition the pack held.
vi.mock("../catalog/CardViews", () => ({
  CardDetails: ({
    cardId,
    chosenPrinting,
    printings,
  }: {
    cardId: string;
    chosenPrinting?: string;
    printings?: string;
  }) => (
    <p>
      Details of {cardId} at {chosenPrinting}, {printings ?? "all"}
    </p>
  ),
}));

beforeAll(() => {
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
beforeEach(() => {
  for (const spy of Object.values(sound)) spy.mockClear();
});
afterEach(() => {
  delete document.documentElement.dataset.reducedMotion;
});

function cues() {
  return sound.play.mock.calls.map(([cue]) => cue);
}

/** Tears the pack open and lets the deal finish, on the fake clock. */
function tearAndDeal() {
  fireEvent.click(
    screen.getByRole("button", {
      name: "Tear open the Zendikar Rising Draft Booster",
    }),
  );
  act(() => vi.advanceTimersByTime(TIMING.tear));
  act(() =>
    vi.advanceTimersByTime(
      opening.cards.length * TIMING.deal + TIMING.settle + 10,
    ),
  );
}

describe("opening a pack", () => {
  it("is the product's own pack, its top strip and the rest, before Leng's counter", () => {
    const { container } = render(
      <PackOpening opening={opening} onDone={vi.fn()} />,
    );
    const pack = screen.getByRole("button", {
      name: "Tear open the Zendikar Rising Draft Booster",
    });
    // The same large picture twice, hidden from assistive technology: the button names it.
    const halves = pack.querySelectorAll('[data-pack-art="picture"]');
    expect(halves).toHaveLength(2);
    for (const half of halves) {
      expect(half).toHaveAttribute("src", "/packs/znr-draft-480.webp");
      expect(half.closest('[aria-hidden="true"]')).not.toBeNull();
    }
    expect(container.querySelector('[data-backdrop="leng"]')).toHaveAttribute(
      "alt",
      "",
    );
    // A product with no picture tears its drawn pack in two the same way.
    fireEvent.error(halves[0]);
    fireEvent.error(halves[1]);
    expect(pack.querySelectorAll('[data-pack-art="drawn"]')).toHaveLength(2);
  });

  it("tears, deals face down, and turns cards over by click and by Space", () => {
    vi.useFakeTimers();
    render(<PackOpening opening={opening} onDone={vi.fn()} />);
    tearAndDeal();
    expect(sound.unlock).toHaveBeenCalled();
    expect(cues().slice(0, 2)).toEqual(["packTear", "cardDeal"]);
    const faceDown = screen.getAllByRole("button", { name: /face down/ });
    expect(faceDown).toHaveLength(6);
    // The board has the keyboard: Space turns over the next card.
    const board = screen.getByRole("group", { name: "The pack's cards" });
    expect(document.activeElement).toBe(board);
    sound.play.mockClear();
    fireEvent.keyDown(board, { key: " " });
    expect(
      screen.getByRole("button", {
        name: "Common, Common Card 0, new to your library",
      }),
    ).toBeInTheDocument();
    expect(cues()).toEqual(["cardFlip"]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Common, Common Card 0, new to your library",
    );
    // A click turns over that card: a mythic rare rings and glows.
    sound.play.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Card 5 of 6/ }));
    const mythic = screen.getByRole("button", {
      name: "Mythic rare, Mythic Card, new to your library",
    });
    expect(mythic).toHaveAttribute("data-glow", "mythic");
    expect(cues()).toEqual(["cardFlip", "mythicReveal"]);
    vi.useRealTimers();
  });

  it("reveals the rest at once, with foils' shimmer, then sums the pack up", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const another = vi.fn();
    render(
      <PackOpening
        opening={opening}
        onDone={done}
        onAnother={another}
        remaining={1}
      />,
    );
    tearAndDeal();
    sound.play.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    act(() => vi.advanceTimersByTime(opening.cards.length * TIMING.revealAll));
    expect(cues()).toEqual(
      expect.arrayContaining(["rareReveal", "mythicReveal", "foilShimmer"]),
    );
    const foil = screen.getByRole("button", {
      name: "Common, Foil Card, foil",
    });
    expect(foil).toHaveAttribute("data-finish", "foil");
    act(() => vi.advanceTimersByTime(1000));
    vi.useRealTimers();
    const summary = screen.getByRole("list", { name: "Cards in the pack" });
    expect(within(summary).getAllByRole("listitem")).toHaveLength(6);
    expect(within(summary).getAllByText("New")).toHaveLength(3);
    expect(
      screen.getByText(/6 cards · 3 new to your library · 1 foil/),
    ).toBeInTheDocument();
    // The card itself is the details button (v0.9.1): no separate Details link.
    expect(within(summary).queryByText("Details")).toBeNull();
    const mythic = screen.getByRole("button", {
      name: "Details of Mythic Card",
    });
    expect(mythic.querySelector("img")).not.toBeNull();
    fireEvent.click(mythic);
    expect(
      screen.getByText("Details of card-4 at printing-4, chosen"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open another/ }));
    expect(another).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to the shop" }));
    expect(done).toHaveBeenCalled();
  });

  it("moves nothing with reduced motion: every step is immediate", () => {
    document.documentElement.dataset.reducedMotion = "true";
    render(<PackOpening opening={opening} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Tear open the/ }));
    expect(screen.getAllByRole("button", { name: /face down/ })).toHaveLength(
      6,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    // The best card sounds once, and the summary follows at once.
    expect(cues()).toEqual(["packTear", "cardFlip", "mythicReveal"]);
    expect(
      screen.getByRole("list", { name: "Cards in the pack" }),
    ).toBeInTheDocument();
  });

  it("shows a pack opened before as its summary", () => {
    render(<PackOpening opening={opening} onDone={vi.fn()} startOpen />);
    expect(
      screen.getByRole("heading", { name: "Zendikar Rising Draft Booster" }),
    ).toHaveFocus();
    expect(
      within(
        screen.getByRole("list", { name: "Cards in the pack" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(6);
    expect(sound.play).not.toHaveBeenCalled();
  });

  it("marks a stand-in, and a past pack's card given in place of the one drawn (v0.6.2)", () => {
    const past = {
      ...opening,
      cards: [
        card(0, { name: "Farmstead", rarity: "rare", stand_in: true }),
        card(1, { name: "Given Card", extra: true }),
        card(2),
      ],
    };
    render(<PackOpening opening={past} onDone={vi.fn()} startOpen />);
    const items = within(
      screen.getByRole("list", { name: "Cards in the pack" }),
    ).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const stand = within(items[0]!).getByText("Stand-in");
    expect(stand).toHaveAttribute(
      "title",
      expect.stringContaining("plays as a stand-in"),
    );
    expect(items[1]).toHaveTextContent(
      "Extra: given in place of the card before it, which is now yours too",
    );
    expect(items[2]).not.toHaveTextContent("Stand-in");
    expect(items[2]).not.toHaveTextContent("Extra");
    expect(
      screen.queryByText(/In place of a card the game cannot play/),
    ).toBeNull();
  });

  it("sums a basic land pack up by land and edition, and every card a press away (v0.9.0)", () => {
    const land = (
      position: number,
      name: string,
      set_code: string,
      set_name: string,
      released_at: string,
      finish: "nonfoil" | "foil" = "nonfoil",
    ) =>
      card(position, {
        name,
        type_line: `Basic Land — ${name}`,
        mana_cost: null,
        set_code,
        set_name,
        released_at,
        finish,
      });
    const lands = {
      ...opening,
      product: {
        ...opening.product,
        kind: "lands" as const,
        name: "Basic Land Pack",
      },
      cards: [
        land(0, "Mountain", "blb", "Bloomburrow", "2024-08-02"),
        land(1, "Plains", "blb", "Bloomburrow", "2024-08-02", "foil"),
        land(2, "Mountain", "lea", "Limited Edition Alpha", "1993-08-05"),
        land(3, "Mountain", "blb", "Bloomburrow", "2024-08-02"),
        land(4, "Plains", "m10", "Magic 2010", "2009-07-17"),
      ],
    };
    render(<PackOpening opening={lands} onDone={() => {}} startOpen />);
    const oldest = screen.getByRole("heading", {
      name: "Oldest pulls",
    }).parentElement!;
    expect(within(oldest).getAllByRole("listitem")[0]).toHaveTextContent(
      "Mountain · Limited Edition Alpha (1993)",
    );
    const byLand = screen.getByRole("list", { name: "Lands by edition" });
    const [plains, mountain] = within(byLand).getAllByRole("listitem");
    // WUBRG order: Plains before Mountain.
    expect(plains).toHaveTextContent("Plains · 2 · 1 foil");
    expect(mountain).toHaveTextContent("Mountain · 3");
    const rows = within(within(mountain).getByRole("table")).getAllByRole(
      "row",
    );
    // Newest first: Bloomburrow ×2, then Alpha ×1.
    expect(rows[1]).toHaveTextContent("Bloomburrow BLB20242");
    expect(rows[2]).toHaveTextContent("Limited Edition Alpha LEA19931");
    expect(
      screen.queryByRole("list", { name: "Cards in the pack" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Every card" }));
    expect(
      within(
        screen.getByRole("list", { name: "Cards in the pack" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(5);
  });

  it("keeps an ordinary pack's summary as its cards", () => {
    render(<PackOpening opening={opening} onDone={() => {}} startOpen />);
    expect(
      screen.queryByRole("button", { name: "By land and edition" }),
    ).toBeNull();
    expect(
      screen.getByRole("list", { name: "Cards in the pack" }),
    ).toBeInTheDocument();
  });
});
