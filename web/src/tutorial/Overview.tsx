import { useEffect, useRef, useState, type RefObject } from "react";
import shell from "../App.module.css";
import { LearnMore } from "./LearnMore";
import styles from "./tutorial.module.css";

// The Novice's overview (v0.8.4): how Commander Duels works, then a short refresher on Magic's
// rules, a page at a time. The wizard shows it before the setup; Settings › Tutorial again later.

interface OverviewPage {
  part: "Commander Duels" | "A Magic refresher";
  title: string;
  points: string[];
}

export const OVERVIEW: OverviewPage[] = [
  {
    part: "Commander Duels",
    title: "The table",
    points: [
      "Play Commander (two to four players, 40 life each, 100-card decks led by a commander) or Legacy (two players, 20 life each, 60-card decks).",
      "Play page: a practice game against bots, at the skill you choose. Tables: find a game in the public queue, or sit down with other players.",
      "At the table, the big diamonds on the left are your choices; drag a card from your hand to play it, or click it.",
    ],
  },
  {
    part: "Commander Duels",
    title: "Your library and your decks",
    points: [
      "Every card you own is in your library, on the Cards page. Cards come from your starter decks, packs, the auction house, your ally and the campaign.",
      "Decks are built from your library: a deck may hold as many copies of a card as you own, and the format's rules are checked as you build.",
      "You'll choose two free starter decks in a moment, ready to play.",
    ],
  },
  {
    part: "Commander Duels",
    title: "Tokens and Leng's Card Shop",
    points: [
      "Tokens are the game's money. You start with 1,000; wins, daily quests and achievements earn more.",
      "Leng's Card Shop sells booster packs from every era of Magic for tokens. Packs open card by card at the counter, and every card is yours for good.",
      "Tokens are play money only: there is nothing to pay for and nothing to cash out.",
    ],
  },
  {
    part: "Commander Duels",
    title: "Tivit's Auction House",
    points: [
      "Sell the cards you don't need to other players, or bid on theirs.",
      "A listing has a starting bid, an optional Buy Now, and a length. A sale pays you in full: there is no fee.",
    ],
  },
  {
    part: "Commander Duels",
    title: "The Alliance and the Campaign",
    points: [
      "Ally with a Planeswalker: their portrait becomes yours, and their cards join your library while you're allied. Wins raise your tier and open more of them.",
      "The Campaign, The Final Concordance: fourteen one-on-one Commander duels against Planeswalker wardens. Beat one the first time to win their deck and tokens.",
    ],
  },
  {
    part: "A Magic refresher",
    title: "Turns and mana",
    points: [
      "A turn goes untap, upkeep, draw, first main phase, combat, second main phase, end.",
      "Once in each of your turns, in a main phase, you may play a land. Tap lands for mana: Plains {W}, Islands {U}, Swamps {B}, Mountains {R}, Forests {G}.",
      "A spell's cost is at its top right. {2}{G} is two mana of any kind and one green.",
    ],
  },
  {
    part: "A Magic refresher",
    title: "Casting and the stack",
    points: [
      "Creatures, sorceries, artifacts, enchantments and planeswalkers are cast in your own main phase, with the stack empty. Instants, and abilities, any time you have priority.",
      "Spells and abilities wait on the stack, and every player may respond. The stack resolves from the top: the last one in happens first.",
      "Passing priority with nothing to do is Continue at the table.",
    ],
  },
  {
    part: "A Magic refresher",
    title: "Combat",
    points: [
      "Your creatures attack players or planeswalkers; attacking taps them. A creature can't attack the turn it arrives (summoning sickness) unless it has haste.",
      "The defender's untapped creatures may block. Creatures deal their power in damage; damage equal to toughness destroys a creature. Unblocked attackers damage the player.",
      "Keywords to know: flying (only flying or reach blocks it), trample, vigilance (attacks without tapping), deathtouch, lifelink, first strike.",
    ],
  },
  {
    part: "A Magic refresher",
    title: "Commander's own rules",
    points: [
      "One copy of each card, basic lands aside, and every card shares the commander's colors.",
      "Your commander starts in the command zone and is cast from there. If it would go to the graveyard or exile, it may go back; each cast from the command zone after the first costs {2} more (the commander tax).",
      "A player dealt 21 combat damage by the same commander loses, whatever their life.",
    ],
  },
];

export function Overview({
  heading,
  doneLabel,
  onDone,
}: {
  heading?: RefObject<HTMLHeadingElement | null>;
  doneLabel: string;
  onDone: () => void;
}) {
  const [at, setAt] = useState(0);
  const own = useRef<HTMLHeadingElement>(null);
  const title = heading ?? own;
  const page = OVERVIEW[at]!;
  const last = at === OVERVIEW.length - 1;
  const first = useRef(true);
  // Each page after the first takes focus to its heading, as the wizard's steps do.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    title.current?.focus();
  }, [at, title]);
  return (
    <div className={styles.overview}>
      <span className={shell.eyebrow}>
        {page.part.toUpperCase()} · {at + 1} OF {OVERVIEW.length}
      </span>
      <h2 id="overview-title" ref={title} tabIndex={-1}>
        {page.title}
      </h2>
      <ul className={styles.points}>
        {page.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <LearnMore title={page.title} />
      <ol className={styles.dots} aria-hidden="true">
        {OVERVIEW.map((item, index) => (
          <li
            key={item.title}
            data-on={index === at || undefined}
            data-part={item.part === "A Magic refresher" ? "rules" : "site"}
          />
        ))}
      </ol>
      <div className={styles.overviewActions}>
        {at > 0 && (
          <button
            type="button"
            className={styles.quiet}
            onClick={() => setAt(at - 1)}
          >
            Back
          </button>
        )}
        {last ? (
          <button type="button" className={shell.primary} onClick={onDone}>
            {doneLabel}
          </button>
        ) : (
          <button
            type="button"
            className={shell.primary}
            onClick={() => setAt(at + 1)}
          >
            Next <span aria-hidden="true">▸</span>
          </button>
        )}
        {!last && (
          <button type="button" className={styles.quiet} onClick={onDone}>
            Skip the overview
          </button>
        )}
      </div>
    </div>
  );
}
