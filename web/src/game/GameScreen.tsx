import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client, type Me } from "../api";
import { useFullscreen } from "../app/fullscreen";
import {
  holdLiveGame,
  markIntendedLeave,
  useLiveGameNotice,
} from "../app/liveGame";
import { useLargeText, useMotionLevel } from "../app/motion";
import { useOnline } from "../app/online";
import { useTableSettings } from "../app/tableSettings";
import { TableSettingsForm } from "../app/TableSettingsForm";
import { UpdateNotice } from "../app/UpdateNotice";
import { GameContext, boxStyle, type GameContextValue } from "./Board";
import { CardZoom } from "./Card";
import { useGame } from "./connection";
import { InspectionPanel } from "./Inspection";
import {
  objectIndex,
  optionsByObject,
  optionsBySeat,
  playerName,
  primaryOption,
  resultText,
  words,
  type Located,
} from "./model";
import { PriorityPanel } from "./PriorityPanel";
import { PromptPanel } from "./PromptPanel";
import { useTableSound } from "./sound/useTableSound";
import { BandHud, type TurnLine } from "./table/BandHud";
import { DomLayer } from "./table/DomLayer";
import { Drawer } from "./table/Drawers";
import { useDragController } from "./table/dnd";
import { GameMenu } from "./table/GameMenu";
import { REGIONS } from "./table/geometry";
import { useTableKeys } from "./table/keys";
import { Magnifier } from "./table/Magnifier";
import { PassingNotice } from "./table/PassingNotice";
import { probeWebGL, SceneHost } from "./table/SceneHost";
import { Stage, useStageFit } from "./table/Stage";
import { TableContext, useTableContext } from "./table/TableContext";
import {
  ARM_CAP_MS,
  timerAnnouncement,
  timerKey,
  timerLive,
} from "./table/timer";
import type {
  BuildInput,
  DrawerId,
  Painter,
  SceneStatus,
  TableContextValue,
  TimerInput,
  ZoneBrowserTarget,
} from "./table/types";
import { createTableUi, useTableUi } from "./table/uiStore";
import { useTableEvents, useTableModel } from "./table/useTable";
import { useResponseTimer, useWindowAttention } from "./table/useResponseTimer";
import { ZoneContents, zoneTitle } from "./table/ZoneContents";
import type { CardView, CommandEnvelope, PromptOption, Seat } from "./types";
import styles from "./game.module.css";
import screen from "./table/screen.module.css";

// The game screen (v0.3.0, design §6): one 16:9 table in the manner of Magic Duels. The PixiJS
// scene draws the table behind a DOM layer of real, named buttons, which paint the faces
// themselves when WebGL is not there. Around the table: the band's HUD with the Game menu, the
// prompt column at the left, the drawers at the right, the magnifier, and the dialogs on top.
// Every answer still goes through answer() with the prompt and revision this render drew.

type Summary = NonNullable<Awaited<ReturnType<typeof loadSummary>>>;
async function loadSummary(gameId: string) {
  const { data } = await client.GET("/api/v1/games/{game_id}", {
    params: { path: { game_id: gameId } },
  });
  return data?.game;
}

function remembered(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function remember(key: string, value: boolean) {
  try {
    if (value) sessionStorage.setItem(key, "1");
    else sessionStorage.removeItem(key);
  } catch {
    // Storage may be unavailable; the choice then lasts for this page only.
  }
}

const ended: Record<string, string> = {
  not_live: "This game is no longer running on the server.",
  signed_out: "Your session ended. Sign in again to keep playing.",
  forbidden: "This game is not available to this account.",
  not_found: "There is no such game, or it is not yours.",
};

/** How long the band's "Full screen: F" chip stays when the table could not start in full screen. */
const FULLSCREEN_HINT_MS = 6000;

export function GameScreen({ gameId, me }: { gameId: string; me: Me | null }) {
  const sysop = me?.permissions.includes("games.view_concealed") ?? false;
  const [inspect, setInspect] = useState(
    () => sysop && remembered(`cd.inspect.${gameId}`),
  );
  const [state, connection] = useGame(gameId, inspect);
  const [summary, setSummary] = useState<Summary>();
  const [zoomed, setZoomed] = useState<{
    card: CardView;
    located?: Located;
  } | null>(null);
  const [noticeHidden, setNoticeHidden] = useState(() =>
    remembered("cd.ai-notice"),
  );
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  const [zone, setZone] = useState<ZoneBrowserTarget | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedSeat, setExpandedSeat] = useState<Seat | null>(null);
  const [sceneStatus, setSceneStatus] = useState<SceneStatus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [fullscreenHint, setFullscreenHint] = useState(false);
  const [ui] = useState(createTableUi);
  const concedeDialog = useRef<HTMLDialogElement>(null);
  const resultDialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  /** Where focus was when a drawer opened, to go back to when it closes. */
  const opener = useRef<HTMLElement | null>(null);

  const fit = useStageFit();
  const [settings, updateSettings] = useTableSettings();
  const motion = useMotionLevel(settings.animationSpeed);
  const largeText = useLargeText();
  const online = useOnline();
  const fullscreen = useFullscreen();
  const attention = useWindowAttention();
  const liveNotice = useLiveGameNotice();

  const snapshot = state.snapshot;
  const view = snapshot?.view ?? null;
  const prompt = snapshot?.prompt ?? null;
  const canAnswer =
    state.phase === "open" &&
    state.role === "controller" &&
    state.pending === null &&
    !snapshot?.result;
  // SysOp observing another player's game: the view is the owner's, but not SysOp's own.
  const observing = state.seat === null;

  // Every answer names the prompt and revision this render drew. A click or a P that lands before
  // React draws a newer prompt is then refused instead of answering a prompt nobody has seen.
  const promptId = prompt?.id ?? null;
  const revision = snapshot?.revision ?? null;
  const answer = useCallback(
    (payload: CommandEnvelope["payload"]) =>
      promptId !== null &&
      revision !== null &&
      (connection?.answer({ promptId, revision }, payload) ?? false),
    [connection, promptId, revision],
  );

  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
    document.title = "Commander Duels · Game";
    return () => {
      document.title = "Commander Duels";
    };
  }, []);
  useEffect(() => {
    let active = true;
    void loadSummary(gameId).then((game) => active && game && setSummary(game));
    return () => {
      active = false;
    };
  }, [gameId, state.ended, snapshot?.result]);
  useEffect(() => {
    if (snapshot?.result && !resultDialog.current?.open)
      resultDialog.current?.showModal();
  }, [snapshot?.result]);

  // While the game is live in this tab, it holds its lock: an update waits for it, and the
  // browser's Back keeps the game on screen (v0.3.0, PWA04).
  const live = Boolean(snapshot) && !snapshot?.result && !state.ended;
  useEffect(() => (live ? holdLiveGame(gameId) : undefined), [live, gameId]);

  // A table that opened without full screen (a reload, a typed address, the app's launch) says
  // once how to get it: F, or the band's diamond.
  useEffect(() => {
    if (
      !settings.fullscreenOnStart ||
      !fullscreen.available ||
      fullscreen.active
    )
      return;
    setFullscreenHint(true);
    const timer = window.setTimeout(
      () => setFullscreenHint(false),
      FULLSCREEN_HINT_MS,
    );
    return () => window.clearTimeout(timer);
    // Only as the table opens.
  }, []);
  useEffect(() => {
    if (fullscreen.active) setFullscreenHint(false);
  }, [fullscreen.active]);

  const context = useMemo<GameContextValue>(
    () => ({
      view,
      prompt,
      index: objectIndex(view),
      byObject: optionsByObject(prompt),
      bySeat: optionsBySeat(prompt),
      canAnswer,
      observing,
      choose: (option: PromptOption) => {
        answer({ option_id: option.id });
      },
      zoom: (card, located) => setZoomed({ card, located }),
      // The magnifier follows the pointer and keyboard focus through the table's store
      // (pointer.ts), so the old side preview has nothing left to draw.
      preview: () => {},
    }),
    [view, prompt, canAnswer, observing, answer],
  );

  // The table: its model and layout, the events since the model drawn before, and the painter.
  const input = useMemo<BuildInput | null>(
    () =>
      snapshot && view
        ? {
            gameId,
            snapshot,
            context,
            viewSeat: state.seat,
            summarySeats: summary?.seats ?? null,
            selfHandle: me?.handle ?? null,
            sysop,
          }
        : null,
    [gameId, snapshot, view, context, state.seat, summary, me?.handle, sysop],
  );
  const { model, layout } = useTableModel({
    input,
    expandedSeat,
    textScale: largeText ? 1.25 : 1,
  });
  const diff = useTableEvents(model, state.phase, snapshot?.result ?? null);
  const frame = useMemo(
    () => (model && layout && diff ? { model, layout, diff } : null),
    [model, layout, diff],
  );
  // The scene stays mounted while its context is lost, so a restored or recreated one can take
  // over again; meanwhile, and once it has failed for good, the DOM paints the table.
  const [webglAvailable] = useState(probeWebGL);
  const sceneWanted =
    settings.painter !== "dom" &&
    webglAvailable &&
    sceneStatus?.renderer !== "failed";
  const painter: Painter =
    sceneWanted && sceneStatus?.renderer !== "lost" ? "webgl" : "dom";

  // The response timer (design §12): it answers only the pass of the prompt on screen.
  const controls = state.priority ?? view?.priority ?? null;
  const timerInput: TimerInput = {
    prompt,
    revision,
    view,
    status: snapshot?.status ?? null,
    canAnswer,
    observing,
    role: state.role,
    phase: state.phase,
    pending: state.pending !== null,
    controls,
    seconds: settings.responseTimerSeconds,
    hidden: attention.hidden,
    blurred: attention.blurred,
    settledRevision:
      painter === "webgl" ? (sceneStatus?.settledRevision ?? null) : revision,
    armCapMs: motion === "none" || painter === "dom" ? 0 : ARM_CAP_MS,
  };

  // P answers the primary option (pass, done, keep or yes) unless the player is typing, and the
  // timer's expiry answers its pass. Both read the prompt on screen when they act: the layout
  // effect runs as the prompt is drawn, while a listener added again by a later effect could
  // answer the prompt drawn before it.
  const onScreen = useRef({ prompt, canAnswer, answer, timerInput });
  useLayoutEffect(() => {
    onScreen.current = { prompt, canAnswer, answer, timerInput };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "p" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, dialog[open]")) return;
      const shown = onScreen.current;
      const primary = primaryOption(shown.prompt);
      if (primary && shown.canAnswer) {
        event.preventDefault();
        shown.answer({ option_id: primary.id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const onExpire = useCallback((key: string) => {
    const shown = onScreen.current;
    const primary = primaryOption(shown.prompt);
    if (
      shown.canAnswer &&
      primary?.action === "pass" &&
      timerKey(shown.timerInput) === key
    )
      shown.answer({ option_id: primary.id });
  }, []);
  const timer = useResponseTimer(timerInput, ui, onExpire);

  // One polite voice for the table: a timer starting, a drop that did nothing.
  const say = useCallback((text: string) => {
    // The same words again are still said: a live region speaks only what changed.
    setAnnouncement((current) => (current === text ? `${text} ` : text));
  }, []);
  const announced = useRef<string | null>(null);
  useEffect(() => {
    const view = timer.view;
    if (!view || !timerLive(view.phase) || announced.current === view.key)
      return;
    announced.current = view.key;
    say(timerAnnouncement(view));
  }, [timer.view, say]);

  useTableSound({
    diff,
    layout,
    settings,
    viewSeat: state.seat,
    refusal: state.refusal,
    timer: timer.view,
  });

  const drag = useDragController({
    layout,
    fit,
    ui,
    promptKey:
      canAnswer && promptId !== null ? `${promptId}|${revision}` : null,
    choose: (option) => context.choose(option),
    openMenu: (key) => ui.set({ menu: key }),
    status: say,
    model,
  });
  const table = useMemo<TableContextValue>(
    () => ({ painter, ui, layout, model, fit, drag }),
    [painter, ui, layout, model, fit, drag],
  );

  // The drawers, one open at a time; the store knows which, so the timer stops as one opens.
  const openDrawer = (next: DrawerId | null) => {
    if (next && !drawer) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
    }
    setDrawer(next);
    setMenuOpen(false);
    if (next !== "zone") setZone(null);
  };
  useEffect(() => ui.set({ drawer }), [ui, drawer]);
  const closeDrawer = () => {
    const closing = drawer;
    setDrawer(null);
    setZone(null);
    // Back to the drawer's own diamond; a drawer without one (the zone browser, the options)
    // goes back to what opened it while that is still on screen, else to the Game menu's.
    const from = opener.current;
    const back =
      document.querySelector<HTMLElement>(
        `[data-drawer-toggle="${closing}"]`,
      ) ??
      (from?.isConnected && from !== document.body && !from.closest("[hidden]")
        ? from
        : document.querySelector<HTMLElement>("[data-menu-toggle]"));
    opener.current = null;
    back?.focus({ preventScroll: true });
  };
  const browse = (target: ZoneBrowserTarget) => {
    setZone(target);
    openDrawer("zone");
  };
  const closeMenu = (refocus: boolean) => {
    setMenuOpen(false);
    if (refocus)
      document.querySelector<HTMLElement>("[data-menu-toggle]")?.focus();
  };

  useTableKeys({
    timer,
    fullscreen,
    closeLayer: () => {
      if (drag.active) {
        drag.cancel();
        return true;
      }
      if (menuOpen) {
        closeMenu(true);
        return true;
      }
      if (drawer) {
        closeDrawer();
        return true;
      }
      if (ui.get().magnified?.level === 2) {
        ui.set({ magnified: null });
        return true;
      }
      if (expandedSeat !== null) {
        setExpandedSeat(null);
        return true;
      }
      return false;
    },
  });

  function toggleInspect(next: boolean) {
    remember(`cd.inspect.${gameId}`, next);
    setInspect(next);
  }

  const result = snapshot?.result ?? null;
  const outcome = result ? resultText(view, state.seat, result) : null;
  const format = snapshot?.settings.format ?? summary?.format;
  const concedeDisabled = state.role !== "controller" || result !== null;
  const connectionText =
    state.phase === "open"
      ? state.role === "controller"
        ? "Connected"
        : "Watching"
      : !online
        ? "Offline"
        : state.phase === "reconnecting"
          ? "Reconnecting…"
          : state.phase === "connecting"
            ? "Connecting…"
            : "Disconnected";
  const turnLine: TurnLine | null = view && {
    turn: [
      `Turn ${view.turn}`,
      view.active_seat === null
        ? null
        : view.active_seat === view.seat && !observing
          ? "Your turn"
          : `${playerName(view, view.active_seat, observing)}’s turn`,
    ]
      .filter(Boolean)
      .join(" · "),
    step: words(view.step ?? view.phase) || null,
    stepId: view.step ?? view.phase,
  };
  const leave = () => markIntendedLeave();

  const canvas = sceneWanted && (
    <SceneHost
      frame={frame}
      fit={fit}
      motion={motion}
      ui={ui}
      onStatus={setSceneStatus}
    />
  );

  return (
    <GameContext.Provider value={context}>
      <TableContext.Provider value={table}>
        <div className={styles.screen}>
          <Stage
            fit={fit}
            painter={painter}
            status={sceneStatus}
            revision={model?.revision ?? null}
            arrangement={model?.arrangement ?? null}
            opponents={view?.opponents.length ?? 0}
            keyboardLock={fullscreen.escapeLocked}
            canvas={canvas}
          >
            <h1 ref={heading} tabIndex={-1} className={styles.visuallyHidden}>
              {format === "commander" ? "Commander" : "Legacy"}
              <span> · Practice game</span>
            </h1>

            <BandHud
              layout={layout}
              sysop={sysop}
              drawer={drawer}
              onDrawer={openDrawer}
              menuOpen={menuOpen}
              onMenu={(open) => (open ? setMenuOpen(true) : closeMenu(false))}
              fullscreen={fullscreen}
              turnLine={turnLine}
              statusText={connectionText}
              statusPhase={state.phase}
            />
            <div className={screen.notes} aria-label="Table notices">
              <UpdateNotice inGame className={screen.chip} />
              {liveNotice && (
                <span role="status" className={screen.chip}>
                  {liveNotice}
                </span>
              )}
              {sceneStatus?.renderer === "lost" && sceneWanted && (
                <span role="status" className={screen.chip}>
                  Redrawing the table…
                </span>
              )}
              {fullscreenHint && (
                <span className={screen.chip} aria-hidden="true">
                  Full screen: F
                </span>
              )}
            </div>
            <GameMenu
              open={menuOpen}
              onClose={closeMenu}
              fullscreen={fullscreen}
              muted={settings.muted}
              onMute={(muted) => updateSettings({ muted })}
              onOptions={() => openDrawer("options")}
              onConcede={() => {
                closeMenu(false);
                concedeDialog.current?.showModal();
              }}
              concedeDisabled={concedeDisabled}
              onLeave={leave}
            />

            {(state.ended || state.crowded || state.interrupted || !view) && (
              <div className={screen.alerts} style={boxStyle(REGIONS.alerts)}>
                {state.ended && (
                  <div className={screen.alert} role="alert">
                    <p>{ended[state.ended] ?? "This game has ended."}</p>
                    <a
                      href="#play"
                      className={styles.secondaryButton}
                      onClick={leave}
                    >
                      Back to the table
                    </a>
                  </div>
                )}
                {state.crowded && (
                  <div className={screen.alert} role="alert">
                    <p>
                      This game is open in too many tabs. Close one, and this
                      tab connects by itself.
                    </p>
                  </div>
                )}
                {state.interrupted && (
                  <div className={screen.alert} role="alert">
                    <p>
                      The rules engine lost this game (a restart), so it cannot
                      continue. Recovery arrives in a later version.
                    </p>
                  </div>
                )}
                {!view && !state.ended && (
                  <p role="status" className={screen.setup}>
                    Setting up the table…
                  </p>
                )}
              </div>
            )}

            {model && layout && (
              <DomLayer
                model={model}
                layout={layout}
                painter={painter}
                onBrowse={browse}
                onExpand={setExpandedSeat}
              />
            )}

            <aside aria-label="Prompt and game log" className={screen.aside}>
              <div
                className={screen.column}
                style={boxStyle(REGIONS.column)}
                data-column
              >
                {fit.small && (
                  <p role="status" className={screen.small}>
                    The table is designed for a window of at least 1280 × 720.
                  </p>
                )}
                {!noticeHidden && (
                  <div className={screen.note} role="note">
                    <p>
                      <strong>Practice table.</strong> The bots still read your
                      hand while they plan (the AI audit, AI02, is not done
                      yet), so their play is not a fair test of yours.
                    </p>
                    <button
                      type="button"
                      aria-label="Dismiss the practice notice"
                      onClick={() => {
                        remember("cd.ai-notice", true);
                        setNoticeHidden(true);
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
                {state.seat !== null && (
                  <PassingNotice
                    passing={controls?.passing ?? null}
                    disabled={
                      state.role !== "controller" ||
                      state.pending !== null ||
                      result !== null
                    }
                    onStop={() =>
                      connection?.setPriority({ cancel_passes: true })
                    }
                  />
                )}
                <PromptPanel
                  state={state}
                  onAnswer={answer}
                  onTakeControl={() => connection?.takeControl()}
                  onConcede={() => concedeDialog.current?.showModal()}
                  timer={timer.view}
                  onStopTimer={timer.stop}
                />
                {result && outcome && (
                  <section
                    className={styles.result}
                    aria-labelledby="result-side-title"
                  >
                    <h2 id="result-side-title">{outcome.title}</h2>
                    <p>{outcome.detail}</p>
                    <a
                      href="#play"
                      className={styles.secondaryButton}
                      onClick={leave}
                    >
                      Back to the table
                    </a>
                  </section>
                )}
              </div>

              <Drawer
                id="priority"
                name="Priority controls"
                open={drawer === "priority"}
                closed="hidden"
                onClose={closeDrawer}
              >
                <PriorityPanel
                  state={state}
                  onSet={(priority) => connection?.setPriority(priority)}
                  showPassing={false}
                />
                {state.seat === null && (
                  <p className={styles.hint}>
                    Only the seat’s own player sets its priority.
                  </p>
                )}
              </Drawer>
              {sysop && (
                <Drawer
                  id="inspection"
                  name="Inspection"
                  open={drawer === "inspection"}
                  closed="hidden"
                  onClose={closeDrawer}
                >
                  <label className={styles.switch}>
                    <input
                      type="checkbox"
                      checked={inspect}
                      onChange={(event) => toggleInspect(event.target.checked)}
                    />
                    <span>Inspect</span>
                  </label>
                  {inspect && <InspectionPanel inspection={state.inspection} />}
                </Drawer>
              )}
              <Drawer
                id="log"
                name="Game log"
                open={drawer === "log"}
                closed="visually-hidden"
                onClose={closeDrawer}
              >
                <section className={styles.log} aria-labelledby="log-title">
                  <h2 id="log-title">Game log</h2>
                  <GameLog lines={state.log} focusable={drawer === "log"} />
                </section>
              </Drawer>
              {drawer === "options" && (
                <Drawer
                  id="options"
                  name="Table options"
                  titled
                  open
                  closed="hidden"
                  onClose={closeDrawer}
                >
                  <TableSettingsForm compact />
                </Drawer>
              )}
              {drawer === "zone" && zone && model && (
                <Drawer
                  id="zone"
                  name={zoneTitle(zone, model)}
                  titled
                  open
                  closed="hidden"
                  onClose={closeDrawer}
                >
                  <ZoneContents target={zone} model={model} />
                </Drawer>
              )}
            </aside>

            <p
              className={styles.visuallyHidden}
              aria-live="polite"
              data-announcer
            >
              {announcement}
            </p>
            <TimerStatus />

            {model && layout && (
              <Magnifier
                model={model}
                layout={layout}
                fit={fit}
                view={view}
                observing={observing}
                painter={painter}
              />
            )}
          </Stage>

          <CardZoom
            card={zoomed?.card ?? null}
            located={zoomed?.located}
            onClose={() => setZoomed(null)}
          />
          <dialog
            ref={concedeDialog}
            className={styles.confirm}
            aria-labelledby="concede-title"
          >
            <h2 id="concede-title">Concede this game?</h2>
            <p>You lose this game at once. The bots play on without you.</p>
            <form method="dialog" className={styles.confirmButtons}>
              <button
                type="submit"
                className={styles.secondaryButton}
                autoFocus
              >
                Keep playing
              </button>
              <button
                type="submit"
                className={styles.dangerButton}
                onClick={() => connection?.concede()}
              >
                Concede
              </button>
            </form>
          </dialog>
          <dialog
            ref={resultDialog}
            className={styles.confirm}
            aria-labelledby="result-title"
          >
            <h2 id="result-title">{outcome?.title}</h2>
            <p>{outcome?.detail}</p>
            <form method="dialog" className={styles.confirmButtons}>
              <button type="submit" className={styles.secondaryButton}>
                Review the board
              </button>
              <a href="#play" className={styles.primaryButton} onClick={leave}>
                Back to the table
              </a>
            </form>
          </dialog>
        </div>
      </TableContext.Provider>
    </GameContext.Provider>
  );
}

/** The response timer for the browser tests and assistive technology that reads timers: silent,
 * with the whole seconds left. The countdown itself is the ring around Continue and the bar. */
function TimerStatus() {
  const { ui } = useTableContext();
  const timer = useTableUi(ui, (s) => s.timer);
  if (!timer) return null;
  return (
    <div
      role="timer"
      aria-label="Response timer"
      className={styles.visuallyHidden}
      data-timer={timer.phase}
      data-remaining={Math.ceil(timer.remainingMs / 1000)}
    >
      {Math.ceil(timer.remainingMs / 1000)}
    </div>
  );
}

function GameLog({
  lines,
  focusable,
}: {
  lines: { index: number; turn: number; text: string }[];
  focusable: boolean;
}) {
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const element = list.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <ol
      ref={list}
      role="log"
      className={styles.logLines}
      // Closed, the log is only visually hidden so that it keeps announcing; it is no Tab stop.
      tabIndex={focusable ? 0 : -1}
      aria-label="Game log"
      onScroll={(event) => {
        const element = event.currentTarget;
        stick.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {lines.length === 0 && <li className={styles.hint}>Nothing yet.</li>}
      {lines.slice(-120).map((line) => (
        <li key={line.index}>
          <span>T{line.turn}</span> {line.text}
        </li>
      ))}
    </ol>
  );
}
