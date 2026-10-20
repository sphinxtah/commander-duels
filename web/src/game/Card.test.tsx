import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardFace, cardImageUrl } from "./Card";
import type { CardView } from "./types";

function card(name: string): CardView {
  return {
    id: name,
    hidden: false,
    name,
    mana_cost: null,
    type_line: "Artifact",
    power: null,
    toughness: null,
    rules: [],
  };
}

/** The server's answer when the page asks why an image failed. */
function answering(status: number, code: string, retryAfter?: number) {
  const blob = vi.fn(async () => new Blob());
  const fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(
      retryAfter ? { "Retry-After": String(retryAfter) } : {},
    ),
    json: async () => ({ code }),
    blob,
  }));
  vi.stubGlobal("fetch", fetch);
  return Object.assign(fetch, { blob });
}

const image = (container: HTMLElement) => container.querySelector("img");

beforeEach(() => {
  vi.useFakeTimers();
  // No spread, so the waits below are exact; one test sets its own.
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("card images", () => {
  it("retry after a transient failure and are not remembered as missing", async () => {
    const fetch = answering(503, "card_images_unavailable");
    const first = render(<CardFace card={card("Sol Ring")} />);
    fireEvent.error(image(first.container)!);
    expect(image(first.container)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetch).toHaveBeenCalledWith(
      cardImageUrl("Sol Ring", "normal"),
      expect.anything(),
    );
    expect(image(first.container)).toHaveAttribute(
      "src",
      cardImageUrl("Sol Ring", "normal"),
    );
    first.unmount();

    // A later card of the same name, in either size, asks for its image again.
    const again = render(
      <>
        <CardFace card={card("Sol Ring")} />
        <CardFace card={card("Sol Ring")} size="large" />
      </>,
    );
    expect(again.container.querySelectorAll("img")).toHaveLength(2);
  });

  it("wait as long as the server's Retry-After before asking again", async () => {
    answering(429, "card_images_busy", 30);
    const face = render(<CardFace card={card("Mox Pearl")} />);
    fireEvent.error(image(face.container)!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(image(face.container)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(image(face.container)).not.toBeNull();
  });

  it("spread their retries, so a board of failed cards does not ask at once", async () => {
    vi.mocked(Math.random).mockReturnValue(0.99);
    answering(503, "card_images_unavailable");
    const face = render(<CardFace card={card("Mox Jet")} />);
    fireEvent.error(image(face.container)!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(image(face.container)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(image(face.container)).not.toBeNull();
  });

  it("ask again at once when the server has the image by then", async () => {
    const fetch = answering(200, "");
    const face = render(<CardFace card={card("Mox Ruby")} />);
    fireEvent.error(image(face.container)!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The body is read to the end, so the new <img> can draw it from the browser's cache.
    expect(fetch.blob).toHaveBeenCalledTimes(1);
    expect(image(face.container)).toHaveAttribute(
      "src",
      cardImageUrl("Mox Ruby", "normal"),
    );
  });

  it("stop retrying after a few attempts", async () => {
    const fetch = answering(503, "card_images_unavailable");
    const face = render(<CardFace card={card("Black Lotus")} />);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const shown = image(face.container);
      if (shown) fireEvent.error(shown);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(image(face.container)).toBeNull();
  });

  it("remember a name the server has no image for, for a while", async () => {
    answering(404, "card_image_missing");
    const first = render(<CardFace card={card("Goblin Token")} />);
    fireEvent.error(image(first.container)!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(image(first.container)).toBeNull();
    first.unmount();

    const again = render(
      <>
        <CardFace card={card("Goblin Token")} />
        <CardFace card={card("Goblin Token")} size="large" />
      </>,
    );
    expect(again.container.querySelector("img")).toBeNull();
    again.unmount();

    // The server asks Scryfall again after a week; the page asks the server after an hour.
    vi.setSystemTime(Date.now() + 61 * 60_000);
    const later = render(<CardFace card={card("Goblin Token")} />);
    expect(image(later.container)).not.toBeNull();
  });
});
