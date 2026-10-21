import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureInput, tableFixture } from "./fixtures";
import { layoutTable } from "./layout";
import { SceneHost, probeWebGL } from "./SceneHost";
import { stageFit } from "./stage";
import { buildTableModel } from "./tableModel";
import type {
  CreateTableScene,
  MotionLevel,
  SceneFrame,
  SceneStats,
  SceneStatus,
  StageFit,
  TableScene,
} from "./types";
import { createTableUi } from "./uiStore";

class FakeScene implements TableScene {
  readonly stats: SceneStats = {
    frames: 0,
    applyMs: 0,
    textures: 0,
    textureBytes: 0,
    pending: 0,
  };
  readonly commits: SceneFrame[] = [];
  readonly fits: StageFit[] = [];
  readonly motions: MotionLevel[] = [];
  destroyed = false;
  private current: SceneStatus = {
    renderer: "webgl",
    webgl: 2,
    drawnRevision: null,
    settledRevision: null,
  };
  private readonly listeners = new Set<(status: SceneStatus) => void>();
  readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }
  commit(frame: SceneFrame) {
    this.commits.push(frame);
  }
  resize(fit: StageFit) {
    this.fits.push(fit);
  }
  setMotion(motion: MotionLevel) {
    this.motions.push(motion);
  }
  status() {
    return this.current;
  }
  subscribe(listener: (status: SceneStatus) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(renderer: SceneStatus["renderer"]) {
    this.current = { ...this.current, renderer };
    for (const listener of this.listeners) listener(this.current);
  }
  destroy() {
    this.destroyed = true;
  }
}

function factory() {
  const made: FakeScene[] = [];
  const create = vi.fn<CreateTableScene>(async (canvas) => {
    const scene = new FakeScene(canvas);
    made.push(scene);
    return scene;
  });
  return { create, made };
}

function frame(name: "duel" | "three" = "duel"): SceneFrame {
  const model = buildTableModel(fixtureInput(tableFixture(name)));
  return {
    model,
    layout: layoutTable(model, { expandedSeat: null, textScale: 1 }),
    diff: { baseline: true, events: [] },
  };
}

const fit = stageFit(1920, 1080, 1);
const ui = createTableUi();
const flush = () => act(async () => {});

afterEach(() => {
  vi.useRealTimers();
});

describe("the scene's host", () => {
  it("never shares a canvas between StrictMode's two mounts, and destroys the first scene", async () => {
    const { create, made } = factory();
    const shown = frame();
    const view = render(
      <StrictMode>
        <SceneHost
          frame={shown}
          fit={fit}
          motion="normal"
          ui={ui}
          create={create}
          onStatus={() => {}}
        />
      </StrictMode>,
    );
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(made[0].canvas).not.toBe(made[1].canvas);
    expect(made[0].destroyed).toBe(true);
    expect(made[1].destroyed).toBe(false);
    const canvases = view.container.querySelectorAll("canvas");
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toBe(made[1].canvas);
    expect(canvases[0]).toHaveAttribute("aria-hidden", "true");
    expect(made[0].commits).toHaveLength(0);
    expect(made[1].commits).toEqual([shown]);
  });

  it("reports the scene's status and commits each new frame", async () => {
    const { create, made } = factory();
    const onStatus = vi.fn();
    const first = frame();
    const view = render(
      <SceneHost
        frame={first}
        fit={fit}
        motion="normal"
        ui={ui}
        create={create}
        onStatus={onStatus}
      />,
    );
    await flush();
    expect(onStatus.mock.calls.map(([s]) => s.renderer)).toEqual([
      "starting",
      "webgl",
    ]);
    const next = frame("three");
    view.rerender(
      <SceneHost
        frame={next}
        fit={fit}
        motion="faster"
        ui={ui}
        create={create}
        onStatus={onStatus}
      />,
    );
    expect(made[0].commits).toEqual([first, next]);
    expect(made[0].motions.at(-1)).toBe("faster");
  });

  it("removes its canvas and destroys the scene when it unmounts", async () => {
    const { create, made } = factory();
    const view = render(
      <SceneHost
        frame={null}
        fit={fit}
        motion="normal"
        ui={ui}
        create={create}
        onStatus={() => {}}
      />,
    );
    await flush();
    view.unmount();
    expect(made[0].destroyed).toBe(true);
    expect(made[0].canvas.isConnected).toBe(false);
  });

  it("says the scene failed when WebGL cannot start", async () => {
    const onStatus = vi.fn();
    render(
      <SceneHost
        frame={null}
        fit={fit}
        motion="normal"
        ui={ui}
        create={() => Promise.reject(new Error("No WebGL"))}
        onStatus={onStatus}
      />,
    );
    await flush();
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer: "failed" }),
    );
  });

  it("keeps a scene whose context comes back within 3 seconds", async () => {
    vi.useFakeTimers();
    const { create, made } = factory();
    const onStatus = vi.fn();
    render(
      <SceneHost
        frame={frame()}
        fit={fit}
        motion="normal"
        ui={ui}
        create={create}
        onStatus={onStatus}
      />,
    );
    await flush();
    act(() => made[0].emit("lost"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    act(() => made[0].emit("webgl"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls.map(([s]) => s.renderer)).toEqual([
      "starting",
      "webgl",
      "lost",
      "webgl",
    ]);
  });

  it("recreates a lost scene after 3 seconds, at most three times in five minutes", async () => {
    vi.useFakeTimers();
    const { create, made } = factory();
    const onStatus = vi.fn();
    const shown = frame();
    render(
      <SceneHost
        frame={shown}
        fit={fit}
        motion="normal"
        ui={ui}
        create={create}
        onStatus={onStatus}
      />,
    );
    await flush();
    for (let i = 0; i < 3; i++) {
      act(() => made[i].emit("lost"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_999);
      });
      expect(create).toHaveBeenCalledTimes(i + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(create).toHaveBeenCalledTimes(i + 2);
      expect(made[i].destroyed).toBe(true);
      // The new scene draws what is on screen.
      expect(made[i + 1].commits).toEqual([shown]);
    }
    act(() => made[3].emit("lost"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(create).toHaveBeenCalledTimes(4);
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ renderer: "failed" }),
    );
  });

  it("does not probe WebGL in jsdom", () => {
    expect(probeWebGL()).toBe(false);
  });
});
