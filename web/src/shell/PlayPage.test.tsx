import { act, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Format, Me } from "../api";
import { PlayPage, comingSoon } from "./PlayPage";

// The Play wizard and the list of games have their own tests (game/PlayWizard.test.tsx).
vi.mock("../game/PlayWizard", () => ({
  PlayWizard: () => <section aria-label="Play wizard" />,
}));
vi.mock("../game/GamesList", () => ({
  GamesList: () => <section aria-label="Your games" />,
}));

const me = { handle: "ada", permissions: ["games.play"] } as unknown as Me;

const kingsTable: Format = {
  id: "kings_table",
  name: "King's Table",
  description: "Two teams of three, a King and two Generals each.",
  seats: [6],
  default_seats: 6,
  available: true,
  early: false,
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});

describe("the Play page's formats (v0.8.7)", () => {
  it("shows King's Table's card, open to play, and says where it is played", async () => {
    render(
      <PlayPage
        me={me}
        formats={[kingsTable]}
        connection="connected"
        onRetry={() => undefined}
        heading={createRef()}
      />,
    );
    const card = screen.getByRole("article");
    expect(card).toHaveAttribute("data-format", "kings_table");
    expect(card).toHaveTextContent("♔");
    expect(card).toHaveTextContent("6 PLAYERS");
    expect(within(card).getByText("Open to play")).toBeInTheDocument();
    await act(async () =>
      within(card)
        .getByRole("button", { name: /About this format/ })
        .click(),
    );
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog).toHaveTextContent(
      "from the wizard here, you and five bots in the seat you choose; or at a table in Tables",
    );
    expect(dialog).toHaveTextContent("Not in the queues.");
  });

  it("never calls King's Table coming soon, whatever the server's flag", () => {
    expect(comingSoon({ ...kingsTable, available: false })).toBe(false);
  });
});

describe("the Play page's two views (v1.0.0)", () => {
  const page = (view?: "wizard" | "games") => (
    <PlayPage
      me={me}
      formats={[kingsTable]}
      connection="connected"
      onRetry={() => undefined}
      heading={createRef()}
      view={view}
    />
  );

  it("is the wizard, over the formats", () => {
    render(page());
    expect(
      screen.getByRole("heading", { level: 1, name: "Battle the bots." }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Play wizard" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your games" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Formats" }),
    ).toBeInTheDocument();
  });

  it("is the account's games at #play/games, with the way back to the wizard", () => {
    render(page("games"));
    expect(
      screen.getByRole("heading", { level: 1, name: "Your games." }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Your games" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Play wizard" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Formats" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Play" })).toHaveAttribute(
      "href",
      "#play",
    );
  });
});
