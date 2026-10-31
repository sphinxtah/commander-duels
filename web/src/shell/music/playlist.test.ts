import { describe, expect, it } from "vitest";
import {
  MAX_TRACKS,
  PLAYLIST_URL,
  Queue,
  parsePlaylist,
  trackLabel,
  trackUrl,
} from "./playlist";

// The manifest's reading and the order the songs play in (v0.7.3).

const files = ["01-a.mp3", "02-b.mp3", "03-c.mp3", "04-d.mp3"];

/** A deterministic "random": the values in turn, then zeros. */
function dice(...values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

describe("the playlist manifest", () => {
  it("reads the tracks in order, with their titles and artists", () => {
    expect(
      parsePlaylist({
        tracks: [
          {
            file: "01-Linkin.Park-Heavy.is.the.Crown.mp3",
            title: " Heavy Is the Crown ",
            artist: "Linkin Park",
          },
          {
            file: "19-Hades.II-Coral.Crown.mp3",
            title: "Coral Crown",
            artist: "Hades II",
          },
          { file: "solo.mp3", title: "Solo" },
        ],
      }),
    ).toEqual([
      {
        file: "01-Linkin.Park-Heavy.is.the.Crown.mp3",
        title: "Heavy Is the Crown",
        artist: "Linkin Park",
      },
      {
        file: "19-Hades.II-Coral.Crown.mp3",
        title: "Coral Crown",
        artist: "Hades II",
      },
      { file: "solo.mp3", title: "Solo", artist: "" },
    ]);
  });

  it("is null for anything but a playlist, and leaves out the entries it cannot use", () => {
    expect(parsePlaylist(null)).toBeNull();
    expect(parsePlaylist("tracks")).toBeNull();
    expect(parsePlaylist({ id: "abc", status: "active" })).toBeNull();
    expect(parsePlaylist({ tracks: "none" })).toBeNull();
    expect(parsePlaylist({ tracks: [] })).toEqual([]);
    expect(
      parsePlaylist({
        tracks: [
          null,
          "01-a.mp3",
          { title: "No file" },
          { file: "../VERSION", title: "Up the tree" },
          { file: "sub/track.mp3", title: "In a folder" },
          { file: "20-Lumière.mp3", title: "Not plain ASCII" },
          { file: ".env", title: "A dot file" },
          { file: "01-a.mp3", title: "" },
          { file: "01-a.mp3" },
          { file: "01-a.mp3", title: "A" },
          { file: "01-a.mp3", title: "A again" },
          { file: "02-b.mp3", title: "B", artist: 7 },
        ],
      }),
    ).toEqual([
      { file: "01-a.mp3", title: "A", artist: "" },
      { file: "02-b.mp3", title: "B", artist: "" },
    ]);
  });

  it("stops at the cap", () => {
    const tracks = Array.from({ length: MAX_TRACKS + 5 }, (_, i) => ({
      file: `${i}.mp3`,
      title: `Song ${i}`,
    }));
    expect(parsePlaylist({ tracks })).toHaveLength(MAX_TRACKS);
  });

  it("knows the addresses and the one-line label", () => {
    expect(PLAYLIST_URL).toBe("/music/playlist.json");
    expect(trackUrl("01-a.mp3")).toBe("/music/01-a.mp3");
    expect(trackLabel({ file: "x", title: "Golden", artist: "HUNTRIX" })).toBe(
      "Golden — HUNTRIX",
    );
    expect(trackLabel({ file: "x", title: "Golden", artist: "" })).toBe(
      "Golden",
    );
  });
});

describe("the queue in order", () => {
  it("plays the ticked songs down the manifest, round and round", () => {
    const queue = new Queue();
    queue.setTracks(files);
    expect(queue.now).toBeNull();
    expect(queue.tickedCount).toBe(4);
    expect(queue.start()).toBe("01-a.mp3");
    expect(queue.next()).toBe("02-b.mp3");
    expect(queue.next()).toBe("03-c.mp3");
    expect(queue.next()).toBe("04-d.mp3");
    expect(queue.next()).toBe("01-a.mp3");
    expect(queue.now).toBe("01-a.mp3");
  });

  it("skips unticked songs, and the last ticked song cannot be unticked", () => {
    const queue = new Queue();
    queue.setTracks(files);
    queue.setExcluded(["02-b.mp3", "04-d.mp3", "not-there.mp3"]);
    expect(queue.isTicked("02-b.mp3")).toBe(false);
    expect(queue.isTicked("not-there.mp3")).toBe(false);
    expect(queue.excluded).toEqual(["02-b.mp3", "04-d.mp3"]);
    expect(queue.start()).toBe("01-a.mp3");
    expect(queue.next()).toBe("03-c.mp3");
    expect(queue.next()).toBe("01-a.mp3");
    // Everything out: the first song stays in.
    queue.setExcluded(files);
    expect(queue.tickedCount).toBe(1);
    expect(queue.isTicked("01-a.mp3")).toBe(true);
    expect(queue.next()).toBe("01-a.mp3");
    expect(queue.next()).toBe("01-a.mp3");
  });

  it("goes back through what was heard, then on backwards", () => {
    const queue = new Queue();
    queue.setTracks(files);
    queue.setExcluded(["02-b.mp3"]);
    queue.start(); // a
    queue.next(); // c
    queue.next(); // d
    expect(queue.previous()).toBe("03-c.mp3");
    expect(queue.previous()).toBe("01-a.mp3");
    // Nothing heard before: backwards through the manifest, round the end.
    expect(queue.previous()).toBe("04-d.mp3");
    expect(queue.previous()).toBe("03-c.mp3");
    expect(queue.now).toBe("03-c.mp3");
  });

  it("plays a chosen song whatever its tick, and goes on with the ticked ones", () => {
    const queue = new Queue();
    queue.setTracks(files);
    queue.setExcluded(["03-c.mp3"]);
    queue.start();
    expect(queue.select("03-c.mp3")).toBe(true);
    expect(queue.now).toBe("03-c.mp3");
    expect(queue.isTicked("03-c.mp3")).toBe(false);
    expect(queue.next()).toBe("04-d.mp3");
    expect(queue.select("nope.mp3")).toBe(false);
    expect(queue.now).toBe("04-d.mp3");
  });

  it("keeps the ticks and the current song through a new manifest that still lists them", () => {
    const queue = new Queue();
    queue.setTracks(files);
    queue.setExcluded(["02-b.mp3"]);
    queue.start();
    queue.next(); // c
    queue.setTracks(["03-c.mp3", "02-b.mp3", "05-e.mp3"]);
    expect(queue.now).toBe("03-c.mp3");
    expect(queue.isTicked("02-b.mp3")).toBe(false);
    expect(queue.isTicked("05-e.mp3")).toBe(true);
    expect(queue.next()).toBe("05-e.mp3");
    // A manifest without the current song: nothing is playing until start().
    queue.setTracks(["06-f.mp3"]);
    expect(queue.now).toBeNull();
    expect(queue.start()).toBe("06-f.mp3");
    // An empty one plays nothing.
    queue.setTracks([]);
    expect(queue.start()).toBeNull();
    expect(queue.next()).toBeNull();
    expect(queue.previous()).toBeNull();
  });

  it("applies ticks given before the manifest", () => {
    const queue = new Queue();
    queue.setExcluded(["01-a.mp3"]);
    queue.setTracks(files);
    expect(queue.isTicked("01-a.mp3")).toBe(false);
    expect(queue.start()).toBe("02-b.mp3");
  });
});

describe("the queue shuffled", () => {
  it("plays each ticked song once a round, and no round opens on the song just played", () => {
    // Dice that leave the deal as it is (j = i each time).
    const queue = new Queue(() => 0.999);
    queue.setTracks(files);
    queue.setExcluded(["04-d.mp3"]);
    queue.setShuffle(true);
    expect(queue.shuffled).toBe(true);
    const first = [queue.start(), queue.next(), queue.next()];
    expect([...first].sort()).toEqual(["01-a.mp3", "02-b.mp3", "03-c.mp3"]);
    const second = [queue.next(), queue.next(), queue.next()];
    expect([...second].sort()).toEqual(["01-a.mp3", "02-b.mp3", "03-c.mp3"]);
    expect(second[0]).not.toBe(first[2]);
  });

  it("shuffles with the dice it is given", () => {
    const queue = new Queue(dice(0, 0, 0));
    queue.setTracks(files);
    queue.setShuffle(true);
    // j = 0 at every step: a, b, c, d → d, b, c, a → c, b, d, a → b, c, d, a. The first draw is b.
    expect(queue.start()).toBe("02-b.mp3");
    const round = [queue.now, queue.next(), queue.next(), queue.next()];
    expect([...round].sort()).toEqual(files);
  });

  it("walks back through the songs heard, and a chosen song leaves the round", () => {
    const queue = new Queue(() => 0.999);
    queue.setTracks(files);
    queue.setShuffle(true);
    const a = queue.start()!;
    const b = queue.next()!;
    expect(queue.previous()).toBe(a);
    expect(queue.next()).not.toBe(b);
    // Turning shuffle off goes on in order from the current song.
    queue.setShuffle(false);
    queue.select("02-b.mp3");
    expect(queue.next()).toBe("03-c.mp3");
  });

  it("keeps one ticked song going", () => {
    const queue = new Queue();
    queue.setTracks(files);
    queue.setShuffle(true);
    queue.setExcluded(["01-a.mp3", "02-b.mp3", "03-c.mp3"]);
    expect(queue.start()).toBe("04-d.mp3");
    expect(queue.next()).toBe("04-d.mp3");
    expect(queue.previous()).toBe("04-d.mp3");
  });
});
