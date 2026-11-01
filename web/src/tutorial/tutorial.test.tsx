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
import { OVERVIEW } from "./Overview";
import { Tour } from "./Tour";
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
    expect(beats.length).toBeGreaterThan(12);
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
});
