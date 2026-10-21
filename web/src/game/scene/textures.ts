import {
  RETRIES,
  backoff,
  isTryAgain,
  knownMissing,
  requestCardImage,
  type TryAgain,
} from "../images";
import type { CardImageSize } from "../table/types";

// The table's card textures (design §11). Each card picture is decoded at the smallest of a few
// widths (tiers) that covers it as drawn, from the smallest Scryfall size that holds that width,
// so a board of 240 permanents at 4K costs what it shows and no more. Textures are shared and
// reference-counted by name and tier, fetched six at a time with the hand first, handed to the
// GPU at most eight a frame, and kept within a memory budget, oldest unused first. A name the
// server has no image for is remembered in images.ts, where CardFace looks too. A failed request
// is tried again with CardFace's backoff, but the wait happens here, outside the six: a card
// waiting to try again never holds up another card's first request.
//
// Nothing here imports PixiJS: the scene passes an adapter that makes and destroys textures, so
// the cache's rules are tested in jsdom without WebGL.

/** Decoded widths, in device pixels. */
export const TIERS = [128, 192, 256, 384, 488, 672, 745] as const;
export type Tier = (typeof TIERS)[number];
/** The board and the hand never use png: only the magnifier and the zoom do, from the DOM. */
export const BOARD_MAX_TIER: Tier = 672;

/** The smallest tier at least this many device pixels wide (or the largest allowed). */
export function tierFor(width: number, max: Tier = BOARD_MAX_TIER): Tier {
  for (const tier of TIERS) if (tier >= width || tier >= max) return tier;
  return max;
}

/** The Scryfall size a tier is decoded from: `normal` is 488 wide, `large` 672, `png` 745. */
export function sourceFor(tier: Tier): CardImageSize {
  if (tier <= 488) return "normal";
  if (tier <= 672) return "large";
  return "png";
}

const MB = 1024 * 1024;

/** The texture memory budget: 48 MB per GB of device memory (4 GB when the browser does not
 * say), between 128 and 384 MB. */
export function textureBudget(deviceMemory?: number): number {
  const gb = deviceMemory && deviceMemory > 0 ? deviceMemory : 4;
  return Math.min(384 * MB, Math.max(128 * MB, 48 * MB * gb));
}

/** How to fetch, by priority: the hand, your board, the stack, opponents, then zone tiles. */
export type Priority = 0 | 1 | 2 | 3 | 4;

export interface Decoded {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface TextureAdapter<T, B extends Decoded = Decoded> {
  /** Decodes an image to `width` device pixels wide, keeping its proportions. */
  decode(blob: Blob, width: number): Promise<B>;
  create(bitmap: B): T;
  destroy(texture: T, bitmap: B): void;
  /** Bytes the texture holds on the GPU (mipmaps included). */
  bytes?(bitmap: B): number;
  /** One request for an image (images.ts's requestCardImage unless a test says otherwise). A
   * TryAgain is tried again later; a rejection gives up. */
  fetch?: (
    name: string,
    size: CardImageSize,
    o: { signal?: AbortSignal },
  ) => Promise<Blob | "missing" | TryAgain>;
}

export type TextureState = "loading" | "ready" | "missing" | "failed";

export interface TextureHandle<T> {
  readonly key: string;
  readonly state: TextureState;
  readonly texture: T | null;
  /** Called once when the texture becomes ready, or when the image turns out missing or failed. */
  onSettle(listener: (state: TextureState) => void): void;
  release(): void;
}

interface Entry<T, B> {
  key: string;
  name: string;
  tier: Tier;
  priority: Priority;
  order: number;
  /** "waiting": a request failed and the next one may start at `notBefore`. */
  phase:
    | "queued"
    | "fetching"
    | "waiting"
    | "decoded"
    | "ready"
    | "missing"
    | "failed";
  refs: number;
  lastUsed: number;
  controller: AbortController | null;
  bitmap: B | null;
  texture: T | null;
  bytes: number;
  listeners: ((state: TextureState) => void)[];
  /** Requests made so far that failed and may be tried again. */
  attempt: number;
  notBefore: number;
}

export interface TextureCacheOptions {
  budget?: number;
  maxInFlight?: number;
  uploadsPerFrame?: number;
  /** An unused texture older than this is let go even within the budget. */
  idleMs?: number;
  now?: () => number;
  /** Something changed that the scene should draw: a texture is ready to hand over, or settled. */
  onChange?: () => void;
  /** Bytes held elsewhere that count against the same budget (the cards' text frames). */
  otherBytes?: () => number;
}

export interface TextureCacheStats {
  textures: number;
  bytes: number;
  pending: number;
  inFlight: number;
}

export class TextureCache<T, B extends Decoded = Decoded> {
  private readonly entries = new Map<string, Entry<T, B>>();
  private readonly adapter: TextureAdapter<T, B>;
  private readonly budget: number;
  private readonly maxInFlight: number;
  private readonly uploadsPerFrame: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly otherBytes: () => number;
  private inFlight = 0;
  private order = 0;
  private bytes = 0;
  private disposed = false;
  /** Wakes the queue when the soonest waiting card may try again. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wakeAt = Infinity;

  constructor(adapter: TextureAdapter<T, B>, o: TextureCacheOptions = {}) {
    this.adapter = adapter;
    this.budget = o.budget ?? textureBudget();
    this.maxInFlight = o.maxInFlight ?? 6;
    this.uploadsPerFrame = o.uploadsPerFrame ?? 8;
    this.idleMs = o.idleMs ?? 60_000;
    this.now = o.now ?? (() => performance.now());
    this.onChange = o.onChange ?? (() => undefined);
    this.otherBytes = o.otherBytes ?? (() => 0);
  }

  private overBudget(): boolean {
    return this.bytes + this.otherBytes() > this.budget;
  }

  /** A handle on the picture of `name` at `tier`. Release it when the card stops showing it. */
  acquire(name: string, tier: Tier, priority: Priority): TextureHandle<T> {
    const key = `${name}|${tier}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        name,
        tier,
        priority,
        order: this.order++,
        phase: knownMissing(name) ? "missing" : "queued",
        refs: 0,
        lastUsed: this.now(),
        controller: null,
        bitmap: null,
        texture: null,
        bytes: 0,
        listeners: [],
        attempt: 0,
        notBefore: 0,
      };
      this.entries.set(key, entry);
    } else if (priority < entry.priority) entry.priority = priority;
    entry.refs += 1;
    entry.lastUsed = this.now();
    this.drain();
    return this.handle(entry);
  }

  private handle(entry: Entry<T, B>): TextureHandle<T> {
    let released = false;
    const state = (): TextureState =>
      entry.phase === "ready" ||
      entry.phase === "missing" ||
      entry.phase === "failed"
        ? entry.phase
        : "loading";
    return {
      key: entry.key,
      get state() {
        return state();
      },
      get texture() {
        return entry.phase === "ready" ? entry.texture : null;
      },
      onSettle: (listener) => {
        if (released) return;
        const now = state();
        if (now !== "loading") listener(now);
        else entry.listeners.push(listener);
      },
      release: () => {
        if (released) return;
        released = true;
        this.release(entry);
      },
    };
  }

  private release(entry: Entry<T, B>): void {
    entry.refs -= 1;
    entry.lastUsed = this.now();
    if (entry.refs > 0) return;
    entry.listeners = [];
    // Nobody wants it any more: stop asking, and forget what was not worth keeping.
    if (
      entry.phase === "queued" ||
      entry.phase === "fetching" ||
      entry.phase === "waiting"
    ) {
      entry.controller?.abort();
      this.entries.delete(entry.key);
    } else if (entry.phase === "missing" || entry.phase === "failed")
      this.entries.delete(entry.key);
  }

  /** Starts fetches while fewer than six are in flight, the most wanted first, and sets a timer
   * for the soonest card waiting to try again. */
  private drain(): void {
    if (this.disposed) return;
    const now = this.now();
    let soonest = Infinity;
    for (const entry of this.entries.values())
      if (entry.phase === "waiting") {
        if (entry.notBefore <= now) entry.phase = "queued";
        else soonest = Math.min(soonest, entry.notBefore);
      }
    while (this.inFlight < this.maxInFlight) {
      let next: Entry<T, B> | null = null;
      for (const entry of this.entries.values())
        if (
          entry.phase === "queued" &&
          (!next ||
            entry.priority < next.priority ||
            (entry.priority === next.priority && entry.order < next.order))
        )
          next = entry;
      if (!next) break;
      this.start(next);
    }
    if (soonest < this.wakeAt) {
      clearTimeout(this.timer);
      this.wakeAt = soonest;
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          this.wakeAt = Infinity;
          this.drain();
        },
        Math.max(0, soonest - now),
      );
    }
  }

  /** A request failed in a way worth trying again: wait (outside the six in flight) as long as
   * CardFace would, or give up after as many tries. */
  private later(entry: Entry<T, B>, retryAfter: number): void {
    if (entry.attempt >= RETRIES) {
      this.settle(entry, "failed");
      return;
    }
    entry.phase = "waiting";
    entry.notBefore = this.now() + backoff(entry.attempt, retryAfter);
    entry.attempt += 1;
  }

  private start(entry: Entry<T, B>): void {
    entry.phase = "fetching";
    const controller = new AbortController();
    entry.controller = controller;
    this.inFlight += 1;
    const fetch = this.adapter.fetch ?? requestCardImage;
    const live = () =>
      !this.disposed &&
      !controller.signal.aborted &&
      this.entries.get(entry.key) === entry;
    void fetch(entry.name, sourceFor(entry.tier), {
      signal: controller.signal,
    })
      .then(async (blob) => {
        if (!live()) return;
        if (blob === "missing") {
          this.settle(entry, "missing");
          return;
        }
        if (isTryAgain(blob)) {
          this.later(entry, blob.retryAfter);
          return;
        }
        const bitmap = await this.adapter.decode(blob, entry.tier);
        if (!live()) {
          bitmap.close();
          return;
        }
        entry.bitmap = bitmap;
        entry.phase = "decoded";
        this.onChange();
      })
      .catch(() => {
        if (live()) this.settle(entry, "failed");
      })
      .finally(() => {
        entry.controller = null;
        this.inFlight -= 1;
        this.drain();
      });
  }

  private settle(entry: Entry<T, B>, phase: "ready" | "missing" | "failed") {
    entry.phase = phase;
    const listeners = entry.listeners;
    entry.listeners = [];
    for (const listener of listeners) listener(phase);
    this.onChange();
  }

  /** Hands decoded pictures to the GPU, at most eight a call, the most wanted first. Returns how
   * many are still waiting for a later frame. */
  pump(): number {
    const ready = [...this.entries.values()]
      .filter((entry) => entry.phase === "decoded")
      .sort((a, b) => a.priority - b.priority || a.order - b.order);
    for (const entry of ready.slice(0, this.uploadsPerFrame)) {
      const bitmap = entry.bitmap!;
      entry.texture = this.adapter.create(bitmap);
      entry.bytes =
        this.adapter.bytes?.(bitmap) ?? bitmap.width * bitmap.height * 4;
      this.bytes += entry.bytes;
      this.settle(entry, "ready");
    }
    if (this.overBudget()) this.sweep();
    return Math.max(0, ready.length - this.uploadsPerFrame);
  }

  /** Lets go of unused textures: any idle for a minute, then the oldest unused while over the
   * budget. A texture someone holds is never let go: a card keeps holding the picture it shows
   * until the one replacing it is ready. */
  sweep(): void {
    const now = this.now();
    const unused = [...this.entries.values()]
      .filter((entry) => entry.refs <= 0 && entry.phase === "ready")
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of unused)
      if (now - entry.lastUsed >= this.idleMs || this.overBudget())
        this.evict(entry);
  }

  private evict(entry: Entry<T, B>): void {
    if (entry.texture && entry.bitmap)
      this.adapter.destroy(entry.texture, entry.bitmap);
    this.bytes -= entry.bytes;
    this.entries.delete(entry.key);
  }

  get stats(): TextureCacheStats {
    let textures = 0;
    let pending = 0;
    for (const entry of this.entries.values()) {
      if (entry.phase === "ready") textures += 1;
      else if (
        entry.phase === "queued" ||
        entry.phase === "fetching" ||
        entry.phase === "waiting" ||
        entry.phase === "decoded"
      )
        pending += 1;
    }
    return { textures, bytes: this.bytes, pending, inFlight: this.inFlight };
  }

  /** The bytes its textures hold now (stats.bytes, without counting the rest). */
  get bytesHeld(): number {
    return this.bytes;
  }

  /** Stops every fetch and starts no more; the textures made so far stay until dispose(). */
  stop(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const entry of this.entries.values()) entry.controller?.abort();
  }

  /** Stops every fetch and destroys every texture. */
  dispose(): void {
    this.stop();
    for (const entry of this.entries.values()) {
      if (entry.texture && entry.bitmap)
        this.adapter.destroy(entry.texture, entry.bitmap);
      else entry.bitmap?.close();
    }
    this.entries.clear();
    this.bytes = 0;
  }
}

export interface LazyHandle<T> {
  readonly key: string;
  /** The texture once it has been made, null while it waits its turn. */
  readonly texture: T | null;
  release(): void;
}

interface LazyEntry<T> {
  key: string;
  make: (() => T) | null;
  texture: T | null;
  refs: number;
  lastUsed: number;
  bytes: number;
}

export interface LazyTexturesOptions<T> {
  destroy(texture: T): void;
  /** Bytes the texture holds, counted against the budget. */
  bytes?(texture: T): number;
  budget?: number;
  /** An unused texture older than this is let go even within the budget. */
  idleMs?: number;
  now?: () => number;
  /** Bytes held elsewhere that count against the same budget (the card images). */
  otherBytes?: () => number;
}

/**
 * Pictures made on the main thread (the text frames under every card face) in small slices, so
 * a first board of many names never makes one long task: each frame makes as many as fit in a
 * few milliseconds, and the cards wait on a plain placeholder until theirs is made. They are
 * shared and reference-counted as the card images are, count against the same budget, and go
 * when no card has shown them for a minute or the budget is spent: a creature whose power keeps
 * changing makes a new frame each time, and the old ones must not pile up for the whole game.
 */
export class LazyTextures<T> {
  private readonly entries = new Map<string, LazyEntry<T>>();
  private readonly destroy: (texture: T) => void;
  private readonly bytesOf: (texture: T) => number;
  private readonly budget: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly otherBytes: () => number;
  private held = 0;

  constructor(o: LazyTexturesOptions<T>) {
    this.destroy = o.destroy;
    this.bytesOf = o.bytes ?? (() => 0);
    this.budget = o.budget ?? textureBudget();
    this.idleMs = o.idleMs ?? 60_000;
    this.now = o.now ?? (() => performance.now());
    this.otherBytes = o.otherBytes ?? (() => 0);
  }

  /** A handle on the texture for `key`, made by `make` in a later pump() if it is not made yet.
   * Release it when the card stops showing it. */
  acquire(key: string, make: () => T): LazyHandle<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, make, texture: null, refs: 0, lastUsed: 0, bytes: 0 };
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    entry.lastUsed = this.now();
    const held = entry;
    let released = false;
    return {
      key,
      get texture() {
        return held.texture;
      },
      release: () => {
        if (released) return;
        released = true;
        held.refs -= 1;
        held.lastUsed = this.now();
        // Not made yet, and nobody wants it made.
        if (held.refs <= 0 && !held.texture) this.entries.delete(held.key);
      },
    };
  }

  /** Makes queued textures until `budgetMs` has passed (at least one). Returns how many wait. */
  pump(budgetMs: number): number {
    const start = this.now();
    for (const entry of this.entries.values()) {
      if (!entry.make) continue;
      const make = entry.make;
      entry.make = null;
      try {
        entry.texture = make();
        entry.bytes = this.bytesOf(entry.texture);
        this.held += entry.bytes;
      } catch {
        // The cards keep their placeholder.
      }
      if (this.now() - start >= budgetMs) break;
    }
    if (this.overBudget()) this.sweep();
    return this.pending;
  }

  private overBudget(): boolean {
    return this.held + this.otherBytes() > this.budget;
  }

  /** Lets go of unused textures: any idle for a minute, then the oldest unused while over the
   * budget. A texture someone holds is never let go. */
  sweep(): void {
    const now = this.now();
    const unused = [...this.entries.values()]
      .filter((entry) => entry.refs <= 0 && entry.texture !== null)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of unused)
      if (now - entry.lastUsed >= this.idleMs || this.overBudget()) {
        this.destroy(entry.texture!);
        this.held -= entry.bytes;
        this.entries.delete(entry.key);
      }
  }

  get pending(): number {
    let pending = 0;
    for (const entry of this.entries.values()) if (entry.make) pending += 1;
    return pending;
  }

  /** How many have been made and are kept. */
  get size(): number {
    let made = 0;
    for (const entry of this.entries.values()) if (entry.texture) made += 1;
    return made;
  }

  /** The bytes the textures made so far hold. */
  get bytesHeld(): number {
    return this.held;
  }

  dispose(): void {
    for (const entry of this.entries.values())
      if (entry.texture) this.destroy(entry.texture);
    this.entries.clear();
    this.held = 0;
  }
}
