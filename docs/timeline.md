# The explainable game timeline (v1.0.0)

The second of v1.0.0's features ([the plan](plans/1.0.0.md#2-explainable-game-timeline-21), the specification's §21): a game told event by event, in sentences, with what explains each one and the rule that says so. It is a screen over the game's structured events ([events](engine/events.md)), which every game has kept since v0.9.10, and it shows a reader only what their own seat saw. It replaces nothing: the table's text log stays as it was.

It has no gate. The events were readable by a game's own players before it; the timeline is how they read them.

## The owner's decisions (2026-11-15)

| # | Question | Decided |
| --- | --- | --- |
| 19 | Where it opens during a game | **Its own drawer**, behind a diamond of its own on the band, beside the log's |
| 20 | Whether it is read during the game or only after it | **During and after**: live at the table, and afterwards from the result, from Your games and from the match history, for the 90 days the events are kept |
| 21 | How "What changed?" appears after a large resolution | **A chip to click**: it shows for a few seconds; nothing opens by itself |
| 22 | Whether the engine's events are extended for it | **Yes**: a cast says what it cost and what changed its cost, a permanent that left the battlefield says why, a spell or ability that left the stack without resolving says so ([the events' version 2](engine/events.md#version-2-v100-what-the-timeline-asks)) |

## Where it is

- **At the table.** The band's third diamond, **Timeline**, opens it as a drawer at the right, as the log and the chat open; Escape or its close button closes it and gives focus back to the diamond. It is a part of the page, never a dialog: the game goes on beside it. While it is open it follows the game. Closed, it asks the server for nothing. A scripted game (the tutorial's watched game) has no events and no diamond, and the diamonds after its place close the gap.
- **At the game's end.** The result's dialog has **See the timeline** beside Review the board; the diamond stays on the band while the board is reviewed.
- **On a page of its own**, `#timeline/<game>`: from Your games (`#play/games`), where each game that is over has a **Timeline** button, and from the match history on a player's own record (a **Timeline** link in each game's line). Both offer it for 89 days after the game, a day short of the events' 90, so that no link leads to a timeline the daily job is about to remove. The page names the format, the players and the day, and says whose eyes it is read through.

A game older than its events, and a game played before v0.9.10, says that it has no events to show.

## What it tells

The events are grouped by turn ("Turn 7 · ada", the player whose turn it was) and by step ("Declare attackers"). Each is a sentence:

| Kind | Sentences |
| --- | --- |
| Spells and abilities | "ada cast Lightning Bolt for {1}{R}." · "ada activated an ability of Viscera Seer." · "An ability of Blood Artist triggered, for Bot 2." · "Lightning Bolt targets Grizzly Bears." · "Lightning Bolt resolved." · "Grizzly Bears resolved and entered the battlefield." · "Grizzly Bears was countered, by Counterspell." · "Lightning Bolt did not resolve." |
| Combat | "Grizzly Bears attacked ada." · "Runeclaw Bear blocked Grizzly Bears." |
| Damage and life | "Lightning Bolt dealt 3 damage to Grizzly Bears." · "ada lost 2 life." · "Bot 2 won the game." |
| Cards moving | "ada drew a hidden card." (another seat's) · "ada played Mountain." · "Grizzly Bears died." · "ada discarded Shock." · "Isamaru, Hound of Konda was moved to the command zone." |
| Counters and tokens | "2 +1/+1 counters were put on Grizzly Bears." · "ada created Soldier, a token." |

A card's name is a button: it shows the card's picture under its line (the same image cache as the table's), and again closes it. A card the reader was not shown is "a hidden card" and no button. A player is named by handle, a bot by the engine's name; the reader's own name is underlined. A cost is drawn as mana symbols and said in words to a screen reader.

Under a sentence stand its **explanations**, each ending in the rule that says so, a link into How to play by the rule's number (`#how-to-play/rules/704.5g`). At a table the rule opens in a tab of its own, so that the game goes on where it is; on the page it is an ordinary link.

| What is explained | From | Rule |
| --- | --- | --- |
| A cost that is not the printed one | The cast's `cost`: the printed cost, the X chosen, commander tax by its amount, each effect that raised, reduced or set it, by its source | 601.2f, 903.8 |
| A death by lethal damage, or by deathtouch | The departure's `why`, and the damage events before it this turn: "It had been dealt 3 damage this turn, by Lightning Bolt." | 704.5g, 704.5h |
| A death by a toughness of 0 | `why` | 704.5f |
| A permanent destroyed, or sacrificed | `why`, with its source | 701.8, 701.21 |
| The legend rule, a planeswalker without loyalty, an Aura with nothing to enchant | `why` | 704.5j, 704.5i, 704.5m |
| A spell or ability that did not resolve: its targets were illegal, or its condition no longer true | The `fizzled` event | 608.2b, 603.4 |
| A countered spell | The `countered` event and its source | 701.6 |
| A commander moved to the command zone | The move itself | 903.9a |

The rule numbers are in one table, `RULES` in `web/src/timeline/events.ts`. Wizards renumbers the keyword actions (chapter 701) whenever it adds one: 701.6, 701.8 and 701.21 are the ones to look at after an update of the official rules. They were checked on 2026-11-15 against published excerpts of the rules (701.21 in those of April 2026); the private repository's copy of the official text is what to check them against.

### Where it does not know

The timeline says only what the events say. Where they carry no reason it says so, in italics: **"The game recorded no reason."** That is the specification's honest fallback, and it is what a reader sees for:

- a death in a game recorded before v1.0.0 (the events' version 1 has no `why`), where the damage dealt before it this turn is still told, followed by "The game recorded no reason beyond that damage.";
- a cost that differs from the printed one with no change on record: an additional or alternative cost, or an effect that no longer applied once the spell was cast;
- a spell that left the stack with no resolution on record;
- a kind of event the timeline has no words for yet.

A game with events of version 1 says once, under its list, that part of it was recorded before the timeline could ask the game why.

### Bookkeeping

Some events repeat what another line already tells: the card put onto the stack as its spell is cast, a land's mana ability resolving, a resolved spell's card going to the graveyard. They are left out unless **Every event, bookkeeping too** is ticked; ticked, they are drawn fainter.

## Narrowing it

- **Find a card**: part of a name. The server looks among the names this reader may see, whatever the case, the sources of a cost's change included. A card that was hidden from the reader is found by no name, and the page says so when nothing matches.
- **Player**: what that player did, what was done to them, and their cards.
- **Show only**: one or more of the five kinds above.

Each narrowing is asked of the server (`type`, `seat` and `q` on `GET /api/v1/games/{id}/timeline`), so it covers the whole game, not only the part on screen. The seat and the name are judged on each event as the reader's perspective shows it, never on the stored rows (`api/events.py` `read`): that is what keeps a search from telling what a hidden card was.

The newest 300 events are read first, and **Show earlier events** reads 300 more. A running game's new events are asked for 0.8 seconds after the table changes and every five seconds besides. The API reads a running game's events from the engine as the timeline is asked for, at most once a second a game, so a reader does not wait for the hub's five seconds ([events](engine/events.md#kept-by-the-api)). A game the engine took up again made its later events anew; the timeline reads its page again.

## What changed?

After a spell or ability resolves, what it did is summed from the events up to the next action (the next cast, activation, attack, block, step or resolution): how many permanents went to the graveyard, were sacrificed, exiled, returned to hand or put into a library, how many entered the battlefield, the tokens made, the damage and life of each player, the cards each drew, discarded and put into their graveyard, the counters, and the abilities that triggered. Cards are named when all of them may be named and there are six or fewer.

A resolution is **large** from four changes up (`LARGE`): each permanent that left or entered the battlefield, each token and each damaged permanent counts one, and so does each player's damage, life, draws, discards and cards put into the graveyard; the counters count one together. A large resolution's line in the timeline has **What changed?**, closed until it is opened.

At the table, a chip **What changed?** appears among the table's notices for twelve seconds after a large resolution. It opens the timeline at that resolution with its summary open; by itself it opens nothing. The table's own view says when to look (the board changed in three or more places at once: permanents that came or went, life totals that changed), and the events say whether to offer: the chip shows only for a resolution the events sum to a large one, once, and only while it is the latest thing that happened. With the timeline's drawer open there is no chip: the summary is in front of the reader.

## Hidden information

Nothing new is shown. Every event leaves the API through its one filter ([events](engine/events.md#read-through-one-filter)), as before; the events' version 2 adds a spell's printed cost to its object, which is hidden with it, and names what changed a cost only for a spell every seat may see. A spell cast face down says what was paid and nothing else. The filter now also covers the sources of a cost's change (`cost.changes[].by`), each an object with its own visibility. `tests/test_events.py` checks each perspective against them, and that a hidden card is found by no name through `q`.

## Keyboard, screen readers and small screens

Every control is a native one: the search field, the player's select, the kinds as toggle buttons that say whether they are pressed (and show a check mark, not only a colour), the checkbox, the card names as buttons that say whether their picture is open, the rules as links that say where they lead. The list is a region that takes focus and scrolls by the keyboard. The kinds of lines differ by a coloured mark and by their words. The page was looked at 390 and 1366 wide, and the drawer at 1366 × 768, with nothing wider than its box.

## Where it is built

| Part | Where |
| --- | --- |
| The words, the explanations, the summaries | `web/src/timeline/events.ts` |
| The screen and its reading of the API | `web/src/timeline/Timeline.tsx`, `timeline.module.css` |
| The page | `web/src/timeline/TimelinePage.tsx`, `#timeline/<game>` in `web/src/App.tsx` |
| The table's chip | `web/src/timeline/chip.ts`, in `web/src/game/GameScreen.tsx` |
| The band's diamond | `web/src/game/table/BandHud.tsx`, `geometry.ts` |
| The route's narrowing and freshness | `api/events.py`, `GameHub.events_fresh` in `api/games.py` |
| The events' version 2 | `engine/src/main/java/com/commanderduels/GameEvents.java` |

Tests: `TimelineEventsTest` and `CommanderScenarioTest` (engine, games played through the prompts); `tests/test_events.py`; `web/src/timeline/events.test.ts` and `Timeline.test.tsx`; the band's and the game screen's tests; the journey "the timeline explains a death by its rule…" on the fake table (`web/e2e/table.spec.ts`); and against the real engine the Legacy game played to its end opens its timeline from the result (`web/e2e/game.spec.ts`).

## What is not in it

- **Activated abilities' costs** are not explained: only a spell's cast carries a cost.
- **Why an optional ability did nothing** when its player declined it is not an event; the timeline says nothing rather than guess.
- **A replacement** ("instead") is told by its outcome: a destroyed commander's line says it went to the command zone, not which choice sent it there.
- **Replays, bookmarks and notes** are [feature 3](plans/1.0.0.md#3-native-replays-and-review-23), built from these parts.
- **Inspection** (SysOp reading everything) stays in the console's `python -m api.cli timeline`; the screen reads a seat's perspective only.
