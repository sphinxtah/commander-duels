import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveEvents } from "../table/events";
import {
  fixtureInput,
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "../table/fixtures";
import { layoutTable } from "../table/layout";
import { stageFit } from "../table/stage";
import { buildTableModel } from "../table/tableModel";
import type {
  EffectsLevel,
  MotionLevel,
  SceneFrame,
  TableEvent,
  TableModel,
  TableScene,
  TableUiStore,
} from "../table/types";
import { createTableUi } from "../table/uiStore";
import type { Snapshot } from "../types";
import { createTableScene } from "./createTableScene";
import { Sprite, Texture, type Container } from "./pixi";

// The scene itself, on PixiJS's real scene graph, with a stand-in for the renderer: jsdom has no
// WebGL, so the stand-in only walks the stage as Pixi's renderer would and fails as it would on a
// visible sprite whose texture has been destroyed. Canvas drawing and text measuring are stubbed;
// the clock and the animation frames are the test's.

vi.mock("./pixi", async (importOriginal) => {
  const real = await importOriginal<typeof import("./pixi")>();
  /** Text without a canvas to measure it on. */
  class StubText extends real.Container {
    text: string;
    style: Record<string, unknown>;
    readonly anchor = { set: () => undefined };
    constructor(o: { text: string; style?: Record<string, unknown> }) {
      super();
      this.text = o.text;
      this.style = { ...(o.style ?? {}) };
    }
  }
  function walk(node: Container): void {
    if (!node.visible || !node.renderable) return;
    const texture = (node as Container & { texture?: Texture }).texture;
    if (texture?.destroyed)
      throw new TypeError(
        "Cannot read properties of null (reading 'addressModeU')",
      );
    for (const child of node.children) walk(child);
  }
  class StubApplication {
    readonly stage = new real.Container();
    readonly renderer = {
      resize: () => undefined,
      context: { webGLVersion: 2 },
    };
    renders = 0;
    async init() {}
    render() {
      this.renders += 1;
      walk(this.stage);
    }
    destroy() {
      this.stage.destroy({ children: true });
    }
  }
  return {
    ...real,
    Application: StubApplication,
    BitmapFont: { install: () => undefined },
    BitmapText: StubText,
    Text: StubText,
  };
});

// A 2D context that accepts every call and draws nothing, in place before PixiJS loads (it
// looks at a canvas as it starts).
vi.hoisted(() => {
  const context2d: unknown = new Proxy(function () {}, {
    get: (_target, name) => (name === Symbol.toPrimitive ? () => 0 : context2d),
    apply: () => context2d,
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = (() => context2d) as never;
});

let clock = 0;
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
/** "hang": card image requests never answer (until aborted). */
let images: "ok" | "hang" = "ok";
/** How the Planeswalker portraits answer: "missing" is a 404, "hang" never answers. */
let portraits: "ok" | "missing" | "hang" = "ok";

beforeEach(() => {
  clock = 10_000;
  images = "ok";
  portraits = "ok";
  frames.clear();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "createImageBitmap",
    async (_blob: Blob, o?: ImageBitmapOptions) => {
      const width = o?.resizeWidth ?? 100;
      return { width, height: Math.round(width * 1.4), close() {} };
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const portrait = url.startsWith("/portraits/");
      if (!url.startsWith("/api/v1/card-images") && !portrait)
        return { ok: false, status: 404 } as Response;
      if (portrait && portraits === "missing")
        return { ok: false, status: 404 } as Response;
      if (portrait ? portraits === "hang" : images === "hang")
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        );
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["image"]),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Lets `ms` of animation frames pass, 16 ms at a time. */
async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 16) {
    await flush();
    clock += 16;
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(clock);
  }
  await flush();
}

/** The parts of the scene the tests look at. */
interface Internals {
  app: { renders: number };
  art: { blank: Texture };
  cards: Map<string, CardInternals>;
  ghosts: Map<string, CardInternals>;
  tiles: Map<string, { root: Container; seat: number; top: CardInternals }>;
  portraits: Map<
    number,
    { root: Container; shade: Container; sigil: Sprite; picture: Sprite }
  >;
  portraitPictures: Map<string, Texture | string>;
  portraitLoads: Set<AbortController>;
  curves: Map<string, { drawnShare: number; root: Container }>;
  mores: Map<string, { root: Container; backs: Container }>;
  floats: Map<string, { root: Container }>;
  emblem: { root: Container; caption: { text: string } };
  fx: { root: Container; active: boolean; count: number };
  frames: { size: number; bytesHeld: number; entries: Map<string, unknown> };
  textures: { bytesHeld: number };
  timeline: { has(key: string): boolean };
  stackLayer: Container;
}

interface CardInternals {
  image: Sprite;
  frame: Sprite;
  frameKey: string;
  back: Sprite;
  marks: Container;
  root: Container;
}

class Table {
  scene!: TableScene;
  ui: TableUiStore = createTableUi();
  snapshot: Snapshot;
  private readonly fixture;
  private previous: TableModel | null = null;

  constructor(name: FixtureName, change?: (f: TableFixture) => void) {
    this.fixture = tableFixture(name);
    change?.(this.fixture);
    this.snapshot = structuredClone(this.fixture.snapshot);
  }

  async start(
    motion: MotionLevel = "normal",
    effects?: EffectsLevel,
  ): Promise<SceneFrame> {
    this.scene = await createTableScene(document.createElement("canvas"), {
      fit: stageFit(1920, 1080, 1),
      motion,
      ui: this.ui,
      ...(effects ? { effects } : {}),
    });
    const first = this.frame(true);
    this.scene.commit(first);
    // Long enough for every image and text frame to arrive and fade in.
    await run(600);
    return first;
  }

  get internals(): Internals {
    return this.scene as unknown as Internals;
  }

  frame(baseline = false): SceneFrame {
    const model = buildTableModel(
      fixtureInput({ ...this.fixture, snapshot: this.snapshot }),
    );
    const layout = layoutTable(model, { expandedSeat: null, textScale: 1 });
    const diff = deriveEvents(this.previous, model, {
      baseline: baseline || this.previous === null,
      hidden: false,
    });
    this.previous = model;
    return { model, layout, diff };
  }

  /** The next revision, changed by `change`, committed. */
  next(
    change: (s: Snapshot) => void = () => undefined,
    baseline = false,
  ): SceneFrame {
    this.snapshot = structuredClone(this.snapshot);
    this.snapshot.revision += 1;
    change(this.snapshot);
    const frame = this.frame(baseline);
    this.scene.commit(frame);
    return frame;
  }

  /** The next revision, unchanged, committed with these events. */
  nextWith(events: TableEvent[]): SceneFrame {
    this.snapshot = structuredClone(this.snapshot);
    this.snapshot.revision += 1;
    const frame = { ...this.frame(), diff: { baseline: false, events } };
    this.scene.commit(frame);
    return frame;
  }

  keyOf(name: string, zone = "battlefield"): string {
    const model = this.previous!;
    return [...model.cards.values()].find(
      (c) => c.card.name === name && c.zone === zone,
    )!.key;
  }
}

describe("the scene's card textures", () => {
  it("keep showing and holding a card's picture while its next tier is on its way", async () => {
    const table = new Table("duel");
    await table.start("none");
    expect(table.scene.stats.pending).toBe(0);
    images = "hang";
    table.scene.resize(stageFit(1920, 1080, 2));
    // Every card asks for a larger tier once the window stops changing.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const cards = [...table.internals.cards.values()];
    const shown = cards.filter((view) => view.image.visible);
    expect(shown.length).toBeGreaterThan(10);
    // A minute later nothing has arrived; the next commit sweeps what nobody holds.
    clock += 61_000;
    expect(() => table.next()).not.toThrow();
    expect(() => table.scene.resize(stageFit(1920, 1080, 2))).not.toThrow();
    // No card, shown or hidden, points at a texture that has been let go.
    const tops = [...table.internals.tiles.values()].flatMap((t) =>
      t.top ? [t.top] : [],
    );
    for (const view of [...cards, ...tops]) {
      expect(view.image.texture.destroyed).toBe(false);
      expect(view.frame.texture.destroyed).toBe(false);
    }
    expect(cards.filter((view) => view.image.visible)).toHaveLength(
      shown.length,
    );
    table.scene.destroy();
  });

  it("never leave one card's picture over another's frame", async () => {
    const table = new Table("duel");
    await table.start("none");
    images = "hang";
    table.next((s) =>
      s.view!.opponents[0].graveyard.push({
        id: "d-new-top",
        hidden: false,
        name: "Counterspell",
        mana_cost: "{U}{U}",
        type_line: "Instant",
        power: null,
        toughness: null,
        rules: ["Counter target spell."],
      }),
    );
    await run(100);
    const tile = table.internals.tiles.get("tile:1:graveyard")!;
    expect(tile.top.image.visible).toBe(false);
    expect(tile.top.image.texture).toBe(Texture.EMPTY);
    expect(tile.top.frame.visible).toBe(true);
    table.scene.destroy();
  });

  it("let go of text frames no card shows, and count them in the budget", async () => {
    const table = new Table("duel");
    await table.start("none");
    const internals = table.internals;
    const bears = table.keyOf("Grizzly Bears");
    // The frames the creature on the battlefield showed (the one in hand keeps its own).
    const shown = new Set([internals.cards.get(bears)!.frameKey]);
    for (let i = 0; i < 5; i++) {
      table.next((s) => {
        const card = s.view!.battlefield.find(
          (p) => p.card.name === "Grizzly Bears",
        )!.card;
        card.power = `${10 + i}`;
        card.toughness = `${10 + i}`;
      });
      // Until its new frame is made, the card keeps the one it had.
      expect(internals.cards.get(bears)!.frame.texture).not.toBe(
        internals.art.blank,
      );
      shown.add(internals.cards.get(bears)!.frameKey);
      await run(50);
    }
    expect(shown.size).toBe(6);
    for (const key of shown)
      expect(internals.frames.entries.has(key)).toBe(true);
    table.next((s) => {
      s.view!.battlefield = s.view!.battlefield.filter(
        (p) => p.card.name !== "Grizzly Bears" && p.card.name !== "Rancor",
      );
    });
    await run(300);
    clock += 61_000;
    table.next();
    for (const key of shown)
      expect(internals.frames.entries.has(key)).toBe(false);
    expect(internals.frames.size).toBeGreaterThan(0);
    expect(table.scene.stats.textureBytes).toBe(
      internals.textures.bytesHeld + internals.frames.bytesHeld,
    );
    expect(internals.frames.bytesHeld).toBeGreaterThan(0);
    table.scene.destroy();
  });
});

describe("drawing on demand", () => {
  it("draws nothing for store changes the canvas does not show", async () => {
    const table = new Table("duel");
    await table.start();
    await run(500);
    const before = table.scene.stats.frames;
    for (let i = 0; i < 30; i++) {
      table.ui.set({ pointer: { x: 100 + i, y: 100 } });
      await run(16);
    }
    table.ui.set({ drawer: "log" });
    table.ui.set({ menu: "hud:menu" });
    table.ui.set({ focusVisible: true });
    table.ui.set({ hover: "player:1" });
    await run(100);
    expect(table.scene.stats.frames).toBe(before);
    // The timer bar is drawn as it runs, but not again for the same share.
    const timer = {
      key: "p-duel|attack",
      phase: "running" as const,
      remainingMs: 4_000,
      totalMs: 8_000,
      subject: null,
    };
    table.ui.set({ timer });
    await run(50);
    const timed = table.scene.stats.frames;
    expect(timed).toBeGreaterThan(before);
    table.ui.set({ timer: { ...timer } });
    await run(50);
    expect(table.scene.stats.frames).toBe(timed);
    // A hand card rising is drawn.
    const hand = table.keyOf("Lightning Bolt", "hand");
    table.ui.set({ risen: { key: hand, source: "pointer" } });
    await run(50);
    expect(table.scene.stats.frames).toBeGreaterThan(timed);
    table.scene.destroy();
  });

  it("draws an older stack item's lines when it is pointed at", async () => {
    const table = new Table("stack");
    const first = await table.start();
    await run(500);
    const second = first.model.stack[1];
    const line = table.internals.curves.get(`cast:${second.id}`)!;
    expect(line.root.visible).toBe(false);
    const before = table.scene.stats.frames;
    table.ui.set({ hover: second.key });
    await run(50);
    expect(line.root.visible).toBe(true);
    expect(table.scene.stats.frames).toBeGreaterThan(before);
    table.scene.destroy();
  });

  it("settles a new prompt on an unchanged board at once, glow breath or not", async () => {
    const table = new Table("duel");
    await table.start();
    const frame = table.next((s) => {
      s.prompt!.id = "p-duel-2";
    });
    expect(table.internals.timeline.has("breath")).toBe(true);
    expect(table.scene.status()).toMatchObject({
      drawnRevision: frame.model.revision,
      settledRevision: frame.model.revision,
    });
    table.scene.destroy();
  });
});

describe("animation", () => {
  it("stops what was playing when a commit jumps, and it stays stopped", async () => {
    const table = new Table("duel");
    await table.start();
    table.nextWith([
      {
        type: "step",
        phase: "combat",
        step: "declare_attackers",
        emblem: "attack",
      },
    ]);
    await run(300);
    const emblem = table.internals.emblem.root;
    expect(emblem.alpha).toBe(1);
    table.next(() => undefined, true);
    expect(emblem.alpha).toBe(0);
    await run(150);
    expect(emblem.alpha).toBe(0);
    expect(emblem.visible).toBe(false);
    table.scene.destroy();
  });

  it("keeps floating numbers still with reduced motion", async () => {
    const table = new Table("duel");
    await table.start("none");
    table.next((s) => {
      s.view!.you!.life -= 3;
    });
    const floats = [...table.internals.floats.values()];
    expect(floats).toHaveLength(1);
    const y = floats[0].root.position.y;
    await run(64);
    expect(floats[0].root.position.y).toBe(y);
    await run(100);
    expect(table.internals.floats.size).toBe(0);
    table.scene.destroy();
  });

  it("draws a new cast's lines on", async () => {
    const table = new Table("duel");
    await table.start();
    table.next((s) => {
      s.view!.opponents[0].hand_count -= 1;
      s.view!.stack = [
        {
          id: "d-bolt",
          kind: "spell",
          controller_seat: 1,
          name: "Lightning Bolt",
          text: "Lightning Bolt deals 3 damage to any target.",
          hidden: false,
          targets: [{ kind: "player", seat: 0, object_id: null, label: null }],
        },
      ];
    });
    const curves = table.internals.curves;
    const cast = curves.get("cast:d-bolt")!;
    const target = curves.get("target:d-bolt:0")!;
    expect(cast.drawnShare).toBeLessThan(0.05);
    expect(target.drawnShare).toBeLessThan(0.05);
    await run(160);
    expect(cast.drawnShare).toBeGreaterThan(0.2);
    expect(cast.drawnShare).toBeLessThan(1);
    await run(400);
    expect(cast.drawnShare).toBe(1);
    expect(target.drawnShare).toBe(1);
    table.scene.destroy();
  });

  it("cracks and dims an eliminated player's portrait, tiles and column over time", async () => {
    const table = new Table("three");
    await table.start();
    const frame = table.next((s) => {
      s.view!.opponents.find((p) => p.seat === 2)!.lost = true;
    });
    expect(frame.diff.events.map((e) => e.type)).toContain("eliminated");
    const portrait = table.internals.portraits.get(2)!;
    const tiles = [...table.internals.tiles.values()].filter(
      (t) => t.seat === 2,
    );
    expect(tiles.length).toBeGreaterThan(0);
    expect(portrait.root.alpha).toBe(1);
    expect(tiles[0].root.alpha).toBe(1);
    await run(450);
    expect(portrait.root.alpha).toBeLessThan(0.95);
    expect(portrait.root.alpha).toBeGreaterThan(0.6);
    await run(600);
    expect(portrait.root.alpha).toBeCloseTo(0.55, 5);
    for (const tile of tiles) expect(tile.root.alpha).toBeCloseTo(0.55, 5);
    expect(portrait.shade.alpha).toBeCloseTo(0.35, 5);
    // It stays so through a jump.
    table.next(() => undefined, true);
    expect(portrait.root.alpha).toBeCloseTo(0.55, 5);
    expect(table.internals.portraits.get(1)!.root.alpha).toBe(1);
    table.scene.destroy();
  });

  it("turns a card going back to a hand to our back on the way", async () => {
    const table = new Table("duel");
    await table.start();
    const frame = table.next((s) => {
      s.view!.battlefield = s.view!.battlefield.filter(
        (p) => p.card.name !== "Air Elemental",
      );
      s.view!.opponents[0].hand_count += 1;
    });
    expect(frame.diff.events).toContainEqual(
      expect.objectContaining({
        type: "leave",
        to: { kind: "anchor", anchor: "hand", seat: 1 },
      }),
    );
    const [ghost] = [...table.internals.ghosts.values()];
    expect(ghost.back.visible).toBe(false);
    await run(160);
    expect(ghost.back.visible).toBe(false);
    await run(160);
    expect(ghost.back.visible).toBe(true);
    expect(ghost.back.alpha).toBe(1);
    table.scene.destroy();
  });

  it("says whose turn it is with a curly apostrophe", async () => {
    const table = new Table("duel");
    await table.start();
    table.next((s) => {
      s.view!.turn += 1;
      s.view!.active_seat = 1;
      s.view!.priority_seat = 1;
    });
    expect(table.internals.emblem.caption.text).toBe("Bot 2’s Turn");
    table.scene.destroy();
  });

  it("draws a Two-Headed Giant teammate's hand face up, their draw flying in from their library (v0.5.1)", async () => {
    const table = new Table("giant");
    const first = await table.start();
    const keys = first.model.opponents[0].hand!;
    expect(keys).toHaveLength(6);
    for (const key of keys) {
      const view = table.internals.cards.get(key)!;
      expect(view, key).toBeDefined();
      expect(view.back.visible).toBe(false);
      expect(view.image.visible).toBe(true);
    }
    // No other seat's hand is drawn: only the teammate's and your own.
    const hands = [...table.internals.cards.keys()].filter((key) =>
      key.startsWith("hand:"),
    );
    expect(hands.sort()).toEqual([...keys, ...first.model.hand].sort());
    const frame = table.next((s) => {
      const mate = s.view!.opponents[0];
      mate.hand!.push({
        id: "g-drawn",
        hidden: false,
        name: "Mountain",
        mana_cost: null,
        type_line: "Basic Land — Mountain",
        power: null,
        toughness: null,
        rules: [],
      });
      mate.hand_count += 1;
      mate.library_count -= 1;
    });
    expect(frame.diff.events).toContainEqual({
      type: "draw",
      seat: 1,
      keys: ["hand:g-drawn"],
      count: 1,
    });
    expect(table.internals.cards.has("hand:g-drawn")).toBe(true);
    expect(table.internals.timeline.has("p:hand:g-drawn")).toBe(true);
    expect(table.internals.timeline.has("f:hand:g-drawn")).toBe(true);
    table.scene.destroy();
  });

  it("puts a long teammate's hand's “+N” on its fan as a plate, never at your hand's end (v0.5.1)", async () => {
    const table = new Table("giant", (f) => {
      const mate = f.snapshot.view!.opponents[0];
      const first = mate.hand![0];
      mate.hand = Array.from({ length: 20 }, (_, i) => ({
        ...first,
        id: `mate-${i}`,
      }));
      mate.hand_count = 20;
    });
    const first = await table.start("none");
    const more = table.internals.mores.get("more:hand:1")!;
    expect(more).toBeDefined();
    expect(more.backs.children).toHaveLength(0);
    // Fourteen of the twenty are drawn; the plate stands for the rest.
    expect(
      first.model.opponents[0].hand!.filter((key) =>
        table.internals.cards.has(key),
      ),
    ).toHaveLength(14);
    table.scene.destroy();
  });

  it("calls a Two-Headed Giant team's turn the viewer's, whichever teammate holds it (v0.5.1)", async () => {
    const table = new Table("giant");
    await table.start();
    table.next((s) => {
      s.view!.turn += 1;
      s.view!.active_seat = 2;
    });
    expect(table.internals.emblem.caption.text).toBe("Other Team’s Turn");
    table.next((s) => {
      s.view!.turn += 1;
      s.view!.active_seat = 1;
    });
    expect(table.internals.emblem.caption.text).toBe("Your Turn");
    table.scene.destroy();
    const watched = new Table("giantSysop");
    await watched.start();
    watched.next((s) => {
      s.view!.turn += 1;
      s.view!.active_seat = 3;
    });
    expect(watched.internals.emblem.caption.text).toBe("Team 2’s Turn");
    watched.scene.destroy();
  });

  it("says a controlled turn is the controller's to play (rule 723, v0.5.1)", async () => {
    const table = new Table("duel");
    await table.start();
    // Alice controls Bot 2's next turn, then Bot 2 controls hers.
    table.next((s) => {
      s.view!.turn += 1;
      s.view!.active_seat = 1;
      s.view!.priority_seat = 1;
      s.view!.opponents[0].controlled_by = 0;
    });
    expect(table.internals.emblem.caption.text).toBe("You Control This Turn");
    table.next((s) => {
      s.view!.turn += 1;
      s.view!.active_seat = 0;
      s.view!.priority_seat = 0;
      s.view!.opponents[0].controlled_by = null;
      s.view!.you!.controlled_by = 1;
    });
    expect(table.internals.emblem.caption.text).toBe("Controlled Turn");
    table.scene.destroy();
  });

  it("plays a diff's events once, however many frames carry it", async () => {
    const table = new Table("duel");
    await table.start();
    const frame = table.next((s) => {
      s.view!.you!.life -= 3;
    });
    expect(table.internals.floats.size).toBe(1);
    await run(1000);
    expect(table.internals.floats.size).toBe(0);
    table.scene.commit({ ...frame });
    expect(table.internals.floats.size).toBe(0);
    table.scene.destroy();
  });
});

describe("the special effects (v0.7.0)", () => {
  /** Grizzly Bears, blocking in the blockers fixture, dies in combat damage. */
  function slay(table: Table): SceneFrame {
    return table.next((s) => {
      s.view!.step = "combat_damage";
      s.view!.battlefield = s.view!.battlefield.filter(
        (p) => p.card.name !== "Grizzly Bears",
      );
      s.view!.you!.graveyard.push({
        id: "d-bears",
        hidden: false,
        name: "Grizzly Bears",
        mana_cost: "{1}{G}",
        type_line: "Creature — Bear",
        power: "2",
        toughness: "2",
        rules: [],
      });
    });
  }

  it("slashes a creature slain in combat and holds its card under the X before it goes", async () => {
    const table = new Table("blockers");
    await table.start();
    const frame = slay(table);
    expect(frame.diff.events).toContainEqual(
      expect.objectContaining({ type: "leave", combat: true }),
    );
    expect(table.internals.fx.count).toBe(1);
    const [ghost] = [...table.internals.ghosts.values()];
    const start = { x: ghost.root.x, y: ghost.root.y };
    // Through the hold the card stays put under its X.
    await run(300);
    expect(ghost.root.x).toBe(start.x);
    expect(ghost.root.y).toBe(start.y);
    expect(table.internals.fx.active).toBe(true);
    // Then it flies to the graveyard, and the X is gone soon after.
    await run(600);
    expect(table.internals.ghosts.size).toBe(0);
    await run(300);
    expect(table.internals.fx.active).toBe(false);
    expect(table.internals.fx.root.children).toHaveLength(0);
    table.scene.destroy();
  });

  it("plays none with the effects off, or with reduced motion, and the card leaves at once", async () => {
    for (const [motion, effects] of [
      ["normal", "off"],
      ["none", "full"],
    ] as const) {
      const table = new Table("blockers");
      await table.start(motion, effects);
      slay(table);
      expect(table.internals.fx.count).toBe(0);
      const [ghost] = [...table.internals.ghosts.values()];
      const start = ghost.root.x;
      await run(100);
      // With motion the card flies to the graveyard at once; with none it only fades.
      if (motion === "normal") expect(ghost.root.x).not.toBe(start);
      else {
        expect(ghost.root.x).toBe(start);
        await run(200);
        expect(table.internals.ghosts.size).toBe(0);
      }
      table.scene.destroy();
    }
  });

  it("stops at once when the effects are turned off, and keeps the marks when subtle", async () => {
    const table = new Table("blockers");
    await table.start("normal", "subtle");
    slay(table);
    expect(table.internals.fx.count).toBe(1);
    // Subtle: the X without its sparks, so no sprite under the effect.
    const slash = table.internals.fx.root.children[0] as Container;
    expect(slash.children.some((c: unknown) => c instanceof Sprite)).toBe(
      false,
    );
    table.scene.setEffects("off");
    expect(table.internals.fx.active).toBe(false);
    table.scene.destroy();
  });

  it("plays the others from their events: a burst, embers, a shock ring, confetti", async () => {
    const table = new Table("blockers");
    await table.start();
    const dragon = table.keyOf("Shivan Dragon");
    table.nextWith([
      {
        type: "resolve",
        key: "stack:x",
        to: { kind: "node", key: dragon },
        big: true,
        colours: ["R"],
      },
      { type: "attack", keys: [dragon] },
      { type: "life", seat: 0, delta: -8 },
      { type: "eliminated", seat: 1 },
      { type: "result", outcome: "victory" },
      { type: "turn", turn: 11, activeSeat: 0 },
    ]);
    expect(table.internals.fx.count).toBe(6);
    await run(200);
    expect(table.internals.fx.active).toBe(true);
    await run(2400);
    expect(table.internals.fx.active).toBe(false);
    table.scene.destroy();
  });
});

describe("the stack", () => {
  it("draws an ability's ribbon with its own card, and none for items the +N stands for", async () => {
    const table = new Table("stack");
    const first = await table.start("none");
    const ability = first.model.stack.find((e) => e.item.kind === "ability")!;
    const ribbons = (view: CardInternals) =>
      view.marks.children.filter(
        (child) => (child as Container & { text?: string }).text === "ABILITY",
      ).length;
    expect(ribbons(table.internals.cards.get(ability.key)!)).toBe(1);
    expect(
      table.internals.stackLayer.children.filter(
        (child) => (child as Container & { text?: string }).text === "ABILITY",
      ),
    ).toHaveLength(0);
    // The ability is now the oldest of eight: the stack's "+N" stands for it.
    const frame = table.next((s) => {
      const stack = s.view!.stack;
      const [item] = stack.splice(
        stack.findIndex((i) => i.kind === "ability"),
        1,
      );
      stack.push(item);
    });
    expect(frame.layout.nodes.get(ability.key)).toMatchObject({ hit: null });
    expect(table.internals.cards.has(ability.key)).toBe(false);
    for (const view of table.internals.cards.values())
      expect(ribbons(view)).toBe(0);
    table.scene.destroy();
  });
});

describe("Planeswalker portraits (v0.3.1)", () => {
  /** The duel with Alice allied with Rowan, and seat 1 a human allied with `theirs` (else the
   * fixture's bot). */
  function allied(theirs?: string): (f: TableFixture) => void {
    return (f) => {
      f.summarySeats[0] = { ...f.summarySeats[0], portrait: "rowan" };
      if (theirs)
        f.summarySeats[1] = {
          seat: 1,
          player: "human",
          handle: "bob",
          deck: null,
          portrait: theirs,
        };
    };
  }
  const asked = () =>
    vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.startsWith("/portraits/"));

  it("stand in a human's diamond once they arrive, grey for an opponent; a bot keeps its sigil", async () => {
    const table = new Table("duel", allied());
    await table.start("none");
    expect(asked()).toEqual(["/portraits/rowan-256.webp"]);
    const yours = table.internals.portraits.get(0)!;
    expect(yours.picture.visible).toBe(true);
    expect(yours.picture.texture).toBe(
      table.internals.portraitPictures.get("rowan|256|false"),
    );
    expect(yours.sigil.visible).toBe(false);
    const bot = table.internals.portraits.get(1)!;
    expect(bot.picture.visible).toBe(false);
    expect(bot.sigil.visible).toBe(true);
    table.scene.destroy();

    const human = new Table("duel", allied("chandra"));
    await human.start("none");
    expect(asked()).toContain("/portraits/chandra-256.webp");
    expect(human.internals.portraits.get(1)!.picture.visible).toBe(true);
    expect(
      human.internals.portraitPictures.get("chandra|256|true"),
    ).toBeInstanceOf(Texture);
    human.scene.destroy();
  });

  it("take the sharper file at 4K, keeping the one shown until it comes", async () => {
    const table = new Table("duel", allied());
    await table.start("none");
    const small = table.internals.portraitPictures.get("rowan|256|false");
    portraits = "hang";
    table.scene.resize(stageFit(3840, 2160, 1));
    await new Promise((resolve) => setTimeout(resolve, 350));
    await run(50);
    expect(asked()).toContain("/portraits/rowan-512.webp");
    const yours = table.internals.portraits.get(0)!;
    expect(yours.picture.visible).toBe(true);
    expect(yours.picture.texture).toBe(small);
    table.scene.destroy();
    // Stopping the scene stops the request; nothing arrives after it.
    expect(table.internals.portraitLoads.size).toBe(0);
    await run(50);
  });

  it("leave the frame empty while on their way, without holding the table", async () => {
    portraits = "hang";
    const table = new Table("duel", allied());
    const first = await table.start("none");
    const yours = table.internals.portraits.get(0)!;
    expect(yours.picture.visible).toBe(false);
    expect(yours.sigil.visible).toBe(false);
    expect(table.scene.status().settledRevision).toBe(first.model.revision);
    table.scene.destroy();
    await run(50);
  });

  it("keep the sigil when there is none to show", async () => {
    portraits = "missing";
    const table = new Table("duel", allied());
    await table.start("none");
    const yours = table.internals.portraits.get(0)!;
    expect(yours.picture.visible).toBe(false);
    expect(yours.sigil.visible).toBe(true);
    expect(table.internals.portraitPictures.get("rowan|256|false")).toBe(
      "missing",
    );
    // An ID that is not the roster's is never asked for.
    const odd = new Table("duel", (f) => {
      f.summarySeats[0] = { ...f.summarySeats[0], portrait: "../api/v1/me" };
    });
    await odd.start("none");
    expect(asked()).toEqual(["/portraits/rowan-256.webp"]);
    expect(odd.internals.portraits.get(0)!.sigil.visible).toBe(true);
    table.scene.destroy();
    odd.scene.destroy();
  });
});
