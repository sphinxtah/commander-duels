import { fetchCardImage, knownMissing } from "../images";
import type { CardImageSize } from "../table/types";

// The table's card textures (design §11). Each card picture is decoded at the smallest of a few
// widths (tiers) that covers it as drawn, from the smallest Scryfall size that holds that width,
// so a board of 240 permanents at 4K costs what it shows and no more. Textures are shared and
// reference-counted by name and tier, fetched six at a time with the hand first, handed to the
// GPU at most eight a frame, and kept within a memory budget, oldest unused first. A name the
// server has no image for is remembered in images.ts, where CardFace looks too.
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
  fetch?: (
    name: string,
    size: CardImageSize,
    o: { signal?: AbortSignal },
  ) => Promise<Blob | "missing">;
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
  phase: "queued" | "fetching" | "decoded" | "ready" | "missing" | "failed";
  refs: number;
  lastUsed: number;
  controller: AbortController | null;
  bitmap: B | null;
  texture: T | null;
  bytes: number;
  listeners: ((state: TextureState) => void)[];
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
  private inFlight = 0;
  private order = 0;
  private bytes = 0;
  private disposed = false;

  constructor(adapter: TextureAdapter<T, B>, o: TextureCacheOptions = {}) {
    this.adapter = adapter;
    this.budget = o.budget ?? textureBudget();
    this.maxInFlight = o.maxInFlight ?? 6;
    this.uploadsPerFrame = o.uploadsPerFrame ?? 8;
    this.idleMs = o.idleMs ?? 60_000;
    this.now = o.now ?? (() => performance.now());
    this.onChange = o.onChange ?? (() => undefined);
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
    if (entry.phase === "queued" || entry.phase === "fetching") {
      entry.controller?.abort();
      this.entries.delete(entry.key);
    } else if (entry.phase === "missing" || entry.phase === "failed")
      this.entries.delete(entry.key);
  }

  /** Starts fetches while fewer than six are in flight, the most wanted first. */
  private drain(): void {
    while (this.inFlight < this.maxInFlight && !this.disposed) {
      let next: Entry<T, B> | null = null;
      for (const entry of this.entries.values())
        if (
          entry.phase === "queued" &&
          (!next ||
            entry.priority < next.priority ||
            (entry.priority === next.priority && entry.order < next.order))
        )
          next = entry;
      if (!next) return;
      this.start(next);
    }
  }

  private start(entry: Entry<T, B>): void {
    entry.phase = "fetching";
    const controller = new AbortController();
    entry.controller = controller;
    this.inFlight += 1;
    const fetch = this.adapter.fetch ?? fetchCardImage;
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
    if (this.bytes > this.budget) this.sweep();
    return Math.max(0, ready.length - this.uploadsPerFrame);
  }

  /** Lets go of unused textures: any idle for a minute, then the oldest unused while over the
   * budget. Textures in use are never let go. */
  sweep(): void {
    const now = this.now();
    const unused = [...this.entries.values()]
      .filter((entry) => entry.refs <= 0 && entry.phase === "ready")
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of unused)
      if (now - entry.lastUsed >= this.idleMs || this.bytes > this.budget)
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
        entry.phase === "decoded"
      )
        pending += 1;
    }
    return { textures, bytes: this.bytes, pending, inFlight: this.inFlight };
  }

  /** Stops every fetch and starts no more; the textures made so far stay until dispose(). */
  stop(): void {
    this.disposed = true;
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

/**
 * Pictures made on the main thread (the text frames under every card face) in small slices, so
 * a first board of many names never makes one long task: each frame makes as many as fit in a
 * few milliseconds, and the cards wait on a plain placeholder until theirs is made.
 */
export class LazyTextures<T> {
  private readonly made = new Map<string, T>();
  private readonly queue = new Map<string, () => T>();
  private readonly destroy: (texture: T) => void;
  private readonly now: () => number;

  constructor(
    destroy: (texture: T) => void,
    now: () => number = () => performance.now(),
  ) {
    this.destroy = destroy;
    this.now = now;
  }

  /** The texture for `key` if made; otherwise queues `make` and returns null. */
  get(key: string, make: () => T): T | null {
    const texture = this.made.get(key);
    if (texture !== undefined) return texture;
    if (!this.queue.has(key)) this.queue.set(key, make);
    return null;
  }

  /** Makes queued textures until `budgetMs` has passed (at least one). Returns how many wait. */
  pump(budgetMs: number): number {
    const start = this.now();
    for (const [key, make] of this.queue) {
      this.queue.delete(key);
      this.made.set(key, make());
      if (this.now() - start >= budgetMs) break;
    }
    return this.queue.size;
  }

  get pending(): number {
    return this.queue.size;
  }

  get size(): number {
    return this.made.size;
  }

  dispose(): void {
    for (const texture of this.made.values()) this.destroy(texture);
    this.made.clear();
    this.queue.clear();
  }
}
