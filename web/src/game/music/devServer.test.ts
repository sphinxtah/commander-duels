import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MUSIC_PREFIX,
  byteRange,
  musicFile,
  musicFolder,
} from "../../../plugins/music";
import { GAME_MUSIC_URL } from "./gameMusic";

// The dev server's music folder (web/plugins/music.ts) answers the addresses the player asks for,
// as nginx does on the built site.

describe("the music folder in dev", () => {
  it("serves the track's address, and only plain file names under /music/", () => {
    expect(GAME_MUSIC_URL.startsWith(MUSIC_PREFIX)).toBe(true);
    expect(musicFile(GAME_MUSIC_URL)).toBe("game.mp3");
    expect(musicFile("/music/game.mp3?v=2")).toBe("game.mp3");
    expect(musicFile("/music/")).toBeUndefined();
    expect(musicFile("/music/../VERSION")).toBeUndefined();
    expect(musicFile("/music/sub/track.mp3")).toBeUndefined();
    expect(musicFile("/music/.env")).toBeUndefined();
    expect(musicFile("/music/a%20b.mp3")).toBeUndefined();
    expect(musicFile("/musical.mp3")).toBeUndefined();
    expect(musicFile("/api/v1/music")).toBeUndefined();
  });

  it("reads one byte range as the browser sends it", () => {
    expect(byteRange(undefined, 1000)).toBeNull();
    expect(byteRange("bytes=0-", 1000)).toEqual([0, 999]);
    expect(byteRange("bytes=100-199", 1000)).toEqual([100, 199]);
    expect(byteRange("bytes=900-5000", 1000)).toEqual([900, 999]);
    expect(byteRange("bytes=-100", 1000)).toEqual([900, 999]);
    expect(byteRange("bytes=-5000", 1000)).toEqual([0, 999]);
    expect(byteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(byteRange("bytes=200-100", 1000)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 1000)).toBe("unsatisfiable");
    // Several ranges, or other units, mean the whole file.
    expect(byteRange("bytes=0-1,5-9", 1000)).toBeNull();
    expect(byteRange("items=0-1", 1000)).toBeNull();
    expect(byteRange("bytes=-", 1000)).toBeNull();
  });

  it("is the gitignored folder beside compose.yaml, which nginx serves on the built site", () => {
    const root = resolve(musicFolder(), "..");
    expect(readFileSync(resolve(root, "compose.yaml"), "utf8")).toContain(
      "./music:/usr/share/nginx/html/music:ro",
    );
    expect(readFileSync(resolve(root, ".gitignore"), "utf8")).toMatch(
      /^\/music\/$/m,
    );
    expect(readFileSync(resolve(root, "web/nginx.conf"), "utf8")).toContain(
      "location /music/",
    );
  });
});
