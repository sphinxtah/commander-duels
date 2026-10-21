import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CreateTableScene,
  SceneFrame,
  SceneHostProps,
  SceneStatus,
  TableScene,
} from "./types";

// The PixiJS table's host (design §11): a full-viewport canvas behind the DOM layer, aria-hidden
// and taking no pointer events. The scene's code, PixiJS with it, is imported only when a host
// mounts, so no page without a table ever loads it. Each mount makes its own canvas, so React's
// StrictMode double mount never shares a WebGL context between two scenes, and a scene that
// finishes starting after its host has gone is destroyed at once.
//
// A lost context the browser does not restore within 3 s gets a new canvas and scene, at most
// three times in five minutes; after that the status stays "failed" and the game screen draws
// the table with the DOM.
//
// A frame is committed when it says something new: a new frame object whose model, layout and
// diff are the very ones already committed (the screen re-rendered for another reason) is not
// sent again, so its events never play twice.

const RESTORE_MS = 3_000;
const RECREATIONS = 3;
const RECREATION_WINDOW_MS = 5 * 60_000;

function sameFrame(a: SceneFrame | null, b: SceneFrame): boolean {
  return (
    a !== null &&
    a.model === b.model &&
    a.layout === b.layout &&
    a.diff === b.diff
  );
}

let probed: boolean | null = null;

/** Whether this browser can start WebGL at all. jsdom cannot, and is not asked: it would only
 * log that canvases are not implemented. */
export function probeWebGL(): boolean {
  if (probed !== null) return probed;
  probed = false;
  if (typeof document === "undefined" || /jsdom/i.test(navigator.userAgent))
    return probed;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ??
      canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl) {
      probed = true;
      // Give the probe's context back at once: browsers allow only a few at a time.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    probed = false;
  }
  return probed;
}

const lazyCreate: CreateTableScene = (canvas, init) =>
  import("../scene/createTableScene").then((scene) =>
    scene.createTableScene(canvas, init),
  );

const STARTING: SceneStatus = {
  renderer: "starting",
  webgl: null,
  drawnRevision: null,
  settledRevision: null,
};

export function SceneHost({
  frame,
  fit,
  motion,
  ui,
  create,
  onStatus,
}: SceneHostProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<TableScene | null>(null);
  /** What the current scene was last given. */
  const committed = useRef<SceneFrame | null>(null);
  const latest = useRef({ frame, fit, motion, onStatus });
  const [generation, setGeneration] = useState(0);
  const recreations = useRef<number[]>([]);
  const gaveUp = useRef(false);

  useLayoutEffect(() => {
    latest.current = { frame, fit, motion, onStatus };
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent || gaveUp.current) return;
    let cancelled = false;
    let made: TableScene | null = null;
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => {};
    const report = (status: SceneStatus) => latest.current.onStatus(status);

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.dataset.tableCanvas = "";
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      display: "block",
      pointerEvents: "none",
    });
    parent.appendChild(canvas);
    // A recreated scene keeps reporting "lost" until it draws; only the first one starts.
    if (generation === 0) report(STARTING);

    const handle = (status: SceneStatus) => {
      if (status.renderer === "lost") {
        lostTimer ??= setTimeout(() => {
          lostTimer = undefined;
          if (cancelled) return;
          const now = Date.now();
          recreations.current = recreations.current.filter(
            (at) => now - at < RECREATION_WINDOW_MS,
          );
          if (recreations.current.length >= RECREATIONS) {
            gaveUp.current = true;
            report({ ...status, renderer: "failed" });
            return;
          }
          recreations.current.push(now);
          setGeneration((g) => g + 1);
        }, RESTORE_MS);
      } else if (lostTimer !== undefined) {
        clearTimeout(lostTimer);
        lostTimer = undefined;
      }
      report(status);
    };

    const { fit: startFit, motion: startMotion } = latest.current;
    (create ?? lazyCreate)(canvas, {
      fit: startFit,
      motion: startMotion,
      ui,
    }).then(
      (started) => {
        if (cancelled) {
          started.destroy();
          return;
        }
        made = started;
        scene.current = started;
        committed.current = null;
        unsubscribe = started.subscribe(handle);
        // Whatever changed while it started, it draws what is on screen now.
        const now = latest.current;
        started.resize(now.fit);
        started.setMotion(now.motion);
        if (now.frame) {
          committed.current = now.frame;
          started.commit(now.frame);
        }
        handle(started.status());
      },
      () => {
        if (cancelled) return;
        gaveUp.current = true;
        report({ ...STARTING, renderer: "failed" });
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(lostTimer);
      unsubscribe();
      if (made) {
        made.destroy();
        if (scene.current === made) {
          scene.current = null;
          committed.current = null;
        }
      }
      canvas.remove();
    };
  }, [generation, create, ui]);

  useLayoutEffect(() => {
    const current = scene.current;
    if (!frame || !current || sameFrame(committed.current, frame)) return;
    committed.current = frame;
    current.commit(frame);
  }, [frame]);
  useLayoutEffect(() => {
    scene.current?.resize(fit);
  }, [fit]);
  useEffect(() => {
    scene.current?.setMotion(motion);
  }, [motion]);

  return (
    <div
      ref={host}
      aria-hidden="true"
      data-scene-host=""
      style={{ position: "fixed", inset: 0, pointerEvents: "none" }}
    />
  );
}
