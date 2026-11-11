import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { topicById, TUTORIAL_TOPICS } from "../howToPlay/guide";
import { buildDemo } from "./demoScript";
import { LearnMore } from "./LearnMore";

// The owner's report (v0.9.8): in the guided game, "More in How to play: Lands and mana" opened
// the guide in a new tab, and a new tab of an account still in its setup shows the welcome again.
describe("the tutorial's way into How to play", () => {
  it("opens the topic in a pop-up over the tutorial, never in a new tab", async () => {
    const changes: boolean[] = [];
    render(
      <LearnMore
        title="Lands and mana"
        onOpenChange={(open) => changes.push(open)}
      />,
    );
    // A button, not a link: nothing here leaves the page.
    expect(screen.queryByRole("link")).toBeNull();
    const more = screen.getByRole("button", {
      name: "More in How to play: Lands and mana",
    });
    expect(more).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => more.click());
    const dialog = screen.getByRole("dialog", { name: "Lands and mana" });
    const topic = topicById("lands-and-mana")!;
    expect(dialog).toHaveTextContent("How to play");
    expect(dialog).toHaveTextContent(topic.summary.slice(0, 40));
    // The topic's own words and pictures, with nothing that leads away from the tutorial: no
    // links to the official rules, to other topics or to the guide's page.
    expect(dialog.querySelectorAll("a")).toHaveLength(0);
    expect(dialog).toHaveTextContent(
      "The whole guide is under How to play in your account",
    );
    expect(changes).toEqual([true]);

    await act(async () =>
      within(dialog)
        .getByRole("button", { name: "Back to the tutorial" })
        .click(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(changes).toEqual([true, false]);

    // Open again, and closed by its Close button or a click on the backdrop.
    await act(async () => more.click());
    await act(async () =>
      within(screen.getByRole("dialog"))
        .getByRole("button", { name: "Close" })
        .click(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => more.click());
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(changes).toEqual([true, false, true, false, true, false]);
  });

  it("has a topic of the guide for every lesson of the guided game", () => {
    for (const lesson of buildDemo()) {
      const id = TUTORIAL_TOPICS[lesson.title];
      expect(id, lesson.title).toBeTruthy();
      expect(topicById(id!), lesson.title).toBeDefined();
    }
  });

  it("shows nothing for a title the guide has no topic for", () => {
    const spy = vi.fn();
    const { container } = render(
      <LearnMore title="No such lesson" onOpenChange={spy} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(spy).not.toHaveBeenCalled();
  });
});
