// How to play's own guide (v0.8.6, docs/how-to-play.md): Magic explained in plain words, with
// examples, for a player who has never played. It is original writing, not Wizards' text: each
// topic names the official rules it explains (`rules`), and any "rule 702.19" in its words links to
// that rule in the official text when the build has it. Example cards are the keys of
// content/how-to-play-cards.json; screenshots are the table's own (web/e2e/how-to-play-shots.spec.ts
// takes them from the tutorial's guided game).

import cardData from "../../../content/how-to-play-cards.json";

export type CardKey = keyof typeof cardData.cards;

export interface GuideCard {
  name: string;
  cost: string | null;
  type: string;
  pt: string | null;
  rules: string[];
}

export const CARDS = cardData.cards as Record<CardKey, GuideCard>;

/** The parts of a card a callout points at: where they lie on a modern card frame. */
export type CardPart =
  "name" | "cost" | "art" | "type" | "set" | "text" | "pt" | "artist";

export interface Callout {
  part: CardPart;
  label: string;
  text: string;
}

/** A screenshot of the table and the places on it the guide points at (shots.json has where). */
export type ShotId =
  "table" | "commander" | "attacking" | "blocking" | "stack" | "prompt";

export interface ShotMark {
  /** The place's id in shots.json. */
  mark: string;
  label: string;
  text: string;
}

export type Block =
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "steps"; title: string; steps: string[] }
  | {
      kind: "anatomy";
      card: CardKey;
      callouts: Callout[];
      caption: string;
    }
  | {
      kind: "cards";
      cards: { card: CardKey; note: string }[];
      caption?: string;
    }
  | {
      kind: "example";
      title: string;
      cards?: CardKey[];
      steps: string[];
      outcome: string;
    }
  | { kind: "shot"; shot: ShotId; caption: string; marks: ShotMark[] }
  | { kind: "tip"; text: string }
  | { kind: "table"; head: string[]; rows: string[][]; caption?: string };

export interface Topic {
  /** The address part: #how-to-play/<id>. */
  id: string;
  title: string;
  /** One sentence: what the topic answers. Shown in the contents and search. */
  summary: string;
  /** The official rules it explains, by number. */
  rules: string[];
  blocks: Block[];
}

export interface GuideChapter {
  id: string;
  title: string;
  topics: Topic[];
}

export const GUIDE: GuideChapter[] = [
  {
    id: "start",
    title: "Start here",
    topics: [
      {
        id: "what-is-magic",
        title: "What Magic is",
        summary:
          "Two or more players, a deck each, and a race to bring the others' life to zero.",
        rules: ["100.1", "103.4", "104.2"],
        blocks: [
          {
            kind: "p",
            text: "Magic: The Gathering is a card game for two or more players. Each player brings a deck of cards they chose themselves. The cards are spells: creatures that fight for you, lands that give you the energy (called mana) to cast spells, and sorceries, instants, artifacts and enchantments that change the game in every way you can think of.",
          },
          {
            kind: "p",
            text: "Every player starts with a life total: 20 in most games, 40 in Commander. You take turns. On your turn you draw a card, play a land, cast spells and attack with your creatures. The usual way to win is to bring every other player's life to 0. There are other ways, and the guide covers each.",
          },
          {
            kind: "p",
            text: "Commander Duels plays two formats. Commander is the main one: two to four players, 40 life, a 100-card deck led by a legendary creature called your commander. Legacy is a one-on-one game with 60-card decks and 20 life.",
          },
          {
            kind: "steps",
            title: "A game at a glance",
            steps: [
              "Shuffle your deck and draw seven cards. That is your opening hand.",
              "Take turns. Each turn has the same order of steps: untap, upkeep, draw, a main phase, combat, a second main phase, and the end of the turn.",
              "Play one land a turn, and tap your lands for mana to cast spells.",
              "Attack with your creatures. Creatures that aren't blocked deal their damage to the player they attack.",
              "A player at 0 life loses. The last player standing wins.",
            ],
          },
          {
            kind: "tip",
            text: "You never need to know every rule to play. The table at Commander Duels knows them all: it only offers you what is legal, and it does the bookkeeping. This guide explains why.",
          },
        ],
      },
      {
        id: "winning-and-losing",
        title: "Winning and losing",
        summary:
          "Every way a player loses, and how the last one standing wins.",
        rules: ["104.2", "104.3", "704.5a", "704.5b", "704.5c", "903.10a"],
        blocks: [
          {
            kind: "p",
            text: "You win when every other player has lost. A player can lose in several ways, and the game checks for each of them all the time (these checks are called state-based actions, see rule 704):",
          },
          {
            kind: "table",
            head: ["A player loses when…", "In plain words", "Rule"],
            rows: [
              [
                "their life is 0 or less",
                "Damage and life loss brought them down to nothing.",
                "104.3b",
              ],
              [
                "they must draw from an empty library",
                "They ran out of cards. Drawing the last card is fine; trying to draw one more is not.",
                "104.3c",
              ],
              [
                "they have ten or more poison counters",
                "Some creatures (with infect or toxic) give poison instead of damage.",
                "104.3d",
              ],
              [
                "a card says they lose",
                "A few cards win or lose the game outright.",
                "104.3e",
              ],
              [
                "they concede",
                "Any player may leave the game at any time. They lose.",
                "104.3a",
              ],
              [
                "(Commander) one commander has dealt them 21 combat damage",
                "Counted per commander over the whole game.",
                "104.3j",
              ],
            ],
          },
          {
            kind: "p",
            text: "In a game of three or four, a player who loses leaves the game and the others play on. Their cards leave with them (rule 800.4a).",
          },
          {
            kind: "example",
            title: "The empty library",
            steps: [
              "Vok has one card left in his library.",
              "His turn begins. In his draw step he draws it. He is fine.",
              "Next turn he must draw again, with no card to draw.",
            ],
            outcome:
              "Vok loses the game the moment the game next checks, before anyone can do anything.",
          },
        ],
      },
      {
        id: "golden-rules",
        title: "The golden rules",
        summary:
          'Card text beats the rules, "can\'t" beats "can", and whose turn decides the order.',
        rules: ["101.1", "101.2", "101.3", "101.4"],
        blocks: [
          {
            kind: "p",
            text: "Magic has thousands of different cards, and many of them break a rule on purpose. Four principles settle every clash:",
          },
          {
            kind: "list",
            items: [
              "When a card contradicts the rules, the card wins (rule 101.1). The rules say you play one land a turn; a card that lets you play two is right.",
              "When one effect says you can and another says you can't, \"can't\" wins (rule 101.2).",
              "If something is impossible to do, you just don't do it (rule 101.3). Discarding two cards with one card in hand discards that one.",
              "When several players must make choices at once, the player whose turn it is chooses first, then the others in turn order (rule 101.4). Players call this APNAP: active player, nonactive player.",
            ],
          },
        ],
      },
    ],
  },
  {
    id: "cards",
    title: "The cards",
    topics: [
      {
        id: "card-anatomy",
        title: "Reading a card",
        summary: "What each part of a card tells you, with arrows.",
        rules: ["200.1", "201.1", "202.1", "205.1", "207.1", "208.1"],
        blocks: [
          {
            kind: "anatomy",
            card: "serraAngel",
            caption:
              "Serra Angel: a white creature that costs five mana, flies, and doesn't tap to attack.",
            callouts: [
              {
                part: "name",
                label: "Name",
                text: "What the card is called. Text that names the card means this card (rule 201).",
              },
              {
                part: "cost",
                label: "Mana cost",
                text: "What you pay to cast it: {3}{W}{W} is three mana of any kind plus two white (rule 202).",
              },
              {
                part: "art",
                label: "Illustration",
                text: "The art. It has no effect on the game.",
              },
              {
                part: "type",
                label: "Type line",
                text: "What kind of card it is, and its subtypes: a Creature, and an Angel (rule 205).",
              },
              {
                part: "set",
                label: "Set symbol",
                text: "Which set it was printed in; its colour shows the rarity (rule 206).",
              },
              {
                part: "text",
                label: "Text box",
                text: "Its abilities. Flying and vigilance are keywords, short names for rules the guide explains (rule 207).",
              },
              {
                part: "pt",
                label: "Power / toughness",
                text: "4/4: it deals 4 damage in combat, and 4 damage destroys it (rule 208).",
              },
              {
                part: "artist",
                label: "Artist and collector number",
                text: "Who painted it, and its place in the set. No effect on the game.",
              },
            ],
          },
          {
            kind: "p",
            text: "Some cards carry reminder text in italics and parentheses, like a land's ({T}: Add {G}.). It explains a rule; it is not an ability of its own. Flavour text, in italics without parentheses, is there for the story.",
          },
          {
            kind: "tip",
            text: "At the table, rest the pointer on a card, or focus it with the keyboard, and the magnifier shows it large with its current power, toughness, counters and controller. Right-click or Z zooms it.",
          },
        ],
      },
      {
        id: "card-types",
        title: "Kinds of cards",
        summary:
          "Lands, creatures, artifacts, enchantments, planeswalkers, instants, sorceries and battles.",
        rules: [
          "300.1",
          "301.1",
          "302.1",
          "303.1",
          "304.1",
          "305.1",
          "306.1",
          "307.1",
          "310.1",
        ],
        blocks: [
          {
            kind: "p",
            text: "Every card has at least one card type, on its type line. The type decides when you can play it and what it does once played. Cards that stay on the table after you play them are permanents: lands, creatures, artifacts, enchantments, planeswalkers and battles. Instants and sorceries do their thing once and go to your graveyard.",
          },
          {
            kind: "cards",
            caption: "One of each of the most common kinds",
            cards: [
              {
                card: "forest",
                note: "Land. Play one a turn; tap it for mana. Playing a land is not casting a spell.",
              },
              {
                card: "grizzlyBears",
                note: "Creature. Attacks and blocks. Its power and toughness are at the bottom right.",
              },
              {
                card: "solRing",
                note: "Artifact. An object with an ability; this one makes mana.",
              },
              {
                card: "pacifism",
                note: "Enchantment. A lasting effect; an Aura like this one attaches to something.",
              },
              {
                card: "chandra",
                note: "Planeswalker. A powerful ally with loyalty abilities, one a turn.",
              },
              {
                card: "lightningBolt",
                note: "Instant. Cast it any time you could act, even on another player's turn.",
              },
              {
                card: "divination",
                note: "Sorcery. Cast it only in your own main phase, when nothing else is waiting.",
              },
            ],
          },
          {
            kind: "table",
            head: ["Type", "When you can cast it", "After it resolves", "Rule"],
            rows: [
              [
                "Land",
                "Played, not cast: your main phase, stack empty, once a turn",
                "Stays on the battlefield",
                "305",
              ],
              [
                "Creature",
                "Your main phase, stack empty",
                "Stays on the battlefield",
                "302",
              ],
              [
                "Artifact",
                "Your main phase, stack empty",
                "Stays on the battlefield",
                "301",
              ],
              [
                "Enchantment",
                "Your main phase, stack empty",
                "Stays on the battlefield",
                "303",
              ],
              [
                "Planeswalker",
                "Your main phase, stack empty",
                "Stays on the battlefield",
                "306",
              ],
              [
                "Battle",
                "Your main phase, stack empty",
                "Stays on the battlefield; others attack it",
                "310",
              ],
              [
                "Instant",
                "Any time you have priority",
                "Goes to the graveyard",
                "304",
              ],
              [
                "Sorcery",
                "Your main phase, stack empty",
                "Goes to the graveyard",
                "307",
              ],
            ],
          },
          {
            kind: "p",
            text: "Legendary is a supertype: you can control only one legendary permanent with a given name. If you get a second, you choose one and the other goes to the graveyard (rule 704.5j). Basic is another supertype, for the five basic lands. Tokens are permanents made by effects rather than cards from your deck (rule 111).",
          },
        ],
      },
      {
        id: "colors",
        title: "The five colours",
        summary:
          "White, blue, black, red and green, what each is good at, and colourless.",
        rules: ["105.1", "105.2", "107.4"],
        blocks: [
          {
            kind: "p",
            text: "Magic has five colours. A card's colour comes from the coloured symbols in its mana cost. A card with two colours in its cost is both colours (multicolour); one with no coloured symbols, like Sol Ring, is colourless.",
          },
          {
            kind: "table",
            head: ["Colour", "Symbol", "Basic land", "What it tends to do"],
            rows: [
              [
                "White",
                "{W}",
                "Plains",
                "Many small creatures, protection, life, rules for everyone",
              ],
              [
                "Blue",
                "{U}",
                "Island",
                "Drawing cards, countering spells, flying, tricks",
              ],
              [
                "Black",
                "{B}",
                "Swamp",
                "Destroying creatures, bringing cards back, paying life for power",
              ],
              [
                "Red",
                "{R}",
                "Mountain",
                "Direct damage, fast creatures, haste, chaos",
              ],
              [
                "Green",
                "{G}",
                "Forest",
                "Big creatures, extra lands and mana, trample",
              ],
            ],
          },
          {
            kind: "p",
            text: "Colourless mana is written {C}: Sol Ring makes {C}{C}. A cost of {C} needs colourless mana in particular, while a number like {2} can be paid with mana of any kind.",
          },
        ],
      },
    ],
  },
  {
    id: "mana",
    title: "Mana",
    topics: [
      {
        id: "lands-and-mana",
        title: "Lands and mana",
        summary: "One land a turn, tapping for mana, and the mana pool.",
        rules: ["106.1", "106.4", "305.2", "500.5", "701.26"],
        blocks: [
          {
            kind: "p",
            text: "Mana is the energy you spend to cast spells. Most of it comes from lands. Once in each of your turns, in one of your main phases while nothing is on the stack, you may play a land from your hand (rule 305.2). Playing a land doesn't use the stack, so nobody can respond to it.",
          },
          {
            kind: "p",
            text: "To get mana, tap a land: turn it sideways. A Forest taps for {G}. A tapped land stays tapped until your next untap step, so each land gives mana once a turn. The mana goes into your mana pool, where it waits until you spend it, but only until the end of the current step or phase (rule 500.5). Mana you don't use is lost.",
          },
          {
            kind: "cards",
            cards: [
              { card: "plains", note: "Taps for {W}." },
              { card: "island", note: "Taps for {U}." },
              { card: "swamp", note: "Taps for {B}." },
              { card: "mountain", note: "Taps for {R}." },
              { card: "forest", note: "Taps for {G}." },
              {
                card: "commandTower",
                note: "Taps for any colour your commander has.",
              },
            ],
          },
          {
            kind: "tip",
            text: "At the table you rarely tap lands by hand: when you cast a spell the table offers to pay, and you choose which lands to tap only if you want to.",
          },
        ],
      },
      {
        id: "paying-costs",
        title: "Paying a mana cost",
        summary: "Reading {2}{G}, generic and coloured mana, and X.",
        rules: ["107.3", "107.4", "202.1", "601.2g", "601.2h", "605.1a"],
        blocks: [
          {
            kind: "p",
            text: "A mana cost is a row of symbols. A coloured symbol needs mana of that colour. A number is generic: mana of any colour, or colourless, pays it. {2}{G} is three mana in all, at least one of it green.",
          },
          {
            kind: "example",
            title: "Casting Grizzly Bears",
            cards: ["grizzlyBears", "forest", "mountain"],
            steps: [
              "Grizzly Bears costs {1}{G}.",
              "You control a Forest and a Mountain, both untapped.",
              "Tap the Forest for {G}: that pays the green symbol.",
              "Tap the Mountain for {R}: red mana pays the generic {1}.",
            ],
            outcome: "Both lands are tapped and the Bears are cast.",
          },
          {
            kind: "p",
            text: "Some costs have an X: you choose a number, and X is that number everywhere on the card (rule 107.3). Mana abilities, like Llanowar Elves' \"{T}: Add {G}\", can be used in the middle of paying (rule 605). The total mana value of a card counts every symbol: Serra Angel's {3}{W}{W} is a mana value of 5.",
          },
          {
            kind: "cards",
            cards: [
              {
                card: "llanowarElves",
                note: "A creature with a mana ability: it taps for {G}, but not the turn it arrives.",
              },
              {
                card: "solRing",
                note: "An artifact that taps for two colourless mana.",
              },
              {
                card: "arcaneSignet",
                note: "Taps for one mana of a colour your commander has.",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "zones",
    title: "Where cards are",
    topics: [
      {
        id: "zones",
        title: "The zones",
        summary:
          "Library, hand, battlefield, graveyard, the stack, exile and the command zone.",
        rules: [
          "400.1",
          "401.1",
          "402.1",
          "403.1",
          "404.1",
          "405.1",
          "406.1",
          "408.1",
        ],
        blocks: [
          {
            kind: "p",
            text: "Every card is somewhere, and each place is a zone with its own rules. Some zones are hidden (only their owner may look, or nobody), the others are public.",
          },
          {
            kind: "shot",
            shot: "table",
            caption:
              "A Commander game at the table. Your side is the bottom half.",
            marks: [
              {
                mark: "hand",
                label: "Your hand",
                text: "Cards you hold. Hidden from the others; you see yours.",
              },
              {
                mark: "battlefield",
                label: "Your battlefield",
                text: "Your permanents: creatures near the band, lands behind them.",
              },
              {
                mark: "opponent",
                label: "An opponent",
                text: "Their portrait, life and card counts, and their battlefield above the band.",
              },
              {
                mark: "life",
                label: "Your life",
                text: "The red diamond. 40 at the start of a Commander game.",
              },
              {
                mark: "library",
                label: "Your library",
                text: "How many cards are left in your deck. The deck itself lies face down on the stone at the right; you draw from its top.",
              },
              {
                mark: "graveyard",
                label: "Your graveyard",
                text: "Your discard pile: spells that resolved, creatures that died.",
              },
              {
                mark: "command",
                label: "The command zone",
                text: "Where your commander waits until you cast it. Empty here: Mira's commander is on the battlefield.",
              },
              {
                mark: "band",
                label: "The band",
                text: "Whose turn it is, the step, and the stack in the middle.",
              },
            ],
          },
          {
            kind: "table",
            head: ["Zone", "Who sees it", "What it is", "Rule"],
            rows: [
              [
                "Library",
                "Nobody",
                "Your deck, face down, in a random order",
                "401",
              ],
              ["Hand", "You", "The cards you hold; seven to start", "402"],
              [
                "Battlefield",
                "Everyone",
                "Where permanents are: the table itself",
                "403",
              ],
              [
                "Graveyard",
                "Everyone",
                "Your discard pile, face up, in order",
                "404",
              ],
              [
                "Stack",
                "Everyone",
                "Spells and abilities waiting to happen",
                "405",
              ],
              [
                "Exile",
                "Everyone (usually)",
                "Cards removed from the game",
                "406",
              ],
              [
                "Command",
                "Everyone",
                "Your commander, emblems and a few special cards",
                "408",
              ],
            ],
          },
          {
            kind: "p",
            text: "When a card moves from one zone to another, it becomes a new object with no memory of where it was (rule 400.7). A creature that dies and comes back is a fresh creature: no counters, no damage, and summoning sick again.",
          },
          {
            kind: "tip",
            text: "Your graveyard, exile and command zone open in a drawer at the side of the table when you click them. An opponent's do too.",
          },
        ],
      },
    ],
  },
  {
    id: "turn",
    title: "A turn",
    topics: [
      {
        id: "turn-structure",
        title: "The steps of a turn",
        summary: "Five phases, always in the same order.",
        rules: ["500.1", "500.2", "500.5"],
        blocks: [
          {
            kind: "p",
            text: "Every turn has five phases, and some phases have steps (rule 500.1). The player whose turn it is is the active player. The others still get to act during it, whenever they have priority.",
          },
          {
            kind: "table",
            head: ["Phase", "Steps", "What happens"],
            rows: [
              [
                "Beginning",
                "Untap, upkeep, draw",
                'Untap your permanents, "at the beginning of your upkeep" abilities, draw a card',
              ],
              ["First main phase", "—", "Play a land, cast any spell"],
              [
                "Combat",
                "Beginning, declare attackers, declare blockers, combat damage, end of combat",
                "Attack with your creatures",
              ],
              [
                "Second main phase",
                "—",
                "The same as the first: a land if you haven't played one, any spell",
              ],
              [
                "Ending",
                "End step, cleanup",
                '"At the beginning of the end step" abilities; discard down to seven; damage wears off',
              ],
            ],
          },
          {
            kind: "p",
            text: "A step ends when nothing is waiting on the stack and every player in turn passes priority (rule 500.2). The table moves on by itself when you have nothing to do, and its phase pips at the right of the band show where the turn is.",
          },
        ],
      },
      {
        id: "beginning-phase",
        title: "Untap, upkeep and draw",
        summary: "The start of every turn.",
        rules: ["502.1", "502.3", "503.1", "504.1", "103.8a"],
        blocks: [
          {
            kind: "steps",
            title: "The beginning phase",
            steps: [
              "Untap step: you untap everything you control (rule 502.3). Nobody can cast spells here.",
              'Upkeep step: abilities that trigger "at the beginning of your upkeep" happen. Players may cast instants.',
              "Draw step: you draw a card (rule 504.1). Then players may cast instants.",
            ],
          },
          {
            kind: "p",
            text: "In a two-player game, the player who goes first skips the draw of their very first turn (rule 103.8a). In games of three or more, everyone draws from the first turn.",
          },
        ],
      },
      {
        id: "main-phase",
        title: "Main phases",
        summary: "Where you play lands and cast most of your spells.",
        rules: ["505.1", "505.6", "117.1a", "305.2"],
        blocks: [
          {
            kind: "p",
            text: "Your turn has two main phases, one before combat and one after. In either, while the stack is empty, you may play a land (if you haven't this turn) and cast any spell: creatures, sorceries, artifacts, enchantments, planeswalkers. Instants and abilities you can use at other times too.",
          },
          {
            kind: "tip",
            text: "Casting creatures after combat keeps the others guessing about your tricks while you attack; casting them before helps when they make your attack stronger.",
          },
        ],
      },
      {
        id: "ending-phase",
        title: "The end of the turn",
        summary:
          "The end step and cleanup: discarding to seven and damage wearing off.",
        rules: ["513.1", "514.1", "514.2", "402.2"],
        blocks: [
          {
            kind: "steps",
            title: "The ending phase",
            steps: [
              'End step: abilities that trigger "at the beginning of the end step" happen, and players may cast instants.',
              "Cleanup step: if you hold more than seven cards, you discard down to seven (rule 514.1).",
              'Then all damage on creatures goes away, and effects that last "until end of turn" end (rule 514.2).',
            ],
          },
          {
            kind: "example",
            title: "Damage wears off",
            cards: ["hillGiant", "lightningBolt"],
            steps: [
              "Your Hill Giant (3/3) blocks a 2/2 and takes 2 damage. It survives with 2 damage marked on it.",
              "Later in the same turn an opponent casts Lightning Bolt on it: 3 more damage.",
            ],
            outcome:
              "5 damage is at least its toughness of 3, so it is destroyed. Had the Bolt come next turn, the earlier 2 damage would have been gone and 3 would still destroy it, but a 2-damage spell would not.",
          },
        ],
      },
    ],
  },
  {
    id: "spells",
    title: "Spells and the stack",
    topics: [
      {
        id: "casting-spells",
        title: "Casting a spell",
        summary:
          "When you can cast each kind of spell, and what casting involves.",
        rules: [
          "117.1a",
          "601.2",
          "601.2a",
          "601.2b",
          "601.2c",
          "601.2h",
          "700.2",
        ],
        blocks: [
          {
            kind: "p",
            text: "Casting a spell means taking it from your hand, putting it on the stack and paying for it. Instants can be cast any time you have priority (rule 117.1a); every other spell only in your main phase while the stack is empty.",
          },
          {
            kind: "steps",
            title: "The steps of casting (rule 601.2)",
            steps: [
              "Put the card on the stack.",
              'If it is modal ("Choose one —"), choose the mode (rule 700.2).',
              "Choose its targets, if it has any.",
              "Work out the total cost, and pay it: tap lands for mana now if you haven't.",
              "The spell is cast. Abilities that trigger on casting trigger now, and every player gets a chance to respond before it resolves.",
            ],
          },
          {
            kind: "p",
            text: "A spell doesn't happen when you cast it. It waits on the stack until every player passes priority in a row; then it resolves, and its effect happens. That gap is what lets players respond to each other.",
          },
        ],
      },
      {
        id: "priority",
        title: "Priority",
        summary: "Who may act right now, and how a step moves on.",
        rules: ["117.1", "117.3a", "117.3b", "117.3c", "117.3d", "117.4"],
        blocks: [
          {
            kind: "p",
            text: "Priority is permission to act. Only the player with priority can cast a spell or use an ability. The active player gets it first in each step (rule 117.3a). When you have priority you either do something, and get priority again afterwards (rule 117.3c), or pass it to the next player in turn order (rule 117.3d).",
          },
          {
            kind: "p",
            text: "When every player passes in a row without doing anything, the top object of the stack resolves, and the active player gets priority again (rule 117.4, 117.3b). If the stack is empty when everyone passes, the step ends and the game moves on.",
          },
          {
            kind: "tip",
            text: "At the table, Continue (or the P key) passes priority. The Priority drawer can pass for you until a moment you choose: the end of the turn, your next turn, and so on. Something new on the stack still stops the pass so you can answer it.",
          },
        ],
      },
      {
        id: "the-stack",
        title: "The stack: last in, first out",
        summary: "How responses work, step by step.",
        rules: ["405.1", "405.2", "405.5", "608.1", "608.2"],
        blocks: [
          {
            kind: "p",
            text: "The stack is a pile of spells and abilities waiting to resolve. Each new one goes on top, and the top one resolves first (rule 405.5). So when you respond to a spell, your response happens before it.",
          },
          {
            kind: "shot",
            shot: "stack",
            caption:
              "Spells on the stack lie on the band, the next to resolve in the centre.",
            marks: [
              {
                mark: "stack",
                label: "The stack",
                text: "Its top object, with the older ones fanned behind it.",
              },
              {
                mark: "prompt",
                label: "Your choices",
                text: "Respond with an instant, or Continue to let it resolve.",
              },
            ],
          },
          {
            kind: "example",
            title: "A Bolt, a Growth and a Counterspell",
            cards: ["lightningBolt", "giantGrowth", "counterspell"],
            steps: [
              "Vok casts Lightning Bolt at Mira's Grizzly Bears (2/2). The stack: Bolt.",
              "Mira responds with Giant Growth on her Bears: they'll be 5/5. The stack: Bolt, Growth on top.",
              "Vok responds with Counterspell, targeting Giant Growth. The stack: Bolt, Growth, Counterspell on top.",
              "Everyone passes. Counterspell resolves first: Giant Growth is countered and goes to the graveyard.",
              "Everyone passes again. Lightning Bolt resolves: 3 damage to a 2/2.",
            ],
            outcome:
              "The Bears are destroyed. Last in, first out: the last spell cast happened first.",
          },
          {
            kind: "p",
            text: "Abilities use the stack too, except mana abilities, which happen at once (rule 605.3). Playing a land never uses the stack.",
          },
        ],
      },
      {
        id: "targets",
        title: "Targets",
        summary: 'What "target" means, and what happens when a target is gone.',
        rules: ["115.1", "115.3", "601.2c", "608.2b", "702.11a", "702.21a"],
        blocks: [
          {
            kind: "p",
            text: 'A spell or ability that says "target" makes you choose its target as you cast it (rule 601.2c), and everyone sees what you chose. "Any target" means a creature, a player, a planeswalker or a battle.',
          },
          {
            kind: "p",
            text: "When it resolves, it checks its targets again (rule 608.2b). A target that left the battlefield, or that the spell can no longer target, is illegal. If every target is illegal, the spell does nothing at all and goes to the graveyard.",
          },
          {
            kind: "example",
            title: "The target is gone",
            cards: ["lightningBolt", "swordsToPlowshares"],
            steps: [
              "Vok casts Lightning Bolt at Mira's Serra Angel.",
              "In response, Mira exiles her own Angel with Swords to Plowshares to gain 4 life.",
              "The Bolt tries to resolve. Its only target is gone.",
            ],
            outcome:
              "The Bolt does nothing. (Mira lost her Angel either way, but gained 4 life.)",
          },
          {
            kind: "p",
            text: "Hexproof means opponents can't target it (rule 702.11). Shroud means nobody can. Ward makes an opponent's spell or ability that targets it cost more, or be countered (rule 702.21). Spells that don't say \"target\", like Wrath of God, still affect those cards.",
          },
          {
            kind: "tip",
            text: "At the table, the legal targets glow when you are asked to choose; your choice glows teal, and a line runs from the spell on the stack to what it targets.",
          },
        ],
      },
      {
        id: "countering",
        title: "Countering",
        summary: "Stopping a spell before it resolves.",
        rules: ["701.6a", "701.6b"],
        blocks: [
          {
            kind: "p",
            text: "To counter a spell is to cancel it on the stack: it goes to its owner's graveyard and none of its effect happens (rule 701.6). Its mana is still spent. Only something on the stack can be countered; once a creature has resolved and is on the battlefield, a counterspell can't touch it.",
          },
          {
            kind: "cards",
            cards: [
              {
                card: "counterspell",
                note: "{U}{U}: counter target spell. Cast in response to the spell you want to stop.",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "abilities",
    title: "Abilities",
    topics: [
      {
        id: "abilities",
        title: "Static, triggered and activated",
        summary: "The three kinds of abilities, and how to tell them apart.",
        rules: [
          "113.1",
          "113.3",
          "602.1",
          "603.1",
          "603.3b",
          "604.1",
          "605.1a",
        ],
        blocks: [
          {
            kind: "p",
            text: "An ability is text on a permanent (or a card) that does something. There are three kinds, and the wording tells you which:",
          },
          {
            kind: "cards",
            cards: [
              {
                card: "gloriousAnthem",
                note: 'Static: a plain statement that is simply true while the card is on the battlefield. "Creatures you control get +1/+1." (rule 604)',
              },
              {
                card: "soulWarden",
                note: 'Triggered: starts with "When", "Whenever" or "At". It goes on the stack each time the event happens. (rule 603)',
              },
              {
                card: "prodigalSorcerer",
                note: 'Activated: "cost: effect". You choose when to use it, by paying the cost before the colon. {T} means tap it. (rule 602)',
              },
            ],
          },
          {
            kind: "p",
            text: "A creature's ability with {T} in its cost can't be used the turn the creature arrived (summoning sickness, rule 302.6). Abilities that make mana are mana abilities: they don't use the stack (rule 605).",
          },
          {
            kind: "example",
            title: "A triggered ability",
            cards: ["ravenousChupacabra"],
            steps: [
              "You cast Ravenous Chupacabra, and it resolves.",
              'It enters the battlefield, so its "When … enters" ability triggers.',
              "You choose a target creature an opponent controls; the ability goes on the stack.",
              "Your opponents may respond. Then the ability resolves.",
            ],
            outcome: "The target is destroyed, and you keep a 2/2 Chupacabra.",
          },
          {
            kind: "p",
            text: "When several of your abilities trigger at once, you put them on the stack in the order you choose (rule 603.3b); the last one you put there resolves first. The table asks you for that order.",
          },
        ],
      },
      {
        id: "planeswalkers",
        title: "Planeswalkers",
        summary: "Loyalty, one ability a turn, and attacking them.",
        rules: ["306.5b", "306.8", "606.3", "120.3c", "704.5i"],
        blocks: [
          {
            kind: "p",
            text: "A planeswalker enters with the loyalty printed at its bottom right. Once in each of your turns, in your main phase with the stack empty, you may use one of its loyalty abilities (rule 606.3): a plus ability adds loyalty, a minus ability spends it.",
          },
          {
            kind: "cards",
            cards: [
              {
                card: "chandra",
                note: "Starts at 4 loyalty. +1 for value now, −3 to deal 4 damage to a creature, −7 for an emblem that wins games.",
              },
            ],
          },
          {
            kind: "p",
            text: "Opponents can attack your planeswalkers with their creatures instead of attacking you, and damage dealt to a planeswalker removes that much loyalty (rule 120.3c). At 0 loyalty it goes to the graveyard (rule 704.5i). You can block creatures attacking your planeswalker as usual.",
          },
        ],
      },
      {
        id: "counters-and-tokens",
        title: "Counters and tokens",
        summary: "+1/+1 counters, -1/-1 counters, and tokens.",
        rules: ["111.1", "111.8", "122.1", "122.1a", "704.5d", "704.5q"],
        blocks: [
          {
            kind: "p",
            text: "A counter is a marker on a permanent or a player. A +1/+1 counter makes a creature one bigger in power and toughness for as long as it stays. If a creature has both +1/+1 and -1/-1 counters, they cancel out in pairs (rule 704.5q). Poison counters on a player count towards losing at ten.",
          },
          {
            kind: "p",
            text: "A token is a permanent made by an effect, such as the two Soldiers from Raise the Alarm. It acts like any other permanent, but if it ever leaves the battlefield it stops existing (rule 704.5d): a token that dies doesn't stay in the graveyard.",
          },
          {
            kind: "cards",
            cards: [
              { card: "raiseTheAlarm", note: "Makes two 1/1 Soldier tokens." },
              {
                card: "kenrith",
                note: "One of his abilities puts a +1/+1 counter on a creature.",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "combat",
    title: "Combat",
    topics: [
      {
        id: "combat",
        title: "Combat, step by step",
        summary: "The five steps of combat.",
        rules: ["506.1", "507.1", "508.1", "509.1", "510.1", "511.1"],
        blocks: [
          {
            kind: "table",
            head: ["Step", "What happens", "Rule"],
            rows: [
              [
                "Beginning of combat",
                "Last chance to act before attackers are chosen.",
                "507",
              ],
              [
                "Declare attackers",
                "The active player chooses which creatures attack, and whom. Attacking taps them.",
                "508",
              ],
              [
                "Declare blockers",
                "Each defending player chooses which of their untapped creatures block, and what.",
                "509",
              ],
              [
                "Combat damage",
                "Every attacking and blocking creature deals damage equal to its power, all at once.",
                "510",
              ],
              [
                "End of combat",
                "Combat ends. Creatures stop attacking and blocking.",
                "511",
              ],
            ],
          },
          {
            kind: "p",
            text: "Players get priority in each of these steps (but not as attackers or blockers are being declared), so tricks like Giant Growth are cast after blockers are declared and before damage.",
          },
        ],
      },
      {
        id: "attacking",
        title: "Attacking",
        summary: "Who can attack, whom, and summoning sickness.",
        rules: [
          "302.6",
          "508.1",
          "508.1a",
          "508.1f",
          "702.10a",
          "702.20b",
          "802.1",
        ],
        blocks: [
          {
            kind: "p",
            text: "In your declare attackers step you choose any of your untapped creatures to attack. Each attacks one opponent, or a planeswalker an opponent controls, or a battle. In Commander you may attack several opponents at once, sending each creature where you like (rule 802). Attacking taps a creature (rule 508.1f) unless it has vigilance.",
          },
          {
            kind: "p",
            text: "A creature can't attack unless you've controlled it continuously since your most recent turn began (rule 302.6). This is called summoning sickness: a creature you cast this turn has to wait. Haste removes the wait (rule 702.10).",
          },
          {
            kind: "shot",
            shot: "attacking",
            caption:
              "Attackers move forward over the band, and embers rise off them.",
            marks: [
              {
                mark: "attackers",
                label: "Attacking creatures",
                text: "Tapped and pushed towards the player they attack.",
              },
              {
                mark: "defender",
                label: "The defending player",
                text: "Who they attack. Their untapped creatures may block.",
              },
            ],
          },
          {
            kind: "cards",
            cards: [
              {
                card: "ragingGoblin",
                note: "Haste: it can attack the turn it arrives.",
              },
              {
                card: "serraAngel",
                note: "Vigilance: it attacks without tapping, so it can still block next turn.",
              },
            ],
          },
          {
            kind: "tip",
            text: "At the table, drag a creature onto an opponent's side to attack them, or choose Attack With All. In a game of three or four, the table then asks whom each creature attacks.",
          },
        ],
      },
      {
        id: "blocking",
        title: "Blocking",
        summary: "Who can block what, and blocking with several creatures.",
        rules: ["509.1", "509.1a", "509.1b", "702.9b", "702.17b", "702.111b"],
        blocks: [
          {
            kind: "p",
            text: "When you are attacked, each of your untapped creatures may block one attacking creature. Several of your creatures may block the same attacker. Blocking doesn't tap a creature, and summoning sickness doesn't stop a creature from blocking. An attacker that nobody blocks deals its damage to whoever it attacked.",
          },
          {
            kind: "shot",
            shot: "blocking",
            caption: "A blocker steps in front of the attacker it blocks.",
            marks: [
              {
                mark: "blockers",
                label: "Blocking creature",
                text: "Framed in pale steel as blocks are declared.",
              },
              {
                mark: "attackers",
                label: "The attacker it blocks",
                text: "A blocked attacker deals its damage to its blockers instead.",
              },
            ],
          },
          {
            kind: "table",
            head: ["Keyword", "Effect on blocking", "Rule"],
            rows: [
              [
                "Flying",
                "Can be blocked only by creatures with flying or reach",
                "702.9",
              ],
              ["Reach", "Can block creatures with flying", "702.17"],
              [
                "Menace",
                "Can't be blocked except by two or more creatures",
                "702.111",
              ],
              ["Defender", "Can't attack, but blocks normally", "702.3"],
            ],
          },
          {
            kind: "cards",
            cards: [
              {
                card: "giantSpider",
                note: "Reach: blocks flyers like Serra Angel.",
              },
              {
                card: "vampireNighthawk",
                note: "Flying: only flyers and creatures with reach can block it.",
              },
            ],
          },
        ],
      },
      {
        id: "combat-damage",
        title: "Combat damage",
        summary:
          "How damage is dealt, with first strike, trample, deathtouch and lifelink.",
        rules: [
          "510.1",
          "510.1c",
          "510.2",
          "702.2",
          "702.4",
          "702.7",
          "702.15",
          "702.19",
          "704.5g",
        ],
        blocks: [
          {
            kind: "p",
            text: "In the combat damage step every attacking and blocking creature deals damage equal to its power at the same time (rule 510.2). A creature that has been dealt damage at least equal to its toughness is destroyed (rule 704.5g). An attacker blocked by several creatures divides its damage among them as its controller chooses (rule 510.1c).",
          },
          {
            kind: "example",
            title: "A trade",
            cards: ["hillGiant", "grizzlyBears"],
            steps: [
              "Vok attacks with Hill Giant (3/3). Mira blocks with Grizzly Bears (2/2).",
              "Damage: the Giant deals 3 to the Bears, the Bears deal 2 to the Giant, at once.",
            ],
            outcome:
              "The Bears are destroyed (3 damage, toughness 2). The Giant survives with 2 damage, which wears off at the end of the turn.",
          },
          {
            kind: "example",
            title: "Trample over a chump blocker",
            cards: ["colossalDreadmaw", "llanowarElves"],
            steps: [
              "Mira attacks Vok with Colossal Dreadmaw (6/6, trample). Vok blocks with Llanowar Elves (1/1).",
              "With trample, the Dreadmaw must assign lethal damage to the blocker, 1, and may assign the rest to the player (rule 702.19).",
            ],
            outcome: "The Elves are destroyed and Vok takes 5.",
          },
          {
            kind: "example",
            title: "Deathtouch and lifelink",
            cards: ["vampireNighthawk", "colossalDreadmaw"],
            steps: [
              "Vampire Nighthawk (2/3, flying, deathtouch, lifelink) blocks Colossal Dreadmaw (6/6).",
              "Damage: the Dreadmaw deals 6 to the Nighthawk; the Nighthawk deals 2 to the Dreadmaw.",
              "Any damage from a deathtouch source is lethal (rule 702.2), and lifelink gains its controller that much life (rule 702.15).",
            ],
            outcome:
              "Both creatures are destroyed, and the Nighthawk's controller gains 2 life. Trample with deathtouch needs to assign only 1 damage to each blocker.",
          },
          {
            kind: "p",
            text: "First strike and double strike add a damage step before the normal one (rule 510.4): creatures with first strike deal their damage first, so they can destroy a blocker before it strikes back. Double strike deals damage in both steps.",
          },
          {
            kind: "example",
            title: "First strike",
            cards: ["youthfulKnight", "grizzlyBears"],
            steps: [
              "Youthful Knight (2/1, first strike) attacks; Grizzly Bears (2/2) block.",
              "First-strike damage: the Knight deals 2 to the Bears. They are destroyed.",
              "Regular damage: the Bears are gone and deal nothing.",
            ],
            outcome: "The Knight survives, though its toughness is only 1.",
          },
          {
            kind: "tip",
            text: "When you divide damage among several blockers, the table opens a form filled with its suggestion; change the numbers and confirm.",
          },
        ],
      },
    ],
  },
  {
    id: "keywords",
    title: "Keywords",
    topics: [
      {
        id: "keywords",
        title: "Common keywords",
        summary: "The keywords you'll meet most, in a line each.",
        rules: ["702.1"],
        blocks: [
          {
            kind: "p",
            text: "Keywords are short names for abilities that would take too long to write out (rule 702.1). These are the ones on many cards; the official rules have every one, and the search above finds them.",
          },
          {
            kind: "table",
            head: ["Keyword", "In plain words", "Rule"],
            rows: [
              [
                "Deathtouch",
                "Any damage it deals to a creature destroys that creature.",
                "702.2",
              ],
              ["Defender", "It can't attack.", "702.3"],
              [
                "Double strike",
                "Deals combat damage twice: in the first-strike step and the regular one.",
                "702.4",
              ],
              ["Enchant", "An Aura's: what it can be attached to.", "702.5"],
              [
                "Equip",
                "Pay the cost to attach this Equipment to your creature, at sorcery speed.",
                "702.6",
              ],
              [
                "First strike",
                "Deals combat damage before creatures without it.",
                "702.7",
              ],
              [
                "Flash",
                "You may cast it any time you could cast an instant.",
                "702.8",
              ],
              [
                "Flying",
                "Only creatures with flying or reach can block it.",
                "702.9",
              ],
              [
                "Haste",
                "Can attack and use {T} abilities the turn it arrives.",
                "702.10",
              ],
              [
                "Hexproof",
                "Opponents' spells and abilities can't target it.",
                "702.11",
              ],
              [
                "Indestructible",
                'Damage and "destroy" effects don\'t destroy it.',
                "702.12",
              ],
              [
                "Lifelink",
                "Damage it deals also gains you that much life.",
                "702.15",
              ],
              [
                "Protection from …",
                "Can't be blocked, targeted, damaged or enchanted by what it names.",
                "702.16",
              ],
              ["Reach", "Can block creatures with flying.", "702.17"],
              [
                "Trample",
                "Damage beyond what its blockers need goes to the player it attacks.",
                "702.19",
              ],
              ["Vigilance", "Attacking doesn't tap it.", "702.20"],
              [
                "Ward",
                "Spells and abilities opponents aim at it are countered unless they pay the ward cost.",
                "702.21",
              ],
              [
                "Menace",
                "Can't be blocked except by two or more creatures.",
                "702.111",
              ],
            ],
          },
          {
            kind: "table",
            head: ["Action", "In plain words", "Rule"],
            caption: "Words with a game meaning of their own",
            rows: [
              [
                "Destroy",
                "Put it into its owner's graveyard. Indestructible stops this.",
                "701.8",
              ],
              [
                "Exile",
                "Put it into the exile zone, usually for good.",
                "701.13",
              ],
              [
                "Sacrifice",
                "Its controller puts it into the graveyard; not the same as destroying, so indestructible doesn't help.",
                "701.21",
              ],
              [
                "Discard",
                "Put a card from your hand into your graveyard.",
                "701.9",
              ],
              [
                "Mill",
                "Put the top cards of a library into its owner's graveyard.",
                "701.17",
              ],
              [
                "Scry N",
                "Look at your top N cards; put any of them on the bottom and the rest back in any order.",
                "701.22",
              ],
              ["Tap / untap", "Turn sideways / straighten again.", "701.26"],
              ["Create", "Make a token.", "701.7"],
              ["Counter", "Cancel a spell or ability on the stack.", "701.6"],
            ],
          },
          {
            kind: "p",
            text: '"Dies" means a creature went from the battlefield to a graveyard (rule 700.4). "Enters" means it arrived on the battlefield.',
          },
        ],
      },
    ],
  },
  {
    id: "commander",
    title: "Commander",
    topics: [
      {
        id: "commander",
        title: "Commander's rules",
        summary: "100 cards, one of each, a legendary leader and 40 life.",
        rules: [
          "903.1",
          "903.3",
          "903.4",
          "903.5a",
          "903.5b",
          "903.5c",
          "903.6",
          "903.7",
        ],
        blocks: [
          {
            kind: "p",
            text: "Commander is a format built around one legendary creature, your commander. Your deck is exactly 100 cards, the commander included (rule 903.5a), and apart from basic lands no two cards share a name (rule 903.5b).",
          },
          {
            kind: "p",
            text: "Every card in the deck must fit the commander's colour identity: the colours of every mana symbol on the commander, in its cost and its text (rule 903.4). Sigarda, Host of Herons is green and white, so her deck holds only green, white and colourless cards.",
          },
          {
            kind: "shot",
            shot: "commander",
            caption:
              "Each commander waits in the command zone, beside its player.",
            marks: [
              {
                mark: "command",
                label: "Your commander",
                text: "Cast it from here like a card from your hand.",
              },
              {
                mark: "opponent",
                label: "Their commander",
                text: "Every commander is public: everyone knows what you're playing.",
              },
            ],
          },
          {
            kind: "cards",
            cards: [
              {
                card: "sigarda",
                note: "A green-white commander. Flying and hexproof make her hard to answer.",
              },
              {
                card: "kenrith",
                note: "White, but his abilities have {R}, {G}, {U} and {B} symbols: his colour identity is all five colours.",
              },
            ],
          },
          {
            kind: "p",
            text: "The game starts with each commander in the command zone (rule 903.6) and each player at 40 life with seven cards (rule 903.7). In a game of three or four, your first mulligan is free.",
          },
        ],
      },
      {
        id: "commander-tax",
        title: "Casting your commander, and the tax",
        summary:
          "Casting from the command zone, sending it back, and paying {2} more each time.",
        rules: ["903.8", "903.9a", "903.9b"],
        blocks: [
          {
            kind: "p",
            text: "You may cast your commander from the command zone whenever you could cast it from your hand. If it would go to your graveyard or into exile, you may put it back into the command zone instead (rule 903.9a); the same goes for your hand or library (rule 903.9b).",
          },
          {
            kind: "p",
            text: "Each time you cast it from the command zone, it costs {2} more for every earlier time you cast it from there (rule 903.8). This extra cost is the commander tax.",
          },
          {
            kind: "example",
            title: "Sigarda's tax",
            cards: ["sigarda"],
            steps: [
              "First cast: {2}{G}{W}{W}, five mana.",
              "She is destroyed; Mira puts her back into the command zone.",
              "Second cast: five mana plus {2}, seven in all.",
              "Third cast: five plus {4}, nine in all.",
            ],
            outcome:
              "The table shows the tax beside your commander, and adds it to the cost for you.",
          },
        ],
      },
      {
        id: "commander-damage",
        title: "Commander damage",
        summary: "21 combat damage from one commander knocks a player out.",
        rules: ["903.10a", "704.6c"],
        blocks: [
          {
            kind: "p",
            text: "A player who has been dealt 21 or more combat damage by the same commander over the whole game loses (rule 903.10a), whatever their life. Damage from different commanders is counted apart, and only combat damage counts.",
          },
          {
            kind: "example",
            title: "Counting it",
            cards: ["sigarda"],
            steps: [
              "Sigarda (5/5) hits Vok four times over the game: 20 commander damage.",
              "Vok gains plenty of life and sits at 35.",
              "Sigarda connects once more: 25 commander damage.",
            ],
            outcome: "Vok loses at once, with 30 life left.",
          },
          {
            kind: "tip",
            text: "Each player's commander damage shows by their portrait at the table, counted per commander.",
          },
        ],
      },
      {
        id: "multiplayer",
        title: "Playing with three or four",
        summary: "Turn order, attacking several players, and leaving the game.",
        rules: ["101.4", "103.5c", "103.8c", "800.4a", "802.1"],
        blocks: [
          {
            kind: "list",
            items: [
              "Turns go around the table to the left. Nobody skips their first draw (rule 103.8c).",
              "Your first mulligan is free: you draw a new seven and put none on the bottom for it (rule 103.5c).",
              "You may attack any or all of your opponents in the same combat (rule 802.1).",
              "When a player loses, their cards and everything they own leave the game with them (rule 800.4a). Effects they controlled end.",
              "Choices made at the same time go in turn order, starting with the player whose turn it is (rule 101.4).",
            ],
          },
          {
            kind: "tip",
            text: "Every player sees the same board, so politics are part of the game: the biggest threat at the table tends to get attacked.",
          },
        ],
      },
    ],
  },
  {
    id: "fine-print",
    title: "Starting and the fine print",
    topics: [
      {
        id: "starting-the-game",
        title: "Starting a game and mulligans",
        summary: "Shuffling, who goes first, opening hands and the mulligan.",
        rules: ["103.1", "103.3", "103.5", "103.5c", "103.8a"],
        blocks: [
          {
            kind: "p",
            text: "Each player shuffles their deck. One player is chosen at random to take the first turn. Everyone draws seven cards (rule 103.5).",
          },
          {
            kind: "p",
            text: "If you don't like your hand, you may mulligan: shuffle it back, draw seven new cards, then put one card from your hand on the bottom of your library for each mulligan you have taken (rule 103.5). You may mulligan as many times as you like, one fewer card each time. In a multiplayer game the first mulligan doesn't count (rule 103.5c).",
          },
          {
            kind: "example",
            title: "A hand with no lands",
            cards: ["grizzlyBears", "hillGiant", "divination"],
            steps: [
              "Your seven cards hold no land. You can't cast anything.",
              "Mulligan: shuffle them back and draw seven new ones, with three lands.",
              "In a duel, this is your first mulligan, so you put one card of your choice on the bottom.",
            ],
            outcome:
              "You start with six cards you can actually play. A hand of two to four lands is usually a keep.",
          },
          {
            kind: "tip",
            text: "At the table the choice is Keep Hand or Mulligan; after a mulligan, the table asks which cards go to the bottom.",
          },
        ],
      },
      {
        id: "state-based-actions",
        title: "Checks the game makes",
        summary:
          "State-based actions: what the game fixes by itself, all the time.",
        rules: [
          "704.1",
          "704.3",
          "704.5a",
          "704.5f",
          "704.5g",
          "704.5i",
          "704.5j",
          "704.5m",
        ],
        blocks: [
          {
            kind: "p",
            text: "Whenever a player would get priority, the game checks a list of conditions and fixes them all at once (rule 704.3). Nobody chooses these and nothing can respond to them. The ones you'll see most:",
          },
          {
            kind: "list",
            items: [
              "A player at 0 or less life loses (704.5a).",
              "A creature with toughness 0 or less goes to the graveyard (704.5f).",
              "A creature with damage at least equal to its toughness is destroyed (704.5g).",
              "A planeswalker with 0 loyalty goes to the graveyard (704.5i).",
              "You control two legendary permanents with the same name: keep one (704.5j).",
              "An Aura attached to nothing, or to something it can't enchant, goes to the graveyard (704.5m).",
            ],
          },
        ],
      },
      {
        id: "effects",
        title: "How long effects last",
        summary: 'One-shot effects, "until end of turn", and lasting effects.',
        rules: ["609.1", "610.1", "611.1", "611.2a", "613.1"],
        blocks: [
          {
            kind: "p",
            text: "Some effects happen once and are done: deal 3 damage, draw two cards, destroy a creature (rule 610). Others last for a while: Giant Growth's +3/+3 lasts until end of turn (rule 611.2a); Glorious Anthem's +1/+1 lasts as long as the Anthem is on the battlefield (rule 611.3).",
          },
          {
            kind: "p",
            text: "When many lasting effects change the same creature, the rules apply them in a fixed order of layers (rule 613). You'll rarely need it: the table works it out and shows the result.",
          },
          {
            kind: "example",
            title: "Effects that add up",
            cards: ["grizzlyBears", "gloriousAnthem", "giantGrowth"],
            steps: [
              "Grizzly Bears are 2/2.",
              "With Glorious Anthem on your side, they are 3/3.",
              "Giant Growth on them: 6/6 until end of turn.",
            ],
            outcome:
              "In the cleanup step the Growth ends, and they are 3/3 again.",
          },
        ],
      },
    ],
  },
  {
    id: "table",
    title: "At the Commander Duels table",
    topics: [
      {
        id: "the-table",
        title: "Finding your way around the table",
        summary: "Where everything is on the game screen.",
        rules: [],
        blocks: [
          {
            kind: "shot",
            shot: "table",
            caption: "A game in progress, seen from the bottom seat.",
            marks: [
              {
                mark: "band",
                label: "The band",
                text: "The HUD diamonds at its left (Game menu, log, priority controls), the turn, the stack in the middle, the step and phase pips at its right.",
              },
              {
                mark: "opponent",
                label: "Opponents",
                text: "Across the top. Click a portrait to target that player.",
              },
              {
                mark: "battlefield",
                label: "Your battlefield",
                text: "Creatures near the band, lands behind.",
              },
              {
                mark: "hand",
                label: "Your hand",
                text: "Along the bottom. The card under the pointer rises; drag it up to play it.",
              },
              {
                mark: "life",
                label: "You",
                text: "Your portrait, life, and hand, graveyard and library counts.",
              },
              {
                mark: "library",
                label: "Your library and graveyard",
                text: "On the stone at the right, with exile and the command zone.",
              },
            ],
          },
          {
            kind: "list",
            items: [
              "Rest the pointer on any card for the magnifier; right-click or Z to zoom it.",
              "Cards you can play from your hand glow pink; cards with something to do glow purple; your choices glow teal.",
              "The game log, the priority controls and the table's options open as drawers at the right; the game goes on beside them.",
              "Tab moves between the zones and controls; the arrow keys move between cards; Enter answers.",
            ],
          },
        ],
      },
      {
        id: "making-choices",
        title: "Making choices",
        summary: "Prompts, the big diamonds, and the Continue button.",
        rules: ["117.3d", "601.2"],
        blocks: [
          {
            kind: "shot",
            shot: "prompt",
            caption:
              "When the game needs your answer, the prompt column at the left asks.",
            marks: [
              {
                mark: "prompt",
                label: "The prompt",
                text: "What the game is asking, and every answer it allows. The big diamonds are the main ones.",
              },
              {
                mark: "hand",
                label: "Your hand",
                text: "A card you can play glows. Click it, or drag it to the table.",
              },
            ],
          },
          {
            kind: "list",
            items: [
              "Continue (P) passes priority: you are done for now and the game moves on.",
              "Keep Hand or Mulligan, Attack or No Attacks, Block or No Blocks, Yes or No, and Done lead as big diamonds.",
              "Targets glow on the table: click one to choose it. A player's portrait is their target.",
              "Amounts, like damage divided among blockers or the value of X, come in a form with the table's suggestion filled in.",
              '"What\'s this?" next to the prompt opens the part of this guide that explains it.',
              "The engine checks every answer. If one isn't allowed, the prompt stays open and says why.",
            ],
          },
          {
            kind: "tip",
            text: "When an opponent casts something and you have nothing to answer with, a short timer passes for you. Stop Timer (T) gives you all the time you need.",
          },
        ],
      },
      {
        id: "priority-controls",
        title: "Passing for a while",
        summary: "Keep passing, stops and full control.",
        rules: ["117.3d"],
        blocks: [
          {
            kind: "p",
            text: "Magic gives every player priority many times a turn. The table skips the moments you don't care about, and the Priority drawer (the band's third diamond) lets you choose more:",
          },
          {
            kind: "list",
            items: [
              "Keep passing: pass until the stack resolves, the next main phase, the end of the turn, the next turn, or your next turn. A new spell on the stack, attackers or blockers still stop the pass, and a choice you must make is still asked.",
              "Stop passing, or Escape, ends a pass in progress.",
              "Full control stops at every step of every turn, for players who want to act at exact moments.",
              "Hold priority after casting keeps priority after your own spell, so you can respond to it yourself.",
              "Stops… lists the steps where the game should give you priority with an empty stack.",
            ],
          },
        ],
      },
    ],
  },
];

/** Every topic, in the guide's order. */
export const TOPICS: Topic[] = GUIDE.flatMap((chapter) => chapter.topics);

export function topicById(id: string): Topic | undefined {
  return TOPICS.find((topic) => topic.id === id);
}

export function chapterOfTopic(id: string): GuideChapter | undefined {
  return GUIDE.find((chapter) =>
    chapter.topics.some((topic) => topic.id === id),
  );
}

/** The words of a topic, for the search. */
export function topicText(topic: Topic): string {
  const parts: string[] = [topic.title, topic.summary];
  for (const block of topic.blocks) {
    switch (block.kind) {
      case "p":
      case "tip":
        parts.push(block.text);
        break;
      case "list":
        parts.push(...block.items);
        break;
      case "steps":
        parts.push(block.title, ...block.steps);
        break;
      case "anatomy":
        parts.push(
          block.caption,
          ...block.callouts.map((c) => `${c.label} ${c.text}`),
          CARDS[block.card].name,
        );
        break;
      case "cards":
        parts.push(
          ...block.cards.map((c) => `${CARDS[c.card].name} ${c.note}`),
        );
        break;
      case "example":
        parts.push(block.title, ...block.steps, block.outcome);
        break;
      case "shot":
        parts.push(
          block.caption,
          ...block.marks.map((m) => `${m.label} ${m.text}`),
        );
        break;
      case "table":
        parts.push(...block.head, ...block.rows.flat());
        break;
    }
  }
  return parts.join(" ");
}

/** Topics whose words hold every word of the search, titles first. */
export function searchGuide(query: string, limit = 12): Topic[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || query.trim().length < 2) return [];
  const hits = TOPICS.filter((topic) => {
    const text = topicText(topic).toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const titled = (topic: Topic) =>
    words.every((word) =>
      `${topic.title} ${topic.summary}`.toLowerCase().includes(word),
    );
  return hits
    .sort((a, b) => Number(titled(b)) - Number(titled(a)))
    .slice(0, limit);
}

/** Every card name the guide shows: the API serves these images to anyone. */
export function guideCardNames(): string[] {
  return Object.values(CARDS).map((card) => card.name);
}

// "What's this?" from the game's prompts: the topic that explains each kind of prompt.
export const PROMPT_TOPICS: Record<string, string> = {
  priority: "priority",
  mulligan: "starting-the-game",
  yes_no: "making-choices",
  choose_target: "targets",
  choose_defender: "attacking",
  choose_ability: "abilities",
  choose_choice: "making-choices",
  choose_name: "making-choices",
  choose_mode: "casting-spells",
  choose_amount: "making-choices",
  order_triggers: "abilities",
  choose_pile: "making-choices",
  pay_mana: "paying-costs",
  declare_attackers: "attacking",
  declare_blockers: "blocking",
  assign_amounts: "combat-damage",
};

// The tutorial's links into the guide: the Novice refresher's pages and the guided game's lessons,
// by their titles.
export const TUTORIAL_TOPICS: Record<string, string> = {
  // The Novice's refresher (tutorial/Overview.tsx).
  "Turns and mana": "turn-structure",
  "Casting and the stack": "the-stack",
  Combat: "combat",
  "Commander's own rules": "commander",
  // The Beginner's guided game (tutorial/demoScript.ts).
  "A game of Commander": "what-is-magic",
  "The steps of a turn": "turn-structure",
  "Lands and mana": "lands-and-mana",
  "Taking turns": "turn-structure",
  "Casting a spell": "casting-spells",
  Haste: "attacking",
  Attacking: "attacking",
  Blocking: "blocking",
  "Damage to a player": "combat-damage",
  "Mana kept back": "priority",
  "The stack": "the-stack",
  Responding: "the-stack",
  "Last in, first out": "the-stack",
  "The commander": "commander",
  "Back to the command zone": "commander-tax",
  "Mira's commander": "commander",
  "The commander tax": "commander-tax",
  "Commander damage": "commander-damage",
  "A few turns later": "commander-damage",
  "The end of the game": "winning-and-losing",
  "Your turn at the table": "making-choices",
};

/** The address of a topic, or of the guide's start. */
export function guideHref(topic?: string): string {
  return topic ? `#how-to-play/${topic}` : "#how-to-play";
}

/** The address of an official rule or chapter. */
export function ruleHref(number: string): string {
  return `#how-to-play/rules/${number}`;
}
