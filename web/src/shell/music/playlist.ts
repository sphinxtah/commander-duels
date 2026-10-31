// The menu playlist (v0.7.3): the owner's songs, played on every page of the app but a game's. Which
// songs there are is the manifest's business, /music/playlist.json, a file beside the tracks in the
// same gitignored music/ folder (locally) or the owner's private web image (the live site). The
// public images have no manifest, so the request answers 404 and the menus stay quiet, with no
// player on screen. The manifest names each track's file, title and artist:
//
//   {"tracks": [{"file": "01-Artist-Title.mp3", "title": "Title", "artist": "Artist"}, …]}
//
// This module is the pure part: reading the manifest, the addresses, and the order the songs play
// in, in the manifest's order or shuffled, skipping the ones the player unticked.

export const PLAYLIST_URL = "/music/playlist.json";
export const MUSIC_PREFIX = "/music/";
/** More than this many tracks in a manifest, and the rest are ignored. */
export const MAX_TRACKS = 200;
/** A file name the music folder serves: one plain name, no folders, nothing to decode
 * (web/plugins/music.ts and the live site's nginx take the same). */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface Track {
  /** The file's name in the music folder, and the track's identity everywhere else. */
  file: string;
  title: string;
  artist: string;
}

/** The manifest read: its tracks in order, or null when the value is not a playlist at all. A bad
 * entry (no file, a file name the folder would not serve, no title, one seen already) is left out
 * rather than spoiling the rest. */
export function parsePlaylist(value: unknown): Track[] | null {
  if (typeof value !== "object" || value === null) return null;
  const list = (value as { tracks?: unknown }).tracks;
  if (!Array.isArray(list)) return null;
  const tracks: Track[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (tracks.length >= MAX_TRACKS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { file, title, artist } = entry as Record<string, unknown>;
    if (typeof file !== "string" || !FILE_NAME.test(file) || seen.has(file))
      continue;
    const name = typeof title === "string" ? title.trim() : "";
    if (!name) continue;
    seen.add(file);
    tracks.push({
      file,
      title: name,
      artist: typeof artist === "string" ? artist.trim() : "",
    });
  }
  return tracks;
}

/** Where a track streams from. */
export function trackUrl(file: string): string {
  return MUSIC_PREFIX + file;
}

/** The track's one line: "Title — Artist", or the title alone. */
export function trackLabel(track: Track): string {
  return track.artist ? `${track.title} — ${track.artist}` : track.title;
}

/**
 * What plays after what. In order, the next ticked track down the manifest, round and round. In
 * shuffle, a round is a random order of the ticked tracks, each once, and the next round is drawn
 * when it runs out, never opening on the song that just ended (when there are two or more).
 * "Previous" walks back through what was heard, in either mode, then on backwards in order.
 */
export class Queue {
  private tracks: string[] = [];
  /** The songs unticked, by file: names not in the manifest are kept but mean nothing. */
  private left = new Set<string>();
  private shuffle = false;
  /** The current round's remaining draws, in shuffle. */
  private round: string[] = [];
  /** What played, latest last; Previous walks it. */
  private history: string[] = [];
  private current: string | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** The manifest's files, in order; the ticks and the current song survive when still listed. */
  setTracks(files: readonly string[]): void {
    this.tracks = [...files];
    const known = new Set(files);
    this.guard();
    this.round = this.round.filter((file) => this.isTicked(file));
    this.history = this.history.filter((file) => known.has(file));
    if (this.current !== null && !known.has(this.current)) this.current = null;
  }

  get files(): readonly string[] {
    return this.tracks;
  }

  get now(): string | null {
    return this.current;
  }

  isTicked(file: string): boolean {
    return this.tracks.includes(file) && !this.left.has(file);
  }

  get tickedCount(): number {
    return this.tickedInOrder().length;
  }

  /** The songs left out, by file, in the manifest's order. */
  get excluded(): string[] {
    return this.tracks.filter((file) => this.left.has(file));
  }

  /** The songs left out, from the settings. A list that would leave nothing keeps the first
   * song, so there is always something to play. */
  setExcluded(files: readonly string[]): void {
    this.left = new Set(files);
    this.guard();
    this.round = this.round.filter((file) => this.isTicked(file));
  }

  /** At least one song stays ticked. */
  private guard(): void {
    if (this.tracks.length > 0 && this.tickedInOrder().length === 0)
      this.left.delete(this.tracks[0]);
  }

  get shuffled(): boolean {
    return this.shuffle;
  }

  /** Shuffle or in order; a change starts shuffle's rounds afresh. */
  setShuffle(on: boolean): void {
    if (this.shuffle === on) return;
    this.shuffle = on;
    this.round = [];
  }

  /** A song chosen by hand (or remembered from the last visit) plays whatever its tick; the ticked
   * songs go on after it. Returns false for a file not in the manifest. */
  select(file: string): boolean {
    if (!this.tracks.includes(file)) return false;
    this.round = this.round.filter((other) => other !== file);
    this.play(file);
    return true;
  }

  /** The first song of a visit when nothing is remembered: the first ticked one, or a draw. */
  start(): string | null {
    if (this.tracks.length === 0) return null;
    const file = this.shuffle ? this.draw() : this.firstTicked();
    if (file !== null) this.play(file);
    return file;
  }

  /** The song after the current one; null with nothing to play. */
  next(): string | null {
    if (this.tracks.length === 0) return null;
    const file = this.shuffle ? this.draw() : this.after(this.current);
    if (file !== null) this.play(file);
    return file;
  }

  /** The song before: the last one heard, then on backwards through the manifest's ticked songs.
   * In shuffle with no history left, another draw. */
  previous(): string | null {
    if (this.tracks.length === 0) return null;
    // The history's last entry is the current song.
    this.history.pop();
    const heard = this.history.pop();
    let file: string | null;
    if (heard !== undefined) file = heard;
    else if (this.shuffle) file = this.draw();
    else file = this.before(this.current);
    if (file !== null) this.play(file);
    else if (this.current !== null) this.history.push(this.current);
    return file;
  }

  private play(file: string): void {
    this.current = file;
    this.history.push(file);
    if (this.history.length > 100) this.history.shift();
  }

  private tickedInOrder(): string[] {
    return this.tracks.filter((file) => !this.left.has(file));
  }

  private firstTicked(): string | null {
    return this.tickedInOrder()[0] ?? null;
  }

  private after(file: string | null): string | null {
    const order = this.tickedInOrder();
    if (order.length === 0) return null;
    const at = file === null ? -1 : this.tracks.indexOf(file);
    // The first ticked song further down the manifest, or round to the top.
    const below = order.find((other) => this.tracks.indexOf(other) > at);
    return below ?? order[0];
  }

  private before(file: string | null): string | null {
    const order = this.tickedInOrder();
    if (order.length === 0) return null;
    const at = file === null ? this.tracks.length : this.tracks.indexOf(file);
    const above = [...order]
      .reverse()
      .find((other) => this.tracks.indexOf(other) < at);
    return above ?? order[order.length - 1];
  }

  /** The next draw of the shuffle, dealing a new round when this one is out. */
  private draw(): string | null {
    if (this.round.length === 0) {
      const pool = this.tickedInOrder();
      if (pool.length === 0) return null;
      this.round = this.deal(pool);
      // The round must not open on the song that just played, unless it is the only one.
      if (
        this.round.length > 1 &&
        this.current !== null &&
        this.round[0] === this.current
      ) {
        const swap = 1 + Math.floor(this.random() * (this.round.length - 1));
        [this.round[0], this.round[swap]] = [this.round[swap], this.round[0]];
      }
    }
    return this.round.shift() ?? null;
  }

  private deal(pool: string[]): string[] {
    const dealt = [...pool];
    for (let i = dealt.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [dealt[i], dealt[j]] = [dealt[j], dealt[i]];
    }
    return dealt;
  }
}
