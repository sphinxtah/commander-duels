import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RETRIES,
  backoff,
  cardImageUrl,
  fetchCardImage,
  imageSizeFor,
  knownMissing,
  rememberMissing,
} from "./images";

/** A fetch that answers each call with the next status in `statuses` (the last one repeats). */
function serving(statuses: (number | "error")[], code = "card_images_busy") {
  let call = 0;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const status = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    if (status === "error") throw new TypeError("Failed to fetch");
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => ({ code }),
      blob: async () => new Blob(["image"], { type: "image/jpeg" }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
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

describe("image addresses and sizes", () => {
  it("name the card and the size, png included", () => {
    expect(cardImageUrl("Jace, the Mind Sculptor", "png")).toBe(
      "/api/v1/card-images?name=Jace%2C%20the%20Mind%20Sculptor&size=png",
    );
    expect(cardImageUrl("Island", "normal")).toBe(
      "/api/v1/card-images?name=Island&size=normal",
    );
  });

  it("choose the smallest size that covers the drawn height", () => {
    expect(imageSizeFor(200)).toBe("normal");
    expect(imageSizeFor(680)).toBe("normal");
    expect(imageSizeFor(681)).toBe("large");
    expect(imageSizeFor(936)).toBe("large");
    expect(imageSizeFor(937)).toBe("png");
  });

  it("back off by doubling up to a minute, never less than Retry-After", () => {
    expect(backoff(0, 0)).toBe(2_000);
    expect(backoff(3, 0)).toBe(16_000);
    expect(backoff(10, 0)).toBe(60_000);
    expect(backoff(0, 30)).toBe(30_000);
    vi.mocked(Math.random).mockReturnValue(0.99);
    expect(backoff(0, 0)).toBeCloseTo(2_495, 0);
  });
});

describe("fetching an image for the table", () => {
  it("returns the image when the server has it", async () => {
    const fetch = serving([200]);
    const blob = await fetchCardImage("Forest", "normal");
    expect(blob).toBeInstanceOf(Blob);
    expect(fetch).toHaveBeenCalledWith(
      cardImageUrl("Forest", "normal"),
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("remembers a name the server has no image for, as CardFace does", async () => {
    const fetch = serving([404], "card_image_missing");
    expect(await fetchCardImage("Soldier Token", "normal")).toBe("missing");
    expect(knownMissing("Soldier Token")).toBe(true);
    // The memory is by name: no size asks again while it lasts.
    expect(await fetchCardImage("Soldier Token", "large")).toBe("missing");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a name already known to be missing", async () => {
    const fetch = serving([200]);
    rememberMissing("Goblin Token");
    expect(await fetchCardImage("Goblin Token", "png")).toBe("missing");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a transient failure with backoff", async () => {
    const fetch = serving([503, "error", 200]);
    const result = fetchCardImage("Mox Sapphire", "normal");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await result).toBeInstanceOf(Blob);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(knownMissing("Mox Sapphire")).toBe(false);
  });

  it("retries a 404 that is not the server's missing answer", async () => {
    serving([404, 200], "not_found");
    const result = fetchCardImage("Mox Emerald", "normal");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBeInstanceOf(Blob);
    expect(knownMissing("Mox Emerald")).toBe(false);
  });

  it("gives up after the same number of retries as CardFace", async () => {
    const fetch = serving([503]);
    const result = fetchCardImage("Time Walk", "normal");
    const settled = result.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await settled).toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(RETRIES + 1);
  });

  it("stops at once when the image is no longer wanted", async () => {
    const fetch = serving([503]);
    const controller = new AbortController();
    const result = fetchCardImage("Ancestral Recall", "normal", {
      signal: controller.signal,
    });
    const settled = result.catch((error: DOMException) => error);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    expect(((await settled) as DOMException).name).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
