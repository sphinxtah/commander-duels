import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardImage } from "../catalog/CardViews";
import type { CardSummary } from "../catalog/catalog";
import { CardFace } from "../shop/PackOpening";
import type { PulledCard } from "../shop/shop";
import { RetryingImage } from "./RetryingImage";

// The owner's report (v0.4.4): opening a pack of new cards, or paging the Cards list, some
// pictures never came; the server had refused them while it fetched the others, and these
// pictures gave up at the first failure. They are now tried again, as the table's faces are.

function answering(status: number, code: string, retryAfter?: number) {
  const fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(
      retryAfter ? { "Retry-After": String(retryAfter) } : {},
    ),
    json: async () => ({ code }),
    blob: async () => new Blob(),
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const image = (container: HTMLElement) => container.querySelector("img");

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pulled = {
  position: 0,
  printing_id: "p-1",
  name: "Engine Rat",
  mana_cost: "{B}",
  type_line: "Creature — Zombie Rat",
  rarity: "common",
  finish: "nonfoil",
  faces: 0,
} as unknown as PulledCard;

const summary = {
  name: "Engine Rat",
  mana_cost: "{B}",
  type_line: "Creature — Zombie Rat",
  oracle_text: "Deathtouch",
  power: "1",
  toughness: "1",
  faces: [],
  image: { printing_id: "p-1", faces: 0 },
  custom_image: null,
} as unknown as CardSummary;

describe("card pictures outside the table", () => {
  it("try a pack's card again after the server asked to wait", async () => {
    answering(429, "card_images_busy", 3);
    const face = render(<CardFace card={pulled} />);
    const first = image(face.container)!;
    expect(first).toHaveAttribute(
      "src",
      "/api/v1/card-images/printings/p-1?size=normal",
    );
    fireEvent.error(first);
    expect(image(face.container)).toBeNull();
    await wait(2_999);
    expect(image(face.container)).toBeNull();
    await wait(1);
    const again = image(face.container)!;
    expect(again).not.toBe(first);
    fireEvent.load(again);
    expect(face.container.firstElementChild).toHaveAttribute(
      "data-loaded",
      "true",
    );
  });

  it("try a catalog card again, and start over for another printing", async () => {
    answering(503, "card_images_unavailable");
    const card = render(<CardImage card={summary} />);
    fireEvent.error(image(card.container)!);
    expect(image(card.container)).toBeNull();
    await wait(2_000);
    expect(image(card.container)).not.toBeNull();

    fireEvent.error(image(card.container)!);
    card.rerender(<CardImage card={summary} printingId="p-2" />);
    expect(image(card.container)).toHaveAttribute(
      "src",
      "/api/v1/card-images/printings/p-2?size=normal",
    );
    // The first printing's retry, still pending, changes nothing for the second.
    await wait(10_000);
    expect(image(card.container)).toHaveAttribute(
      "src",
      "/api/v1/card-images/printings/p-2?size=normal",
    );
  });

  it("keep the text frame for a printing the server has no image for", async () => {
    const fetch = answering(404, "card_image_missing");
    const card = render(<CardImage card={summary} printingId="p-404" />);
    fireEvent.error(image(card.container)!);
    await wait(60_000);
    expect(image(card.container)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(card.container.textContent).toContain("Engine Rat");
  });

  it("show their fallback while waiting to try again", async () => {
    answering(503, "card_images_unavailable");
    const deck = render(
      <RetryingImage
        src="/api/v1/card-images/printings/p-3?size=normal"
        fallback={<span>Atraxa</span>}
      />,
    );
    fireEvent.error(image(deck.container)!);
    expect(deck.container.textContent).toBe("Atraxa");
    await wait(2_000);
    expect(image(deck.container)).not.toBeNull();
    expect(deck.container.textContent).toBe("");
  });

  it("ask a busy server again for as long as the picture is shown (v0.6.5)", async () => {
    const fetch = answering(429, "card_images_busy", 1);
    const card = render(<CardImage card={summary} printingId="p-busy" />);
    // Well past the RETRIES other failures get: a big library's pictures queue for their turn.
    for (let tries = 0; tries < 8; tries += 1) {
      fireEvent.error(image(card.container)!);
      await wait(75_000);
      expect(image(card.container)).not.toBeNull();
    }
    expect(fetch).toHaveBeenCalledTimes(8);
    fireEvent.load(image(card.container)!);
    expect(card.container.firstElementChild).toHaveAttribute(
      "data-loaded",
      "true",
    );
  });
});
