import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Me } from "../api";
import { SetupWizard } from "../app/SetupWizard";
import { buildDemo, MIRA, VOK } from "./demoScript";
import { placeCoach, VISIBLE } from "./Coach";
import { OVERVIEW } from "./Overview";
import {
  autoWaitMs,
  frameHolds,
  readingMs,
  READ_MAX_MS,
  READ_MIN_MS,
  STILL_MS,
  wordCount,
} from "./pacing";
import { Tour } from "./Tour";
import { TutorialSettings } from "./TutorialSettings";
import {
  bestPulled,
  moveTutorial,
  signalTutorial,
  suggestedPrices,
  tourCard,
  tutorialPending,
  type Tutorial,
} from "./tutorial";

vi.mock("./tutorial", async (original) => ({
  ...(await original<typeof import("./tutorial")>()),
  moveTutorial: vi.fn(),
}));
const move = vi.mocked(moveTutorial);

beforeAll(() => {
  // jsdom has no modal dialogs; the setup wizard is one.
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function account(tutorialState: Tutorial, overrides: Partial<Me> = {}): Me {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "player",
    status: "active",
    onboarding: "handle",
    tutorial: tutorialState,
    handle: null,
    display_name: "Alice",
    email: "alice@example.com",
    avatar: "sigil",
    locale: "en",
    alliance: null,
    csrf_token: "token-1",
    permissions: ["profile.edit", "games.play"],
    roles: ["player"],
    preferences: { large_text: false, reduced_motion: false },
    session: {
      id: "session-1",
      kind: "google",
      authenticated_at: "2026-11-01T10:00:00Z",
      idle_expires_at: "2026-11-15T10:00:00Z",
      absolute_expires_at: "2026-12-01T10:00:00Z",
    },
    ...overrides,
  };
}
const choosing: Tutorial = { path: null, stage: "choose", skipped: false };

describe("the guided game's script", () => {
  const beats = buildDemo();
  const frames = beats.flatMap((beat) => beat.frames);
  const last = frames[frames.length - 1]!;

  it("has words and at least one frame for every lesson, in rising revisions", () => {
    expect(beats.length).toBe(21);
    for (const beat of beats) {
      expect(beat.title).not.toBe("");
      expect(beat.text.length).toBeGreaterThan(60);
      expect(beat.frames.length).toBeGreaterThan(0);
    }
    frames.forEach((frame, index) => {
      expect(frame.revision).toBe(index + 1);
      expect(frame.view?.seat).toBe(MIRA);
      expect(frame.prompt).toBeNull();
      expect(frame.result).toBeNull();
      expect(frame.log.length).toBe(frame.log_count);
    });
  });

  it("keeps every object on the battlefield, the stack and in hand unique", () => {
    for (const frame of frames) {
      const view = frame.view!;
      const ids = [
        ...view.battlefield.map((p) => p.id),
        ...view.stack.map((s) => s.id),
        ...view.hand.map((c) => c.id),
      ];
      expect(new Set(ids).size).toBe(ids.length);
      expect(view.hand.length).toBe(view.you!.hand_count);
    }
  });

  it("ends with Vok beaten by 25 commander damage from Sigarda, at 10 life", () => {
    const view = last.view!;
    const vok = view.opponents.find((p) => p.seat === VOK)!;
    expect(vok.lost).toBe(true);
    expect(vok.life).toBe(10);
    expect(view.you!.won).toBe(true);
    expect(view.you!.life).toBe(26);
    expect(view.you!.commanders[0]!.damage_dealt).toEqual([
      { seat: VOK, damage: 25 },
    ]);
    // Judith was cast twice: her tax is {4} for a third cast.
    expect(vok.commanders[0]).toMatchObject({ cast_count: 2, tax: 4 });
  });

  it("shows the stack with Giant Growth on top of Lightning Bolt", () => {
    const stacked = frames.find((frame) => frame.view!.stack.length === 2);
    expect(stacked?.view!.stack.map((item) => item.name)).toEqual([
      "Lightning Bolt",
      "Giant Growth",
    ]);
  });
});

describe("the guided game's pace", () => {
  const beats = buildDemo();

  it("gives each lesson time to read by its words, within bounds", () => {
    expect(wordCount("Grizzly Bears costs {1}{G}: one green mana.")).toBe(7);
    expect(readingMs("A few words.")).toBe(READ_MIN_MS);
    expect(readingMs("word ".repeat(400))).toBe(READ_MAX_MS);
    const times = beats.map((beat) => readingMs(beat.text));
    // Longer lessons read longer; none rushes, none stalls.
    const short = beats.findIndex((beat) => beat.title === "Haste");
    const long = beats.findIndex((beat) => beat.title === "Blocking");
    expect(times[long]!).toBeGreaterThan(times[short]!);
    for (const time of times) {
      expect(time).toBeGreaterThanOrEqual(READ_MIN_MS);
      expect(time).toBeLessThanOrEqual(READ_MAX_MS);
    }
  });

  it("keeps each lesson short, in plain words", () => {
    for (const beat of beats) {
      expect(wordCount(beat.text)).toBeLessThanOrEqual(75);
      // No other game named, and no engine words.
      expect(beat.text).not.toMatch(/priority|ETB|\bCMC\b|XMage/i);
    }
  });

  it("holds a frame until its animation has finished, and still pictures with motion reduced", () => {
    const normal = frameHolds(beats, "normal");
    const faster = frameHolds(beats, "faster");
    const still = frameHolds(beats, "none");
    expect(normal.map((holds) => holds.length)).toEqual(
      beats.map((beat) => beat.frames.length),
    );
    const blocking = beats.findIndex((beat) => beat.title === "Blocking");
    // The Goblin dies in the lesson's last frame: the slash, then the card leaving.
    const dying = normal[blocking]!.at(-1)!;
    expect(dying).toBeGreaterThanOrEqual(760 + 450);
    expect(faster[blocking]!.at(-1)!).toBeLessThan(dying);
    // The end: the result's emblem and the confetti.
    expect(normal.at(-2)!.at(-1)!).toBeGreaterThanOrEqual(2200);
    for (const holds of still)
      for (const hold of holds) expect(hold).toBe(STILL_MS);
  });

  it("goes on by itself once the words are read and the board has settled", () => {
    const text = "word ".repeat(40);
    expect(autoWaitMs(text, 900, 0)).toBe(readingMs(text));
    // Time already spent on the lesson's frames counts toward its reading.
    expect(autoWaitMs(text, 900, 4_000)).toBe(readingMs(text) - 4_000);
    // A long last animation waits for itself.
    expect(autoWaitMs(text, 3_000, 60_000)).toBe(3_000);
  });
});

describe("the tour's bubble placement", () => {
  const phone = { width: 360, height: 740 };
  const target = { left: 16, top: 120, width: 328, height: 150 };

  it("sits below its target when there is room, inside the window", () => {
    const place = placeCoach(target, 200, phone);
    expect(place.side).toBe("below");
    expect(place.top).toBe(120 + 150 + 18);
    expect(place.left).toBeGreaterThanOrEqual(12);
    expect(place.left + place.width).toBeLessThanOrEqual(360 - 12);
    expect(place.arrow).toBeGreaterThanOrEqual(22);
    expect(place.arrow!).toBeLessThanOrEqual(place.width - 22);
  });

  it("flips above a target near the window's foot, never over it", () => {
    const low = { ...target, top: 560 };
    const place = placeCoach(low, 220, phone);
    expect(place.side).toBe("above");
    expect(place.top + 220).toBeLessThanOrEqual(low.top);
    expect(place.top).toBeGreaterThanOrEqual(12);
  });

  it("stays in the window with no room on any side, leaving the target's top in view", () => {
    const tall = { left: 0, top: 60, width: 360, height: 640 };
    const place = placeCoach(tall, 240, phone);
    expect(place.side).toBe("over");
    expect(place.top).toBeGreaterThanOrEqual(60 + VISIBLE);
    expect(place.top + 240).toBeLessThanOrEqual(740 - 12);
    // A phone turned sideways: the Play tile fills the window under the bar.
    const sideways = { width: 740, height: 360, top: 118 };
    const tile = { left: 16, top: 130, width: 708, height: 260 };
    const low = placeCoach(tile, 150, sideways);
    expect(low.top).toBeGreaterThanOrEqual(130 + VISIBLE);
    expect(low.top + 150).toBeLessThanOrEqual(360 - 12);
  });

  it("keeps the arrow under a target at the window's edge", () => {
    const corner = { left: 300, top: 20, width: 50, height: 40 };
    const place = placeCoach(corner, 180, phone);
    expect(place.left + place.arrow!).toBeGreaterThan(300);
    expect(place.left + place.arrow!).toBeLessThan(350);
  });

  it("goes beside its target on a phone turned sideways", () => {
    const sideways = { width: 740, height: 360, top: 118 };
    const button = { left: 33, top: 160, width: 157, height: 39 };
    const place = placeCoach(button, 208, sideways);
    expect(place.side).toBe("right");
    expect(place.left).toBe(33 + 157 + 18);
    expect(place.left + place.width).toBeLessThanOrEqual(740 - 12);
    expect(place.top).toBeGreaterThanOrEqual(118 + 12);
    expect(place.top + 208).toBeLessThanOrEqual(360 - 12);
    // The arrow is level with the button's middle.
    expect(place.top + place.arrow!).toBeCloseTo(160 + 39 / 2, 0);
  });

  it("keeps below the sticky top bar, unless its target is in the bar", () => {
    const bar = { ...phone, top: 118 };
    const low = { ...target, top: 400, height: 300 };
    const place = placeCoach(low, 240, bar);
    expect(place.side).toBe("above");
    expect(place.top).toBeGreaterThanOrEqual(118 + 12);
    expect(place.top + 240).toBeLessThanOrEqual(400);
    // A target in the bar itself: the bubble goes below it.
    const button = { left: 300, top: 20, width: 44, height: 44 };
    expect(placeCoach(button, 180, bar).top).toBe(20 + 44 + 18);
  });

  it("is the same 340-pixel bubble on a desktop", () => {
    const desk = { width: 1280, height: 800 };
    const tile = { left: 700, top: 300, width: 300, height: 180 };
    const place = placeCoach(tile, 190, desk);
    expect(place).toMatchObject({ side: "below", width: 340, top: 498 });
    expect(place.left).toBe(700 + 150 - 170);
  });
});

describe("the tutorial's helpers", () => {
  it("picks the pack's rarest card to list, foils first, never a basic land", () => {
    const card = (
      name: string,
      rarity: string,
      finish = "nonfoil",
      type_line = "Creature",
    ) => ({
      printing_id: `p-${name}`,
      name,
      rarity,
      finish,
      type_line,
      stand_in: false,
    });
    expect(
      bestPulled([
        card("Forest", "common", "foil", "Basic Land — Forest"),
        card("Bear", "common"),
        card("Angel", "rare"),
        card("Shiny Angel", "rare", "foil"),
        card("Elf", "uncommon"),
      ]),
    ).toEqual({
      printingId: "p-Shiny Angel",
      name: "Shiny Angel",
      rarity: "rare",
      finish: "foil",
    });
    expect(
      bestPulled([card("Forest", "common", "nonfoil", "Basic Land — Forest")]),
    ).toBeNull();
  });

  it("suggests prices by rarity, foils at twice, Buy Now at three times the bid", () => {
    expect(suggestedPrices("common", "nonfoil")).toEqual({
      startingBid: 10,
      buyNow: 30,
    });
    expect(suggestedPrices("mythic", "foil")).toEqual({
      startingBid: 500,
      buyNow: 1500,
    });
  });

  it("opens the wizard by itself before the setup, and for a guided setup", () => {
    const at = (stage: Tutorial["stage"], path: Tutorial["path"] = null) =>
      tutorialPending(account({ path, stage, skipped: false }));
    expect(at("choose")).toBe(true);
    expect(at("demo", "beginner")).toBe(true);
    expect(at("overview", "novice")).toBe(true);
    expect(at("setup", "novice")).toBe(true);
    expect(at("setup", "advanced")).toBe(false);
    expect(at("tour_shop", "beginner")).toBe(false);
    expect(at("done", "beginner")).toBe(false);
  });

  it("has an overview of the site first, then the rules' refresher", () => {
    const parts = OVERVIEW.map((page) => page.part);
    expect(parts[0]).toBe("Commander Duels");
    expect(parts[parts.length - 1]).toBe("A Magic refresher");
    expect(parts.indexOf("A Magic refresher")).toBeGreaterThan(
      parts.lastIndexOf("Commander Duels"),
    );
  });
});

describe("the welcome's three paths", () => {
  beforeEach(() => {
    move.mockReset();
    window.location.hash = "";
  });

  function Wizard({
    initial,
    onClose = () => {},
  }: {
    initial: Me;
    onClose?: () => void;
  }) {
    const [me, setMe] = useState(initial);
    return (
      <SetupWizard me={me} onChange={setMe} open="welcome" onClose={onClose} />
    );
  }

  it("asks how to start, and Advanced goes straight to the name, with no tips", async () => {
    move.mockResolvedValue({
      me: account({ path: "advanced", stage: "setup", skipped: false }),
    });
    render(<Wizard initial={account(choosing)} />);
    expect(
      screen.getByRole("heading", { name: "How would you like to start?" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up my game" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    await screen.findByRole("heading", { name: "Choose your name" });
    expect(move).toHaveBeenCalledWith({
      stage: "setup",
      path: "advanced",
      skipped: false,
    });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("gives a Novice the overview, page by page, then the setup with a tip", async () => {
    render(<Wizard initial={account(choosing)} />);
    move.mockResolvedValueOnce({
      me: account({ path: "novice", stage: "overview", skipped: false }),
    });
    fireEvent.click(screen.getByRole("button", { name: /^Novice/ }));
    await screen.findByRole("heading", { name: OVERVIEW[0]!.title });
    expect(
      screen.getByRole("list", { name: "Setting up your game" }),
    ).toHaveTextContent(
      "1 Welcome2 Overview3 Your name4 Starter decks5 Alliance",
    );
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(
      screen.getByRole("heading", { name: OVERVIEW[1]!.title }),
    ).toBeInTheDocument();
    move.mockResolvedValueOnce({
      me: account({ path: "novice", stage: "setup", skipped: false }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip the overview" }));
    await screen.findByRole("heading", { name: "Choose your name" });
    expect(move).toHaveBeenLastCalledWith({
      stage: "setup",
      path: undefined,
      skipped: false,
    });
    expect(screen.getByRole("note")).toHaveTextContent(
      /Your handle is the name other players see/,
    );
  });

  it("sends a Beginner to the guided game", async () => {
    const onClose = vi.fn();
    move.mockResolvedValue({
      me: account({ path: "beginner", stage: "demo", skipped: false }),
    });
    render(<Wizard initial={account(choosing)} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /^Beginner/ }));
    await waitFor(() => expect(window.location.hash).toBe("#tutorial/demo"));
    expect(onClose).toHaveBeenCalled();
  });

  it("says why a choice could not be saved", async () => {
    move.mockResolvedValue({ error: "The service is not answering." });
    render(<Wizard initial={account(choosing)} />);
    fireEvent.click(screen.getByRole("button", { name: /^Advanced/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The service is not answering.",
    );
  });
});

describe("the main menu's tour", () => {
  beforeEach(() => {
    move.mockReset();
    sessionStorage.clear();
  });
  afterEach(() => {
    for (const element of document.querySelectorAll("[data-tour]"))
      element.remove();
  });

  function target(name: string) {
    const element = document.createElement("a");
    element.dataset.tour = name;
    element.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 100,
        right: 300,
        bottom: 200,
        width: 200,
        height: 100,
      }) as DOMRect;
    document.body.append(element);
    return element;
  }

  it("points at Leng's Card Shop from the main menu", async () => {
    target("shop");
    const me = account(
      { path: "beginner", stage: "tour_shop", skipped: false },
      { onboarding: "complete", handle: "alice" },
    );
    render(<Tour me={me} page="Home" onChange={() => {}} />);
    expect(
      await screen.findByText(
        "You have some tokens! Let's go check out Leng's Card Shop and tear some packs!",
      ),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-tutorial="coach"]')).toHaveAttribute(
      "data-target",
      "shop",
    );
  });

  it("moves on to the auction house once a pack is opened, with its best card", async () => {
    const onChange = vi.fn();
    const after = account(
      { path: "novice", stage: "tour_auctions", skipped: false },
      { onboarding: "complete", handle: "alice" },
    );
    move.mockResolvedValue({ me: after });
    const me = account(
      { path: "novice", stage: "tour_shop", skipped: false },
      { onboarding: "complete", handle: "alice" },
    );
    render(<Tour me={me} page="Shop" onChange={onChange} />);
    act(() =>
      signalTutorial("pack_opened", [
        {
          printing_id: "p1",
          name: "Shivan Dragon",
          rarity: "rare",
          finish: "nonfoil",
          type_line: "Creature — Dragon",
          stand_in: false,
        },
      ]),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(after));
    expect(move).toHaveBeenCalledWith({
      stage: "tour_auctions",
      skipped: false,
    });
    expect(tourCard()).toMatchObject({ name: "Shivan Dragon" });
  });

  it("skips the tour for good", async () => {
    target("shop");
    const done = account(
      { path: "beginner", stage: "done", skipped: true },
      { onboarding: "complete", handle: "alice" },
    );
    move.mockResolvedValue({ me: done });
    const onChange = vi.fn();
    const me = account(
      { path: "beginner", stage: "tour_shop", skipped: false },
      { onboarding: "complete", handle: "alice" },
    );
    render(<Tour me={me} page="Home" onChange={onChange} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Skip the tour" }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(done));
    expect(move).toHaveBeenCalledWith({ stage: "done", skipped: true });
  });

  const at = (stage: Tutorial["stage"]) =>
    account(
      { path: "beginner", stage, skipped: false },
      { onboarding: "complete", handle: "alice" },
    );

  it("goes on to Decks once the card is listed", async () => {
    const onChange = vi.fn();
    move.mockResolvedValue({ me: at("tour_decks") });
    render(
      <Tour me={at("tour_auctions")} page="Auctions" onChange={onChange} />,
    );
    act(() => signalTutorial("card_listed"));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(at("tour_decks")),
    );
    expect(move).toHaveBeenCalledWith({ stage: "tour_decks", skipped: false });
  });

  it("points at Decks from the main menu, then explains the decks and building one", async () => {
    target("decks");
    const { rerender } = render(
      <Tour me={at("tour_decks")} page="Home" onChange={() => {}} />,
    );
    expect(
      await screen.findByText(/Next, the decks you play with/),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-tutorial="coach"]')).toHaveAttribute(
      "data-target",
      "decks",
    );
    // On Decks: the starter decks first, Next, then building one.
    target("deck-list");
    target("deck-build");
    rerender(<Tour me={at("tour_decks")} page="Decks" onChange={() => {}} />);
    expect(
      await screen.findByText(/Your two starter decks are already here/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(
      await screen.findByText(/Build one with help picks a commander/),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-tutorial="coach"]')).toHaveAttribute(
      "data-target",
      "deck-build",
    );
    move.mockResolvedValue({ me: at("tour_play") });
    fireEvent.click(screen.getByRole("button", { name: /On to Play/ }));
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith({ stage: "tour_play", skipped: false }),
    );
  });

  it("ends at the practice table, with a last bubble", async () => {
    target("practice-start");
    const onChange = vi.fn();
    move.mockResolvedValue({ me: at("done") });
    render(<Tour me={at("tour_play")} page="Play" onChange={onChange} />);
    expect(
      await screen.findByText(/At the practice table you play against bots/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Finish the tour/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(at("done")));
    expect(move).toHaveBeenCalledWith({ stage: "done", skipped: false });
    expect(
      await screen.findByRole("heading", { name: "You're all set" }),
    ).toBeInTheDocument();
  });

  it("skips the tour from its last bubbles too", async () => {
    target("play");
    move.mockResolvedValue({ me: at("done") });
    render(<Tour me={at("tour_play")} page="Home" onChange={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Skip the tour" }),
    );
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith({ stage: "done", skipped: true }),
    );
  });

  it("ends when a practice game starts from the Play page", async () => {
    target("practice-start");
    move.mockResolvedValue({ me: at("done") });
    render(<Tour me={at("tour_play")} page="Play" onChange={() => {}} />);
    await screen.findByText(/At the practice table/);
    act(() => {
      window.location.hash = "#game/00000000-0000-4000-8000-0000000000aa";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith({ stage: "done", skipped: false }),
    );
    window.location.hash = "";
  });

  it("is taken again from Settings: all of it, or Decks and Play alone", async () => {
    const onChange = vi.fn();
    move.mockResolvedValue({ me: at("tour_decks") });
    render(<TutorialSettings me={at("done")} onChange={onChange} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Tour Decks and Play" }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#decks"));
    expect(move).toHaveBeenCalledWith({
      stage: "tour_decks",
      path: "beginner",
    });
    move.mockResolvedValue({ me: at("tour_shop") });
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    await waitFor(() => expect(window.location.hash).toBe("#home"));
    expect(move).toHaveBeenLastCalledWith({
      stage: "tour_shop",
      path: "beginner",
    });
    window.location.hash = "";
  });
});
