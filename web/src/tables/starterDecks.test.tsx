import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, openDialogs, reply } from "../decks/fixtures";
import {
  StarterOfferFields,
  StarterReveal,
  buyStarter,
  revealOf,
  starterFormat,
} from "./starterDecks";
import { boughtDeck, offer, offersOf } from "./starterFixtures";

// The pack's reveal has its own tests (shop/PackOpening.test.tsx); here it only takes up room.
vi.mock("../shop/PackOpening", () => ({
  PackOpening: ({
    doneLabel,
    onDone,
  }: {
    doneLabel: string;
    onDone: () => void;
  }) => <button onClick={onDone}>{doneLabel}</button>,
}));

beforeEach(() => openDialogs());
afterEach(() => vi.restoreAllMocks());

describe("a starter deck bought at the table (v1.0.0)", () => {
  it("is offered in Legacy and Commander alone", () => {
    expect(starterFormat("legacy")).toBe(true);
    expect(starterFormat("commander")).toBe(true);
    expect(starterFormat("two_headed_giant")).toBe(false);
    expect(starterFormat("kings_table")).toBe(false);
  });

  it("shows Leng's decks with their prices, and greys one the account cannot afford", () => {
    const chose = vi.fn();
    render(
      <StarterOfferFields
        offers={offersOf()}
        format="commander"
        chosen="starter_red"
        onChoose={chose}
        name="offers"
      />,
    );
    expect(screen.getByText("You have 600 tokens.")).toBeInTheDocument();
    const group = within(
      screen.getByRole("group", { name: "Leng's starter decks, at his price" }),
    );
    expect(
      group.getByRole("radio", { name: /^Red Test · 500 tokens/ }),
    ).toBeChecked();
    // One the account owns is bought again, and says so.
    const blue = group.getByRole("radio", { name: /^Blue Test · 250 tokens/ });
    expect(blue.closest("label")).toHaveTextContent(
      "you own one: this buys another",
    );
    blue.click();
    expect(chose).toHaveBeenCalledWith("starter_blue");
    const karlach = group.getByRole("radio", { name: /^Karlach Test/ });
    expect(karlach).toBeDisabled();
    expect(karlach.closest("label")).toHaveTextContent("more than you have");
  });

  it("says what the account lacks for the cheapest deck, and the week's sale", () => {
    render(
      <StarterOfferFields
        offers={offersOf({
          format: "legacy",
          balance: 100,
          short: 204,
          offers: [
            offer({
              id: "product-1",
              format: "legacy",
              title: "Tempest Starter Deck",
              detail: "TMP · 60 cards",
              price: 304,
              list_price: 380,
              on_sale: true,
              affordable: false,
            }),
          ],
        })}
        format="legacy"
        chosen=""
        onChoose={() => undefined}
        name="offers"
      />,
    );
    expect(
      screen.getByText(
        "You have 100 tokens. You need 204 tokens more to buy the cheapest deck on offer, so you cannot sit down yet.",
      ),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("radio", { name: /^Tempest Starter Deck · 304 tokens/ })
        .closest("label"),
    ).toHaveTextContent(
      "TMP · 60 cards · this week's sale (380 tokens otherwise)",
    );
  });

  it("says so while Leng is asked, and when his shelf is empty", () => {
    const { rerender } = render(
      <StarterOfferFields
        offers={undefined}
        format="legacy"
        chosen=""
        onChoose={() => undefined}
        name="offers"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Asking Leng");
    rerender(
      <StarterOfferFields
        offers={offersOf({ format: "legacy", offers: [] })}
        format="legacy"
        chosen=""
        onChoose={() => undefined}
        name="offers"
      />,
    );
    expect(
      screen.getByText("Leng has no Legacy starter deck on his shelf now."),
    ).toBeInTheDocument();
  });

  it("buys with the key it is given, and says in words what was refused", async () => {
    const api = mockApi();
    api.on(
      "POST /api/v1/starter-decks/purchases",
      () => reply(201, boughtDeck()),
      () => reply(409, { code: "insufficient_tokens", message: "Not enough." }),
    );
    expect(await buyStarter(offer(), "key-1")).toMatchObject({
      deck_id: "00000000-0000-4000-8000-00000000d001",
    });
    expect(api.calls[0]!.options).toMatchObject({
      body: { format: "commander", offer: "starter_red", key: "key-1" },
    });
    expect(typeof (await buyStarter(offer(), "key-2"))).toBe("string");
  });

  it("reveals a Commander starter's own cards, and a Legacy product's opening", async () => {
    const api = mockApi();
    const card = { position: 0, name: "Mountain" };
    const commander = await revealOf(
      offer(),
      boughtDeck({ cards: [card] as never }),
    );
    expect(commander).toMatchObject({
      product: { name: "Red Test", kind: "starter" },
      cards: [card],
    });
    // A retry reveals nothing again.
    expect(await revealOf(offer(), boughtDeck())).toBeUndefined();
    api.on("GET /api/v1/shop/openings/{opening_id}", () =>
      reply(200, { id: "opening-1", cards: [card] }),
    );
    expect(
      await revealOf(offer(), boughtDeck({ opening_id: "opening-1" })),
    ).toMatchObject({ id: "opening-1" });
    expect(api.calls[0]!.options).toMatchObject({
      params: { path: { opening_id: "opening-1" } },
    });
  });

  it("can be skipped, and ends once however it is closed", async () => {
    const done = vi.fn();
    render(
      <StarterReveal
        opening={{ id: "opening-1" } as never}
        title="Red Test"
        doneLabel="Start Game"
        onDone={done}
      />,
    );
    const dialog = screen.getByRole("dialog", {
      name: "Red Test: your deck",
      hidden: true,
    });
    await act(async () =>
      within(dialog)
        .getByRole("button", { name: "Skip the reveal", hidden: true })
        .click(),
    );
    await act(async () =>
      within(dialog)
        .getByRole("button", { name: "Start Game", hidden: true })
        .click(),
    );
    expect(done).toHaveBeenCalledTimes(1);
  });
});
