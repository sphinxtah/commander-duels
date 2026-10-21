import { HAND, PLANE } from "../table/geometry";
import { sigilSpec } from "../table/sigil";
import type {
  CardNode as Placed,
  CreateTableScene,
  DropZone,
  MotionLevel,
  Point as StagePoint,
  Rect,
  SceneFrame,
  SceneStats,
  SceneStatus,
  StageFit,
  TableCard,
  TableDiff,
  TableEvent,
  TableLayout,
  TableModel,
  TableScene,
  TableUiSnapshot,
  TableUiStore,
} from "../table/types";
import type { CardView, Seat } from "../types";
import {
  FONT,
  bandStrip,
  canvas,
  cardBack,
  crack,
  glow,
  stone,
  textFrame,
} from "./art";
import { drawSigil } from "./drawSigil";
import { diamondPath } from "./icons";
import { BandNode } from "./nodes/BandNode";
import {
  CardNode,
  GLOW_REACH,
  restPose,
  type CardPlacement,
} from "./nodes/CardNode";
import { CurveNode } from "./nodes/CurveNode";
import { EmblemNode, type EmblemKind } from "./nodes/EmblemNode";
import { FLOAT_COLOURS, FloatNode } from "./nodes/FloatNode";
import { HandNode } from "./nodes/HandNode";
import { MoreBadge, PileNode, fitCard } from "./nodes/PileNode";
import { PortraitNode } from "./nodes/PortraitNode";
import { StackNode } from "./nodes/StackNode";
import {
  Application,
  BitmapFont,
  CanvasSource,
  Container,
  Graphics,
  ImageSource,
  PerspectiveMesh,
  Sprite,
  Texture,
} from "./pixi";
import {
  LazyTextures,
  TextureCache,
  textureBudget,
  type TextureAdapter,
  type Tier,
} from "./textures";
import { Timeline, duration, easeInOut, linear, type Pose } from "./timeline";

// The PixiJS table (design §11): one canvas behind the DOM layer, aria-hidden and taking no
// pointer events, drawing the stone table in perspective, the band, the zone tiles, the cards,
// the stack and its lines, the portraits, the hand and the effects, all from the same layout
// the DOM layer puts its buttons on. It renders on demand: a frame when a commit lands, then only
// while something moves, a texture arrives or the timer bar runs; at rest it draws nothing.
//
// Pixi starts with `manageImports: false`, so its accessibility layer (which would take Tab), its
// event system and its DOM pipe never load; the scene uses no filters and no masks, and card
// images are only ever scaled evenly and turned.

export interface SceneArt {
  stone: Texture;
  band: Texture;
  back: Texture;
  /** A plain dark card, shown while a card's text frame is still being made. */
  blank: Texture;
  glowOffered: Texture;
  glowPlayable: Texture;
  glowDamage: Texture;
  shadow: Texture;
  crack: Texture;
  ropeGlow: Texture;
  ropeCore: Texture;
}

/** What the scene's nodes share. */
export interface SceneKit {
  readonly art: SceneArt;
  readonly textures: TextureCache<Texture, ImageBitmap>;
  /** Device pixels per stage unit. */
  resolution(): number;
  /** A card's text frame at a tier, or null while it waits to be made. */
  frameTexture(card: CardView, tier: Tier): Texture | null;
  waitForFrame(node: CardNode): void;
  fadeImage(node: CardNode): void;
  sigil(seed: string, grey: boolean): Texture;
  /** Asks for a frame to be drawn. */
  request(): void;
}

/** A picture's look, independent of where its pose's pivot is: centre, height, turn, opacity. */
interface Visual {
  cx: number;
  cy: number;
  height: number;
  rotation: number;
  alpha: number;
}

interface Arrival {
  visual: Visual | null;
  ms: number;
  delay: number;
  faceDown: boolean;
  token: boolean;
}

interface Plan {
  arrivals: Map<string, Arrival>;
  exits: Map<string, { visual: Visual | null; ms: number }>;
  /** Cards that became another card: their successor starts where they are, so they go at once. */
  paired: Set<string>;
  effects: TableEvent[];
}

interface PlacedCard {
  card: CardView;
  placement: CardPlacement;
  node: Placed;
  nudged: boolean;
}

/** More events than this in one diff is a jump: snap to it rather than play it. */
const MAX_EVENTS = 24;
const BAND_Y = 510;
const NUDGE = 16;
const FONT_NAME = "cd-bold";
let fontInstalled = false;

function installFont(): void {
  if (fontInstalled) return;
  fontInstalled = true;
  BitmapFont.install({
    name: FONT_NAME,
    style: {
      fontFamily: FONT,
      fontSize: 48,
      fontWeight: "700",
      fill: "#ffffff",
    },
    chars: [[" ", "~"], "×−·◇…"],
    resolution: 1,
    padding: 4,
    // Numbers and short words need no kerning, and measuring it costs a start-up long task.
    skipKerning: true,
  });
}

function canvasTexture(c: HTMLCanvasElement, resolution = 1): Texture {
  return new Texture({
    source: new CanvasSource({ resource: c, resolution, scaleMode: "linear" }),
  });
}

/** A vertical gradient strip for a rope: soft for the glow, sharp-edged for the core. */
function ropeStrip(height: number, soft: boolean): HTMLCanvasElement {
  const c = canvas(4, height);
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, height);
  if (soft) {
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.75)");
    g.addColorStop(1, "rgba(255,255,255,0)");
  } else {
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.2, "rgba(255,255,255,1)");
    g.addColorStop(0.8, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, height);
  return c;
}

function makeArt(): { art: SceneArt; backCanvas: HTMLCanvasElement } {
  const backCanvas = cardBack(244, 340, null);
  const blank = canvas(64, 90);
  const ctx = blank.getContext("2d")!;
  ctx.fillStyle = "#1d2826";
  ctx.beginPath();
  ctx.roundRect(0, 0, 64, 90, 3);
  ctx.fill();
  ctx.strokeStyle = "rgba(124,139,134,0.55)";
  ctx.lineWidth = 1;
  ctx.stroke();
  return {
    backCanvas,
    art: {
      stone: canvasTexture(stone()),
      band: canvasTexture(bandStrip(88), 2),
      back: canvasTexture(backCanvas),
      blank: canvasTexture(blank),
      glowOffered: canvasTexture(glow("#a86bff", GLOW_REACH * 2), 2),
      glowPlayable: canvasTexture(glow("#ff6fb8", GLOW_REACH * 2), 2),
      glowDamage: canvasTexture(glow("#ff2a2a", GLOW_REACH * 2), 2),
      shadow: canvasTexture(glow("#000000", GLOW_REACH * 2), 2),
      crack: canvasTexture(crack(256)),
      // Ropes take their width from their texture's height: 10 su of glow, a 4 su core.
      ropeGlow: canvasTexture(ropeStrip(40, true), 4),
      ropeCore: canvasTexture(ropeStrip(16, false), 4),
    },
  };
}

function samePose(a: Pose, b: Pose): boolean {
  return (
    Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.rotation - b.rotation) < 0.01 &&
    Math.abs(a.scale - b.scale) < 0.0001 &&
    Math.abs(a.alpha - b.alpha) < 0.001
  );
}

/** The face centre's offset from the pivot, turned and scaled as the pose turns and scales it. */
function centreOffset(p: CardPlacement, rotation: number, scale: number) {
  const dx = p.face.x + p.face.w / 2 - p.pivot.x;
  const dy = p.face.y + p.face.h / 2 - p.pivot.y;
  const a = (rotation * Math.PI) / 180;
  return {
    x: (dx * Math.cos(a) - dy * Math.sin(a)) * scale,
    y: (dx * Math.sin(a) + dy * Math.cos(a)) * scale,
  };
}

function poseFrom(v: Visual, p: CardPlacement): Pose {
  const scale = v.height / p.face.h;
  const o = centreOffset(p, v.rotation, scale);
  return {
    x: v.cx - o.x,
    y: v.cy - o.y,
    rotation: v.rotation,
    scale,
    alpha: v.alpha,
  };
}

function sign(n: number): string {
  return n > 0 ? `+${n}` : `−${-n}`;
}

class PixiTableScene implements TableScene {
  readonly stats: SceneStats = {
    frames: 0,
    applyMs: 0,
    textures: 0,
    textureBytes: 0,
    pending: 0,
  };
  private readonly app: Application;
  private readonly canvas: HTMLCanvasElement;
  private readonly ui: TableUiStore;
  private readonly timeline = new Timeline();
  private readonly textures: TextureCache<Texture, ImageBitmap>;
  private readonly frames: LazyTextures<Texture>;
  private readonly art: SceneArt;
  private readonly backCanvas: HTMLCanvasElement;
  private readonly kit: SceneKit;
  private readonly sigils = new Map<string, Texture>();
  private fit: StageFit;
  private motion: MotionLevel;
  private state: SceneStatus = {
    renderer: "starting",
    webgl: null,
    drawnRevision: null,
    settledRevision: null,
  };
  private readonly listeners = new Set<(status: SceneStatus) => void>();
  private frame: SceneFrame | null = null;
  private raf = 0;
  private lastRender = 0;
  private destroyed = false;
  private lost = false;
  private retier: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;
  private lastUi: TableUiSnapshot;
  private webgl2 = false;
  /** The stage's visible width in stage units: wider than 0–1920 on an ultrawide screen. */
  private span = { left: 0, right: 1920 };
  private groovesKey = "";

  // Layers, back to front, in render groups: a change inside one (a card added, a mark redrawn)
  // rebuilds that group's drawing instructions only, never the static table's.
  private readonly table = new Container({ isRenderGroup: true });
  private readonly chromeGroup = new Container({ isRenderGroup: true });
  private readonly boardGroup = new Container({ isRenderGroup: true });
  private readonly middleGroup = new Container({ isRenderGroup: true });
  private readonly handGroup = new Container({ isRenderGroup: true });
  private readonly plane: PerspectiveMesh;
  private readonly grooves = new Graphics();
  private readonly floor = new Container();
  private readonly bandLayer = new Container();
  private readonly tileLayer = new Container();
  private readonly boardUnder = new Container();
  private readonly boardLayer = new Container({ sortableChildren: true });
  private readonly stackLayer = new Container();
  /** The stack's cards, over the lines that run to and from them. */
  private readonly stackUnder = new Container();
  private readonly stackCards = new Container({ sortableChildren: true });
  private readonly dropLayer = new Container();
  private readonly drops = new Graphics();
  private readonly handUnder = new Container();
  private readonly curveLayer = new Container();
  private readonly portraitLayer = new Container();
  private readonly handLayer = new Container({ sortableChildren: true });
  private readonly effectLayer = new Container();

  // Pooled nodes, by key.
  private readonly cards = new Map<string, CardNode>();
  private readonly placed = new Map<string, PlacedCard>();
  private readonly animated = new Set<string>();
  private readonly pool: CardNode[] = [];
  private readonly ghosts = new Map<string, CardNode>();
  private readonly flyers = new Map<string, Sprite>();
  private readonly tiles = new Map<string, PileNode>();
  private readonly mores = new Map<string, MoreBadge>();
  private readonly portraits = new Map<Seat, PortraitNode>();
  private readonly curves = new Map<string, CurveNode>();
  private readonly floats = new Map<string, FloatNode>();
  private readonly waitingFrames = new Set<CardNode>();
  private readonly fading = new Map<CardNode, number>();
  private readonly band: BandNode;
  private readonly stack: StackNode;
  private readonly hand: HandNode;
  private readonly emblem = new EmblemNode();
  private dragCurve: CurveNode | null = null;
  private dropZones: DropZone[] | null = null;
  private dropOver: DropZone | null = null;
  private readonly dragShadow: Sprite;
  private serial = 0;
  private promptId: string | null = null;

  constructor(
    app: Application,
    canvasElement: HTMLCanvasElement,
    init: { fit: StageFit; motion: MotionLevel; ui: TableUiStore },
  ) {
    this.app = app;
    this.canvas = canvasElement;
    this.ui = init.ui;
    this.fit = init.fit;
    this.motion = init.motion;
    this.lastUi = init.ui.get();
    const version = (
      app.renderer as unknown as { context?: { webGLVersion?: number } }
    ).context?.webGLVersion;
    this.webgl2 = version === 2;
    installFont();
    const made = makeArt();
    this.art = made.art;
    this.backCanvas = made.backCanvas;
    const webgl2 = this.webgl2;
    const adapter: TextureAdapter<Texture, ImageBitmap> = {
      decode: (blob, width) =>
        createImageBitmap(blob, { resizeWidth: width, resizeQuality: "high" }),
      create: (bitmap) =>
        new Texture({
          source: new ImageSource({
            resource: bitmap,
            autoGenerateMipmaps: webgl2,
            autoGarbageCollect: false,
            scaleMode: "linear",
          }),
        }),
      destroy: (texture, bitmap) => {
        texture.destroy(true);
        bitmap.close();
      },
      bytes: (bitmap) =>
        Math.round(bitmap.width * bitmap.height * 4 * (webgl2 ? 4 / 3 : 1)),
    };
    const memory = (navigator as Navigator & { deviceMemory?: number })
      .deviceMemory;
    this.textures = new TextureCache(adapter, {
      budget: textureBudget(memory),
      onChange: () => this.requestFrame(),
    });
    this.frames = new LazyTextures<Texture>((texture) => texture.destroy(true));
    const scene = this;
    this.kit = {
      art: this.art,
      textures: this.textures,
      resolution: () => scene.fit.resolution,
      frameTexture: (card, tier) =>
        scene.frames.get(
          `${card.name}|${card.type_line}|${card.power}/${card.toughness}|${card.mana_cost}|${tier}`,
          () => canvasTexture(textFrame(card, tier)),
        ),
      waitForFrame: (node) => {
        scene.waitingFrames.add(node);
        scene.requestFrame();
      },
      fadeImage: (node) => {
        const ms = duration("imageFade", scene.motion);
        if (ms <= 0) node.setImageAlpha(1);
        else {
          scene.fading.set(node, scene.timeline.now());
          scene.requestFrame();
        }
      },
      sigil: (seed, grey) => scene.sigil(seed, grey),
      request: () => scene.requestFrame(),
    };

    this.plane = new PerspectiveMesh({
      texture: this.art.stone,
      verticesX: 10,
      verticesY: 10,
    });
    this.table.addChild(this.plane, this.grooves);
    this.band = new BandNode(this.kit);
    this.bandLayer.addChild(this.band.root);
    this.stack = new StackNode();
    this.stackLayer.addChild(this.stack.root);
    this.hand = new HandNode(this.kit);
    this.dragShadow = new Sprite(this.art.shadow);
    this.dragShadow.visible = false;
    this.dropLayer.addChild(this.drops, this.dragShadow);
    this.effectLayer.addChild(this.emblem.root);
    app.stage.eventMode = "none";
    this.chromeGroup.addChild(this.floor, this.bandLayer, this.tileLayer);
    this.boardGroup.addChild(this.boardUnder, this.boardLayer);
    this.middleGroup.addChild(
      this.dropLayer,
      this.curveLayer,
      this.stackUnder,
      this.stackCards,
      this.stackLayer,
      this.portraitLayer,
    );
    this.handGroup.addChild(this.hand.root, this.handUnder, this.handLayer);
    app.stage.addChild(
      this.table,
      this.chromeGroup,
      this.boardGroup,
      this.middleGroup,
      this.handGroup,
      this.effectLayer,
    );

    canvasElement.addEventListener("webglcontextlost", this.onLost);
    canvasElement.addEventListener("webglcontextrestored", this.onRestored);
    document.addEventListener("visibilitychange", this.onVisible);
    this.unsubscribe = this.ui.subscribe(this.onUi);
    void this.loadMark();

    this.layoutStage();
    this.render();
    this.setStatus({ renderer: "webgl", webgl: this.webgl2 ? 2 : 1 });
  }

  /* ---------- the public face ---------- */

  commit(frame: SceneFrame): void {
    if (this.destroyed || frame === this.frame) return;
    if (this.lost) {
      this.frame = frame;
      return;
    }
    this.apply(frame, false);
    this.render();
    // Pictures no card has shown for a minute, or the oldest unused over the budget, go.
    this.textures.sweep();
    const busy = this.busy();
    this.setStatus({
      drawnRevision: frame.model.revision,
      settledRevision: busy ? this.state.settledRevision : frame.model.revision,
    });
    if (busy) this.requestFrame();
  }

  resize(fit: StageFit): void {
    if (this.destroyed) return;
    const tiers = fit.resolution !== this.fit.resolution;
    this.fit = fit;
    this.layoutStage();
    if (this.lost) return;
    this.render();
    // New tiers wait for the window to stop changing.
    if (tiers) {
      clearTimeout(this.retier);
      this.retier = setTimeout(() => this.reTier(), 300);
    }
  }

  setMotion(motion: MotionLevel): void {
    this.motion = motion;
    if (motion === "none") {
      // Nothing moves any more: land everything where it is going.
      this.timeline.clear();
      this.finishAll();
      this.requestFrame();
    }
  }

  status(): SceneStatus {
    return this.state;
  }

  subscribe(listener: (status: SceneStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Stop asking for images, stop drawing, stop listening; then let go of the GPU.
    this.textures.stop();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.retier);
    this.unsubscribe();
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    document.removeEventListener("visibilitychange", this.onVisible);
    for (const view of [
      ...this.cards.values(),
      ...this.ghosts.values(),
      ...this.pool,
    ])
      view.recycle();
    try {
      this.app.destroy({ removeView: false }, { children: true });
    } catch {
      // A renderer that never finished starting has little to let go of.
    }
    this.textures.dispose();
    this.frames.dispose();
    for (const texture of [...Object.values(this.art), ...this.sigils.values()])
      texture.destroy(true);
    this.sigils.clear();
    this.listeners.clear();
  }

  /* ---------- status ---------- */

  private setStatus(patch: Partial<SceneStatus>): void {
    const next = { ...this.state, ...patch };
    if (
      next.renderer === this.state.renderer &&
      next.webgl === this.state.webgl &&
      next.drawnRevision === this.state.drawnRevision &&
      next.settledRevision === this.state.settledRevision
    )
      return;
    this.state = next;
    for (const listener of [...this.listeners]) listener(next);
  }

  private onLost = (event: Event): void => {
    event.preventDefault();
    if (this.destroyed) return;
    this.lost = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.setStatus({ renderer: "lost" });
  };

  private onRestored = (): void => {
    if (this.destroyed) return;
    this.lost = false;
    // Every texture's pixels are still in memory, so a full redraw brings the table back.
    this.timeline.clear();
    if (this.frame) this.apply(this.frame, true);
    this.finishAll();
    this.render();
    this.setStatus({
      renderer: "webgl",
      drawnRevision: this.frame?.model.revision ?? this.state.drawnRevision,
      settledRevision: this.frame?.model.revision ?? this.state.settledRevision,
    });
  };

  private onVisible = (): void => {
    if (document.visibilityState === "visible") this.requestFrame();
  };

  /* ---------- drawing on demand ---------- */

  private render(): void {
    if (this.destroyed || this.lost) return;
    this.app.render();
    this.stats.frames += 1;
    this.lastRender = this.timeline.now();
    const t = this.textures.stats;
    this.stats.textures = t.textures + this.frames.size;
    this.stats.textureBytes = t.bytes;
    this.stats.pending = t.pending + this.frames.pending;
  }

  private requestFrame(): void {
    if (this.raf || this.destroyed || this.lost) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (): void => {
    this.raf = 0;
    if (this.destroyed || this.lost) return;
    const now = this.timeline.now();
    // A glow's breath alone draws at most 30 frames a second.
    const breathing =
      this.timeline.size === 1 &&
      this.timeline.has("breath") &&
      this.textures.stats.pending === 0;
    if (breathing && now - this.lastRender < 32) {
      this.requestFrame();
      return;
    }
    this.step(now);
    this.render();
    if (this.busy()) this.requestFrame();
    else if (this.frame)
      this.setStatus({ settledRevision: this.frame.model.revision });
  };

  private busy(): boolean {
    return (
      this.timeline.busy() ||
      this.fading.size > 0 ||
      this.waitingFrames.size > 0 ||
      this.frames.pending > 0 ||
      this.ghosts.size > 0 ||
      this.flyers.size > 0 ||
      this.floats.size > 0
    );
  }

  /** One frame of everything that moves. */
  private step(now: number): void {
    // Hand decoded pictures to the GPU and make waiting text frames, a few at a time.
    this.textures.pump();
    if (this.frames.pending > 0) this.frames.pump(4);
    if (this.waitingFrames.size > 0) {
      const waiting = [...this.waitingFrames];
      this.waitingFrames.clear();
      for (const node of waiting) node.refreshFrame();
    }
    const fadeMs = Math.max(1, duration("imageFade", this.motion));
    for (const [node, start] of this.fading) {
      const t = Math.min(1, (now - start) / fadeMs);
      node.setImageAlpha(t);
      if (t >= 1) this.fading.delete(node);
    }

    for (const key of this.animated) {
      const view = this.cards.get(key);
      if (!view) {
        this.animated.delete(key);
        continue;
      }
      const pose = this.timeline.sample(`p:${key}`, now) as Pose | null;
      const shake = this.shake(key, now);
      const at = pose ?? view.rest;
      view.setPose(shake ? { ...at, x: at.x + shake } : at);
      const flip = this.timeline.progress(`f:${key}`, now);
      if (flip !== null) view.setShown(flip);
      const damage = this.timeline.progress(`d:${key}`, now);
      if (damage !== null) view.setDamageGlow(1 - damage);
      if (
        !this.timeline.active(`p:${key}`, now) &&
        !this.timeline.active(`f:${key}`, now) &&
        !this.timeline.active(`d:${key}`, now)
      ) {
        view.setPose(view.rest);
        view.setShown(1);
        view.setDamageGlow(0);
        this.timeline.cancel(`p:${key}`);
        this.timeline.cancel(`f:${key}`);
        this.timeline.cancel(`d:${key}`);
        this.animated.delete(key);
      }
    }
    for (const [key, ghost] of this.ghosts) {
      const pose = this.timeline.sample(`p:${key}`, now) as Pose | null;
      if (pose) ghost.setPose(pose);
      if (!this.timeline.active(`p:${key}`, now)) {
        this.timeline.cancel(`p:${key}`);
        this.ghosts.delete(key);
        this.recycle(ghost);
      }
    }
    for (const [key, sprite] of this.flyers) {
      const pose = this.timeline.sample(key, now) as Pose | null;
      if (pose) {
        sprite.position.set(pose.x, pose.y);
        sprite.scale.set(pose.scale);
        sprite.alpha = pose.alpha;
      }
      if (!this.timeline.active(key, now)) {
        this.timeline.cancel(key);
        this.flyers.delete(key);
        sprite.destroy();
      }
    }
    for (const [key, float] of this.floats) {
      const t = this.timeline.progress(key, now);
      float.update(t ?? 1);
      if (t === null || t >= 1) {
        this.timeline.cancel(key);
        this.floats.delete(key);
        float.destroy();
      }
    }
    for (const [key, curve] of this.curves) {
      const t = this.timeline.progress(`k:${key}`, now);
      if (t === null) continue;
      curve.setDrawn(t);
      if (t >= 1) this.timeline.cancel(`k:${key}`);
    }
    for (const [seat, portrait] of this.portraits) {
      const life = this.timeline.progress(`l:${seat}`, now);
      if (life !== null) {
        portrait.pulseLife(1 + 0.25 * Math.sin(Math.PI * life));
        if (life >= 1) this.timeline.cancel(`l:${seat}`);
      }
      const cracked = this.timeline.progress(`c:${seat}`, now);
      if (cracked !== null) {
        portrait.setCrack(cracked);
        if (cracked >= 1) this.timeline.cancel(`c:${seat}`);
      }
    }
    const emblem = this.timeline.progress("emblem", now);
    if (emblem !== null) {
      let alpha: number;
      if (this.motion === "none") alpha = emblem < 1 ? 1 : 0;
      else if (emblem < 0.136) alpha = emblem / 0.136;
      else if (emblem < 0.773) alpha = 1;
      else alpha = Math.max(0, (1 - emblem) / 0.227);
      this.emblem.setAlpha(alpha);
      if (emblem >= 1) {
        this.emblem.setAlpha(0);
        this.timeline.cancel("emblem");
      }
    }
    const breath = this.timeline.progress("breath", now);
    if (breath !== null) {
      const alpha =
        breath >= 1 ? 1 : 0.72 + 0.28 * Math.cos(Math.PI * 4 * breath);
      for (const view of this.cards.values()) view.setGlowAlpha(alpha);
      if (breath >= 1) this.timeline.cancel("breath");
    }
    this.timeline.prune(now);
  }

  /** A card shaking as damage lands: up to 4 su, dying away. */
  private shake(key: string, now: number): number {
    if (this.motion === "none") return 0;
    const t = this.timeline.progress(`d:${key}`, now);
    if (t === null || t >= 1) return 0;
    return Math.sin(t * Math.PI * 8) * 4 * (1 - t);
  }

  private finishAll(): void {
    for (const key of this.animated) {
      const view = this.cards.get(key);
      view?.setPose(view.rest);
      view?.setShown(1);
      view?.setDamageGlow(0);
    }
    this.animated.clear();
    for (const ghost of this.ghosts.values()) this.recycle(ghost);
    this.ghosts.clear();
    for (const sprite of this.flyers.values()) sprite.destroy();
    this.flyers.clear();
    for (const float of this.floats.values()) float.destroy();
    this.floats.clear();
    for (const [node] of this.fading) node.setImageAlpha(1);
    this.fading.clear();
    for (const curve of this.curves.values()) curve.setDrawn(1);
    for (const portrait of this.portraits.values()) portrait.pulseLife(1);
    this.emblem.setAlpha(0);
    for (const view of this.cards.values()) view.setGlowAlpha(1);
  }

  /* ---------- the stage and the table plane ---------- */

  /** Sizes the renderer to the viewport and lays the plane and band across what it shows. */
  private layoutStage(): void {
    const fit = this.fit;
    this.app.renderer.resize(fit.designW, fit.designH, fit.resolution);
    const left = -fit.ox / fit.k;
    const top = -fit.oy / fit.k;
    this.app.stage.position.set(-left, -top);
    const right = left + fit.designW;
    const bottom = top + fit.designH;

    // The plane's edges run to the vanishing point; it widens and deepens to fill a viewport
    // wider or taller than the stage, so the letterbox shows more table.
    const vp = PLANE.vanishingPoint;
    const near = PLANE.quad[2];
    const slope = (near.x - vp.x) / (near.y - vp.y);
    const farY = Math.min(PLANE.quad[0].y, top - 8);
    const nearY = Math.max(near.y, bottom + 8);
    const half = (y: number) => (y - vp.y) * slope;
    const widen = Math.max(
      1,
      (Math.max(vp.x - left, right - vp.x) + 8) / half(farY),
    );
    this.plane.setCorners(
      vp.x - widen * half(farY),
      farY,
      vp.x + widen * half(farY),
      farY,
      vp.x + widen * half(nearY),
      nearY,
      vp.x - widen * half(nearY),
      nearY,
    );
    this.span = { left, right };
    if (this.frame) {
      this.drawGrooves(this.frame.layout);
      this.band.resize(this.frame.layout.band, left, right);
    }
  }

  /** Lines cut into the stone: the field lines, the rims, the columns and the sockets the
   * portraits sit in, and two large diamonds laid on the table in perspective. */
  private drawGrooves(layout: TableLayout): void {
    const signature = [
      this.span.left,
      this.span.right,
      ...layout.table.grooves.flat().map((p) => `${p.x},${p.y}`),
      ...layout.table.sockets.map((d) => `${d.cx},${d.cy},${d.side}`),
    ].join("|");
    if (signature === this.groovesKey) return;
    this.groovesKey = signature;
    const g = this.grooves;
    g.clear();
    const cut = (a: StagePoint, b: StagePoint) => {
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({
        width: 3,
        color: 0x111414,
        alpha: 0.32,
      });
      g.moveTo(a.x, a.y + 1.8)
        .lineTo(b.x, b.y + 1.8)
        .stroke({
          width: 1,
          color: 0xf2f0e6,
          alpha: 0.1,
        });
    };
    const { left, right } = this.span;
    for (const [a, b] of layout.table.grooves) {
      // Rims run the plane's whole visible width.
      if (a.y === b.y && a.x < b.x)
        cut(
          { x: Math.min(a.x, left), y: a.y },
          { x: Math.max(b.x, right), y: b.y },
        );
      else cut(a, b);
    }
    // Diamonds on the ground, one each side of the band, drawn through the perspective.
    const vp = PLANE.vanishingPoint;
    const project = (cx: number, cy: number, half: number): number[] => {
      const z = 1 / (cy - vp.y);
      const x0 = (cx - vp.x) * z;
      const r = half * z;
      const toScreen = (x: number, zz: number) => [
        vp.x + x / zz,
        vp.y + 1 / zz,
      ];
      return [
        ...toScreen(x0, z + r),
        ...toScreen(x0 + r, z),
        ...toScreen(x0, z - r),
        ...toScreen(x0 - r, z),
      ];
    };
    for (const [cx, cy, half] of [
      [960, 780, 520],
      [960, 250, 560],
    ] as const) {
      const outer = project(cx, cy, half);
      g.poly(outer).stroke({ width: 3, color: 0x111414, alpha: 0.22 });
      const inner = project(cx, cy, half * 0.94);
      g.poly(inner).stroke({ width: 1.2, color: 0xf2f0e6, alpha: 0.07 });
    }
    for (const socket of layout.table.sockets) {
      if (
        socket.cx === PLANE.bandSocket.cx &&
        socket.cy === PLANE.bandSocket.cy
      )
        continue;
      diamondPath(g, socket.cx, socket.cy, socket.side).fill({
        color: 0x0c0e0e,
        alpha: 0.3,
      });
      diamondPath(g, socket.cx, socket.cy + 1.5, socket.side).stroke({
        width: 1.5,
        color: 0xf2f0e6,
        alpha: 0.12,
      });
      diamondPath(g, socket.cx, socket.cy, socket.side).stroke({
        width: 2,
        color: 0x0b0d0d,
        alpha: 0.5,
      });
    }
  }

  /* ---------- applying a commit ---------- */

  private placementOf(
    node: Placed,
    card: TableCard,
    model: TableModel,
  ): CardPlacement {
    const hand = node.role === "hand";
    const face = node.face;
    const pivot = hand
      ? { x: face.x + face.w / 2, y: face.y + face.h }
      : { x: face.x + face.w / 2, y: face.y + face.h / 2 };
    const anchoredSeat = model.anchored?.seat ?? null;
    const yours =
      card.controllerSeat !== null && card.controllerSeat === anchoredSeat;
    return {
      face,
      rotation: node.rotation,
      pivot,
      mark: node.mark,
      faceUp: node.faceUp,
      tag: node.tag,
      pips: node.pips,
      badges: node.badges,
      tierHeight: hand ? face.h * HAND.rise.scale : node.drawHeight,
      priority: hand ? 0 : node.role === "stack" ? 2 : yours ? 1 : 3,
      yours,
    };
  }

  /** Where a card rests now: the layout's pose, nudged towards the band while it attacks or
   * blocks, and moved by the ui (a risen hand card, its neighbours, a card being dragged). */
  private targetOf(key: string, placed: PlacedCard, ui: TableUiSnapshot): Pose {
    let pose = restPose(placed.placement);
    if (placed.nudged)
      pose.y += placed.placement.pivot.y > BAND_Y ? -NUDGE : NUDGE;
    const frame = this.frame;
    if (frame && placed.node.role === "hand")
      pose = HandNode.pose(
        key,
        pose,
        placed.placement.face,
        frame.model.hand,
        frame.layout,
        ui.risen?.key ?? null,
      );
    const drag = ui.drag;
    if (drag?.key === key && frame?.model.cards.get(key)?.drag === "play") {
      const scale = 1.08;
      const o = centreOffset(placed.placement, 0, scale);
      pose = {
        x: drag.point.x - o.x,
        y: drag.point.y - o.y,
        rotation: 0,
        scale,
        alpha: 1,
      };
    }
    return pose;
  }

  private take(): CardNode {
    return this.pool.pop() ?? new CardNode(this.kit);
  }

  private recycle(view: CardNode): void {
    this.waitingFrames.delete(view);
    this.fading.delete(view);
    view.recycle();
    if (this.pool.length < 64) this.pool.push(view);
    else view.destroy();
  }

  /** A card's current look, wherever it is in its tween. */
  private visual(key: string): Visual | null {
    const view = this.cards.get(key);
    const placed = this.placed.get(key);
    if (!view || !placed) return null;
    const pose = (this.timeline.sample(`p:${key}`) as Pose | null) ?? view.rest;
    const o = centreOffset(placed.placement, pose.rotation, pose.scale);
    return {
      cx: pose.x + o.x,
      cy: pose.y + o.y,
      height: placed.placement.face.h * pose.scale,
      rotation: pose.rotation,
      alpha: pose.alpha,
    };
  }

  /** Where a card comes from or goes to when it is not another card: a zone tile, a hand count
   * diamond, your hand's edge or the band. */
  private anchorVisual(
    anchor: string,
    seat: Seat,
    layout: TableLayout,
    model: TableModel,
  ): Visual | null {
    const at = (r: Rect): Visual => {
      const face = fitCard(r);
      return {
        cx: face.x + face.w / 2,
        cy: face.y + face.h / 2,
        height: face.h,
        rotation: 0,
        alpha: 1,
      };
    };
    if (anchor === "band")
      return { cx: 960, cy: BAND_Y, height: 128, rotation: 0, alpha: 1 };
    if (anchor === "hand") {
      if (seat === model.anchored?.seat && model.handBacks === 0)
        return {
          cx: HAND.centre,
          cy: 1080 + 60,
          height: HAND.card.h,
          rotation: 0,
          alpha: 1,
        };
      const d = layout.players.get(seat)?.counts.hand;
      return d
        ? { cx: d.cx, cy: d.cy, height: d.side * 1.6, rotation: 0, alpha: 1 }
        : null;
    }
    const tile = layout.zones.find((t) => t.seat === seat && t.zone === anchor);
    return tile ? at(tile.card) : null;
  }

  /** What the diff's events ask of the cards: where arrivals start, where departures go. */
  private plan(diff: TableDiff, model: TableModel, layout: TableLayout): Plan {
    const arrivals = new Map<string, Arrival>();
    const exits = new Map<string, { visual: Visual | null; ms: number }>();
    const paired = new Set<string>();
    const effects: TableEvent[] = [];
    const ms = (name: Parameters<typeof duration>[0]) =>
      duration(name, this.motion);
    const from = (
      origin: Extract<TableEvent, { type: "cast" }>["from"],
      time: number,
      token = false,
    ): Arrival => {
      if (origin.kind === "node") {
        paired.add(origin.key);
        return {
          visual: this.visual(origin.key),
          ms: time,
          delay: 0,
          faceDown: false,
          token,
        };
      }
      if (origin.kind === "anchor")
        return {
          visual: this.anchorVisual(origin.anchor, origin.seat, layout, model),
          ms: time,
          delay: 0,
          faceDown: origin.faceDown,
          token,
        };
      return { visual: null, ms: time, delay: 0, faceDown: false, token };
    };
    const to = (
      exit: Extract<TableEvent, { type: "leave" }>["to"],
      time: number,
    ) =>
      exit.kind === "anchor"
        ? {
            visual: this.anchorVisual(exit.anchor, exit.seat, layout, model),
            ms: time,
          }
        : { visual: null, ms: ms("fade") };
    for (const event of diff.events)
      switch (event.type) {
        case "cast":
          arrivals.set(event.key, from(event.from, ms("cast")));
          break;
        case "enter":
          if (!arrivals.has(event.key))
            arrivals.set(event.key, from(event.from, ms("enter"), event.token));
          break;
        case "resolve":
        case "leave":
          if (event.to.kind === "node") {
            paired.add(event.key);
            arrivals.set(event.to.key, {
              visual: this.visual(event.key),
              ms: ms(event.type),
              delay: 0,
              faceDown: false,
              token: false,
            });
          } else exits.set(event.key, to(event.to, ms(event.type)));
          break;
        case "draw":
          if (event.keys.length > 0) {
            const library = this.anchorVisual(
              "library",
              event.seat,
              layout,
              model,
            );
            event.keys.forEach((key, i) =>
              arrivals.set(key, {
                visual: library,
                ms: ms("draw"),
                delay: Math.min(i * ms("stagger"), ms("staggerMax")),
                faceDown: true,
                token: false,
              }),
            );
          } else effects.push(event);
          break;
        default:
          effects.push(event);
      }
    return { arrivals, exits, paired, effects };
  }

  private apply(frame: SceneFrame, snapAll: boolean): void {
    const started = performance.now();
    const { model, layout, diff } = frame;
    const previous = this.frame;
    this.frame = frame;
    const animate =
      !snapAll &&
      previous !== null &&
      previous.model.gameId === model.gameId &&
      !diff.baseline &&
      diff.events.length <= MAX_EVENTS;
    const plan = animate ? this.plan(diff, model, layout) : null;
    if (!animate) this.finishAll();
    const ui = this.ui.get();
    const moving = this.motion !== "none";

    /* --- cards --- */
    const seen = new Set<string>();
    for (const node of layout.nodes.values()) {
      // Cards without a hit are the ones a "+N" stands for: the plate is drawn instead.
      if (node.kind !== "card" || !node.hit) continue;
      const card = model.cards.get(node.key);
      if (!card) continue;
      const key = node.key;
      seen.add(key);
      const placement = this.placementOf(node, card, model);
      const permanent = card.located.permanent;
      const placed: PlacedCard = {
        card: card.card,
        placement,
        node,
        nudged: !!permanent && (permanent.attacking || permanent.blocking),
      };
      const before = this.placed.get(key);
      this.placed.set(key, placed);
      let view = this.cards.get(key);
      const fresh = !view;
      if (!view) {
        view = this.take();
        view.key = key;
        this.cards.set(key, view);
      }
      if (node.role === "hand") view.addTo(this.handLayer, this.handUnder);
      else if (node.role === "stack")
        view.addTo(this.stackCards, this.stackUnder);
      else view.addTo(this.boardLayer, this.boardUnder);
      const z =
        node.z + (ui.risen?.key === key || ui.drag?.key === key ? 500_000 : 0);
      if (view.root.zIndex !== z) view.root.zIndex = z;
      view.place(card.card, placement);
      const target = this.targetOf(key, placed, ui);
      const poseKey = `p:${key}`;
      if (fresh) {
        const arrival = plan?.arrivals.get(key);
        if (arrival?.visual && moving && arrival.ms > 0) {
          const start = poseFrom(arrival.visual, placement);
          this.timeline.to(poseKey, start, target, arrival.ms, {
            delay: arrival.delay,
          });
          if (arrival.faceDown && placement.faceUp) {
            view.setShown(0);
            this.timeline.to(`f:${key}`, { t: 0 }, { t: 1 }, arrival.ms, {
              delay: arrival.delay,
              ease: linear,
            });
          }
          this.animated.add(key);
        } else if (animate) {
          // Out of nowhere (or with reduced motion): a fade where it lands; a token grows.
          const grow = arrival?.token && moving;
          this.timeline.to(
            poseKey,
            { ...target, alpha: 0, scale: grow ? 0.6 : 1 },
            target,
            grow
              ? duration("enter", this.motion)
              : duration("fade", this.motion),
            { ease: grow ? undefined : linear },
          );
          this.animated.add(key);
        }
      } else if (before && !samePose(view.rest, target)) {
        if (!animate || !moving) {
          this.timeline.cancel(poseKey);
        } else {
          const name = this.timeline.active(poseKey)
            ? "retarget"
            : Math.abs(before.placement.rotation - placement.rotation) > 0.01
              ? "tap"
              : before.nudged !== placed.nudged
                ? "attack"
                : "move";
          this.timeline.retarget(
            poseKey,
            view.rest,
            target,
            duration(name, this.motion),
          );
          this.animated.add(key);
        }
      }
      view.rest = target;
      if (!this.animated.has(key)) view.setPose(target);
      else {
        const pose = this.timeline.sample(poseKey) as Pose | null;
        view.setPose(pose ?? target);
      }
    }
    for (const [key, view] of this.cards) {
      if (seen.has(key)) continue;
      const exit = plan?.exits.get(key);
      const visual = animate ? this.visual(key) : null;
      const placed = this.placed.get(key);
      this.cards.delete(key);
      this.placed.delete(key);
      this.animated.delete(key);
      const poseKey = `p:${key}`;
      this.timeline.cancel(poseKey);
      this.timeline.cancel(`f:${key}`);
      this.timeline.cancel(`d:${key}`);
      // A card that became another one (cast, resolved, played) goes at once: its successor
      // starts from where it was.
      if (!animate || !visual || !placed || plan?.paired.has(key)) {
        this.recycle(view);
        continue;
      }
      const ghostKey = `g${this.serial++}`;
      const now = poseFrom(visual, placed.placement);
      const ms = exit?.ms ?? duration("fade", this.motion);
      const end =
        exit?.visual && moving
          ? { ...poseFrom(exit.visual, placed.placement), alpha: 0.35 }
          : { ...now, alpha: 0 };
      const time = exit?.visual && moving ? ms : duration("fade", this.motion);
      if (time <= 0) {
        this.recycle(view);
        continue;
      }
      this.timeline.to(`p:${ghostKey}`, now, end, time, {
        ease: exit?.visual && moving ? easeInOut : linear,
      });
      view.root.zIndex = view.root.zIndex + 1;
      this.ghosts.set(ghostKey, view);
    }

    /* --- the rest of the table --- */
    this.drawGrooves(layout);
    this.band.resize(layout.band, this.span.left, this.span.right);
    this.band.update(layout.band, model.phase, model.step);
    this.stack.update(model, layout);
    this.hand.setBacks(model.handBacks);
    this.applyTiles(model, layout);
    this.applyMores(layout);
    this.applyPortraits(model, layout, ui);
    this.applyCurves(layout, ui);
    this.applyDrag(ui);
    if (plan) this.playEffects(plan.effects, model, layout);
    if (model.promptId !== this.promptId) {
      this.promptId = model.promptId;
      if (animate && (this.motion === "normal" || this.motion === "fast"))
        this.timeline.to("breath", { t: 0 }, { t: 1 }, 2400, { ease: linear });
    }
    this.lastUi = ui;
    this.stats.applyMs = performance.now() - started;
  }

  private applyTiles(model: TableModel, layout: TableLayout): void {
    const seen = new Set<string>();
    for (const tile of layout.zones) {
      seen.add(tile.key);
      let view = this.tiles.get(tile.key);
      if (!view) {
        view = new PileNode(this.kit);
        this.tiles.set(tile.key, view);
        this.tileLayer.addChild(view.root);
      }
      // Your command cards are cards of their own; the tile only draws what nothing else does.
      view.update(tile, model, !!tile.topKey && !layout.nodes.has(tile.topKey));
    }
    for (const [key, view] of this.tiles)
      if (!seen.has(key)) {
        view.destroy();
        this.tiles.delete(key);
      }
  }

  private applyMores(layout: TableLayout): void {
    const seen = new Set<string>();
    for (const node of layout.nodes.values()) {
      if (node.kind !== "more") continue;
      seen.add(node.key);
      let view = this.mores.get(node.key);
      if (!view) {
        view = new MoreBadge(this.kit);
        this.mores.set(node.key, view);
        (node.key === "more:hand" ? this.handLayer : this.stackLayer).addChild(
          view.root,
        );
        if (node.key === "more:hand") view.root.zIndex = 3_400_000;
      }
      view.update(
        node,
        node.opens.kind === "stack"
          ? "diamond"
          : node.opens.kind === "hand"
            ? "hand"
            : "plate",
      );
    }
    for (const [key, view] of this.mores)
      if (!seen.has(key)) {
        view.destroy();
        this.mores.delete(key);
      }
  }

  private applyPortraits(
    model: TableModel,
    layout: TableLayout,
    ui: TableUiSnapshot,
  ): void {
    const seen = new Set<Seat>();
    const players = [
      ...(model.anchored ? [model.anchored] : []),
      ...model.opponents,
    ];
    for (const player of players) {
      const node = layout.players.get(player.seat);
      if (!node) continue;
      seen.add(player.seat);
      let view = this.portraits.get(player.seat);
      if (!view) {
        view = new PortraitNode(this.kit);
        this.portraits.set(player.seat, view);
        this.floor.addChild(view.floor);
        this.portraitLayer.addChild(view.root);
      }
      // An active opponent's column is lit, with a gold line along its foot.
      const column =
        !player.anchored && !node.chip
          ? layout.arrangement === "duel" || layout.expandedSeat === player.seat
            ? {
                x: this.span.left,
                y: 0,
                w: this.span.right - this.span.left,
                h: 476,
              }
            : { ...node.area, h: 476 }
          : null;
      view.update(node, player, { column, activeLine: column ? 474 : null });
      if (player.anchored) view.setBar(model.phase, this.timerShare(ui));
    }
    for (const [seat, view] of this.portraits)
      if (!seen.has(seat)) {
        view.destroy();
        this.portraits.delete(seat);
      }
  }

  private timerShare(ui: TableUiSnapshot): number | null {
    const timer = ui.timer;
    if (!timer || timer.totalMs <= 0) return null;
    if (
      timer.phase !== "running" &&
      timer.phase !== "paused" &&
      timer.phase !== "arming"
    )
      return null;
    return timer.phase === "arming" ? 1 : timer.remainingMs / timer.totalMs;
  }

  private applyCurves(layout: TableLayout, ui: TableUiSnapshot): void {
    const seen = new Set<string>();
    const pointed = new Set(
      [ui.hover, ui.focus, ui.magnified?.key].filter(
        (key): key is string => !!key,
      ),
    );
    for (const curve of layout.curves) {
      seen.add(curve.key);
      let view = this.curves.get(curve.key);
      if (!view) {
        view = new CurveNode(this.kit);
        this.curves.set(curve.key, view);
        this.curveLayer.addChild(view.root);
      }
      view.update(curve);
      // Lines of items below the top of the stack show while that item is pointed at.
      const item = curve.key.match(/^(?:cast|target):([^:]+)/)?.[1];
      view.setVisible(
        curve.emphasis === "always" || (!!item && pointed.has(`stack:${item}`)),
      );
    }
    for (const [key, view] of this.curves)
      if (!seen.has(key)) {
        view.destroy();
        this.curves.delete(key);
        this.timeline.cancel(`k:${key}`);
      }
  }

  /** A drag in progress: the drop zones it may end in, lit; the one under the pointer brighter;
   * a line from an attacker or blocker to the pointer; a shadow under a card being played. */
  private applyDrag(ui: TableUiSnapshot): void {
    const drag = ui.drag;
    const card = drag ? this.frame?.model.cards.get(drag.key) : undefined;
    this.dragShadow.visible = false;
    // The lit zones change only as the pointer enters or leaves one, not on every move.
    const zones = drag && card ? drag.valid : null;
    const over = drag && card ? drag.over : null;
    if (zones !== this.dropZones || over !== this.dropOver) {
      this.dropZones = zones;
      this.dropOver = over;
      const g = this.drops;
      g.clear();
      for (const zone of zones ?? []) {
        const r = zone.rect;
        const lit = over !== null && over.rect === r;
        g.roundRect(r.x, r.y, r.w, r.h, 8).fill({
          color: 0xf2e2b0,
          alpha: lit ? 0.14 : 0.05,
        });
        g.roundRect(r.x, r.y, r.w, r.h, 8).stroke({
          width: lit ? 3 : 2,
          color: 0xf2e2b0,
          alpha: lit ? 0.9 : 0.4,
        });
      }
    }
    if (!drag || !card) {
      this.dragCurve?.setVisible(false);
      return;
    }
    const placed = this.placed.get(drag.key);
    if (card.drag === "play" && placed) {
      const w = placed.placement.face.w * 1.08;
      const h = placed.placement.face.h * 1.08;
      this.dragShadow.visible = true;
      this.dragShadow.position.set(
        drag.point.x - w / 2 - GLOW_REACH + 10,
        drag.point.y - h / 2 - GLOW_REACH + 14,
      );
      this.dragShadow.width = w + GLOW_REACH * 2;
      this.dragShadow.height = h + GLOW_REACH * 2;
      this.dragShadow.alpha = 0.7;
      this.dragCurve?.setVisible(false);
    } else if (placed) {
      const f = placed.placement.face;
      const p0 = { x: f.x + f.w / 2, y: f.y + f.h / 2 };
      const p1 = drag.point;
      const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (!this.dragCurve) {
        this.dragCurve = new CurveNode(this.kit);
        this.effectLayer.addChild(this.dragCurve.root);
      }
      this.dragCurve.update({
        key: "drag",
        kind: card.drag === "block" ? "block" : "attack",
        p0,
        c: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 - 0.25 * length },
        p1,
        owner: "viewer",
        emphasis: "always",
      });
      this.dragCurve.setVisible(true);
    }
  }

  private playEffects(
    effects: TableEvent[],
    model: TableModel,
    layout: TableLayout,
  ): void {
    const moving = this.motion !== "none";
    const floatAt = (at: StagePoint, value: string, colour: number) => {
      const key = `float:${this.serial++}`;
      const float = new FloatNode(key, value, at, colour);
      this.effectLayer.addChild(float.root);
      this.floats.set(key, float);
      this.timeline.to(
        key,
        { t: 0 },
        { t: 1 },
        duration("float", this.motion),
        { ease: linear },
      );
    };
    const cardTop = (key: string): StagePoint | null => {
      const v = this.visual(key);
      return v ? { x: v.cx, y: v.cy - v.height * 0.3 } : null;
    };
    const players = [
      ...(model.anchored ? [model.anchored] : []),
      ...model.opponents,
    ];
    for (const event of effects)
      switch (event.type) {
        case "counters": {
          const at = event.key
            ? cardTop(event.key)
            : event.seat !== null
              ? (() => {
                  const p = layout.players.get(event.seat)?.portrait;
                  return p ? { x: p.cx, y: p.cy - p.side * 0.5 } : null;
                })()
              : null;
          if (at) floatAt(at, sign(event.delta), FLOAT_COLOURS.counter);
          break;
        }
        case "damage": {
          const at = cardTop(event.key);
          if (at) floatAt(at, sign(-event.amount), FLOAT_COLOURS.loss);
          if (this.cards.has(event.key)) {
            this.timeline.to(
              `d:${event.key}`,
              { t: 0 },
              { t: 1 },
              Math.max(1, duration("damage", this.motion) || 120),
              {
                ease: linear,
              },
            );
            this.animated.add(event.key);
          }
          break;
        }
        case "life": {
          const d = layout.players.get(event.seat)?.life;
          if (d)
            floatAt(
              { x: d.cx + d.side * 0.9, y: d.cy - d.side * 0.3 },
              sign(event.delta),
              event.delta > 0 ? FLOAT_COLOURS.gain : FLOAT_COLOURS.loss,
            );
          if (moving)
            this.timeline.to(
              `l:${event.seat}`,
              { t: 0 },
              { t: 1 },
              duration("life", this.motion),
              {
                ease: linear,
              },
            );
          break;
        }
        case "draw": {
          // An opponent's draw: backs from their library to their hand's count.
          if (!moving) break;
          const from = this.anchorVisual("library", event.seat, layout, model);
          const to = this.anchorVisual("hand", event.seat, layout, model);
          if (!from || !to) break;
          for (let i = 0; i < Math.min(event.count, 4); i++) {
            const key = `fly:${this.serial++}`;
            const sprite = new Sprite(this.art.back);
            sprite.anchor.set(0.5);
            const w = from.height * (150 / 209.52);
            sprite.width = w;
            sprite.height = from.height;
            const base = sprite.scale.x;
            sprite.position.set(from.cx, from.cy);
            this.effectLayer.addChild(sprite);
            this.flyers.set(key, sprite);
            this.timeline.to(
              key,
              { x: from.cx, y: from.cy, rotation: 0, scale: base, alpha: 1 },
              { x: to.cx, y: to.cy, rotation: 0, scale: base * 0.35, alpha: 0 },
              duration("opponentDraw", this.motion),
              { delay: i * duration("stagger", this.motion), ease: easeInOut },
            );
          }
          break;
        }
        case "step":
          if (event.emblem) {
            let caption = "Attack!";
            if (event.emblem === "block") caption = "Block!";
            if (event.emblem === "turn") {
              const active = players.find((p) => p.seat === model.activeSeat);
              caption =
                active && active.seat === model.viewSeat && !model.observing
                  ? "Your Turn"
                  : `${active?.name ?? "Next"}'s Turn`;
            }
            this.showEmblem(event.emblem, caption, layout, "emblem");
          }
          break;
        case "eliminated":
          if (this.portraits.has(event.seat))
            this.timeline.to(
              `c:${event.seat}`,
              { t: 0 },
              { t: 1 },
              Math.max(1, duration("eliminated", this.motion) || 120),
              {
                ease: linear,
              },
            );
          break;
        case "result": {
          const captions: Record<typeof event.outcome, [EmblemKind, string]> = {
            victory: ["victory", "Victory"],
            defeat: ["defeat", "Defeat"],
            draw: ["draw", "Draw"],
            over: ["over", "Game Over"],
          };
          const [kind, caption] = captions[event.outcome];
          this.showEmblem(kind, caption, layout, "result");
          break;
        }
        default:
          break;
      }
  }

  private showEmblem(
    kind: EmblemKind,
    caption: string,
    layout: TableLayout,
    length: "emblem" | "result",
  ): void {
    this.emblem.show(kind, caption, layout.band);
    this.timeline.to(
      "emblem",
      { t: 0 },
      { t: 1 },
      duration(length, this.motion),
      {
        ease: linear,
      },
    );
  }

  /* ---------- the ui store ---------- */

  private onUi = (): void => {
    if (this.destroyed) return;
    const ui = this.ui.get();
    const last = this.lastUi;
    this.lastUi = ui;
    const frame = this.frame;
    if (!frame) return;
    if (ui.risen !== last.risen || ui.drag !== last.drag) {
      const ms = duration("rise", this.motion);
      for (const [key, placed] of this.placed) {
        if (
          placed.node.role !== "hand" &&
          last.drag?.key !== key &&
          ui.drag?.key !== key
        )
          continue;
        const view = this.cards.get(key);
        if (!view) continue;
        const target = this.targetOf(key, placed, ui);
        const z =
          placed.node.z +
          (ui.risen?.key === key || ui.drag?.key === key ? 500_000 : 0);
        if (view.root.zIndex !== z) view.root.zIndex = z;
        if (samePose(view.rest, target)) continue;
        // A dragged card follows the pointer at once; a rise eases.
        const following = ui.drag?.key === key && last.drag?.key === key;
        if (following || ms <= 0) {
          this.timeline.cancel(`p:${key}`);
          view.rest = target;
          view.setPose(target);
        } else {
          this.timeline.retarget(`p:${key}`, view.rest, target, ms);
          view.rest = target;
          this.animated.add(key);
        }
      }
      this.applyDrag(ui);
    }
    if (
      ui.hover !== last.hover ||
      ui.focus !== last.focus ||
      ui.magnified !== last.magnified
    )
      this.applyCurves(frame.layout, ui);
    if (ui.timer !== last.timer && frame.model.anchored)
      this.portraits
        .get(frame.model.anchored.seat)
        ?.setBar(frame.model.phase, this.timerShare(ui));
    this.requestFrame();
  };

  /* ---------- textures that need the scene ---------- */

  private sigil(seed: string, grey: boolean): Texture {
    const key = `${seed}|${grey}`;
    let texture = this.sigils.get(key);
    if (!texture) {
      texture = canvasTexture(drawSigil(sigilSpec(seed, grey), 384));
      this.sigils.set(key, texture);
    }
    return texture;
  }

  /** Draws the site's mark onto the card back once its image has loaded. */
  private async loadMark(): Promise<void> {
    try {
      const response = await fetch("/brand/mark.webp", {
        credentials: "same-origin",
      });
      if (!response.ok) return;
      const bitmap = await createImageBitmap(await response.blob());
      if (this.destroyed) {
        bitmap.close();
        return;
      }
      const drawn = cardBack(
        this.backCanvas.width,
        this.backCanvas.height,
        bitmap,
      );
      bitmap.close();
      this.backCanvas.getContext("2d")?.drawImage(drawn, 0, 0);
      this.art.back.source.update();
      this.requestFrame();
    } catch {
      // The lattice alone is still a card back.
    }
  }

  /** After a resize settles: each card takes the tier its new size needs. */
  private reTier(): void {
    if (this.destroyed || this.lost) return;
    for (const [key, placed] of this.placed)
      this.cards.get(key)?.place(placed.card, placed.placement);
    this.textures.sweep();
    this.requestFrame();
  }
}

/** Starts PixiJS on the canvas and builds the table on it. Rejects when WebGL cannot start, and
 * the game screen then draws the table with the DOM. */
export const createTableScene: CreateTableScene = async (
  canvasElement,
  init,
) => {
  const app = new Application();
  await app.init({
    canvas: canvasElement,
    preference: ["webgl"],
    preferWebGLVersion: 2,
    powerPreference: "high-performance",
    // No browserAll: no AccessibilitySystem (it would take Tab), no EventSystem, no filters.
    manageImports: false,
    autoStart: false,
    sharedTicker: false,
    autoDensity: false,
    antialias: false,
    width: init.fit.designW,
    height: init.fit.designH,
    resolution: init.fit.resolution,
    background: "#101819",
    backgroundAlpha: 1,
    hello: false,
    // SwiftShader in CI must pass: the table is light enough for a software GPU.
    failIfMajorPerformanceCaveat: false,
  });
  try {
    return new PixiTableScene(app, canvasElement, init);
  } catch (error) {
    app.destroy({ removeView: false }, { children: true });
    throw error;
  }
};
