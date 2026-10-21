import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AwayPlayers, awayFor } from "./AwayPlayers";
import type { GameState } from "./connection";
import type { PresenceSeat } from "./types";

function seat(fields: Partial<PresenceSeat> & { seat: number }): PresenceSeat {
  return {
    connected: true,
    away_seconds: null,
    left: null,
    removable: false,
    yes: [],
    no: [],
    needed: 1,
    ...fields,
  };
}

function state(seats: PresenceSeat[], fields: Partial<GameState> = {}) {
  return {
    seat: 0,
    presence: { away_after: 120, seats, received: Date.now() },
    voteRefusal: null,
    ...fields,
  } as GameState;
}

const names = ["ada", "bob", "cara"];
const name = (seat: number) => names[seat] ?? "someone";

describe("away players at a human table", () => {
  it("shows nothing while everyone is here, and away times in words", () => {
    const { container } = render(
      <AwayPlayers
        state={state([seat({ seat: 0 }), seat({ seat: 1 })])}
        name={name}
        onVote={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect([awayFor(45), awayFor(130), awayFor(3700)]).toEqual([
      "45 s",
      "2 min",
      "1 h 1 min",
    ]);
  });

  it("says who is away, and offers the vote once they may be removed", () => {
    const onVote = vi.fn();
    const { rerender } = render(
      <AwayPlayers
        state={state([
          seat({ seat: 0 }),
          seat({ seat: 1, connected: false, away_seconds: 40 }),
        ])}
        name={name}
        onVote={onVote}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("bob is away · 40 s");
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByText("After 2 min away, you may vote to remove bob."),
    ).toBeInTheDocument();

    rerender(
      <AwayPlayers
        state={state([
          seat({ seat: 0 }),
          seat({
            seat: 1,
            connected: false,
            away_seconds: 125,
            removable: true,
            yes: [2],
            needed: 2,
          }),
          seat({ seat: 2 }),
        ])}
        name={name}
        onVote={onVote}
      />,
    );
    expect(screen.getByText(/1 of 2 votes to remove/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Vote to remove bob" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep waiting" }));
    expect(onVote.mock.calls).toEqual([
      [1, true],
      [1, false],
    ]);
  });

  it("shows your own vote, and why one was refused", () => {
    render(
      <AwayPlayers
        state={state(
          [
            seat({ seat: 0 }),
            seat({
              seat: 1,
              connected: false,
              away_seconds: 200,
              removable: true,
              yes: [0],
              needed: 2,
            }),
          ],
          { voteRefusal: "That player is not away." },
        )}
        name={name}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByText(/you voted to remove/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Vote to remove bob" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That player is not away.",
    );
  });

  it("tells a removed player, and lets no one out of the game or watching vote", () => {
    const away = seat({
      seat: 1,
      connected: false,
      away_seconds: 300,
      removable: true,
    });
    const { rerender } = render(
      <AwayPlayers
        state={state([seat({ seat: 0, left: "removed" }), away])}
        name={name}
        onVote={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The other players removed you from this game while you were away.",
    );
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <AwayPlayers
        state={state(
          [seat({ seat: 0 }), away, seat({ seat: 2, left: "conceded" })],
          {
            seat: null,
          },
        )}
        name={name}
        onVote={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("cara conceded.")).toBeInTheDocument();
  });
});
