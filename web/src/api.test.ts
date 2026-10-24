import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_REQUESTS,
  answered,
  backgroundRead,
  forgetRequests,
  onboarding,
  recentRequests,
  describe as words,
  type Me,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  forgetRequests();
});

describe("the latest requests, for a problem report (v0.4.1)", () => {
  it("keeps each request's method, path, status and ID, never its query or body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 201,
            headers: { "X-Request-ID": "6f1d2c3b-aaaa-4bbb-8ccc-0123456789ab" },
          }),
      ),
    );
    await answered(
      new Request("http://localhost/api/v1/cards/search?q=secret+words", {
        method: "POST",
        body: JSON.stringify({ private: "body" }),
      }),
    );
    expect(recentRequests()).toEqual([
      {
        method: "POST",
        path: "/api/v1/cards/search",
        status: 201,
        request_id: "6f1d2c3b-aaaa-4bbb-8ccc-0123456789ab",
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
    ]);
    expect(JSON.stringify(recentRequests())).not.toMatch(/secret|private/);
  });

  it("notes a request that got no answer, and an ID it does not trust, as none", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce(
          new Response(null, {
            status: 502,
            headers: { "X-Request-ID": "<script>" },
          }),
        ),
    );
    await answered(new Request("http://localhost/api/v1/games"));
    await answered(new Request("http://localhost/api/v1/me"));
    expect(
      recentRequests().map(({ path, status, request_id }) => ({
        path,
        status,
        request_id,
      })),
    ).toEqual([
      { path: "/api/v1/games", status: 0, request_id: null },
      { path: "/api/v1/me", status: 502, request_id: null },
    ]);
  });

  it("keeps only the latest, leaves out the minute's counts, and hands out copies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    for (let index = 0; index < RECENT_REQUESTS + 5; index += 1)
      await answered(new Request(`http://localhost/api/v1/decks/${index}`));
    await answered(new Request("http://localhost/api/v1/admin/counts"));
    await answered(new Request("http://localhost/brand/mark.webp"));
    const kept = recentRequests();
    expect(kept).toHaveLength(RECENT_REQUESTS);
    expect(kept[0]!.path).toBe("/api/v1/decks/5");
    expect(kept.at(-1)!.path).toBe(`/api/v1/decks/${RECENT_REQUESTS + 4}`);
    kept[0]!.path = "/changed";
    expect(recentRequests()[0]!.path).toBe("/api/v1/decks/5");
  });

  it("leaves out a read the page made on its own (v0.5.1)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await answered(
      new Request("http://localhost/api/v1/friends", backgroundRead(true)),
    );
    await answered(
      new Request(
        "http://localhost/api/v1/conversations",
        backgroundRead(false),
      ),
    );
    expect(backgroundRead(true)).toEqual({ headers: { "X-Background": "1" } });
    expect(recentRequests().map((each) => each.path)).toEqual([
      "/api/v1/conversations",
    ]);
  });
});

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

describe("onboarding", () => {
  it("lasts through the handle and the starter decks (v0.3.1)", () => {
    const at = (step: Me["onboarding"]) =>
      onboarding({ onboarding: step } as Me);
    expect(at("handle")).toBe(true);
    expect(at("starters")).toBe(true);
    expect(at("complete")).toBe(false);
  });
});
