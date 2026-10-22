import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ImportDialog } from "./ImportDialog";
import {
  card,
  entry,
  mockApi,
  openDialogs,
  reply,
  validation,
} from "./fixtures";

beforeAll(openDialogs);
afterEach(() => vi.restoreAllMocks());

const bolt = card("Lightning Bolt");

describe("importing a deck list", () => {
  it("leaves out a line naming a card not in the game, and says why (v0.4.5)", async () => {
    const api = mockApi();
    api.on("POST /api/v1/decks/import/preview", () =>
      reply(200, {
        format: "legacy",
        title: null,
        lines: [
          {
            line: 1,
            text: "4 Lightning Bolt",
            quantity: 4,
            location: "main",
            name: "Lightning Bolt",
            status: "resolved",
            card_id: bolt.id,
            printing_id: null,
            candidates: [],
            reason: null,
          },
          {
            line: 2,
            text: "1 Temple of Khonshu",
            quantity: 1,
            location: "main",
            name: "Temple of Khonshu",
            status: "unavailable",
            card_id: null,
            printing_id: null,
            candidates: [],
            reason: "The game engine has no implementation of this card yet.",
          },
        ],
        entries: [entry(bolt, 4)],
        unresolved: 0,
        ambiguous: 0,
        unavailable: 1,
        validation: validation(),
        cards: { [bolt.id]: bolt },
      }),
    );
    render(<ImportDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Deck list"), {
      target: { value: "4 Lightning Bolt\n1 Temple of Khonshu" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      await screen.findByRole("heading", {
        name: "2 lines · 0 not found · 0 with several matches · 1 not in the game",
      }),
    ).toBeInTheDocument();
    const left = screen.getByRole("list", { name: "Not in the game" });
    expect(left).toHaveTextContent(
      "Line 2: 1 Temple of Khonshu names Temple of Khonshu, which is not in the game and is left out. The game engine has no implementation of this card yet.",
    );
    // Nothing to choose for it: it is no line to resolve.
    expect(within(left).queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText("Card for line 2")).toBeNull();
  });
});
