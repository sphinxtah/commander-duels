import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import "../../global.css";
import { CardFace } from "../Card";
import { deriveEvents } from "../table/events";
import {
  FIXTURE_NAMES,
  fixtureInput,
  tableFixture,
  type FixtureName,
} from "../table/fixtures";
import { hitEntries, layoutTable } from "../table/layout";
import { SceneHost, probeWebGL } from "../table/SceneHost";
import { stageFit } from "../table/stage";
import { buildTableModel } from "../table/tableModel";
import type {
  CreateTableScene,
  MotionLevel,
  Painter,
  SceneFrame,
  SceneStatus,
  StageFit,
  TableLayout,
  TableModel,
  TableDiff,
  TableScene,
} from "../table/types";
import { createTableUi } from "../table/uiStore";
import type { CardView, PermanentView, Snapshot, StackItem } from "../types";

// The table lab (development only, at /table-lab.html under Vite's dev server; never built):
// the PixiJS table drawn from the fixtures at two, three and four seats, with either painter, a
// short scripted turn to watch the animation, and a bench that times commits on the stress
// board. It is the owner's look-and-feel check against the Magic Duels screenshots, so beside the
// canvas it draws a rough stand-in for the DOM layer's text (names, life, the band's words and
// the prompt's diamonds) that the game screen draws for real.
//
// Query: ?fixture=<name> (or ?seats=2|3|4), &painter=webgl|dom, &motion=normal|fast|faster|none,
// &hits=1 (outline every button's box), &chrome=0 (hide the toolbar; H toggles it), &text=1.25.

const params = new URLSearchParams(location.search);
const SEATS: Record<string, FixtureName> = { 2: "duel", 3: "three", 4: "four" };

function initialFixture(): FixtureName {
  const named = params.get("fixture");
  if (named && (FIXTURE_NAMES as string[]).includes(named))
    return named as FixtureName;
  return SEATS[params.get("seats") ?? ""] ?? "duel";
}

function useWindowFit(): StageFit {
  const measure = () =>
    stageFit(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  const [fit, setFit] = useState(measure);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setFit(measure()));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return fit;
}

/* ---------- a scripted turn ---------- */

let made = 0;
const card = (
  name: string,
  cost: string | null,
  type: string,
  pt: string | null,
  rules: string[] = [],
): CardView => {
  const [power, toughness] = pt ? pt.split("/") : [null, null];
  made += 1;
  return {
    id: `lab-${made}`,
    hidden: false,
    name,
    mana_cost: cost,
    type_line: type,
    power,
    toughness,
    rules,
  };
};

function permanent(
  c: CardView,
  seat: number,
  change: Partial<PermanentView> = {},
): PermanentView {
  return {
    id: `p-${c.id}`,
    controller_seat: seat,
    owner_seat: seat,
    card: c,
    tapped: false,
    summoning_sick: false,
    damage: 0,
    counters: {},
    attacking: false,
    blocking: false,
    attached_to: null,
    ...change,
  };
}

const isLandCard = (c: CardView) => /\bLand\b/.test(c.type_line ?? "");
const isCreatureCard = (c: CardView) => /\bCreature\b/.test(c.type_line ?? "");

interface Step {
  label: string;
  apply(s: Snapshot): void;
}

/** A turn in small steps, each a new revision, so every kind of motion can be watched. */
const STEPS: Step[] = [
  {
    label: "Draw a card",
    apply(s) {
      const view = s.view!;
      view.hand.push(
        card("Llanowar Elves", "{G}", "Creature — Elf Druid", "1/1", [
          "{T}: Add {G}.",
        ]),
      );
      if (view.you) {
        view.you.library_count -= 1;
        view.you.hand_count = view.hand.length;
      }
      view.step = "draw";
      view.phase = "beginning";
    },
  },
  {
    label: "Play a land",
    apply(s) {
      const view = s.view!;
      const land = view.hand.find(isLandCard);
      view.phase = "precombat_main";
      view.step = "precombat_main";
      if (!land || !view.you) return;
      view.hand = view.hand.filter((c) => c !== land);
      view.you.hand_count = view.hand.length;
      view.battlefield.push(permanent(land, view.you.seat));
    },
  },
  {
    label: "Tap lands, cast a spell",
    apply(s) {
      const view = s.view!;
      if (!view.you) return;
      let tapped = 0;
      for (const p of view.battlefield)
        if (
          p.controller_seat === view.you.seat &&
          isLandCard(p.card) &&
          !p.tapped &&
          tapped < 2
        ) {
          p.tapped = true;
          tapped += 1;
        }
      const spell = view.hand.find((c) => !isLandCard(c));
      if (!spell) return;
      view.hand = view.hand.filter((c) => c !== spell);
      view.you.hand_count = view.hand.length;
      const opponent = view.opponents[0];
      const item: StackItem = {
        id: spell.id,
        kind: "spell",
        controller_seat: view.you.seat,
        name: spell.name,
        text: spell.rules.join(" ") || null,
        hidden: false,
        targets: opponent
          ? [
              {
                kind: "player",
                seat: opponent.seat,
                object_id: null,
                label: null,
              },
            ]
          : [],
      };
      view.stack = [item, ...view.stack];
    },
  },
  {
    label: "Resolve it",
    apply(s) {
      const view = s.view!;
      const [top, ...rest] = view.stack;
      if (!top || !view.you) return;
      view.stack = rest;
      const resolved = card(
        top.name ?? "Spell",
        null,
        "Instant",
        null,
        top.text ? [top.text] : [],
      );
      resolved.id = top.id;
      const opponent = view.opponents.find((p) =>
        top.targets.some((t) => t.seat === p.seat),
      );
      if (opponent) opponent.life -= 3;
      view.you.graveyard = [...view.you.graveyard, resolved];
    },
  },
  {
    label: "Attack",
    apply(s) {
      const view = s.view!;
      if (!view.you) return;
      view.phase = "combat";
      view.step = "declare_attackers";
      const attackers = view.battlefield.filter(
        (p) =>
          p.controller_seat === view.you!.seat &&
          isCreatureCard(p.card) &&
          !p.tapped &&
          !p.summoning_sick,
      );
      for (const p of attackers) {
        p.attacking = true;
        p.tapped = true;
      }
      const opponent = view.opponents[0];
      view.combat = attackers.length
        ? [
            {
              attackers: attackers.map((p) => p.id),
              defender: opponent
                ? {
                    kind: "player",
                    seat: opponent.seat,
                    object_id: null,
                    label: null,
                  }
                : null,
              blockers: [],
              blocked: false,
            },
          ]
        : [];
    },
  },
  {
    label: "Combat damage",
    apply(s) {
      const view = s.view!;
      view.step = "combat_damage";
      const opponent = view.opponents[0];
      const power = view.battlefield
        .filter((p) => p.attacking)
        .reduce((n, p) => n + (Number(p.card.power) || 0), 0);
      if (opponent) opponent.life -= power;
      const target = view.battlefield.find(
        (p) => p.controller_seat !== view.you?.seat && isCreatureCard(p.card),
      );
      if (target) target.damage += 2;
      const grower = view.battlefield.find(
        (p) => p.controller_seat === view.you?.seat && isCreatureCard(p.card),
      );
      if (grower)
        grower.counters = {
          ...grower.counters,
          "+1/+1": (grower.counters["+1/+1"] ?? 0) + 1,
        };
    },
  },
  {
    label: "Next turn",
    apply(s) {
      const view = s.view!;
      const opponent = view.opponents[0];
      view.turn += 1;
      view.active_seat = opponent?.seat ?? view.active_seat;
      view.priority_seat = view.active_seat;
      view.phase = "beginning";
      view.step = "upkeep";
      view.combat = [];
      for (const p of view.battlefield) {
        p.attacking = false;
        p.blocking = false;
        p.damage = 0;
        if (p.controller_seat === view.active_seat) p.tapped = false;
      }
      if (opponent) {
        opponent.library_count -= 1;
        opponent.hand_count += 1;
      }
    },
  },
  {
    label: "Opponent casts",
    apply(s) {
      const view = s.view!;
      const opponent = view.opponents[0];
      if (!opponent) return;
      opponent.hand_count -= 1;
      view.phase = "precombat_main";
      view.step = "precombat_main";
      const target = view.battlefield.find(
        (p) => p.controller_seat === view.you?.seat && isCreatureCard(p.card),
      );
      const bolt = card("Lightning Bolt", "{R}", "Instant", null, [
        "Lightning Bolt deals 3 damage to any target.",
      ]);
      view.stack = [
        {
          id: bolt.id,
          kind: "spell",
          controller_seat: opponent.seat,
          name: bolt.name,
          text: bolt.rules[0],
          hidden: false,
          targets: target
            ? [
                {
                  kind: "object",
                  seat: null,
                  object_id: target.id,
                  label: target.card.name,
                },
              ]
            : [],
        },
        ...view.stack,
      ];
    },
  },
];

/* ---------- the lab ---------- */

interface BenchResult {
  commits: number;
  commitP50: number;
  commitP95: number;
  commitMax: number;
  applyP95: number;
  idle: boolean;
}

declare global {
  interface Window {
    __tableLab?: {
      bench(commits?: number): Promise<BenchResult>;
      status(): SceneStatus | null;
      scene(): TableScene | null;
      /** The events of the frame on screen. */
      diff(): TableDiff;
    };
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  );
}

export function TableLab() {
  const fit = useWindowFit();
  const [fixtureName, setFixtureName] = useState<FixtureName>(initialFixture);
  const [snapshot, setSnapshot] = useState<Snapshot>(
    () => tableFixture(fixtureName).snapshot,
  );
  const [step, setStep] = useState(0);
  const [painter, setPainter] = useState<Painter>(() =>
    params.get("painter") === "dom" || !probeWebGL() ? "dom" : "webgl",
  );
  const [motion, setMotion] = useState<MotionLevel>(
    () => (params.get("motion") as MotionLevel | null) ?? "normal",
  );
  const [hits, setHits] = useState(params.get("hits") === "1");
  const [chrome, setChrome] = useState(params.get("chrome") !== "0");
  const [textScale] = useState<1 | 1.25>(
    params.get("text") === "1.25" ? 1.25 : 1,
  );
  const [status, setStatus] = useState<SceneStatus | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const ui = useMemo(() => createTableUi(), []);
  const scene = useRef<TableScene | null>(null);
  const statusRef = useRef<SceneStatus | null>(null);

  const fixture = useMemo(() => {
    const f = tableFixture(fixtureName);
    return { ...f, snapshot };
  }, [fixtureName, snapshot]);
  const model = useMemo<TableModel>(
    () => buildTableModel(fixtureInput(fixture)),
    [fixture],
  );
  const layout = useMemo<TableLayout>(
    () => layoutTable(model, { expandedSeat: null, textScale }),
    [model, textScale],
  );
  const drawn = useRef<TableModel | null>(null);
  const frame = useMemo<SceneFrame>(() => {
    const diff = deriveEvents(drawn.current, model, {
      baseline: drawn.current === null,
      hidden: document.visibilityState === "hidden",
    });
    return { model, layout, diff };
  }, [model, layout]);
  useLayoutEffect(() => {
    drawn.current = model;
  }, [model]);

  const create = useCallback<CreateTableScene>(
    (canvas, init) =>
      import("../scene/createTableScene").then(async (m) => {
        const made = await m.createTableScene(canvas, init);
        scene.current = made;
        return made;
      }),
    [],
  );

  const choose = (name: FixtureName) => {
    drawn.current = null;
    setFixtureName(name);
    setSnapshot(tableFixture(name).snapshot);
    setStep(0);
  };

  const next = () => {
    const copy = structuredClone(snapshot);
    if (!copy.view) return;
    STEPS[step % STEPS.length].apply(copy);
    copy.revision += 1;
    copy.prompt = null;
    copy.status = "waiting";
    setSnapshot(copy);
    setStep(step + 1);
  };

  // The bench: commits on the stress board, alternating two revisions that differ in a tapped
  // land, timing each commit's JavaScript; then whether the scene goes idle.
  const runBench = useCallback(
    async (commits = 120): Promise<BenchResult> => {
      const target = scene.current;
      if (!target)
        throw new Error("No scene: the bench needs the webgl painter.");
      const stress = tableFixture("stress");
      const frames = [0, 1].map((variant) => {
        const s = structuredClone(stress.snapshot);
        s.revision += variant;
        const land = s.view?.battlefield.find((p) => isLandCard(p.card));
        if (land && variant === 1) land.tapped = !land.tapped;
        const m = buildTableModel(fixtureInput({ ...stress, snapshot: s }));
        return {
          model: m,
          layout: layoutTable(m, { expandedSeat: null, textScale: 1 }),
        };
      });
      target.setMotion("none");
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      /** Until pending images and text frames have arrived (up to 30 s). */
      const loaded = async () => {
        for (let waited = 0; waited < 30_000; waited += 250) {
          await wait(250);
          if (target.stats.pending === 0) break;
        }
      };
      const commit = (i: number) =>
        target.commit({
          model: frames[i % 2].model,
          layout: frames[i % 2].layout,
          diff: { baseline: i === 0, events: [] },
        });
      // Both boards once, and their pictures, so the timing is of commits rather than of the
      // first uploads.
      commit(0);
      commit(1);
      await loaded();
      const times: number[] = [];
      const applies: number[] = [];
      for (let i = 2; i < commits + 2; i++) {
        const start = performance.now();
        commit(i);
        times.push(performance.now() - start);
        applies.push(target.stats.applyMs);
        if (i % 10 === 9) await wait(0);
      }
      await loaded();
      await wait(500);
      const before = target.stats.frames;
      await wait(1000);
      const result: BenchResult = {
        commits,
        commitP50: percentile(times, 0.5),
        commitP95: percentile(times, 0.95),
        commitMax: Math.max(...times),
        applyP95: percentile(applies, 0.95),
        idle: target.stats.frames === before,
      };
      target.setMotion(motion);
      setBench(result);
      // Put the lab's own fixture back on screen.
      target.commit({ ...frame, diff: { baseline: true, events: [] } });
      return result;
    },
    [frame, motion],
  );

  useEffect(() => {
    window.__tableLab = {
      bench: runBench,
      status: () => statusRef.current,
      scene: () => scene.current,
      diff: () => frame.diff,
    };
  }, [runBench, frame]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "h" || event.key === "H") setChrome((shown) => !shown);
      if (event.key === "n" || event.key === "N") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onStatus = useCallback((s: SceneStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // While the context is lost the DOM draws the table, but the scene stays mounted, so a
  // restored context (or a recreated scene) can take over again; only "failed" lets it go.
  const hosted = painter === "webgl" && status?.renderer !== "failed";
  const lostOrFailed =
    status?.renderer === "failed" || status?.renderer === "lost";
  const drawnBy: Painter = painter === "dom" || lostOrFailed ? "dom" : "webgl";
  const renderer =
    drawnBy === "dom"
      ? "dom"
      : status?.renderer === "webgl"
        ? "webgl"
        : "starting";
  const ready =
    drawnBy === "dom" || (status !== null && status.drawnRevision !== null);

  const stageStyle: CSSProperties = {
    position: "fixed",
    left: 0,
    top: 0,
    width: 1920,
    height: 1080,
    transformOrigin: "0 0",
    transform: `translate(${fit.ox}px, ${fit.oy}px) scale(${fit.k})`,
    pointerEvents: "none",
  };

  return (
    <div
      data-screen="lab"
      data-renderer={renderer}
      data-ready={ready ? "true" : undefined}
      data-drawn-revision={status?.drawnRevision ?? undefined}
      data-settled-revision={status?.settledRevision ?? undefined}
      data-arrangement={layout.arrangement}
      data-scale={fit.k.toFixed(3)}
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "#101819",
      }}
    >
      {hosted && (
        <SceneHost
          frame={frame}
          fit={fit}
          motion={motion}
          ui={ui}
          create={create}
          onStatus={onStatus}
        />
      )}
      <div style={stageStyle}>
        {drawnBy === "dom" && <DomStandIn layout={layout} model={model} />}
        <TextStandIn layout={layout} model={model} />
        {hits && <HitOutlines layout={layout} />}
      </div>
      {chrome && (
        <div
          style={{
            position: "fixed",
            right: 8,
            bottom: 8,
            padding: "8px 10px",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            maxWidth: 760,
            background: "#000c",
            border: "1px solid #e6c68c55",
            borderRadius: 6,
            font: "12px Inter, 'Segoe UI', sans-serif",
            color: "#ebece6",
            zIndex: 10,
          }}
        >
          <label>
            Fixture{" "}
            <select
              value={fixtureName}
              onChange={(e) => choose(e.target.value as FixtureName)}
            >
              {FIXTURE_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Painter{" "}
            <select
              value={painter}
              onChange={(e) => setPainter(e.target.value as Painter)}
            >
              <option value="webgl">webgl</option>
              <option value="dom">dom</option>
            </select>
          </label>
          <label>
            Motion{" "}
            <select
              value={motion}
              onChange={(e) => setMotion(e.target.value as MotionLevel)}
            >
              {(["normal", "fast", "faster", "none"] as const).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={hits}
              onChange={(e) => setHits(e.target.checked)}
            />{" "}
            Hits
          </label>
          <button type="button" onClick={next}>
            {STEPS[step % STEPS.length].label} (N)
          </button>
          <button
            type="button"
            onClick={() => void runBench()}
            disabled={drawnBy !== "webgl"}
          >
            Bench
          </button>
          <span>
            {renderer} · k {fit.k.toFixed(3)} · {Math.round(fit.designW)}×
            {Math.round(fit.designH)} su · res {fit.resolution.toFixed(2)}
            {scene.current &&
              ` · ${scene.current.stats.frames} frames · apply ${scene.current.stats.applyMs.toFixed(2)} ms · ${scene.current.stats.textures} textures, ${(scene.current.stats.textureBytes / 1048576).toFixed(1)} MB`}
          </span>
          {bench && (
            <span>
              Bench: commit p50 {bench.commitP50.toFixed(2)} ms, p95{" "}
              {bench.commitP95.toFixed(2)} ms, apply p95{" "}
              {bench.applyP95.toFixed(2)} ms,{" "}
              {bench.idle ? "idle after" : "still drawing"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The dom painter, roughly: card faces where the layout puts them (the game draws WP3's layer). */
function DomStandIn({
  layout,
  model,
}: {
  layout: TableLayout;
  model: TableModel;
}) {
  return (
    <>
      <div style={{ position: "absolute", inset: 0, background: "#5c605f" }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: layout.band.rect.y,
          width: 1920,
          height: layout.band.rect.h,
          background: "linear-gradient(#6e0f12, #a3161b, #6e0f12)",
        }}
      />
      {[...layout.nodes.values()].map((node) => {
        if (node.kind !== "card") return null;
        const c = model.cards.get(node.key);
        if (!c) return null;
        const hand = node.role === "hand";
        return (
          <div
            key={node.key}
            style={{
              position: "absolute",
              left: node.face.x,
              top: node.face.y,
              width: node.face.w,
              height: node.face.h,
              zIndex: Math.round(node.z / 1000),
              transform: `rotate(${node.rotation}deg)`,
              transformOrigin: hand ? "50% 100%" : "50% 50%",
              ["--card-w" as string]: `${node.face.w}px`,
              borderRadius: node.face.w * 0.045,
            }}
          >
            <CardFace
              card={node.faceUp ? c.card : { ...c.card, hidden: true }}
            />
          </div>
        );
      })}
    </>
  );
}

/** What the DOM layer will write over the canvas, so the lab's pictures read as the screen will. */
function TextStandIn({
  layout,
  model,
}: {
  layout: TableLayout;
  model: TableModel;
}) {
  const players = [
    ...(model.anchored ? [model.anchored] : []),
    ...model.opponents,
  ];
  const active = players.find((p) => p.seat === model.activeSeat);
  const text: CSSProperties = {
    position: "absolute",
    color: "#f4efe2",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    textShadow: "0 1px 2px #000",
  };
  const step = (model.step ?? model.phase ?? "").replace(/_/g, " ");
  return (
    <>
      {players.map((player) => {
        const node = layout.players.get(player.seat);
        if (!node) return null;
        const right = node.name.align === "right";
        return (
          <div key={player.seat}>
            <div
              style={{
                ...text,
                fontSize: node.name.size,
                fontWeight: 700,
                maxWidth: node.name.maxWidth,
                top: node.name.anchor.y - node.name.size,
                ...(right
                  ? { right: 1920 - node.name.anchor.x, textAlign: "right" }
                  : { left: node.name.anchor.x }),
              }}
            >
              {player.name}
            </div>
            {node.title && player.title && (
              <div
                style={{
                  ...text,
                  fontSize: node.title.size,
                  fontStyle: "italic",
                  color: "#d8d2c2",
                  maxWidth: node.title.maxWidth,
                  top: node.title.anchor.y - node.title.size,
                  ...(right
                    ? { right: 1920 - node.title.anchor.x, textAlign: "right" }
                    : { left: node.title.anchor.x }),
                }}
              >
                {player.title}
              </div>
            )}
            <div
              style={{
                ...text,
                left: node.life.cx - 40,
                width: 80,
                top: node.life.cy - node.life.side * 0.36,
                textAlign: "center",
                fontSize: node.life.side * 0.5,
                fontWeight: 800,
              }}
            >
              {player.player.life}
            </div>
            {player.anchored && node.phase && (
              <div
                style={{
                  ...text,
                  left: node.phase.caption.x,
                  top: node.phase.caption.y,
                  fontSize: 15,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  color: "#d9c8ff",
                }}
              >
                {(model.phase ?? "")
                  .replace(/_/g, " ")
                  .replace("precombat main", "first main")
                  .replace("postcombat main", "second main")}
              </div>
            )}
          </div>
        );
      })}
      <div
        style={{
          ...text,
          left: layout.band.turnText.x,
          top: layout.band.turnText.y + 6,
          fontSize: 18,
          letterSpacing: 1.5,
          textTransform: "uppercase",
        }}
      >
        Turn {model.turn} ·{" "}
        {active
          ? active.name === "You"
            ? "Your turn"
            : `${active.name}’s turn`
          : ""}
      </div>
      <div
        style={{
          ...text,
          right: 1920 - layout.band.stepText.x - layout.band.stepText.w,
          top: layout.band.stepText.y + 6,
          fontSize: 18,
          letterSpacing: 1.5,
          textTransform: "uppercase",
        }}
      >
        {step}
      </div>
      {Object.entries(layout.band.hud).map(([name, d]) =>
        d ? (
          <div
            key={name}
            style={{
              position: "absolute",
              left: d.cx - d.side / 2,
              top: d.cy - d.side / 2,
              width: d.side,
              height: d.side,
              transform: "rotate(45deg)",
              background: "#0b0b0c",
              border: "1.5px solid #e6c68c",
            }}
          />
        ) : null,
      )}
      <div
        style={{
          position: "absolute",
          left: layout.regions.column.x,
          top: layout.regions.column.y + 20,
          display: "grid",
          gap: 14,
        }}
      >
        {["Continue", "Stop Timer"].map((label) => (
          <div
            key={label}
            style={{ display: "flex", alignItems: "center", gap: 18 }}
          >
            <span
              style={{
                width: 40,
                height: 40,
                transform: "rotate(45deg)",
                background: "#0b0b0c",
                border: "2px solid #e6c68c",
                marginLeft: 10,
              }}
            />
            <span style={{ ...text, position: "static", fontSize: 22 }}>
              {label}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function HitOutlines({ layout }: { layout: TableLayout }) {
  return (
    <>
      {hitEntries(layout).map((hit) => (
        <div
          key={hit.key}
          title={hit.key}
          style={{
            position: "absolute",
            left: hit.rect.x,
            top: hit.rect.y,
            width: hit.rect.w,
            height: hit.rect.h,
            outline: "1px solid #00e5ffaa",
            outlineOffset: -1,
          }}
        />
      ))}
    </>
  );
}

const root = document.getElementById("lab");
if (root)
  createRoot(root).render(
    <StrictMode>
      <TableLab />
    </StrictMode>,
  );
