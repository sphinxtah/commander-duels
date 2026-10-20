import { describe, expect, it } from "vitest";
import { cachesToDelete, liveGameHeld, routeRequest } from "./swRules";

const origin = "https://duels.example";
const get = (path: string, mode = "cors") => ({
  method: "GET",
  url: path.startsWith("http") ? path : `${origin}${path}`,
  mode,
});

describe("the service worker's routes", () => {
  it("passes the API, whatever the method or mode", () => {
    for (const path of [
      "/api",
      "/api/v1/me",
      "/api/v1/games/1/events",
      "/api/v1/card-images?name=Island&size=png",
    ]) {
      expect(routeRequest(get(path), origin)).toBe("pass");
      expect(routeRequest(get(path, "navigate"), origin)).toBe("pass");
    }
  });

  it("passes anything but a GET", () => {
    for (const method of ["POST", "PATCH", "DELETE", "PUT", "HEAD"])
      for (const path of ["/", "/assets/index-abc.js", "/brand/mark.webp"])
        expect(routeRequest({ ...get(path, "navigate"), method }, origin)).toBe(
          "pass",
        );
  });

  it("passes other origins, Google's sign-in among them", () => {
    for (const url of [
      "https://accounts.google.com/gsi/client",
      "https://accounts.google.com/gsi/button",
      "https://cards.scryfall.io/large/front/a.jpg",
      "http://duels.example/assets/index-abc.js",
    ]) {
      expect(routeRequest(get(url), origin)).toBe("pass");
      expect(routeRequest(get(url, "navigate"), origin)).toBe("pass");
    }
  });

  it("passes the worker's own script and anything it does not know", () => {
    expect(routeRequest(get("/sw.js"), origin)).toBe("pass");
    expect(routeRequest(get("/table-lab.html"), origin)).toBe("pass");
    expect(routeRequest(get("/favicon.ico"), origin)).toBe("pass");
    expect(
      routeRequest({ method: "GET", url: "not a url", mode: "cors" }, origin),
    ).toBe("pass");
  });

  it("takes page loads, build files and brand images", () => {
    expect(routeRequest(get("/", "navigate"), origin)).toBe("shell");
    expect(routeRequest(get("/?utm=1#play", "navigate"), origin)).toBe("shell");
    expect(routeRequest(get("/assets/index-abc.js"), origin)).toBe("asset");
    expect(routeRequest(get("/assets/scene-def.js", "no-cors"), origin)).toBe(
      "asset",
    );
    expect(routeRequest(get("/brand/icon-192.png"), origin)).toBe("brand");
    expect(routeRequest(get("/manifest.webmanifest"), origin)).toBe("brand");
  });
});

describe("the caches a new version keeps", () => {
  it("keeps itself and the version before it, and nothing that is not ours is touched", () => {
    const keys = [
      "someone-else",
      "cd-shell-0.2.0+aaa",
      "cd-shell-0.3.0+bbb",
      "cd-shell-0.3.0+ccc",
      "cd-shell-0.3.0+ddd",
    ];
    expect(cachesToDelete(keys, "cd-shell-0.3.0+ddd")).toEqual([
      "cd-shell-0.2.0+aaa",
      "cd-shell-0.3.0+bbb",
    ]);
    expect(cachesToDelete(["cd-shell-1"], "cd-shell-1")).toEqual([]);
    expect(cachesToDelete(["cd-shell-1", "cd-shell-2"], "cd-shell-2")).toEqual(
      [],
    );
  });

  it("knows a live game's lock by its prefix", () => {
    expect(liveGameHeld([])).toBe(false);
    expect(liveGameHeld([{ name: "other" }, {}])).toBe(false);
    expect(liveGameHeld([{ name: "cd-live-game:abc" }])).toBe(true);
  });
});
