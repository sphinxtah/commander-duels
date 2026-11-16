import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { client, type Me } from "../api";
import { NOTHING_EARNED, restartSandbox } from "../decks/sandbox";
import {
  ReportMessageDialog,
  type ReportedMessage,
} from "../chat/ReportMessage";
import { useFullscreen } from "../app/fullscreen";
import {
  holdLiveGame,
  markIntendedLeave,
  useLiveGameNotice,
} from "../app/liveGame";
import { useLargeText, useMotionLevel } from "../app/motion";
import { useOnline } from "../app/online";
import { useWorkflow } from "../app/rollout";
import { ReportDialog } from "../app/ReportProblem";
import { useTableSettings } from "../app/tableSettings";
import { TableSettingsForm } from "../app/TableSettingsForm";
import { UpdateNotice } from "../app/UpdateNotice";
import { useChatContext } from "../chat/chat";
import { settingsLine } from "../tables/kingsTable";
import {
  ConcedeMatchDialog,
  MatchChip,
  MatchOutcome,
  matchLink,
  useFollowMatch,
} from "../matches/GameMatch";
import { campaignLink } from "../campaign/campaign";
import { CampaignLayer } from "../campaign/CampaignLayer";
import { RematchPanel, useRematch } from "../queues/Rematch";
import { TableFitPanel, useTableFit } from "../tables/TableFit";
import { AwayPlayers } from "./AwayPlayers";
import { GameContext, boxStyle, type GameContextValue } from "./Board";
import { CardZoom } from "./Card";
import { useGame, type GameState } from "./connection";
import { InspectionPanel } from "./Inspection";
import { PassiveBots } from "./PassiveBots";
import {
  objectIndex,
  optionsByObject,
  optionsBySeat,
  playerName,
  players,
  primaryOption,
  resultText,
  turnHolder,
  words,
  type Located,
} from "./model";
import { PriorityPanel } from "./PriorityPanel";
import { SaveDialog } from "./saves";
import { SuspendDialog, SuspensionVote } from "./Suspension";
import { PromptPanel } from "./PromptPanel";
import { COACHING, CoachDialog, endCoaching } from "./Coaching";
import { delayWords, seenFrom, watchedPlayers } from "./spectating";
import { useGameMusic } from "./music/useGameMusic";
import { useTableSound } from "./sound/useTableSound";
import { AllianceContext, type TableAlliances } from "./table/Alliance";
import { BandHud, type TurnLine } from "./table/BandHud";
import { allianceSeats, type Channel, type ChatPeople } from "./table/chat";
import { DomLayer } from "./table/DomLayer";
import { Drawer } from "./table/Drawers";
import { useDragController } from "./table/dnd";
import { GameMenu } from "./table/GameMenu";
import { useWhatChanged } from "../timeline/chip";
import { Timeline, type TimelineSeat } from "../timeline/Timeline";
import { COMPACT_PILE_CAP, REGIONS } from "./table/geometry";
import { useTableKeys } from "./table/keys";
import { Magnifier } from "./table/Magnifier";
import { PassingNotice } from "./table/PassingNotice";
import { SpectatorChat } from "./table/SpectatorChat";
import { probeWebGL, SceneHost } from "./table/SceneHost";
import { Stage, useStageFit } from "./table/Stage";
import { TableChat, useChatReading } from "./table/TableChat";
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
import type {
  CardView,
  CommandEnvelope,
  PromptOption,
  Seat,
  Snapshot,
} from "./types";
import { loadCardBack } from "./cardBack";
import styles from "./game.module.css";
import screen from "./table/screen.module.css";

// The game screen (v0.3.0, design §6): one 16:9 table. The PixiJS
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
  saved:
    "This game is saved. It waits under Saved games on Your games: resume it there to play on from where it stopped.",
  savedDuel:
    "This duel is saved. It waits on the campaign's map and under Saved games on Your games: resume it from either to play on from where it stopped.",
  signed_out: "Your session ended. Sign in again to keep playing.",
  forbidden: "This game is not available to this account.",
  not_found: "There is no such game, or it is not yours.",
};

/** A reconnect is said in words once it has taken this long (v1.0.0). */
const RECONNECT_SAID_MS = 2500;
/** How long "Recovered after a restart" stays on the table. */
const RECOVERED_SHOWN_MS = 12_000;
/** How long the band's "Full screen: F" chip stays when the table could not start in full screen. */
const FULLSCREEN_HINT_MS = 6000;

export function GameScreen({
  gameId,
  me,
  scripted = null,
  overlay,
}: {
  gameId: string;
  me: Me | null;
  /** A scripted game's state (the tutorial's watched game, v0.8.4): drawn as a live game is, with
   * no connection, no summary and nothing to answer. */
  scripted?: GameState | null;
  /** What a scripted game draws over the table: its narration. */
  overlay?: ReactNode;
}) {
  // Concealed information (every hand and library): SysOp's in any game, and since v0.8.9 an
  // administrator's in a game they do not play with another person, as the summary says.
  const conceals =
    !scripted && (me?.permissions.includes("games.view_concealed") ?? false);
  const root = conceals && me?.kind === "sysop";
  const [inspect, setInspect] = useState(
    () => root && remembered(`cd.inspect.${gameId}`),
  );
  const [liveState, connection] = useGame(scripted ? null : gameId, inspect);
  const state = scripted ?? liveState;
  const [summary, setSummary] = useState<Summary>();
  const sysop = root || (conceals && summary?.inspectable === true);
  // A spectator (v1.0.0, docs/tables.md): the game's public view, drawn from behind the player
  // they choose, with nothing to act on. The connection's welcome says so, and so does the
  // summary, which also says how far behind the game they watch.
  const spectating =
    !scripted && (state.spectating || summary?.spectating === true);
  const [behind, setBehind] = useState<Seat | null>(null);
  // A coach (v1.0.0, docs/games.md): the view of the seat whose player lets them see it, with
  // nothing to act on. And for a player, where coaching is open to the account: the dialog to
  // take a friend as their coach, or to end it.
  const coaching = scripted
    ? null
    : (state.coaching ?? summary?.coaching ?? null);
  const coachingAllowed = useWorkflow(COACHING);
  const [coachOpen, setCoachOpen] = useState(false);
  const [zoomed, setZoomed] = useState<{
    card: CardView;
    located?: Located;
  } | null>(null);
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  const [zone, setZone] = useState<ZoneBrowserTarget | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // "Report a problem" from the Game menu (v0.4.1): the report names this game and its turn.
  const [reporting, setReporting] = useState(false);
  // At a human table (v0.4.4): the chat's tab, and a line being reported.
  const [chatTab, setChatTab] = useState<Channel>("table");
  const [reportedLine, setReportedLine] = useState<ReportedMessage | null>(
    null,
  );
  const [expandedSeat, setExpandedSeat] = useState<Seat | null>(null);
  const [sceneStatus, setSceneStatus] = useState<SceneStatus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [fullscreenHint, setFullscreenHint] = useState(false);
  const [ui] = useState(createTableUi);
  const concedeDialog = useRef<HTMLDialogElement>(null);
  const concedeMatchDialog = useRef<HTMLDialogElement>(null);
  // "Save and leave" (v1.0.0, saves.tsx), where save and resume is open to the account.
  const saveDialog = useRef<HTMLDialogElement>(null);
  const suspendDialog = useRef<HTMLDialogElement>(null);
  // A sandbox game's Restart (v1.0.0): the game is closed and its setup played again.
  const restartDialog = useRef<HTMLDialogElement>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState("");
  const saving = useWorkflow("save_resume");
  // "Watch the replay" on the result (v1.0.0, ../replay), where replays are open to the account.
  const replays = useWorkflow("replays");
  // "Review the board" after a match's game keeps the screen here instead of going on to
  // sideboarding (v0.5.0).
  const [reviewing, setReviewing] = useState(false);
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

  // At a human table (v0.4.0) a player sees the others by their handles, not the engine's
  // "Human 2": the view's names are swapped before anything draws them.
  const snapshot = useMemo(
    () =>
      spectating
        ? seenFrom(state.snapshot, behind, summary?.seats ?? null)
        : coaching !== null
          ? // The coached seat's own view, its players named by their handles.
            seenFrom(state.snapshot, null, summary?.seats ?? null)
          : withHandles(state.snapshot, summary, state.seat),
    [state.snapshot, summary, state.seat, spectating, behind, coaching],
  );
  const shown = useMemo(
    () => (snapshot === state.snapshot ? state : { ...state, snapshot }),
    [state, snapshot],
  );
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
  // The card back the player chose from the campaign's rewards (v0.8.8), asked for once.
  useEffect(() => {
    if (!scripted) loadCardBack();
  }, [scripted]);
  // The summary again once the game ends, and until the API has recorded the end: it then holds
  // the tokens the game paid (v0.4.0).
  const [summaryTries, setSummaryTries] = useState(0);
  useEffect(() => {
    if (scripted) return;
    let active = true;
    void loadSummary(gameId).then((game) => active && game && setSummary(game));
    return () => {
      active = false;
    };
  }, [gameId, state.ended, snapshot?.result, summaryTries]);
  const unrecorded = Boolean(snapshot?.result) && summary?.status === "active";
  useEffect(() => {
    if (!unrecorded || summaryTries >= 20) return;
    const timer = window.setTimeout(() => setSummaryTries((n) => n + 1), 1000);
    return () => window.clearTimeout(timer);
  }, [unrecorded, summaryTries]);
  useEffect(() => {
    if (snapshot?.result && !resultDialog.current?.open)
      resultDialog.current?.showModal();
  }, [snapshot?.result]);

  // While the game is live in this tab, it holds its lock: an update waits for it, and the
  // browser's Back keeps the game on screen (v0.3.0, PWA04).
  const live = Boolean(snapshot) && !snapshot?.result && !state.ended;
  useEffect(
    () => (live && !scripted ? holdLiveGame(gameId) : undefined),
    [live, gameId, scripted],
  );
  // A reconnect that takes more than a moment is said in words (v1.0.0), beside the band's chip:
  // a short drop comes and goes unnoticed.
  const [stalled, setStalled] = useState(false);
  const reconnecting = state.phase === "reconnecting" && !state.crowded;
  useEffect(() => {
    if (!reconnecting) {
      setStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), RECONNECT_SAID_MS);
    return () => window.clearTimeout(timer);
  }, [reconnecting]);
  // "Recovered after a restart" stays a while, then goes.
  useEffect(() => {
    if (!state.recovered) return;
    const timer = window.setTimeout(
      () => connection?.acknowledgeRecovered(),
      RECOVERED_SHOWN_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state.recovered, connection]);

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
      chooseBatch: (batch) => {
        answer({ batch });
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
            selfPortrait: me?.alliance ?? null,
            sysop,
            spectating,
          }
        : null,
    [
      gameId,
      snapshot,
      view,
      context,
      state.seat,
      summary,
      me?.handle,
      me?.alliance,
      sysop,
      spectating,
    ],
  );
  const { model, layout } = useTableModel({
    input,
    expandedSeat,
    textScale: largeText ? 1.25 : 1,
    pileCap: settings.reducedClutter ? COMPACT_PILE_CAP : undefined,
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
      // A held key repeats: each repeat would answer the next prompt as it appears (v0.8.3).
      if (event.repeat) return;
      if (
        event.key.toLowerCase() !== "p" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const target = event.target as HTMLElement;
      // Nor in the chat bar (v0.5.1), whose keys are its own.
      if (
        target.closest("input, textarea, select, dialog[open], [data-chat-bar]")
      )
        return;
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
  // The gameplay music (v0.7.2), while the game is live; it fades out as the result comes.
  useGameMusic({ live, settings });

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

  // A human table's game (v0.4.0): players go by their handles, the others play on after a
  // concession, and leaving goes back to the lobby.
  const atTable = summary?.kind === "table";
  const seatName = (seat: number) =>
    (atTable
      ? summary?.seats.find((entry) => entry.seat === seat)?.handle
      : null) ?? playerName(view, seat, observing);
  // The timeline (v1.0.0, docs/timeline.md): in its own drawer, behind the diamond beside the
  // log's, while the game runs and once it is over; a scripted game has no events to read. After
  // a large resolution a chip offers "What changed?", which opens the timeline at its summary.
  // Nor has a spectator (v1.0.0): the timeline is its players'. A coach reads it while the game
  // runs, as the seat they coach does, and no longer once it is over.
  const hasTimeline = !scripted && !spectating && (coaching === null || live);
  const [timelineFocus, setTimelineFocus] = useState<number | null>(null);
  const timelineSeats = useMemo<TimelineSeat[]>(() => {
    // By name, never "You": the timeline's sentences say whose a card is ("Ada’s graveyard").
    const players = view ? [view.you, ...view.opponents] : [];
    const seats = new Set<number>([
      ...(summary?.seats.map((entry) => entry.seat) ?? []),
      ...players.flatMap((player) => (player ? [player.seat] : [])),
    ]);
    return [...seats]
      .sort((a, b) => a - b)
      .map((seat) => ({
        seat,
        name:
          summary?.seats.find((entry) => entry.seat === seat)?.handle ??
          players.find((player) => player?.seat === seat)?.name ??
          `Player ${seat + 1}`,
        you: seat === state.seat,
      }));
  }, [summary, view, state.seat]);
  const changed = useWhatChanged(
    gameId,
    view,
    hasTimeline && live && drawer !== "timeline",
  );
  // A summary asked for from the chip is opened once: the drawer opened again starts at its end.
  useEffect(() => {
    if (drawer !== "timeline") setTimelineFocus(null);
  }, [drawer]);
  // The engine names players by kind and seat ("Human 2" sits in seat 1); its log lines say the
  // handles instead at a table.
  const handlesInLog = (text: string) =>
    text.replace(/\bHuman ([1-4])\b/g, (words, number: string) => {
      const entry = summary?.seats.find((s) => s.seat === Number(number) - 1);
      return entry?.player === "human" && entry.handle ? entry.handle : words;
    });

  // A human table's chat and alliances (v0.4.4, docs/chat.md): the chat in its drawer behind the
  // band's diamond, and the alliances on the plates. The history the server sends a table's
  // connection says it is one before the summary does; a practice game has neither.
  // A spectator (v1.0.0) has neither: the spectators talk among themselves, in the same drawer.
  // Nor has a coach, who advises in the friends' chat.
  const chatting =
    (atTable || state.chat !== null) && !spectating && coaching === null;
  const spectatorChat = spectating && state.chat !== null;
  // Friends' chat (v0.5.1): the chat bar, folded away into its own diamond on the band at every
  // table, and brought out over the table on demand (chat/ChatBar.tsx).
  const friendsChat = useChatContext();
  const people = useMemo<ChatPeople>(
    () => ({
      seat: state.seat,
      userId: me?.id ?? null,
      handle: (seat) =>
        summary?.seats.find((entry) => entry.seat === seat)?.handle ??
        playerName(view, seat, true),
    }),
    [state.seat, me?.id, summary, view],
  );
  const unread = useChatReading({
    chat: state.chat,
    outbox: state.outbox,
    refusal: state.allianceRefusal,
    people,
    reading:
      drawer !== "chat"
        ? null
        : chatting
          ? chatTab
          : spectatorChat
            ? "spectators"
            : null,
    say,
  });
  const lost = useMemo(
    () =>
      new Set(
        view
          ? players(view)
              .filter((player) => player.lost)
              .map((player) => player.seat)
          : [],
      ),
    [view],
  );
  // Saved to be played on later (v1.0.0), here or in another tab, or found saved on arriving: it
  // has not ended, so it has no result screen and no rematch.
  const savedGame = state.ended === "saved" || summary?.status === "saved";
  const over =
    (Boolean(snapshot?.result) || state.ended !== null) && !savedGame;
  // The result screen's Rematch (v0.5.0), once the game's end is recorded.
  const rematch = useRematch(gameId, summary, over);
  // How the table fit what its host described (v1.0.0, Rule Zero): one optional question on a
  // table game's result, for one who played in it, once the game's end is recorded.
  const tableFit = useTableFit(
    gameId,
    over &&
      summary?.kind === "table" &&
      summary.your_seat !== null &&
      summary.status === "finished",
  );
  const alliances = useMemo<TableAlliances | null>(
    () =>
      chatting
        ? {
            mine: state.seat,
            alliances: state.alliances,
            open: allianceSeats({
              mine: state.seat,
              seats: summary?.seats ?? null,
              presence: state.presence?.seats ?? null,
              lost,
              finished: over,
            }),
            handle: people.handle,
            act: (action, seat) => connection?.alliance(action, seat),
          }
        : null,
    [
      chatting,
      state.seat,
      state.alliances,
      state.presence,
      summary,
      lost,
      over,
      people,
      connection,
    ],
  );

  const result = snapshot?.result ?? null;
  const outcome = result
    ? resultText(view, state.seat, result, seatName)
    : null;
  const format = snapshot?.settings.format ?? summary?.format;
  // King's Table (v0.8.7): the settings, which the game menu shows for the whole game.
  const kingsSettings =
    snapshot?.settings.kings_table ?? summary?.kings_table ?? null;
  // A best-of-three match's game (v0.5.0): the score on the table, and once the game is recorded
  // the way on to sideboarding, which the screen follows by itself.
  const match = summary?.match ?? null;
  const following = useFollowMatch(
    match,
    summary !== undefined && summary.status !== "active",
    !reviewing && state.seat !== null,
  );
  // A rematch replays a whole match, so none is offered while the match goes on.
  const matchGoesOn =
    match !== null &&
    (match.status === "playing" || match.status === "sideboarding");
  // A public queue's game (v0.5.0) leads back to the queue, as its rematch does; a campaign duel
  // (v0.8.0) back to the campaign, to its scene.
  const campaign = summary?.campaign ?? null;
  // A spectator's (v1.0.0) back to the lobby, whose "Watch a game" lists what they may watch.
  const back = spectating
    ? { href: "#tables", text: "Back to the lobby" }
    : campaign
      ? { href: campaignLink(gameId), text: "Back to the campaign" }
      : match
        ? matchLink(match)
        : rematch.view?.origin === "queue"
          ? { href: "#find", text: "Find another game" }
          : atTable
            ? { href: "#tables", text: "Back to the lobby" }
            : { href: "#play", text: "Back to the table" };
  const paid =
    summary?.status === "finished" && summary.tokens ? summary.tokens : null;
  // A sandbox game (v1.0.0) says on its result that it earned nothing, and why.
  const tokensLine = summary?.sandbox
    ? "A sandbox game: nothing was earned, and nothing is in your record."
    : paid !== null
      ? `This game paid you ${paid.toLocaleString()} tokens.`
      : null;
  // A player who comes back after the API stopped following the game sees how it ended.
  const recordedOutcome =
    state.ended === "not_live" && summary?.result
      ? resultText(view, summary.your_seat, summary.result, seatName)
      : null;
  const concedeDisabled = state.role !== "controller" || result !== null;
  // Its own player saves a single game against the bots (v1.0.0): not a table's, not a match's.
  const canSave =
    saving &&
    !scripted &&
    !atTable &&
    match === null &&
    summary?.kind === "practice" &&
    state.seat !== null &&
    state.role === "controller" &&
    live;
  // A private table's single game is suspended by its players together (v1.0.0): any player
  // still in it proposes, where no proposal stands already.
  const tableCode = state.savedTable ?? summary?.table?.code ?? null;
  const canSuspend =
    saving &&
    !scripted &&
    atTable &&
    summary?.table?.suspendable === true &&
    state.seat !== null &&
    state.phase === "open" &&
    live &&
    state.suspension === null &&
    state.presence?.seats.find((entry) => entry.seat === state.seat)?.left ==
      null;
  // A game the engine could not give back (v0.9.9): told as it happens, and to a player who
  // comes back to it later.
  const unrecoverable =
    state.interrupted ||
    (state.ended === "not_live" && summary?.status === "interrupted");
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
    turn: [`Turn ${view.turn}`, turnHolder(view, observing, seatName)]
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
      effects={settings.effects}
      ui={ui}
      onStatus={setSceneStatus}
    />
  );

  return (
    <GameContext.Provider value={context}>
      <TableContext.Provider value={table}>
        <AllianceContext.Provider value={alliances}>
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
                {format === "commander"
                  ? "Commander"
                  : format === "two_headed_giant"
                    ? "Two-Headed Giant"
                    : format === "kings_table"
                      ? "King’s Table"
                      : "Legacy"}
                <span>
                  {scripted
                    ? " · Guided game"
                    : atTable
                      ? " · Table game"
                      : campaign
                        ? ` · Campaign: ${campaign.title}`
                        : " · Practice game"}
                </span>
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
                timeline={hasTimeline}
                chat={
                  chatting
                    ? { unread: unread.table + unread.allies }
                    : spectatorChat
                      ? { unread: unread.spectators, name: "Spectators’ chat" }
                      : null
                }
                friends={
                  friendsChat && {
                    unread: friendsChat.unread,
                    open: friendsChat.tableOpen,
                    onToggle: () =>
                      friendsChat.setTableOpen(!friendsChat.tableOpen),
                  }
                }
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
                {state.recovered && (
                  <span role="status" className={screen.chip}>
                    Recovered after a restart: the game goes on where it stood
                  </span>
                )}
                {changed.offer && (
                  // Said to a screen reader as it appears, as the other notices are.
                  <span role="status">
                    <button
                      type="button"
                      className={`${screen.chip} ${screen.chipButton}`}
                      aria-controls="drawer-timeline"
                      onClick={() => {
                        setTimelineFocus(changed.offer?.seq ?? null);
                        changed.dismiss();
                        openDrawer("timeline");
                      }}
                    >
                      What changed?{" "}
                      <span className={styles.visuallyHidden}>
                        After {changed.offer.source} resolved. Opens the
                        timeline.
                      </span>
                    </button>
                  </span>
                )}
                {match && <MatchChip match={match} seat={state.seat} />}
                {coaching !== null && (
                  <span role="status" className={screen.chip} data-coaching>
                    Coaching {seatName(coaching)}: you see what they see, and
                    cannot act
                  </span>
                )}
                {state.coaches
                  .filter((coach) => coach.seat !== coaching)
                  .map((coach) => (
                    <span
                      key={coach.seat}
                      role="status"
                      className={screen.chip}
                      data-coached={coach.seat}
                    >
                      {coach.seat === state.seat
                        ? `Your coach: ${coach.handle ?? "a friend"}`
                        : `${seatName(coach.seat)} has a coach: ${coach.handle ?? "a friend"}`}
                    </span>
                  ))}
                {spectating && (
                  <span role="status" className={screen.chip} data-spectating>
                    Spectating
                    {summary?.spectating
                      ? ` · ${delayWords(summary.spectator_delay)}`
                      : ""}
                  </span>
                )}
              </div>
              <GameMenu
                open={menuOpen}
                onClose={closeMenu}
                fullscreen={fullscreen}
                muted={settings.muted}
                onMute={(muted) => updateSettings({ muted })}
                musicMuted={settings.musicMuted}
                onMuteMusic={(musicMuted) => updateSettings({ musicMuted })}
                onOptions={() => openDrawer("options")}
                onReport={() => {
                  closeMenu(false);
                  setReporting(true);
                }}
                onConcede={() => {
                  closeMenu(false);
                  concedeDialog.current?.showModal();
                }}
                concedeDisabled={concedeDisabled}
                onConcedeMatch={
                  match?.status === "playing"
                    ? () => {
                        closeMenu(false);
                        concedeMatchDialog.current?.showModal();
                      }
                    : undefined
                }
                onSave={
                  canSave
                    ? () => {
                        closeMenu(false);
                        saveDialog.current?.showModal();
                      }
                    : undefined
                }
                onSuspend={
                  canSuspend
                    ? () => {
                        closeMenu(false);
                        suspendDialog.current?.showModal();
                      }
                    : undefined
                }
                onRestart={
                  summary?.sandbox && !scripted
                    ? () => {
                        closeMenu(false);
                        setRestartError("");
                        restartDialog.current?.showModal();
                      }
                    : undefined
                }
                onLeave={leave}
                rules={kingsSettings ? settingsLine(kingsSettings) : null}
                onCoach={
                  coachingAllowed && !scripted && state.seat !== null && live
                    ? () => {
                        closeMenu(false);
                        setCoachOpen(true);
                      }
                    : undefined
                }
                onStopCoaching={
                  coaching !== null && me?.id
                    ? () => {
                        closeMenu(false);
                        void endCoaching(gameId, me.id!).then(() => {
                          leave();
                          window.location.hash = "#play";
                        });
                      }
                    : undefined
                }
                watching={
                  spectating
                    ? {
                        players: watchedPlayers(snapshot).map((player) => ({
                          seat: player.seat,
                          name: player.name,
                        })),
                        behind: view?.you?.seat ?? null,
                        onBehind: setBehind,
                      }
                    : null
                }
              />

              {(state.ended ||
                state.crowded ||
                unrecoverable ||
                state.recovering ||
                stalled ||
                !view) && (
                <div className={screen.alerts} style={boxStyle(REGIONS.alerts)}>
                  {savedGame && state.ended && (
                    <div className={screen.alert} role="alert">
                      {atTable || state.savedTable ? (
                        <>
                          <p>
                            This game is suspended. It is played on at its
                            table, once every player still in it is back and
                            ready.
                          </p>
                          <a
                            href={
                              tableCode ? `#tables/${tableCode}` : "#play/games"
                            }
                            className={styles.secondaryButton}
                            onClick={leave}
                          >
                            {tableCode ? "Go to the table" : "Your games"}
                          </a>
                        </>
                      ) : campaign ? (
                        <>
                          <p>{ended.savedDuel}</p>
                          <a
                            href="#campaign"
                            className={styles.secondaryButton}
                            onClick={leave}
                          >
                            Back to the campaign
                          </a>
                        </>
                      ) : (
                        <>
                          <p>{ended.saved}</p>
                          <a
                            href="#play/games"
                            className={styles.secondaryButton}
                            onClick={leave}
                          >
                            Your games
                          </a>
                        </>
                      )}
                    </div>
                  )}
                  {state.ended && !savedGame && !unrecoverable && (
                    <div className={screen.alert} role="alert">
                      <p>{ended[state.ended] ?? "This game has ended."}</p>
                      {recordedOutcome && (
                        <p>
                          {recordedOutcome.title}: {recordedOutcome.detail}
                          {tokensLine ? ` ${tokensLine}` : ""}
                        </p>
                      )}
                      <a
                        href={back.href}
                        className={styles.secondaryButton}
                        onClick={leave}
                      >
                        {back.text}
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
                  {state.recovering && !unrecoverable && (
                    <div className={screen.alert} role="status">
                      <p>
                        The server restarted and is recovering this game. This
                        tab reconnects by itself, and the game goes on from
                        where it stood.
                      </p>
                    </div>
                  )}
                  {stalled && !state.recovering && (
                    <div className={screen.alert} role="status">
                      <p>
                        {online
                          ? "The connection to the server dropped. Reconnecting…"
                          : "You are offline. The game reconnects when you are back online."}{" "}
                        The game is kept on the server, and nothing you played
                        is lost.
                      </p>
                    </div>
                  )}
                  {unrecoverable && (
                    <div className={screen.alert} role="alert">
                      <p>
                        This game could not be recovered after a server restart,
                        so it cannot continue. It ended with no result: nobody
                        won or lost.
                        {campaign &&
                          " The duel counts for nothing: start it again from the campaign."}
                      </p>
                      <a
                        href={back.href}
                        className={styles.secondaryButton}
                        onClick={leave}
                      >
                        {back.text}
                      </a>
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
                  {state.seat !== null && (
                    <PassingNotice
                      passing={controls?.passing ?? null}
                      yields={controls?.yields}
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
                  <AwayPlayers
                    state={state}
                    name={seatName}
                    onVote={(seat, remove) => connection?.vote(seat, remove)}
                  />
                  <SuspensionVote
                    state={state}
                    code={summary?.table?.code ?? null}
                    name={seatName}
                  />
                  <PromptPanel
                    state={shown}
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
                      {tokensLine && <p data-tokens={paid}>{tokensLine}</p>}
                      {spectating && (
                        <p data-spectator-next>
                          If its players play on, their next game is listed
                          under Watch a game in the lobby.
                        </p>
                      )}
                      {match && (
                        <MatchOutcome
                          match={match}
                          seat={state.seat}
                          following={following}
                        />
                      )}
                      {!matchGoesOn && !campaign && (
                        <RematchPanel rematch={rematch} />
                      )}
                      {!matchGoesOn && <TableFitPanel fit={tableFit} />}
                      <a
                        href={back.href}
                        className={styles.secondaryButton}
                        onClick={leave}
                      >
                        {back.text}
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
                    state={shown}
                    onSet={(priority) => connection?.setPriority(priority)}
                    showPassing={false}
                  />
                  {state.seat === null && (
                    <p className={styles.hint}>
                      Only the seat’s own player sets its priority.
                    </p>
                  )}
                  {/* Passive bots outside the Inspection drawer: only for a viewer without it.
                      Since v0.8.9 an administrator's switch is in that drawer, as SysOp's. */}
                  {summary?.sandbox && (
                    <p className={styles.hint} data-sandbox-note>
                      <strong>Sandbox game.</strong> {NOTHING_EARNED} Restart it
                      from the Game menu.
                    </p>
                  )}
                  {!sysop && summary?.passive_bots != null && (
                    <PassiveBots
                      gameId={gameId}
                      passive={summary.passive_bots}
                      onChange={setSummary}
                    />
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
                    {summary?.passive_bots != null && (
                      <PassiveBots
                        gameId={gameId}
                        passive={summary.passive_bots}
                        onChange={setSummary}
                      />
                    )}
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        checked={inspect}
                        onChange={(event) =>
                          toggleInspect(event.target.checked)
                        }
                      />
                      <span>Inspect</span>
                    </label>
                    {inspect && (
                      <InspectionPanel inspection={state.inspection} />
                    )}
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
                    <GameLog
                      lines={state.log}
                      focusable={drawer === "log"}
                      rename={atTable ? handlesInLog : undefined}
                    />
                  </section>
                </Drawer>
                {hasTimeline && (
                  <Drawer
                    id="timeline"
                    name="Timeline"
                    titled
                    fill
                    open={drawer === "timeline"}
                    closed="hidden"
                    onClose={closeDrawer}
                  >
                    {/* Read only while it is open: a closed drawer asks the server nothing. */}
                    {drawer === "timeline" && (
                      <Timeline
                        gameId={gameId}
                        seats={timelineSeats}
                        live={live}
                        pulse={revision ?? 0}
                        focus={timelineFocus}
                        newTab
                        fill
                      />
                    )}
                  </Drawer>
                )}
                {chatting && (
                  <Drawer
                    id="chat"
                    name="Table chat"
                    titled
                    fill
                    open={drawer === "chat"}
                    closed="hidden"
                    onClose={closeDrawer}
                  >
                    <TableChat
                      state={state}
                      people={people}
                      tab={chatTab}
                      onTab={setChatTab}
                      unread={unread}
                      open={drawer === "chat"}
                      connected={state.phase === "open"}
                      onSend={(channel, text) =>
                        connection?.chat(channel, text)
                      }
                      onEmote={(emote) => connection?.emote(emote)}
                      onRetry={(id) => connection?.retryChat(id)}
                      onDiscard={(id) => connection?.discardChat(id)}
                      onReport={setReportedLine}
                    />
                  </Drawer>
                )}
                {spectatorChat && (
                  <Drawer
                    id="chat"
                    name="Spectators’ chat"
                    titled
                    fill
                    open={drawer === "chat"}
                    closed="hidden"
                    onClose={closeDrawer}
                  >
                    <SpectatorChat
                      state={state}
                      people={people}
                      open={drawer === "chat"}
                      connected={state.phase === "open"}
                      onSend={(text) => connection?.chat("spectators", text)}
                      onRetry={(id) => connection?.retryChat(id)}
                      onDiscard={(id) => connection?.discardChat(id)}
                      onReport={setReportedLine}
                    />
                  </Drawer>
                )}
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

              {campaign && state.seat !== null && (
                <CampaignLayer
                  gameId={gameId}
                  campaign={campaign}
                  view={view}
                  prompt={canAnswer ? prompt : null}
                  log={state.log}
                  over={over}
                />
              )}

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
              <p>
                {/* Two-Headed Giant (v0.5.1): a team wins and loses together (810.8a). */}
                {format === "two_headed_giant"
                  ? "You and your teammate lose this game at once: a team wins and loses together."
                  : format === "kings_table" && view?.you?.role === "king"
                    ? "You are your team’s King: conceding loses the game for your whole team at once."
                    : `You lose this game at once. ${
                        match
                          ? "The match goes on to its next game."
                          : atTable
                            ? "The other players play on without you."
                            : "The bots play on without you."
                      }`}
              </p>
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
            {/* A sandbox game (v1.0.0) is restarted: closed, and its setup played again. */}
            <dialog
              ref={restartDialog}
              className={styles.confirm}
              aria-labelledby="restart-title"
            >
              <h2 id="restart-title">Restart this sandbox game?</h2>
              <p>
                This game ends here, and the same setup starts again with a new
                shuffle: your deck, the bots, their decks and their skill.
                Nothing is earned or recorded either way.
              </p>
              {restartError && (
                <p role="alert" className={styles.refusal}>
                  {restartError}
                </p>
              )}
              <div className={styles.confirmButtons}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  autoFocus
                  onClick={() => restartDialog.current?.close()}
                >
                  Keep playing
                </button>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={restarting}
                  onClick={() => {
                    setRestarting(true);
                    setRestartError("");
                    void restartSandbox(gameId, !over).then((answer) => {
                      setRestarting(false);
                      if (answer.id) {
                        restartDialog.current?.close();
                        window.location.hash = `#game/${answer.id}`;
                      } else setRestartError(answer.error ?? "");
                    });
                  }}
                >
                  {restarting ? "Restarting…" : "Restart"}
                </button>
              </div>
            </dialog>
            {!scripted && (
              <SaveDialog
                dialog={saveDialog}
                gameId={gameId}
                onSaved={() => {
                  // Left on purpose: the table's lock on leaving lets go, and the saved game is
                  // shown where it waits: a campaign duel on the campaign's map.
                  leave();
                  window.location.hash = campaign ? "#campaign" : "#play/games";
                }}
              />
            )}
            {!scripted && summary?.table && (
              <SuspendDialog dialog={suspendDialog} code={summary.table.code} />
            )}
            {coachingAllowed && !scripted && state.seat !== null && (
              <CoachDialog
                open={coachOpen}
                gameId={gameId}
                onClose={() => setCoachOpen(false)}
              />
            )}
            <ReportDialog
              open={reporting}
              game={{ id: gameId, turn: view?.turn ?? null }}
              onClose={() => {
                setReporting(false);
                // The Game menu closed as the dialog opened: focus goes back to its diamond.
                const active = document.activeElement;
                if (
                  !active ||
                  active === document.body ||
                  active.closest("[hidden]")
                )
                  document
                    .querySelector<HTMLElement>("[data-menu-toggle]")
                    ?.focus({ preventScroll: true });
              }}
            />
            <dialog
              ref={resultDialog}
              className={styles.confirm}
              aria-labelledby="result-title"
            >
              <h2 id="result-title">{outcome?.title}</h2>
              <p>{outcome?.detail}</p>
              {tokensLine && <p data-tokens={paid}>{tokensLine}</p>}
              {spectating && (
                <p data-spectator-next>
                  If its players play on, their next game is listed under Watch
                  a game in the lobby.
                </p>
              )}
              {match && (
                <MatchOutcome
                  match={match}
                  seat={state.seat}
                  following={following}
                />
              )}
              {!matchGoesOn && !campaign && <RematchPanel rematch={rematch} />}
              {!matchGoesOn && <TableFitPanel fit={tableFit} />}
              <form method="dialog" className={styles.confirmButtons}>
                <button
                  type="submit"
                  className={styles.secondaryButton}
                  onClick={() => setReviewing(true)}
                >
                  Review the board
                </button>
                {hasTimeline && (
                  <button
                    type="submit"
                    className={styles.secondaryButton}
                    onClick={() => {
                      setReviewing(true);
                      openDrawer("timeline");
                    }}
                  >
                    See the timeline
                  </button>
                )}
                {/* The game played back (v1.0.0), where replays are open to the account: the
                    player's own seat's, on a page of its own. */}
                {hasTimeline && replays && state.seat !== null && (
                  <a
                    href={`#replay/${gameId}`}
                    className={styles.secondaryButton}
                    onClick={leave}
                  >
                    Watch the replay
                  </a>
                )}
                <a
                  href={back.href}
                  className={styles.primaryButton}
                  onClick={leave}
                >
                  {back.text}
                </a>
              </form>
            </dialog>
            {match && (
              <ConcedeMatchDialog match={match} dialog={concedeMatchDialog} />
            )}
            {(chatting || spectatorChat) && (
              <ReportMessageDialog
                message={reportedLine}
                game={{ id: gameId, turn: view?.turn ?? null }}
                onClose={() => setReportedLine(null)}
              />
            )}
            {overlay}
          </div>
        </AllianceContext.Provider>
      </TableContext.Provider>
    </GameContext.Provider>
  );
}

/** A player's view at a human table (v0.4.0) with the other players named by their handles. The
 * engine names seats by kind and number ("Human 2"); a bot keeps its name, and an observer's view
 * stays as the engine built it. */
function withHandles(
  snapshot: Snapshot | null,
  summary: Summary | undefined,
  seat: Seat | null,
): Snapshot | null {
  // A campaign duel (v0.8.0): the bot is the encounter's opponent, by name.
  const campaign = Boolean(summary?.campaign);
  if (
    !snapshot?.view ||
    !summary ||
    (summary.kind !== "table" && !campaign) ||
    seat === null
  )
    return snapshot;
  const handles = new Map<Seat, string>();
  for (const entry of summary.seats)
    if (
      (entry.player === "human" || campaign) &&
      entry.handle &&
      entry.seat !== seat
    )
      handles.set(entry.seat, entry.handle);
  if (handles.size === 0) return snapshot;
  return {
    ...snapshot,
    view: {
      ...snapshot.view,
      opponents: snapshot.view.opponents.map((player) => {
        const handle = handles.get(player.seat);
        return handle ? { ...player, name: handle } : player;
      }),
    },
  };
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
  rename,
}: {
  lines: { index: number; turn: number; text: string }[];
  focusable: boolean;
  /** Rewrites a line's player names: the engine's "Human 2" as a handle at a human table. */
  rename?: (text: string) => string;
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
          <span>T{line.turn}</span> {rename ? rename(line.text) : line.text}
        </li>
      ))}
    </ol>
  );
}
