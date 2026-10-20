import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client, type Me } from "../api";
import {
  Battlefield,
  CardButton,
  CardRow,
  CombatPanel,
  GameContext,
  PlayerHeader,
  StackPanel,
  ZoneDialog,
  type GameContextValue,
} from "./Board";
import { CardFace, CardZoom, ManaCost, permanentState } from "./Card";
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
import type { CardView, CommandEnvelope, PromptOption, Seat } from "./types";
import styles from "./game.module.css";

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
  const [previewed, setPreviewed] = useState<{
    card: CardView;
    located?: Located;
  } | null>(null);
  const [zone, setZone] = useState<{
    seat: Seat;
    zone: "graveyard" | "exile" | "command";
  } | null>(null);
  const [noticeHidden, setNoticeHidden] = useState(() =>
    remembered("cd.ai-notice"),
  );
  const concedeDialog = useRef<HTMLDialogElement>(null);
  const resultDialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

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

  useEffect(() => {
    heading.current?.focus();
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
      preview: (card, located) => setPreviewed(card ? { card, located } : null),
    }),
    [view, prompt, canAnswer, observing, answer],
  );

  // P answers the primary option (pass, done, keep or yes) unless the player is typing. The key
  // reads the prompt on screen when it is pressed: the layout effect runs as the prompt is drawn,
  // while a listener added again by a later effect could answer the prompt drawn before it.
  const onScreen = useRef({ prompt, canAnswer, answer });
  useLayoutEffect(() => {
    onScreen.current = { prompt, canAnswer, answer };
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

  function toggleInspect(next: boolean) {
    remember(`cd.inspect.${gameId}`, next);
    setInspect(next);
  }

  const you = view?.you ?? null;
  const handTitle = observing && you ? `${you.name}'s hand` : "Your hand";
  const opponents = view?.opponents ?? [];
  const result = snapshot?.result ?? null;
  const outcome = result ? resultText(view, state.seat, result) : null;
  const format = snapshot?.settings.format ?? summary?.format;
  const connectionText =
    state.phase === "open"
      ? state.role === "controller"
        ? "Connected"
        : "Watching"
      : state.phase === "reconnecting"
        ? "Reconnecting…"
        : state.phase === "connecting"
          ? "Connecting…"
          : "Disconnected";

  return (
    <GameContext.Provider value={context}>
      <div className={styles.screen} data-opponents={opponents.length || 1}>
        <header className={styles.gameBar}>
          <a href="#play" className={styles.back}>
            <span aria-hidden="true">←</span> Table
          </a>
          <h1 ref={heading} tabIndex={-1}>
            {format === "commander" ? "Commander" : "Legacy"}
            <span>Practice game</span>
          </h1>
          {view && (
            <p className={styles.turn} aria-live="polite">
              {[
                `Turn ${view.turn}`,
                view.active_seat === null
                  ? null
                  : view.active_seat === view.seat && !observing
                    ? "Your turn"
                    : `${playerName(view, view.active_seat, observing)}’s turn`,
                words(view.step ?? view.phase) || null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          <span
            className={styles.status}
            data-phase={state.phase}
            role="status"
          >
            {connectionText}
          </span>
          {sysop && (
            <label className={styles.inspectToggle}>
              <input
                type="checkbox"
                checked={inspect}
                onChange={(event) => toggleInspect(event.target.checked)}
              />
              Inspect
            </label>
          )}
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={state.role !== "controller" || result !== null}
            onClick={() => concedeDialog.current?.showModal()}
          >
            Concede
          </button>
        </header>

        {!noticeHidden && (
          <div className={styles.notice} role="note">
            <p>
              <strong>Practice table.</strong> The bots still read your hand
              while they plan (the AI audit, AI02, is not done yet), so their
              play is not a fair test of yours.
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
        {state.ended && (
          <div className={styles.notice} role="alert">
            <p>{ended[state.ended] ?? "This game has ended."}</p>
            <a href="#play" className={styles.secondaryButton}>
              Back to the table
            </a>
          </div>
        )}
        {state.crowded && (
          <div className={styles.notice} role="alert">
            <p>
              This game is open in too many tabs. Close one, and this tab
              connects by itself.
            </p>
          </div>
        )}
        {state.interrupted && (
          <div className={styles.notice} role="alert">
            <p>
              The rules engine lost this game (a restart), so it cannot
              continue. Recovery arrives in a later version.
            </p>
          </div>
        )}

        <div className={styles.board}>
          <section className={styles.opponents} aria-label="Opponents">
            {opponents.map((opponent) => (
              <article
                key={opponent.seat}
                className={styles.opponent}
                data-active={view?.active_seat === opponent.seat || undefined}
                aria-label={`${opponent.name}, seat ${opponent.seat + 1}`}
              >
                <PlayerHeader
                  player={opponent}
                  onZone={(seat, z) => setZone({ seat, zone: z })}
                />
                <Battlefield
                  permanents={view!.battlefield.filter(
                    (p) => p.controller_seat === opponent.seat,
                  )}
                  label={`${opponent.name}'s battlefield`}
                  small={opponents.length > 1}
                />
              </article>
            ))}
            {!view && <p role="status">Setting up the table…</p>}
          </section>

          <div className={styles.middle}>
            <StackPanel />
            <CombatPanel />
          </div>

          {you && (
            <section
              className={styles.you}
              aria-label={
                observing
                  ? `${you.name}'s side of the table`
                  : "Your side of the table"
              }
              data-active={view?.active_seat === you.seat || undefined}
            >
              <PlayerHeader
                player={you}
                onZone={(seat, z) => setZone({ seat, zone: z })}
              />
              <Battlefield
                permanents={view!.battlefield.filter(
                  (p) => p.controller_seat === you.seat,
                )}
                label={
                  observing ? `${you.name}'s battlefield` : "Your battlefield"
                }
              />
              <div className={styles.hand}>
                <h2>
                  {handTitle} <span>{view!.hand.length}</span>
                </h2>
                {view!.hand.length === 0 ? (
                  <p className={styles.emptyZone}>No cards in hand</p>
                ) : (
                  <CardRow label={handTitle} className={styles.handRow}>
                    {view!.hand.map((card) => (
                      <CardButton
                        key={card.id}
                        card={card}
                        located={context.index.get(card.id)}
                      />
                    ))}
                  </CardRow>
                )}
              </div>
            </section>
          )}
        </div>

        <aside className={styles.side} aria-label="Prompt and game log">
          {previewed && !previewed.card.hidden && (
            <div className={styles.preview} aria-hidden="true">
              <CardFace card={previewed.card} />
              <div>
                <strong>{previewed.card.name}</strong>{" "}
                <ManaCost cost={previewed.card.mana_cost} />
                <p>{previewed.card.type_line}</p>
                {previewed.card.rules.slice(0, 6).map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
                {permanentState(previewed.located?.permanent).length > 0 && (
                  <p className={styles.hint}>
                    {permanentState(previewed.located?.permanent).join(" · ")}
                  </p>
                )}
              </div>
            </div>
          )}
          <PromptPanel
            state={state}
            onAnswer={answer}
            onTakeControl={() => connection?.takeControl()}
            onConcede={() => concedeDialog.current?.showModal()}
          />
          <PriorityPanel
            state={state}
            onSet={(settings) => connection?.setPriority(settings)}
          />
          {result && outcome && (
            <section
              className={styles.result}
              aria-labelledby="result-side-title"
            >
              <h2 id="result-side-title">{outcome.title}</h2>
              <p>{outcome.detail}</p>
              <a href="#play" className={styles.secondaryButton}>
                Back to the table
              </a>
            </section>
          )}
          {sysop && inspect && (
            <InspectionPanel inspection={state.inspection} />
          )}
          <section className={styles.log} aria-labelledby="log-title">
            <h2 id="log-title">Game log</h2>
            <GameLog lines={state.log} />
          </section>
        </aside>

        <CardZoom
          card={zoomed?.card ?? null}
          located={zoomed?.located}
          onClose={() => setZoomed(null)}
        />
        <ZoneDialog target={zone} onClose={() => setZone(null)} />
        <dialog
          ref={concedeDialog}
          className={styles.confirm}
          aria-labelledby="concede-title"
        >
          <h2 id="concede-title">Concede this game?</h2>
          <p>You lose this game at once. The bots play on without you.</p>
          <form method="dialog" className={styles.confirmButtons}>
            <button type="submit" className={styles.secondaryButton} autoFocus>
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
            <a href="#play" className={styles.primaryButton}>
              Back to the table
            </a>
          </form>
        </dialog>
      </div>
    </GameContext.Provider>
  );
}

function GameLog({
  lines,
}: {
  lines: { index: number; turn: number; text: string }[];
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
      tabIndex={0}
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
