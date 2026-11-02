import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./rules.fixture.txt?raw";
import { HowToPlay, viewOf } from "./HowToPlay";
import { forgetOfficialRules } from "./officialRules";
import { PROMPT_TOPICS } from "./guide";
import { WhatsThis } from "../game/PromptPanel";

function serveRules(answer: "fixture" | "missing" | "html") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url !== "/rules/comprehensive-rules.txt")
        return new Response("", { status: 404 });
      if (answer === "missing")
        return new Response("Not found", { status: 404 });
      if (answer === "html")
        return new Response("<!doctype html><title>App</title>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      return new Response(fixture, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }),
  );
}

beforeEach(() => {
  forgetOfficialRules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("How to play's addresses", () => {
  it("reads topics, rules, the glossary and unknown addresses", () => {
    expect(viewOf(undefined)).toEqual({ kind: "contents" });
    expect(viewOf("")).toEqual({ kind: "contents" });
    expect(viewOf("trample")).toEqual({ kind: "unknown" });
    expect(viewOf("combat-damage")).toMatchObject({ kind: "topic" });
    expect(viewOf("rules")).toEqual({ kind: "rules" });
    expect(viewOf("rules/702.19B")).toEqual({
      kind: "rule",
      number: "702.19b",
    });
    expect(viewOf("rules/702")).toEqual({ kind: "rule", number: "702" });
    expect(viewOf("rules/<script>")).toEqual({ kind: "unknown" });
    expect(viewOf("glossary")).toEqual({ kind: "glossary" });
  });
});

describe("How to play", () => {
  it("lists every chapter of the guide, and the official rules when present", async () => {
    serveRules("fixture");
    render(<HowToPlay rest="" />);
    expect(
      screen.getByRole("heading", { name: "Learn to play Magic" }),
    ).toBeInTheDocument();
    const guide = screen.getByRole("navigation", { name: "The guide" });
    expect(
      within(guide).getByRole("link", { name: "Reading a card" }),
    ).toHaveAttribute("href", "#how-to-play/card-anatomy");
    expect(
      await screen.findByText(/Comprehensive Rules, effective March 4, 2031/),
    ).toBeInTheDocument();
  });

  it("says plainly when the build has no official text", async () => {
    serveRules("missing");
    render(<HowToPlay rest="rules/100.1" />);
    expect(
      await screen.findByText(/Official rules not included in this build/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Wizards of the Coast’s rules page/ }),
    ).toHaveAttribute("href", "https://magic.wizards.com/en/rules");
  });

  it("takes the app's own page for no rules", async () => {
    serveRules("html");
    render(<HowToPlay rest="" />);
    expect(
      await screen.findByText(/Official rules not included in this build/),
    ).toBeInTheDocument();
  });

  it("shows a topic with its cards, examples and official rules", async () => {
    serveRules("missing");
    render(<HowToPlay rest="combat-damage" />);
    expect(
      screen.getByRole("heading", { name: "Combat damage" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Trample over a chump blocker"),
    ).toBeInTheDocument();
    // The cards are real images from the guide's own route, over their text frames.
    const dreadmaw = screen.getAllByRole("img", {
      name: /^Colossal Dreadmaw/,
    })[0]!;
    expect(dreadmaw.querySelector("img")).toHaveAttribute(
      "src",
      "/api/v1/how-to-play/card-images?name=Colossal%20Dreadmaw&size=normal",
    );
    const official = screen.getByRole("complementary", {
      name: "Official rules",
    });
    expect(
      within(official).getByRole("link", { name: "702.19" }),
    ).toHaveAttribute("href", "#how-to-play/rules/702.19");
    const pager = screen.getByRole("navigation", { name: "Topics" });
    expect(
      within(pager).getByRole("link", { name: /Blocking/ }),
    ).toHaveAttribute("rel", "prev");
  });

  it("draws a card's parts with numbered pins and labels", () => {
    serveRules("missing");
    render(<HowToPlay rest="card-anatomy" />);
    const labels = screen
      .getAllByRole("listitem")
      .filter((item) => item.hasAttribute("data-n"));
    expect(
      labels.map((item) => item.querySelector("strong")?.textContent),
    ).toEqual([
      "Name",
      "Mana cost",
      "Illustration",
      "Type line",
      "Set symbol",
      "Text box",
      "Power / toughness",
      "Artist and collector number",
    ]);
  });

  it("opens an official chapter at its rule, with links between rules", async () => {
    serveRules("fixture");
    render(<HowToPlay rest="rules/100.1a" />);
    expect(
      await screen.findByRole("heading", { name: "100. Beginnings" }),
    ).toBeInTheDocument();
    const rule = document.getElementById("rule-100.1a")!;
    expect(rule).toHaveAttribute("data-target", "true");
    expect(within(rule).getByRole("link", { name: "101.2" })).toHaveAttribute(
      "href",
      "#how-to-play/rules/101.2",
    );
    expect(
      within(rule).getByText(/A teapot joins the game/),
    ).toBeInTheDocument();
    const pager = screen.getByRole("navigation", { name: "Chapters" });
    expect(
      within(pager).getByRole("link", { name: /101\. Middles/ }),
    ).toHaveAttribute("rel", "next");
  });

  it("searches the guide and the official rules", async () => {
    serveRules("fixture");
    render(<HowToPlay rest="" />);
    await screen.findByText(/effective March 4, 2031/);
    const search = screen.getByLabelText("Search the rules");
    fireEvent.change(search, { target: { value: "teapot" } });
    expect(
      await screen.findByRole("link", { name: /100\.1a/ }),
    ).toHaveAttribute("href", "#how-to-play/rules/100.1a");
    expect(screen.getByRole("link", { name: "Teapot" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "trample" } });
    const inGuide = screen.getByRole("heading", { name: "In the guide" })
      .nextElementSibling as HTMLElement;
    expect(
      within(inGuide).getByRole("link", { name: "Combat damage" }),
    ).toHaveAttribute("href", "#how-to-play/combat-damage");
  });

  it("shows the glossary", async () => {
    serveRules("fixture");
    render(<HowToPlay rest="glossary" />);
    await waitFor(() => expect(screen.getByText("Marble")).toBeInTheDocument());
    expect(screen.getByText(/A small glass ball/)).toBeInTheDocument();
  });
});

describe("What's this?", () => {
  it("links each kind of prompt to its topic, in a new tab", () => {
    render(<WhatsThis kind="declare_blockers" />);
    const link = screen.getByRole("link", { name: /What's this\? Blocking/ });
    expect(link).toHaveAttribute("href", "/#how-to-play/blocking");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("is absent for a kind with no topic", () => {
    const { container } = render(<WhatsThis kind="unsupported" />);
    expect(container).toBeEmptyDOMElement();
    expect(PROMPT_TOPICS.unsupported).toBeUndefined();
  });
});
