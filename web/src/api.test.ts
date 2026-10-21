import { afterEach, describe, expect, it, vi } from "vitest";
import { answered, describe as words } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("the API client's fetch", () => {
  it("passes every answer the service gives through as it is", async () => {
    const reply = new Response("{}", { status: 409 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply));
    expect(await answered(new Request("http://localhost/api/v1/me"))).toBe(
      reply,
    );
  });

  it("turns a request the network never answered into the service's own unavailable answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    const response = await answered(new Request("http://localhost/api/v1/me"));
    expect(response.status).toBe(503);
    const body: unknown = await response.json();
    expect(body).toEqual({
      code: "service_unavailable",
      message: "The application service is unavailable. Try again.",
    });
    // Callers say so in the words they use for any other failure.
    expect(words(body)).toBe(
      "The application service is unavailable. Try again.",
    );
  });
});
