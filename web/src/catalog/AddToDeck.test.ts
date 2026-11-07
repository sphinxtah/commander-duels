import { describe, expect, it } from "vitest";
import { withCopies } from "./AddToDeck";

describe("Add to deck (v0.8.8)", () => {
  const bolt = {
    card_id: "bolt",
    printing_id: "m10",
    quantity: 2,
    location: "main" as const,
  };
  it("adds to the entry of the same card, edition and place", () => {
    expect(
      withCopies([bolt], {
        cardId: "bolt",
        printingId: "m10",
        quantity: 2,
        place: "main",
      }),
    ).toEqual([{ ...bolt, quantity: 4 }]);
  });
  it("adds a new entry for another edition or place, and keeps the others", () => {
    const other = {
      card_id: "ring",
      printing_id: null,
      quantity: 1,
      location: "main" as const,
    };
    expect(
      withCopies([bolt, other], {
        cardId: "bolt",
        printingId: "m10",
        quantity: 1,
        place: "sideboard",
      }),
    ).toEqual([
      bolt,
      other,
      {
        card_id: "bolt",
        printing_id: "m10",
        quantity: 1,
        location: "sideboard",
      },
    ]);
    expect(
      withCopies([bolt], {
        cardId: "bolt",
        printingId: "2xm",
        quantity: 1,
        place: "main",
      }),
    ).toHaveLength(2);
  });
});
