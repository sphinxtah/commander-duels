import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TABLE_SETTINGS,
  TABLE_SETTINGS_KEY,
} from "../../game/table/types";
import {
  createMenuMusic,
  type MenuMusic,
  type MenuMusicElement,
} from "./menuMusic";
import { MENU_MUSIC_KEY, readMenuMusic } from "./menuMusicSettings";
import { MusicBox } from "./MusicBox";

// The floating music box (v0.7.3) over a player on a stand-in <audio>.

class FakeAudio implements MenuMusicElement {
  src = "";
  preload = "auto";
  volume = 1;
  currentTime = 0;
  paused = true;
  plays = 0;
  private listeners = new Map<string, Set<() => void>>();
  play(): Promise<void> {
    this.plays += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  end(): void {
    this.paused = true;
    for (const listener of this.listeners.get("ended") ?? []) listener();
  }
}

const manifest = {
  tracks: [
    { file: "01-a.mp3", title: "Heavy Is the Crown", artist: "Linkin Park" },
    { file: "02-b.mp3", title: "Enemy", artist: "Imagine Dragons ft. JID" },
    { file: "03-c.mp3", title: "Golden", artist: "HUNTRIX" },
  ],
};

async function settle() {
  for (let i = 0; i < 8; i += 1) await act(() => Promise.resolve());
}

describe("the music box", () => {
  let audio: FakeAudio;
  let player: MenuMusic;
  let unmount: () => void;

  beforeEach(() => {
    audio = new FakeAudio();
  });
  afterEach(() => {
    player?.dispose();
  });

  async function box(
    value: unknown = manifest,
    options: { ok?: boolean; random?: () => number } = {},
  ) {
    player = createMenuMusic({
      element: () => audio,
      fetch: async () => ({ ok: options.ok ?? true, json: async () => value }),
      random: options.random ?? (() => 0.999),
    });
    ({ unmount } = render(<MusicBox player={player} />));
    await settle();
  }

  it("draws nothing without a manifest", async () => {
    await box(null, { ok: false });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(audio.plays).toBe(0);
  });

  it("is a pill with the song's name and Pause, that opens into the player", async () => {
    localStorage.setItem(MENU_MUSIC_KEY, JSON.stringify({ shuffle: false }));
    await box();
    const aside = screen.getByRole("complementary", { name: "Music player" });
    expect(audio.plays).toBe(1);
    expect(
      within(aside).getByRole("button", {
        name: "Music: Heavy Is the Crown — Linkin Park. Open the player",
      }),
    ).toBeInTheDocument();
    expect(within(aside).queryByRole("list", { name: "Songs" })).toBeNull();
    fireEvent.click(
      within(aside).getByRole("button", { name: /Open the player/ }),
    );
    expect(readMenuMusic().open).toBe(true);
    const list = screen.getByRole("list", { name: "Songs" });
    const songs = within(list).getAllByRole("listitem");
    expect(songs).toHaveLength(3);
    expect(songs[0]).toHaveAttribute("aria-current", "true");
    expect(songs[0]).toHaveTextContent("Heavy Is the Crown");
    expect(songs[0]).toHaveTextContent("Linkin Park");
    expect(screen.getByRole("status")).toHaveTextContent(
      /^Now playing\s+Heavy Is the Crown\s+Linkin Park$/,
    );
    // The song is remembered for the next visit.
    expect(readMenuMusic().track).toBe("01-a.mp3");
    fireEvent.click(
      screen.getByRole("button", { name: "Fold the music player" }),
    );
    expect(readMenuMusic().open).toBe(false);
    expect(screen.queryByRole("list", { name: "Songs" })).toBeNull();
  });

  it("pauses and plays, and stays paused across a reload", async () => {
    localStorage.setItem(
      MENU_MUSIC_KEY,
      JSON.stringify({ shuffle: false, open: true }),
    );
    await box();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(audio.paused).toBe(true);
    expect(readMenuMusic().paused).toBe(true);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    unmount();
    player.dispose();
    audio = new FakeAudio();
    await box();
    expect(audio.plays).toBe(0);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await settle();
    expect(audio.paused).toBe(false);
    expect(readMenuMusic().paused).toBe(false);
    expect(screen.getByText("Now playing")).toBeInTheDocument();
  });

  it("moves between songs, by the buttons and by choosing one", async () => {
    localStorage.setItem(
      MENU_MUSIC_KEY,
      JSON.stringify({ shuffle: false, open: true }),
    );
    await box();
    fireEvent.click(screen.getByRole("button", { name: "Next song" }));
    expect(screen.getByRole("status")).toHaveTextContent("Enemy");
    expect(audio.src).toBe("/music/02-b.mp3");
    fireEvent.click(screen.getByRole("button", { name: "Previous song" }));
    expect(screen.getByRole("status")).toHaveTextContent("Heavy Is the Crown");
    fireEvent.click(
      screen.getByRole("button", { name: "Play Golden — HUNTRIX" }),
    );
    await settle();
    expect(audio.src).toBe("/music/03-c.mp3");
    expect(readMenuMusic().track).toBe("03-c.mp3");
    const songs = within(
      screen.getByRole("list", { name: "Songs" }),
    ).getAllByRole("listitem");
    expect(songs[2]).toHaveAttribute("aria-current", "true");
    expect(songs[0]).not.toHaveAttribute("aria-current");
    // A song chosen while paused plays.
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Play Enemy — Imagine Dragons ft. JID",
      }),
    );
    await settle();
    expect(audio.paused).toBe(false);
    expect(readMenuMusic().paused).toBe(false);
    // The song's end moves on by itself.
    act(() => audio.end());
    await settle();
    expect(audio.src).toBe("/music/03-c.mp3");
  });

  it("unticks songs to skip them, and keeps the last one", async () => {
    localStorage.setItem(
      MENU_MUSIC_KEY,
      JSON.stringify({ shuffle: false, open: true }),
    );
    await box();
    const ticks = screen.getAllByRole("checkbox", { name: /^Include / });
    expect(ticks).toHaveLength(3);
    for (const tick of ticks) expect(tick).toBeChecked();
    // The song playing is unticked: the next one plays.
    fireEvent.click(ticks[0]);
    await settle();
    expect(readMenuMusic().excluded).toEqual(["01-a.mp3"]);
    expect(ticks[0]).not.toBeChecked();
    expect(audio.src).toBe("/music/02-b.mp3");
    fireEvent.click(ticks[2]);
    await settle();
    expect(readMenuMusic().excluded).toEqual(["01-a.mp3", "03-c.mp3"]);
    // One song left: its tick is disabled, and a click changes nothing.
    expect(ticks[1]).toBeDisabled();
    fireEvent.click(ticks[1]);
    expect(readMenuMusic().excluded).toEqual(["01-a.mp3", "03-c.mp3"]);
    fireEvent.click(screen.getByRole("button", { name: "Next song" }));
    expect(audio.src).toBe("/music/02-b.mp3");
    // Ticked again, Golden is back in order.
    fireEvent.click(ticks[2]);
    await settle();
    expect(readMenuMusic().excluded).toEqual(["01-a.mp3"]);
    expect(ticks[1]).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Next song" }));
    expect(audio.src).toBe("/music/03-c.mp3");
  });

  it("toggles shuffle, the volume and the mute, and names the all-sound mute", async () => {
    localStorage.setItem(MENU_MUSIC_KEY, JSON.stringify({ open: true }));
    await box();
    const shuffle = screen.getByRole("button", { name: "Shuffle" });
    expect(shuffle).toHaveAttribute("aria-pressed", "true");
    expect(shuffle).toHaveTextContent("Shuffle");
    fireEvent.click(shuffle);
    expect(shuffle).toHaveAttribute("aria-pressed", "false");
    expect(shuffle).toHaveTextContent("In order");
    expect(readMenuMusic().shuffle).toBe(false);
    const volume = screen.getByRole<HTMLInputElement>("slider", {
      name: "Music volume",
    });
    expect(volume.value).toBe("50");
    fireEvent.change(volume, { target: { value: "80" } });
    expect(readMenuMusic().volume).toBe(80);
    expect(volume.value).toBe("80");
    const mute = screen.getByRole("button", { name: "Mute the music" });
    fireEvent.click(mute);
    expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(readMenuMusic().muted).toBe(true);
    expect(audio.paused).toBe(true);
    expect(screen.getByText("Muted")).toBeInTheDocument();
    fireEvent.click(mute);
    await settle();
    expect(audio.paused).toBe(false);
    expect(screen.getByText("Now playing")).toBeInTheDocument();
    // Settings › Mute all sound silences it too, and the box says where.
    act(() => {
      localStorage.setItem(
        TABLE_SETTINGS_KEY,
        JSON.stringify({ ...DEFAULT_TABLE_SETTINGS, muted: true }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: TABLE_SETTINGS_KEY }),
      );
    });
    expect(audio.paused).toBe(true);
    expect(
      screen.getByText("All sound is muted in Settings"),
    ).toBeInTheDocument();
    expect(mute).toHaveAttribute("aria-pressed", "false");
  });

  it("says what to do while the browser waits for a gesture", async () => {
    audio.play = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("gesture first"), { name: "NotAllowedError" }),
      ),
    );
    localStorage.setItem(MENU_MUSIC_KEY, JSON.stringify({ open: true }));
    await box();
    expect(
      screen.getByText("Click anywhere to start the music"),
    ).toBeInTheDocument();
    audio.play = () => {
      audio.paused = false;
      return Promise.resolve();
    };
    fireEvent.pointerDown(document.body);
    await settle();
    expect(screen.getByText("Now playing")).toBeInTheDocument();
  });

  it("pauses the song as it unmounts, for a game, and resumes it when mounted again", async () => {
    localStorage.setItem(MENU_MUSIC_KEY, JSON.stringify({ shuffle: false }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await box();
    expect(audio.paused).toBe(false);
    audio.currentTime = 30;
    unmount();
    expect(player.snapshot.state).toBe("idle");
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(audio.paused).toBe(true);
    render(<MusicBox player={player} />);
    await settle();
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(30);
    expect(audio.src).toBe("/music/01-a.mp3");
  });
});
