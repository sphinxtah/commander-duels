import { useState, type ReactNode } from "react";
import type { Me } from "../api";
import type { Page } from "../shell/pages";
import { Coach, type CoachStep } from "./Coach";
import {
  bestPulled,
  moveTutorial,
  rememberTourCard,
  tourCard,
  useTutorialSignal,
} from "./tutorial";
import styles from "./tutorial.module.css";

// The main menu's tour (v0.8.4), for Beginner and Novice players once their game is set up:
// first to Leng's Card Shop to buy and open a pack, then to Tivit's Auction House to list a card
// from it. Each page it passes through says what happened with a tutorial signal; the stage is
// the account's, so a reload or another device picks up where the player was. "Skip the tour"
// ends it at once.

export function Tour({
  me,
  page,
  onChange,
}: {
  me: Me;
  page: Page;
  onChange: (me: Me) => void;
}) {
  const [finished, setFinished] = useState<string | null>(null);
  const [error, setError] = useState("");
  const stage = me.tutorial?.stage;

  async function move(stage: "tour_auctions" | "done", skipped = false) {
    const moved = await moveTutorial({ stage, skipped });
    if ("me" in moved) {
      setError("");
      onChange(moved.me);
    } else setError(moved.error);
    return "me" in moved;
  }

  useTutorialSignal((signal, cards) => {
    if (signal === "pack_opened" && stage === "tour_shop") {
      rememberTourCard(bestPulled(cards));
      void move("tour_auctions");
    }
    if (signal === "card_listed" && stage === "tour_auctions") {
      const card = tourCard();
      void move("done").then((ok) => {
        if (ok) {
          setFinished(card?.name ?? "card");
          rememberTourCard(null);
        }
      });
    }
  });

  if (finished)
    return (
      <Coach
        label="Tour finished"
        steps={[
          {
            title: "You're all set",
            text: `Your ${finished} is on the market. When the auction ends with a bid, the tokens are yours, in full. That's the tour: win games for more tokens, open packs, build decks, and have fun.`,
          },
        ]}
        actions={
          <button
            type="button"
            className={styles.coachPrimary}
            onClick={() => setFinished(null)}
          >
            Close
          </button>
        }
      />
    );
  if (stage !== "tour_shop" && stage !== "tour_auctions") return null;

  const skip = (
    <button
      type="button"
      className={styles.coachQuiet}
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
          text: "Click each card to turn it over, or Reveal all. Rares and mythics glow, and foils shimmer. Every card joins your library for good.",
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
          text: "Every pack here is priced in tokens, and you started with 1,000. Pick any pack you like (the weekly sale has five at 20% off, and every era is listed below), press Buy, then confirm.",
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
  } else {
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
