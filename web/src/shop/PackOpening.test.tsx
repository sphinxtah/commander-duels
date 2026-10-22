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
import { opening } from "./fixtures";
import { PackOpening, TIMING } from "./PackOpening";

const sound = vi.hoisted(() => ({
  unlock: vi.fn(),
  play: vi.fn(),
  setVolume: vi.fn(),
  setMuted: vi.fn(),
}));
vi.mock("../game/sound/engine", () => ({ getSoundEngine: () => sound }));
// The card's details are CardViews' own tests; here the dialog only has to name the card.
vi.mock("../catalog/CardViews", () => ({
  CardDetails: ({ cardId }: { cardId: string }) => <p>Details of {cardId}</p>,
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
    fireEvent.click(
      screen.getByRole("button", { name: "Details of Mythic Card" }),
    );
    expect(screen.getByText("Details of card-4")).toBeInTheDocument();
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
});
