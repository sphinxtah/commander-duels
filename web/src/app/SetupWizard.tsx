import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { HandleForm } from "../Account";
import { type Me } from "../api";
import { AllianceOffer, useAllianceChange } from "../alliance/StandingPanels";
import { StarterPicker } from "../alliance/StarterPicker";
import { useStanding } from "../alliance/useStanding";
import shell from "../App.module.css";
import { TourTip } from "../tutorial/Coach";
import { Overview } from "../tutorial/Overview";
import {
  DEMO_ROUTE,
  guided,
  tutorialOf,
  moveTutorial,
  type TutorialPath,
  type TutorialStage,
} from "../tutorial/tutorial";
import styles from "./SetupWizard.module.css";

/**
 * The setup wizard (v0.4.2): a new account's welcome to the game, with a quick look at it in
 * screenshots, then the account's handle (the name other players see, at the table and later in
 * a game's chat), its two free starter decks and an alliance. App opens it by itself each time
 * the site opens on an account that has not finished the first two (a new sign-in or a reload),
 * and again from the notice on every page and from Profile. Closing it leaves the account where
 * it was; the alliance may also wait for later. Every choice is the server's, as on Profile.
 *
 * Since v0.8.4 the welcome first asks how the player wants to learn the game (the tutorial,
 * docs/menus.md#the-tutorial): Beginner watches a guided game first (DEMO_ROUTE), Novice reads an
 * overview here, Advanced goes straight to the setup. Beginner and Novice get a tip at each step
 * of the setup, and leave the wizard for the main menu's tour.
 */
export type SetupStep =
  "welcome" | "overview" | "handle" | "starters" | "alliance" | "done";

type Listed = Exclude<SetupStep, "done">;

/** The steps along the top: Novice reads the overview first. */
function stepsOf(path: TutorialPath | null): { step: Listed; label: string }[] {
  return [
    { step: "welcome", label: "Welcome" },
    ...(path === "novice"
      ? [{ step: "overview" as const, label: "Overview" }]
      : []),
    { step: "handle", label: "Your name" },
    { step: "starters", label: "Starter decks" },
    { step: "alliance", label: "Alliance" },
  ];
}

/** Each step's heading, which names the dialog. */
const TITLES: Record<SetupStep, string> = {
  welcome: "setup-step-title",
  overview: "overview-title",
  handle: "handle-title",
  starters: "starters-title",
  alliance: "offer-title",
  done: "setup-step-title",
};

/** The step the account is on: its handle, then its starter decks; none once both are done. */
export function setupStep(me: Me): "handle" | "starters" | null {
  if (me.onboarding === "handle") return "handle";
  if (me.onboarding === "starters") return "starters";
  return null;
}

/** Where the wizard opens on the account's own step: the tutorial's, then the setup's. */
function currentStep(me: Me): SetupStep {
  const stage = tutorialOf(me).stage;
  if (stage === "choose" || stage === "demo") return "welcome";
  if (stage === "overview") return "overview";
  // A guided player who closed the wizard at its end comes back to it, for the tour.
  if (
    stage === "setup" &&
    guided(tutorialOf(me)) &&
    me.alliance &&
    !setupStep(me)
  )
    return "done";
  return setupStep(me) ?? "alliance";
}

/** The four screenshots of the welcome (web/public/welcome), each in two sizes. */
const SHOTS = [
  {
    name: "table",
    title: "The table",
    caption:
      "Commander and Legacy at a 16:9 table, against bots or other players.",
    alt: "A Commander game at the table: Sigarda attacks across the red band for 5 commander damage, creatures and lands on both sides, both libraries face down showing the card back.",
  },
  {
    name: "decks",
    title: "The deck builder",
    caption:
      "Build decks from your own library; each format's rules are checked as you go.",
    alt: "The deck builder: a Commander deck led by Kenrith, the Returned King, ready to play, its cards shown as pictures beside the card search.",
  },
  {
    name: "shop",
    title: "Leng's card shop",
    caption:
      "Wins earn tokens: spend them on packs from Revised to today, and on more decks.",
    alt: "Leng's card shop: a Zendikar Rising pack opened at the counter, half its cards turned over and the rest still face down.",
  },
  {
    name: "alliance",
    title: "The Planeswalker Alliance",
    caption:
      "Ally with a Planeswalker for their cards and portrait; more open as you win.",
    alt: "The Planeswalker Alliance on Profile: allied with Chandra, with the Bronze tier's Planeswalker portraits to choose from.",
  },
] as const;

/** The three ways to learn the game, as the welcome offers them. */
const PATHS: {
  path: TutorialPath;
  title: string;
  who: string;
  what: string;
}[] = [
  {
    path: "beginner",
    title: "Beginner",
    who: "I'm new to Magic.",
    what: "Watch a whole game between two bots, explained move by move. Then set up your game with tips at each step, and a tour of the main menu.",
  },
  {
    path: "novice",
    title: "Novice",
    who: "I know some Magic.",
    what: "A quick overview of Commander Duels and a refresher on Magic's rules. Then set up your game, and an optional tour of the main menu.",
  },
  {
    path: "advanced",
    title: "Advanced",
    who: "I know Magic well.",
    what: "Straight to setting up your game: your name, two starter decks and an ally.",
  },
];

export function SetupWizard({
  me,
  onChange,
  open,
  onClose,
}: {
  me: Me;
  onChange: (me: Me) => void;
  /** Where it opens: at the welcome, or at the account's own step; null keeps it closed. */
  open: "welcome" | "current" | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<SetupStep>("welcome");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open === null) {
      if (node.open) node.close?.();
      return;
    }
    setError("");
    setStep(open === "welcome" ? "welcome" : currentStep(me));
    if (!node.open) node.showModal?.();
    // The account is read when the wizard opens, not as it changes inside it.
  }, [open]);
  // Each step that follows another takes focus to its heading, as following a link does: the
  // button that finished the step went with it.
  useEffect(() => {
    if (open !== null) heading.current?.focus();
  }, [step, open]);

  // Closing tells App at once: a dialog that never opened modally fires no close event.
  function finish() {
    if (dialog.current?.open) dialog.current.close?.();
    onClose();
  }

  /** Moves the tutorial along on the server; false (with its words shown) when it could not. */
  async function move(
    stage: TutorialStage,
    path?: TutorialPath,
    skipped = false,
  ): Promise<Me | null> {
    if (busy) return null;
    setBusy(true);
    setError("");
    try {
      const moved = await moveTutorial({ stage, path, skipped });
      if ("error" in moved) {
        setError(moved.error);
        return null;
      }
      onChange(moved.me);
      return moved.me;
    } finally {
      setBusy(false);
    }
  }

  async function choose(path: TutorialPath) {
    const stage =
      path === "beginner" ? "demo" : path === "novice" ? "overview" : "setup";
    const changed = await move(stage, path);
    if (!changed) return;
    if (path === "beginner") watch();
    else if (path === "novice") setStep("overview");
    else setStep(setupStep(changed) ?? "alliance");
  }
  function watch() {
    finish();
    window.location.hash = DEMO_ROUTE;
  }
  async function toSetup() {
    const changed = await move("setup");
    if (changed) setStep(setupStep(changed) ?? "alliance");
  }
  // Reaching the end: Beginner and Novice go on to the tour, Advanced is done.
  async function reachDone() {
    if (tutorialOf(me).stage === "setup" && !guided(tutorialOf(me)))
      await move("done");
    setStep("done");
  }

  const tips = guided(tutorialOf(me)) && tutorialOf(me).stage === "setup";
  const steps = stepsOf(tutorialOf(me).path);
  const index = steps.findIndex((item) => item.step === step);
  const failed = error && (
    <p className={styles.error} role="alert">
      {error}
    </p>
  );
  return (
    <dialog
      ref={dialog}
      className={styles.wizard}
      aria-labelledby={TITLES[step]}
      onClose={onClose}
    >
      {open !== null && (
        <>
          <div className={styles.top}>
            <ol className={styles.steps} aria-label="Setting up your game">
              {steps.map((item, at) => (
                <li
                  key={item.step}
                  aria-current={item.step === step ? "step" : undefined}
                  data-done={step === "done" || at < index ? "true" : undefined}
                >
                  <span aria-hidden="true">{at + 1}</span> {item.label}
                </li>
              ))}
            </ol>
            <button type="button" className={styles.close} onClick={finish}>
              {step === "done" ? "Close" : "Finish later"}
            </button>
          </div>
          {step === "welcome" ? (
            <Welcome
              me={me}
              heading={heading}
              busy={busy}
              error={failed}
              onChoose={(path) => void choose(path)}
              onWatch={watch}
              onSkipDemo={() => void toSetup()}
              onNext={() =>
                setStep(
                  tutorialOf(me).stage === "overview"
                    ? "overview"
                    : (setupStep(me) ?? "alliance"),
                )
              }
            />
          ) : step === "overview" ? (
            <div className={styles.body}>
              <Overview
                heading={heading}
                doneLabel="Set up my game"
                onDone={() => void toSetup()}
              />
              {failed}
            </div>
          ) : step === "handle" ? (
            <div className={styles.body}>
              {tips && (
                <TourTip>
                  Your handle is the name other players see: at the table, in
                  the lobby and in chat. Pick one you'll be glad to see on a
                  leaderboard. You can change it later on Profile.
                </TourTip>
              )}
              <HandleForm
                key={me.id}
                me={me}
                heading={heading}
                onChange={(changed) => {
                  onChange(changed);
                  setStep(setupStep(changed) ?? "alliance");
                }}
              />
            </div>
          ) : step === "starters" ? (
            <div className={styles.body}>
              {tips && (
                <TourTip>
                  Each starter deck is a ready-to-play Commander deck, led by
                  the commander on its card. Pick two whose colors and style
                  appeal to you: decks that play creatures and attack (green,
                  white, red) are the easiest to start with. Every card of both
                  joins your library for good, and you can change the decks in
                  Decks.
                </TourTip>
              )}
              <StarterPicker
                key={me.id}
                me={me}
                onChange={onChange}
                onChosen={() => setStep("alliance")}
                heading={heading}
              />
            </div>
          ) : step === "alliance" ? (
            <AllianceStep
              me={me}
              onChange={onChange}
              heading={heading}
              tips={tips}
              onDone={() => void reachDone()}
            />
          ) : (
            <Done
              me={me}
              heading={heading}
              busy={busy}
              error={failed}
              onClose={finish}
              onTour={async (skip) => {
                const changed = await move(
                  skip ? "done" : "tour_shop",
                  undefined,
                  skip,
                );
                if (!changed) return;
                if (!skip) {
                  finish();
                  window.location.hash = "#home";
                }
              }}
            />
          )}
        </>
      )}
    </dialog>
  );
}

function Welcome({
  me,
  heading,
  busy,
  error,
  onChoose,
  onWatch,
  onSkipDemo,
  onNext,
}: {
  me: Me;
  heading: RefObject<HTMLHeadingElement | null>;
  busy: boolean;
  error: ReactNode;
  onChoose: (path: TutorialPath) => void;
  onWatch: () => void;
  onSkipDemo: () => void;
  onNext: () => void;
}) {
  const left = setupStep(me);
  const stage = tutorialOf(me).stage;
  return (
    <div className={styles.welcome}>
      <span className={shell.eyebrow}>
        WELCOME, {me.display_name.toUpperCase()}
      </span>
      <h2 id="setup-step-title" ref={heading} tabIndex={-1}>
        Welcome to Commander Duels
      </h2>
      <p className={styles.lead}>
        Play Commander and Legacy against bots and other players, build your
        decks from a card library that grows with every win, and open packs at
        Leng's card shop. Here is a quick look before you set up your game.
      </p>
      <ul className={styles.shots} aria-label="A look at the game">
        {SHOTS.map((shot) => (
          <li key={shot.name}>
            <figure>
              <img
                src={`/welcome/${shot.name}-640.webp`}
                srcSet={`/welcome/${shot.name}-640.webp 640w, /welcome/${shot.name}-1280.webp 1280w`}
                sizes="(max-width: 760px) 100vw, 520px"
                width={1280}
                height={800}
                alt={shot.alt}
                decoding="async"
              />
              <figcaption>
                <strong>{shot.title}.</strong> {shot.caption}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
      {stage === "choose" ? (
        <section className={styles.paths} aria-labelledby="paths-title">
          <h3 id="paths-title">How would you like to start?</h3>
          <ul>
            {PATHS.map((item) => (
              <li key={item.path}>
                <button
                  type="button"
                  className={styles.path}
                  disabled={busy}
                  aria-describedby={`path-${item.path}`}
                  onClick={() => onChoose(item.path)}
                >
                  <strong>{item.title}</strong>
                  <span className={styles.pathWho}>{item.who}</span>
                  <span id={`path-${item.path}`} className={styles.pathWhat}>
                    {item.what}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {error}
        </section>
      ) : stage === "demo" ? (
        <div className={styles.next}>
          <p>
            Your guided game is waiting: two bots play Commander while each move
            is explained.
          </p>
          <div className={styles.links}>
            <button
              type="button"
              className={shell.primary}
              disabled={busy}
              onClick={onWatch}
            >
              Watch the game
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={onSkipDemo}
            >
              Skip to the setup
            </button>
          </div>
          {error}
        </div>
      ) : (
        <div className={styles.next}>
          <p>
            {stage === "overview"
              ? "First, a quick overview of the game, then your name, two free starter decks and a Planeswalker to ally with."
              : left === "handle"
                ? "Three quick steps: the name other players see, two free starter decks, and a Planeswalker to ally with."
                : left === "starters"
                  ? "Two quick steps left: your two free starter decks, and a Planeswalker to ally with."
                  : "One step left: a Planeswalker to ally with."}
          </p>
          <button type="button" className={shell.primary} onClick={onNext}>
            {stage === "overview"
              ? "Continue the overview"
              : left === "handle"
                ? "Set up my game"
                : "Continue setup"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The alliance, offered once the starter decks are chosen; it may wait for later. */
function AllianceStep({
  me,
  onChange,
  heading,
  tips,
  onDone,
}: {
  me: Me;
  onChange: (me: Me) => void;
  heading: RefObject<HTMLHeadingElement | null>;
  tips: boolean;
  onDone: () => void;
}) {
  const standing = useStanding(me.id);
  const alliance = useAllianceChange(me, onChange, standing);
  return (
    <div className={styles.body}>
      {tips && (
        <TourTip>
          Your ally's portrait becomes your picture everywhere, and their cards
          join your library while you're allied. You can change allies at any
          time on Profile, and more Planeswalkers open as you win.
        </TourTip>
      )}
      <AllianceOffer
        standing={standing}
        alliance={alliance}
        onDone={onDone}
        heading={heading}
      />
    </div>
  );
}

function Done({
  me,
  heading,
  busy,
  error,
  onClose,
  onTour,
}: {
  me: Me;
  heading: RefObject<HTMLHeadingElement | null>;
  busy: boolean;
  error: ReactNode;
  onClose: () => void;
  /** Starts the main menu's tour, or skips it. */
  onTour: (skip: boolean) => void;
}) {
  const tour = guided(tutorialOf(me)) && tutorialOf(me).stage === "setup";
  return (
    <div className={styles.done}>
      <h2 id="setup-step-title" ref={heading} tabIndex={-1}>
        You're ready to play, {me.handle ?? me.display_name}.
      </h2>
      {tour ? (
        <>
          <p className={styles.lead}>
            Your two starter decks are in Decks, and their cards in your
            library. One more thing: you have 1,000 tokens to spend. Let's look
            around: open your first pack at Leng's Card Shop, list a card at
            Tivit's Auction House, then see your decks and where to play.
          </p>
          <div className={styles.links}>
            <button
              type="button"
              className={shell.primary}
              disabled={busy}
              onClick={() => onTour(false)}
            >
              Show me around
            </button>
            {tutorialOf(me).path === "novice" && (
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => onTour(true)}
              >
                Skip the tour
              </button>
            )}
          </div>
          {error}
        </>
      ) : (
        <>
          <p className={styles.lead}>
            Your two starter decks are in Decks, and their cards in your
            library. Start a practice game against the bots, or look through
            your decks first.
          </p>
          <div className={styles.links}>
            <a className={shell.primary} href="#play" onClick={onClose}>
              Play a practice game
            </a>
            <a className={styles.secondary} href="#decks" onClick={onClose}>
              See your decks
            </a>
          </div>
        </>
      )}
    </div>
  );
}
