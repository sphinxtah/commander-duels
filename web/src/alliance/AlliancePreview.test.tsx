import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { AlliancePicker } from "./AlliancePicker";
import { planeswalkerCards, roster } from "./fixtures";

// An alliance's cards before choosing it (v0.6.2, the owner's request).

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
afterEach(() => vi.restoreAllMocks());

function serve() {
  return vi.spyOn(client, "GET").mockImplementation((async (
    _path: string,
    init: { params: { path: { planeswalker_id: string } } },
  ) => ({
    data: planeswalkerCards(init.params.path.planeswalker_id),
    response: new Response(),
  })) as never);
}

function picker(current: string | null = null, onAlly = vi.fn()) {
  render(
    <AlliancePicker
      roster={roster}
      current={current}
      busy={false}
      onAlly={onAlly}
    />,
  );
  return onAlly;
}

describe("the alliance picker's tile", () => {
  it("shows an open Planeswalker's cards, each larger on a click, and begins the alliance", async () => {
    const asked = serve();
    const onAlly = picker();
    fireEvent.click(screen.getByRole("button", { name: "See Rowan's cards" }));
    const tile = await screen.findByRole("dialog", { name: "Rowan" });
    expect(asked).toHaveBeenCalledWith(
      "/api/v1/planeswalkers/{planeswalker_id}/cards",
      { params: { path: { planeswalker_id: "rowan" } } },
    );
    const cards = await within(tile).findByRole("list", {
      name: "Rowan's cards",
    });
    expect(
      within(cards)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Rowan, Stand-in Duelist"),
      expect.stringContaining("Rowan, Stand-in Scion"),
    ]);
    expect(tile).toHaveTextContent(
      "2 cards: the alliance puts a playset (4) of each in your library while it lasts.",
    );
    // A card's picture opens large, as on the Cards page.
    fireEvent.click(
      within(cards).getByRole("button", { name: /^Rowan, Stand-in Scion/ }),
    );
    const zoom = screen.getByRole("dialog", {
      name: "Rowan, Stand-in Scion, enlarged",
    });
    expect(within(zoom).getByRole("img")).toHaveAttribute(
      "src",
      expect.stringContaining("printing-rowan-1"),
    );
    fireEvent.click(
      within(zoom).getByRole("button", { name: "Close the picture" }),
    );
    expect(
      screen.queryByRole("dialog", { name: /enlarged/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(tile).getByRole("button", { name: "Begin Alliance with Rowan" }),
    );
    expect(onAlly).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rowan" }),
    );
    expect(screen.queryByRole("dialog", { name: "Rowan" })).toBeNull();
  });

  it("shows a locked Planeswalker's cards without the button, and says why", async () => {
    serve();
    const onAlly = picker();
    fireEvent.click(screen.getByRole("button", { name: "See Kaya's cards" }));
    const tile = await screen.findByRole("dialog", { name: "Kaya" });
    expect(
      await within(tile).findByRole("list", { name: "Kaya's cards" }),
    ).toBeInTheDocument();
    expect(
      within(tile).queryByRole("button", { name: /Begin Alliance/ }),
    ).toBeNull();
    expect(tile).toHaveTextContent(
      "Locked: Kaya opens at 10 wins. Win games to reach the Silver tier.",
    );
    fireEvent.click(within(tile).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Kaya" })).toBeNull();
    expect(onAlly).not.toHaveBeenCalled();
  });

  it("keeps the Godlike tier's custom cards private", async () => {
    serve();
    picker();
    fireEvent.click(
      screen.getByRole("button", { name: "See The Sphinx's cards" }),
    );
    const tile = await screen.findByRole("dialog", { name: "The Sphinx" });
    expect(
      await within(tile).findByText(
        /The Sphinx's cards are the owner's own custom cards, kept private/,
      ),
    ).toBeInTheDocument();
    expect(within(tile).queryByRole("list")).toBeNull();
  });

  it("marks the current alliance, with no button to begin it again", async () => {
    serve();
    picker("rowan");
    const current = screen.getByRole("button", { name: "See Rowan's cards" });
    expect(current).toHaveAttribute("data-current");
    expect(current).toHaveTextContent("Your alliance");
    fireEvent.click(current);
    const tile = await screen.findByRole("dialog", { name: "Rowan" });
    expect(within(tile).getByText("Your alliance")).toBeInTheDocument();
    expect(
      within(tile).queryByRole("button", { name: /Begin Alliance/ }),
    ).toBeNull();
  });

  it("says when the cards did not arrive", async () => {
    vi.spyOn(client, "GET").mockResolvedValue({
      error: { message: "Not found." },
      response: new Response(null, { status: 404 }),
    } as never);
    picker();
    fireEvent.click(screen.getByRole("button", { name: "See Rowan's cards" }));
    const tile = await screen.findByRole("dialog", { name: "Rowan" });
    expect(await within(tile).findByRole("alert")).toHaveTextContent(
      "Not found.",
    );
    // The alliance can still begin: the cards are only a preview.
    expect(
      within(tile).getByRole("button", { name: "Begin Alliance with Rowan" }),
    ).toBeInTheDocument();
  });
});
