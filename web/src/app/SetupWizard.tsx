import { useEffect, useRef, useState, type RefObject } from "react";
import { HandleForm } from "../Account";
import { type Me } from "../api";
import { AllianceOffer, useAllianceChange } from "../alliance/StandingPanels";
import { StarterPicker } from "../alliance/StarterPicker";
import { useStanding } from "../alliance/useStanding";
import shell from "../App.module.css";
import styles from "./SetupWizard.module.css";

/**
 * The setup wizard (v0.4.2): a new account's welcome to the game, with a quick look at it in
 * screenshots, then the account's handle (the name other players see, at the table and later in
 * a game's chat), its two free starter decks and an alliance. App opens it by itself each time
 * the site opens on an account that has not finished the first two (a new sign-in or a reload),
 * and again from the notice on every page and from Profile. Closing it leaves the account where
 * it was; the alliance may also wait for later. Every choice is the server's, as on Profile.
 */
export type SetupStep = "welcome" | "handle" | "starters" | "alliance" | "done";

const STEPS: { step: Exclude<SetupStep, "done">; label: string }[] = [
  { step: "welcome", label: "Welcome" },
  { step: "handle", label: "Your name" },
  { step: "starters", label: "Starter decks" },
  { step: "alliance", label: "Alliance" },
];

/** Each step's heading, which names the dialog. */
const TITLES: Record<SetupStep, string> = {
  welcome: "setup-step-title",
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

/** The four screenshots of the welcome (web/public/welcome), each in two sizes. */
const SHOTS = [
  {
    name: "table",
    title: "The table",
    caption:
      "Commander and Legacy at a Magic Duels-style table, against bots or other players.",
    alt: "A Commander game at the table: both players' battlefields with their creatures and lands, the hand along the bottom.",
  },
  {
    name: "decks",
    title: "The deck builder",
    caption:
      "Build decks from your own library; each format's rules are checked as you go.",
    alt: "The deck builder: a Commander deck's cards beside the card finder.",
  },
  {
    name: "shop",
    title: "Leng's card shop",
    caption:
      "Wins earn tokens: spend them on packs from Revised to today, and on more decks.",
    alt: "Leng's card shop: Leng at the counter, and booster packs on the shelves with their prices in tokens.",
  },
  {
    name: "alliance",
    title: "The Planeswalker Alliance",
    caption:
      "Ally with a Planeswalker for their cards and portrait; more open as you win.",
    alt: "The Planeswalker Alliance: Planeswalker portraits to ally with, by tier.",
  },
] as const;

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

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open === null) {
      if (node.open) node.close?.();
      return;
    }
    setStep(open === "welcome" ? "welcome" : (setupStep(me) ?? "alliance"));
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
  const index = STEPS.findIndex((item) => item.step === step);
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
              {STEPS.map((item, at) => (
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
              onNext={() => setStep(setupStep(me) ?? "alliance")}
            />
          ) : step === "handle" ? (
            <div className={styles.body}>
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
              onDone={() => setStep("done")}
            />
          ) : (
            <Done me={me} heading={heading} onClose={finish} />
          )}
        </>
      )}
    </dialog>
  );
}

function Welcome({
  me,
  heading,
  onNext,
}: {
  me: Me;
  heading: RefObject<HTMLHeadingElement | null>;
  onNext: () => void;
}) {
  const left = setupStep(me);
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
      <div className={styles.next}>
        <p>
          {left === "handle"
            ? "Three quick steps: the name other players see, two free starter decks, and a Planeswalker to ally with."
            : left === "starters"
              ? "Two quick steps left: your two free starter decks, and a Planeswalker to ally with."
              : "One step left: a Planeswalker to ally with."}
        </p>
        <button type="button" className={shell.primary} onClick={onNext}>
          {left === "handle" ? "Set up my game" : "Continue setup"}
        </button>
      </div>
    </div>
  );
}

/** The alliance, offered once the starter decks are chosen; it may wait for later. */
function AllianceStep({
  me,
  onChange,
  heading,
  onDone,
}: {
  me: Me;
  onChange: (me: Me) => void;
  heading: RefObject<HTMLHeadingElement | null>;
  onDone: () => void;
}) {
  const standing = useStanding(me.id);
  const alliance = useAllianceChange(me, onChange, standing);
  return (
    <div className={styles.body}>
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
  onClose,
}: {
  me: Me;
  heading: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
}) {
  return (
    <div className={styles.done}>
      <h2 id="setup-step-title" ref={heading} tabIndex={-1}>
        You're ready to play, {me.handle ?? me.display_name}.
      </h2>
      <p className={styles.lead}>
        Your two starter decks are in Decks, and their cards in your library.
        Start a practice game against the bots, or look through your decks
        first.
      </p>
      <div className={styles.links}>
        <a className={shell.primary} href="#play" onClick={onClose}>
          Play a practice game
        </a>
        <a className={styles.secondary} href="#decks" onClick={onClose}>
          See your decks
        </a>
      </div>
    </div>
  );
}
