import { useEffect, useState, type ReactNode } from "react";
import type { Me } from "../api";
import type { Page } from "../shell/pages";
import { Coach, type CoachStep } from "./Coach";
import {
  bestPulled,
  moveTutorial,
  rememberTourCard,
  tourCard,
  useTutorialSignal,
  type TourStage,
} from "./tutorial";
import styles from "./tutorial.module.css";

// The main menu's tour (v0.8.4), for Beginner and Novice players once their game is set up:
// first to Leng's Card Shop to buy and open a pack, then to Tivit's Auction House to list a card
// from it; since v0.8.5 on to Decks (the starter decks, and building one) and to the Play page,
// where it ends at the practice table. Each page it passes through says what happened with a
// tutorial signal, or the player presses Next; the stage is the account's, so a reload or another
// device picks up where the player was. "Skip the tour" ends it at once, from any bubble.

/** The practice table's start button, which the Play page marks with no data-tour name. */
function startButton(): HTMLElement | null {
  const table = document.getElementById("practice");
  if (!table) return null;
  return (
    [
      ...table.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
    ].find((button) =>
      /Start the game|Shuffling/.test(button.textContent ?? ""),
    ) ?? null
  );
}

/** The first of the player's decks on the Decks page (the list itself can be taller than a
 * phone's window). */
function firstDeck(): HTMLElement | null {
  return (
    document
      .querySelector<HTMLElement>("main ul li a[href^='#deck/']")
      ?.closest("li") ?? null
  );
}

function buildButton(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("main button")].find(
      (button) => button.textContent?.trim() === "Build one with help",
    ) ?? null
  );
}

export function Tour({
  me,
  page,
  onChange,
}: {
  me: Me;
  page: Page;
  onChange: (me: Me) => void;
}) {
  /** The last bubble, once the tour has ended at the practice table. */
  const [finished, setFinished] = useState(false);
  /** Where on Decks the player is: the decks, then building one. */
  const [decksStep, setDecksStep] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const stage = me.tutorial?.stage;

  async function move(stage: TourStage | "done", skipped = false) {
    if (busy) return false;
    setBusy(true);
    try {
      const moved = await moveTutorial({ stage, skipped });
      if ("me" in moved) {
        setError("");
        onChange(moved.me);
      } else setError(moved.error);
      return "me" in moved;
    } finally {
      setBusy(false);
    }
  }

  useTutorialSignal((signal, cards) => {
    if (signal === "pack_opened" && stage === "tour_shop") {
      rememberTourCard(bestPulled(cards));
      void move("tour_auctions");
    }
    if (signal === "card_listed" && stage === "tour_auctions") {
      setDecksStep(0);
      void move("tour_decks");
    }
  });

  // A practice game started from the Play page ends the tour: the table takes the screen.
  useEffect(() => {
    if (stage !== "tour_play") return;
    const started = () => {
      if (/^#game\//i.test(window.location.hash)) void move("done");
    };
    window.addEventListener("hashchange", started);
    return () => window.removeEventListener("hashchange", started);
  });

  const close = (
    <button
      type="button"
      className={styles.coachPrimary}
      onClick={() => setFinished(false)}
    >
      Close
    </button>
  );
  if (finished)
    return (
      <Coach
        label="Tour finished"
        steps={[
          {
            title: "You're all set",
            text: "That's the tour. Win games for tokens, open packs, build decks, and have fun. Settings › Tutorial has the tour and the guided game again whenever you want them.",
          },
        ]}
        actions={close}
      />
    );
  if (
    stage !== "tour_shop" &&
    stage !== "tour_auctions" &&
    stage !== "tour_decks" &&
    stage !== "tour_play"
  )
    return null;

  const skip = (
    <button
      type="button"
      className={styles.coachQuiet}
      disabled={busy}
      onClick={() => void move("done", true)}
    >
      Skip the tour
    </button>
  );
  const go = (href: string, words: string) => (
    <a className={styles.coachPrimary} href={href}>
      {words}
    </a>
  );
  const next = (onClick: () => void, words = "Next") => (
    <button
      type="button"
      className={styles.coachPrimary}
      disabled={busy}
      onClick={onClick}
    >
      {words} <span aria-hidden="true">▸</span>
    </button>
  );
  const card = tourCard();
  let steps: CoachStep[];
  let lead: ReactNode = null;
  if (stage === "tour_shop") {
    if (page === "Home")
      steps = [
        {
          target: "shop",
          title: "Leng's Card Shop",
          text: "You have some tokens! Let's go check out Leng's Card Shop and tear some packs!",
        },
      ];
    else if (page === "Shop")
      steps = [
        {
          target: "pack-reveal",
          title: "Turn them over",
          text: "Click each card to turn it over, or press Reveal all. Rares and mythics glow, and foils shimmer. Every card joins your library for good.",
        },
        {
          target: "pack-tear",
          title: "Tear it open",
          text: "Click the pack to tear it open. Its cards are dealt face down.",
        },
        {
          target: "pack-opening",
          title: "Opening your pack",
          text: "Turn the cards over as they come.",
        },
        {
          target: "open-pack",
          title: "Your pack is in",
          text: "It waits under Your packs. Press Open a pack.",
        },
        {
          target: "buy",
          title: "Buy a pack",
          text: "Packs cost tokens, and you start with 1,000. Pick any pack (the weekly sale has five at 20% off, and every era is listed below), press Buy, then confirm.",
        },
        {
          title: "Buy a pack",
          text: "Pick a pack you can afford in the list below, press Buy, then confirm.",
        },
      ];
    else {
      steps = [
        {
          title: "The tour",
          text: "The tour goes on at Leng's Card Shop, where your tokens buy packs.",
        },
      ];
      lead = go("#shop", "Go to Leng's shop");
    }
  } else if (stage === "tour_auctions") {
    if (page === "Home")
      steps = [
        {
          target: "auctions",
          title: "Tivit's Auction House",
          text: "Here other players bid on the cards you list, and you on theirs. Let's list your first card.",
        },
      ];
    else if (page === "Auctions")
      steps = [
        {
          target: "sell",
          title: "Sell a card",
          text: card
            ? `Press Sell a card to list the ${card.name} from your pack. Each step is explained as you go, and nothing is listed until you confirm.`
            : "Press Sell a card, then find a card from your pack. Each step is explained as you go, and nothing is listed until you confirm.",
        },
      ];
    else {
      steps = [
        {
          title: "Great pulls!",
          text: card
            ? `Every card is yours for good. Next, let's put your ${card.name} up for sale at Tivit's Auction House.`
            : "Every card is yours for good. Next, let's put one up for sale at Tivit's Auction House.",
        },
      ];
      lead = go("#auctions/search", "Go to Tivit's Auction House");
    }
  } else if (stage === "tour_decks") {
    if (page === "Decks")
      steps =
        decksStep === 0
          ? [
              {
                target: "deck-list",
                locate: firstDeck,
                title: "Your decks",
                text: "A deck is the cards you bring to a game. Your two starter decks are already here, ready to play, and every card in them is in your library for good. Open one to see its cards.",
                actions: next(() => setDecksStep(1)),
              },
              {
                title: "Your decks",
                text: "A deck is the cards you bring to a game. Your two starter decks are here, ready to play, and every card in them is in your library for good.",
                actions: next(() => setDecksStep(1)),
              },
            ]
          : [
              {
                target: "deck-build",
                locate: buildButton,
                title: "Build your own",
                text: "When you want a deck of your own, Build one with help picks a commander and cards from your library, or New deck starts an empty one. Each card you pull from a pack can go in.",
                actions: next(() => void move("tour_play"), "On to Play"),
              },
              {
                title: "Build your own",
                text: "When you want a deck of your own, Build one with help picks a commander and cards from your library, or New deck starts an empty one.",
                actions: next(() => void move("tour_play"), "On to Play"),
              },
            ];
    else if (page === "Home" || page === "Auctions")
      steps = [
        {
          target: "decks",
          title: "Decks",
          text: card
            ? `Your ${card.name} is listed: if the auction ends with a bid, the tokens are yours, in full. Next, the decks you play with.`
            : "Your card is listed: if the auction ends with a bid, the tokens are yours, in full. Next, the decks you play with.",
        },
        {
          title: "Decks",
          text: card
            ? `Your ${card.name} is listed: if the auction ends with a bid, the tokens are yours, in full. Next, the decks you play with.`
            : "Your card is listed: if the auction ends with a bid, the tokens are yours, in full. Next, the decks you play with.",
          actions: go("#decks", "Go to Decks"),
        },
      ];
    else {
      steps = [
        {
          title: "The tour",
          text: "The tour goes on at Decks, where your starter decks are.",
        },
      ];
      lead = go("#decks", "Go to Decks");
    }
  } else {
    if (page === "Play")
      steps = [
        {
          target: "practice-start",
          locate: startButton,
          title: "Play a practice game",
          text: "At the practice table you play against bots. Pick Commander and one of your starter decks, choose how many bots and how good they are, then press Start the game. Wins against bots earn tokens too.",
          actions: next(() => {
            void move("done").then((ok) => ok && setFinished(true));
          }, "Finish the tour"),
        },
        {
          title: "Play a practice game",
          text: "At the practice table you play against bots with one of your decks. Wins against bots earn tokens too.",
          actions: next(() => {
            void move("done").then((ok) => ok && setFinished(true));
          }, "Finish the tour"),
        },
      ];
    else if (page === "Home")
      steps = [
        {
          target: "play",
          title: "Play",
          text: "Last stop: Play, where you can start a practice game against the bots with one of your decks.",
        },
      ];
    else {
      steps = [
        {
          title: "Play",
          text: "Last stop: the Play page, where you can start a practice game against the bots with one of your decks.",
        },
      ];
      lead = go("#practice", "Go to Play");
    }
  }
  return (
    <Coach
      steps={steps}
      actions={
        <>
          {lead}
          {skip}
          {error && (
            <span className={styles.coachError} role="alert">
              {error}
            </span>
          )}
        </>
      }
    />
  );
}
