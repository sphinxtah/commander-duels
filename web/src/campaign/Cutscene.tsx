import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { TierBadge } from "../alliance/TierBadge";
import { portraitUrl } from "../game/table/portrait";
import { hoverSound, selectSound } from "../shell/menuSound";
import { castOf, type CastMember, type PlayerFace } from "./cast";
import { FigureArt } from "./Figures";
import { Scenery, SCENERY_ACCENTS, SCENERY_NAMES } from "./scenery/Scenery";
import type { Fx, Scene, Speaker } from "./script";
import { CHARS_PER_SECOND, useCampaignSettings } from "./settings";
import {
  readingMs,
  stagesOf,
  stepsOf,
  wordsOf,
  type StageState,
  type Step,
} from "./stage";
import styles from "./cutscene.module.css";

// The campaign's cut scenes (v0.8.0): a cinematic between the duels, as the owner asked. The
// scene's place is painted behind (the scenery, layered and drifting), letterboxed; the speakers'
// portraits stand at either side, the one speaking stepping forward lit while the others dim, and
// each line comes in a speech bubble pointing at its speaker, typed out. Lines carry effects (a
// flash, a shake, a stamp, chains, a fracture of gold…) and change the scenery's phase. Titles,
// narration, a seal claimed and a chapter's rewards are cards of their own. Next (Enter, Space,
// →) shows the whole line, then the next; Auto reads on by itself; Skip (Escape) ends the scene,
// which never skips a duel or a reward. Reduced motion keeps short fades and no shaking.

/** How long an effect's class stays on, for its CSS animation to play once. */
const FX_MS: Partial<Record<Fx, number>> = {
  shake: 700,
  flash: 900,
  voice: 1600,
  laugh: 900,
  stamp: 1800,
  glitch: 900,
  fracture: 2400,
  reveal: 2200,
  sever: 2000,
  sparks: 1800,
  chains: 2200,
  mirror: 1800,
  prism: 2200,
  "five-suns": 4200,
  "gold-thread": 4200,
  "lamps-out": 2600,
  "shadows-return": 2600,
  silence: 2200,
  burn: 2200,
  "names-dim": 2200,
  "staff-dims": 2600,
  "lights-return": 4200,
};

export function Cutscene({
  scene,
  extra,
  player,
  onDone,
  onStep,
  start = 0,
}: {
  scene: Scene;
  /** Steps after the lines: a seal claimed, a chapter's rewards, an end card. */
  extra?: Step[];
  player: PlayerFace;
  /** The scene ended: seen to its end, or skipped. */
  onDone: (skipped: boolean) => void;
  onStep?: (index: number) => void;
  /** The step to open on (a preview, a resumed scene). */
  start?: number;
}) {
  const steps = useMemo(() => stepsOf(scene, extra), [scene, extra]);
  const stages = useMemo(
    () => stagesOf(scene, steps, player),
    [scene, steps, player],
  );
  const [index, setIndex] = useState(start);
  const [settings, updateSettings] = useCampaignSettings();
  const step = steps[index] ?? steps[steps.length - 1];
  const stage = stages[index] ?? stages[stages.length - 1];
  const words = step ? wordsOf(step) : "";
  const typed = step?.kind === "line" || step?.kind === "narration";
  const [shown, setShown] = useState(0);
  const [fx, setFx] = useState<{ fx: Fx; key: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const reduced =
    typeof document !== "undefined" &&
    document.documentElement.dataset.reducedMotion === "true";
  const speed = reduced ? Infinity : CHARS_PER_SECOND[settings.textSpeed];
  const complete = !typed || shown >= words.length;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      // jsdom's dialogs have no showModal; the attribute is enough there.
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    next.current?.focus({ preventScroll: true });
    return () => {
      if (element?.open && typeof element.close === "function") element.close();
    };
  }, []);

  const finish = useCallback(
    (skipped: boolean) => {
      if (done.current) return;
      done.current = true;
      onDone(skipped);
    },
    [onDone],
  );

  // Each step types its words afresh, and plays its line's effect once.
  useEffect(() => {
    setShown(typed && Number.isFinite(speed) ? 0 : words.length);
    onStep?.(index);
    if (step?.kind === "line") {
      if (step.line.fx) {
        setFx((current) => ({
          fx: step.line.fx as Fx,
          key: (current?.key ?? 0) + 1,
        }));
      }
      if (index > 0) hoverSound();
    }
    // Only as the step changes.
  }, [index]);
  useEffect(() => {
    if (!fx) return;
    const timer = window.setTimeout(
      () => setFx((current) => (current?.key === fx.key ? null : current)),
      FX_MS[fx.fx] ?? 1500,
    );
    return () => window.clearTimeout(timer);
  }, [fx]);
  useEffect(() => {
    if (complete || !Number.isFinite(speed)) return;
    const timer = window.setInterval(
      () => setShown((value) => Math.min(words.length, value + 1)),
      1000 / speed,
    );
    return () => window.clearInterval(timer);
  }, [complete, speed, words]);

  const advance = useCallback(() => {
    if (!complete) {
      setShown(words.length);
      return;
    }
    if (index >= steps.length - 1) {
      selectSound();
      finish(false);
      return;
    }
    setIndex((value) => value + 1);
  }, [complete, words.length, index, steps.length, finish]);

  // Automatic advance, once the words are all shown and read.
  useEffect(() => {
    if (!settings.auto || !complete || !step) return;
    const timer = window.setTimeout(advance, readingMs(step));
    return () => window.clearTimeout(timer);
  }, [settings.auto, complete, step, advance]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      if (
        event.key === "Enter" ||
        event.key === " " ||
        event.key === "ArrowRight"
      ) {
        // A focused control (Auto, Skip) answers its own Enter and Space.
        if (
          (event.key === "Enter" || event.key === " ") &&
          target?.closest("button") &&
          target !== next.current
        )
          return;
        event.preventDefault();
        advance();
      } else if (event.key.toLowerCase() === "a") {
        updateSettings({ auto: !settings.auto });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, settings.auto, updateSettings]);

  if (!step || !stage) return null;
  const accent = SCENERY_ACCENTS[stage.scenery];
  const speaking = stage.speaker
    ? castOf(stage.speaker, scene.id, player)
    : null;
  const fxClass = fx && !reduced ? styles[`fx-${fx.fx}`] : undefined;
  const shake =
    fx && !reduced && ["shake", "voice", "fracture", "stamp"].includes(fx.fx);
  const last = index >= steps.length - 1;
  const label = scene.caption?.title ?? SCENERY_NAMES[stage.scenery];

  return (
    <dialog
      ref={dialog}
      className={styles.cutscene}
      aria-label={`Story: ${label}`}
      style={{ "--accent": accent } as CSSProperties}
      data-scene={scene.id}
      data-step={index}
      onCancel={(event) => {
        // Escape skips the scene; the dialog closes with it.
        event.preventDefault();
        finish(true);
      }}
      onClick={(event) => {
        // A click on the picture (not on a control) reads on, as in Magic Duels.
        if ((event.target as HTMLElement).closest("button, a")) return;
        advance();
      }}
    >
      <div className={[styles.world, shake ? styles.shaking : ""].join(" ")}>
        <Scenery
          id={stage.scenery}
          phase={stage.phase}
          className={styles.scenery}
        />
        <div className={styles.grade} aria-hidden="true" />
        <Stage
          stage={stage}
          sceneId={scene.id}
          player={player}
          fx={fx?.fx ?? null}
        />
        {fx && !reduced && <FxLayer key={fx.key} fx={fx.fx} />}
        <div className={styles.grain} aria-hidden="true" />
      </div>
      <div className={styles.bars} aria-hidden="true">
        <span />
        <span />
      </div>
      <div className={[styles.overlay, fxClass].filter(Boolean).join(" ")}>
        <StepView
          step={step}
          speaking={speaking}
          shown={typed ? shown : words.length}
          stepKey={index}
        />
      </div>
      {/* The whole line at once for screen readers, however it is typed on screen. */}
      <p className={styles.visuallyHidden} aria-live="polite">
        {speaking?.name ? `${speaking.name}: ` : ""}
        {words}
      </p>
      <div className={styles.controls}>
        <span className={styles.progress} aria-hidden="true">
          {Math.min(index, steps.length - 1) + 1} / {steps.length}
        </span>
        <button
          type="button"
          className={styles.quiet}
          aria-pressed={settings.auto}
          onClick={() => updateSettings({ auto: !settings.auto })}
        >
          Auto
        </button>
        <button
          type="button"
          className={styles.quiet}
          onClick={() => {
            const order = ["slow", "normal", "fast", "instant"] as const;
            const at = order.indexOf(settings.textSpeed);
            updateSettings({ textSpeed: order[(at + 1) % order.length] });
          }}
          aria-label={`Text speed: ${settings.textSpeed}`}
        >
          Text: {settings.textSpeed}
        </button>
        <button
          type="button"
          className={styles.quiet}
          onClick={() => finish(true)}
        >
          Skip scene
        </button>
        <button
          type="button"
          ref={next}
          className={styles.next}
          onClick={advance}
        >
          {!complete ? "Show all" : last ? "Continue" : "Next"}{" "}
          <span aria-hidden="true">▶</span>
        </button>
      </div>
    </dialog>
  );
}

function Stage({
  stage,
  sceneId,
  player,
  fx,
}: {
  stage: StageState;
  sceneId: string;
  player: PlayerFace;
  fx: Fx | null;
}) {
  const people: { speaker: Speaker; slot: number; side: "left" | "right" }[] = [
    ...stage.left.map((speaker, slot) => ({
      speaker,
      slot,
      side: "left" as const,
    })),
    ...stage.right.map((speaker, slot) => ({
      speaker,
      slot,
      side: "right" as const,
    })),
  ];
  return (
    <div className={styles.stage} aria-hidden="true">
      {people.map(({ speaker, slot, side }) => {
        const member = castOf(speaker, sceneId, player);
        const active = stage.speaker === speaker;
        const severed = stage.severed === speaker;
        const count = side === "left" ? stage.left.length : stage.right.length;
        // The one nearest the middle stands in front.
        const depth = side === "left" ? slot : count - 1 - slot;
        return (
          <div
            key={speaker}
            className={[
              styles.actor,
              styles[side],
              active ? styles.active : "",
              severed ? styles.severed : "",
              member.veiled ? styles.veiled : "",
              active && fx === "laugh" ? styles.laughing : "",
              active && fx === "reveal" ? styles.revealing : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={
              {
                "--slot": side === "left" ? slot : count - 1 - slot,
                "--depth": depth,
              } as CSSProperties
            }
            data-speaker={speaker}
          >
            <Likeness member={member} staff={stage.staff} />
          </div>
        );
      })}
    </div>
  );
}

function Likeness({ member, staff }: { member: CastMember; staff: number }) {
  const [failed, setFailed] = useState(false);
  if (member.figure)
    return (
      <FigureArt
        figure={member.figure}
        lights={staff}
        className={styles.likeness}
      />
    );
  if (!member.portrait || failed)
    return <FigureArt figure="wayfarer" className={styles.likeness} />;
  return (
    <img
      className={styles.likeness}
      src={portraitUrl(member.portrait, 512)}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function StepView({
  step,
  speaking,
  shown,
  stepKey,
}: {
  step: Step;
  speaking: CastMember | null;
  shown: number;
  stepKey: number;
}) {
  switch (step.kind) {
    case "title":
      return (
        <div key={stepKey} className={styles.titleCard}>
          <span className={styles.kicker}>{step.kicker}</span>
          <h2 className={styles.title}>{step.title}</h2>
          {step.sub && <span className={styles.sub}>{step.sub}</span>}
          <span className={styles.rule} aria-hidden="true" />
        </div>
      );
    case "narration":
      return (
        <div key={stepKey} className={styles.narration}>
          <Typed text={step.text} shown={shown} />
        </div>
      );
    case "seal":
      return (
        <div key={stepKey} className={styles.sealCard}>
          <div className={styles.seal} aria-hidden="true">
            <span className={styles.sealRing} />
            <span className={styles.sealNumber}>
              {String(step.number).padStart(2, "0")}
            </span>
            {Array.from({ length: 10 }, (_, shard) => (
              <span
                key={shard}
                className={styles.shard}
                style={{ "--shard": shard } as CSSProperties}
              />
            ))}
          </div>
          <span className={styles.kicker}>Seal claimed</span>
          <h2 className={styles.title}>
            Seal {String(step.number).padStart(2, "0")} · {step.name}
          </h2>
          <span className={styles.sub}>
            The ward breaks, and its seal answers to you now.
          </span>
        </div>
      );
    case "chapter":
      return (
        <div key={stepKey} className={styles.chapterCard}>
          <div className={styles.badges} aria-hidden="true">
            <span className={styles.badgeFrom}>
              <TierBadge tier={step.tier} size={112} decorative />
            </span>
            {step.next && (
              <span className={styles.badgeTo}>
                <TierBadge tier={step.next.tier} size={112} decorative />
              </span>
            )}
          </div>
          <span className={styles.kicker}>Chapter complete</span>
          <h2 className={styles.title}>{step.name}</h2>
          {step.rewards.length > 0 && (
            <ul className={styles.rewards}>
              {step.rewards.map((reward) => (
                <li key={reward}>{reward}</li>
              ))}
            </ul>
          )}
          {step.next && (
            <span className={styles.sub}>The {step.next.name} wards open.</span>
          )}
        </div>
      );
    case "spoils":
      return (
        <div key={stepKey} className={styles.spoilsCard}>
          <div className={styles.deckBox} aria-hidden="true">
            {[0, 1, 2].map((card) => (
              <span
                key={card}
                className={styles.deckCard}
                style={{ "--card": card } as CSSProperties}
              />
            ))}
            <img
              className={styles.deckPortrait}
              src={portraitUrl(step.opponent, 256)}
              alt=""
              width={128}
              height={128}
            />
          </div>
          <span className={styles.kicker}>Spoils of the ward</span>
          <h2 className={styles.title}>{step.deck}</h2>
          <span className={styles.sub}>
            Led by {step.commander}. Every card is yours, and the deck waits
            among your decks.
          </span>
          {step.tokens > 0 && (
            <span className={styles.tokenGain}>
              +{step.tokens.toLocaleString("en-US")} tokens
            </span>
          )}
        </div>
      );
    case "card":
      return (
        <div key={stepKey} className={styles.titleCard}>
          <span className={styles.kicker}>{step.kicker}</span>
          <h2 className={styles.title}>{step.title}</h2>
          {step.text && <p className={styles.cardText}>{step.text}</p>}
          <span className={styles.rule} aria-hidden="true" />
        </div>
      );
    case "line": {
      const narrator = step.line.speaker === "NARRATOR";
      if (narrator || !speaking)
        return (
          <div key={stepKey} className={styles.narration}>
            <Typed text={step.line.text} shown={shown} />
          </div>
        );
      return (
        <div
          key={stepKey}
          className={[
            styles.bubble,
            styles[`from-${speaking.side}`],
            speaking.veiled ? styles.voice : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <span className={styles.speaker}>{speaking.name}</span>
          <Typed text={step.line.text} shown={shown} />
        </div>
      );
    }
  }
}

/** Text typed out: the part shown, and the rest kept in place invisibly so the bubble never
 * changes size as it types. */
function Typed({ text, shown }: { text: string; shown: number }) {
  return (
    <p className={styles.words} aria-hidden="true">
      <span>{text.slice(0, shown)}</span>
      <span className={styles.ghost}>{text.slice(shown)}</span>
    </p>
  );
}

/** A line's effect, drawn over the scene once. */
function FxLayer({ fx }: { fx: Fx }) {
  switch (fx) {
    case "five-suns":
      return (
        <div className={styles.suns} aria-hidden="true">
          {[0, 1, 2, 3, 4].map((sun) => (
            <span key={sun} style={{ "--sun": sun } as CSSProperties} />
          ))}
        </div>
      );
    case "gold-thread":
      return (
        <svg
          className={styles.thread}
          viewBox="0 0 1920 1080"
          aria-hidden="true"
        >
          <path d="M-20 900 C 400 820, 640 980, 980 700 S 1400 380, 1520 420" />
          <rect x="1480" y="250" width="90" height="190" rx="45" />
        </svg>
      );
    case "stamp":
      return (
        <div className={styles.stamp} aria-hidden="true">
          REJECTED
        </div>
      );
    case "chains":
      return (
        <div className={styles.chains} aria-hidden="true">
          {[0, 1, 2, 3].map((chain) => (
            <span key={chain} style={{ "--chain": chain } as CSSProperties} />
          ))}
        </div>
      );
    case "fracture":
      return (
        <svg
          className={styles.fracture}
          viewBox="0 0 1920 1080"
          aria-hidden="true"
        >
          <path d="M960 520 L880 300 L910 180 L860 0" />
          <path d="M960 520 L1180 420 L1340 470 L1600 300 L1920 330" />
          <path d="M960 520 L1060 760 L1010 900 L1080 1080" />
          <path d="M960 520 L720 620 L520 560 L300 700 L0 660" />
          <path d="M880 300 L760 260 M1180 420 L1220 300 M1060 760 L1220 820 M720 620 L700 780" />
        </svg>
      );
    case "sparks":
      return (
        <div className={styles.sparks} aria-hidden="true">
          {Array.from({ length: 18 }, (_, spark) => (
            <span key={spark} style={{ "--spark": spark } as CSSProperties} />
          ))}
        </div>
      );
    case "prism":
      return (
        <div className={styles.prism} aria-hidden="true">
          {[0, 1, 2, 3, 4].map((ray) => (
            <span key={ray} style={{ "--ray": ray } as CSSProperties} />
          ))}
        </div>
      );
    case "staff-dims":
      return (
        <div className={styles.staffLights} aria-hidden="true">
          {[0, 1, 2, 3, 4].map((light) => (
            <span key={light} style={{ "--light": light } as CSSProperties} />
          ))}
        </div>
      );
    case "lights-return":
      return (
        <div className={styles.lightsReturn} aria-hidden="true">
          {Array.from({ length: 24 }, (_, light) => (
            <span key={light} style={{ "--light": light } as CSSProperties} />
          ))}
        </div>
      );
    case "shadows-return":
      return (
        <div className={styles.shadows} aria-hidden="true">
          {[0, 1, 2, 3, 4].map((shadow) => (
            <span
              key={shadow}
              style={{ "--shadow": shadow } as CSSProperties}
            />
          ))}
        </div>
      );
    default:
      return (
        <div
          className={styles[`wash-${fx}`] ?? styles.wash}
          aria-hidden="true"
        />
      );
  }
}
