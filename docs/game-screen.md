# The game screen (v0.1.0)

v0.1.0 puts the practice games of v0.0.6 on screen. A signed-in, approved player starts a game against bots from the Play page and plays it to the end in the browser, by mouse or by keyboard alone. The screen shows every prompt the engine types and nothing the seat may not see. It follows the scope's UI01, UI03 to UI05 and UI08, and the first part of UI07. It is built in React DOM, as the scope sets it for now; PixiJS is left for later effects. The protocol underneath is unchanged ([games through the API](games.md)).

## Starting a game

The Play page opens with the owner's banner. Below it, the practice table offers:
- **the format.** Legacy against one bot, or Commander against one to three bots;
- **your fixture deck, and each bot's,** or any free fixture deck;
- **the bots' skill** (1–6) and a turn limit;
- **for SysOp, a deck list.** Any card the engine implements, with card-name lookup that adds a line per click.

The table also lists your running games (resume or close) and your recent ones with their results. SysOp may list every player's games and observe any running one.

Signed-out visitors see a sign-in link. Accounts waiting for approval, or not approved, see why they cannot play.

## The table

`#game/<id>` opens the game full screen. The header shows:
- the format, turn, active player and step;
- the connection's state;
- for SysOp, the inspection switch;
- the concede button.

The board:
- **Opponents.** One panel per opponent, three side by side at four seats. Each shows life, hand and library counts, counters, the mana pool and commanders (zone, tax, commander damage per player). It also has buttons for its graveyard, exile and command zone, and the opponent's battlefield.
- **Stack and combat.** The stack panel lists every object top first, marking the next to resolve, with its controller, text and targets. The combat panel lists attackers, the defender and blockers.
- **Your side.** Your header, your battlefield and your hand. Creatures and other permanents sit on one row and lands on another. Attachments follow what they are attached to, and tapped permanents turn sideways.

The side panel holds:
- a large preview of the card under the pointer or focus (wide screens only);
- the prompt;
- the result when the game ends;
- SysOp's inspection;
- the game log.

**Sizes (UI01).** The screen is designed at 1920 x 1080 and stays usable at 1366 x 768 with smaller cards. Below 900 px it becomes one column. The prompt is then docked at the bottom, and the hand scrolls sideways inside its own row; the page itself never scrolls sideways.

## Cards

Every card is a printed image, drawn over a text frame built from the engine's view: name, cost, type, rules, power and toughness.
- **The frame stays underneath.** A missing or slow image never hides the rules text or blocks a choice (UI03).
- **Hidden cards.** A face-down or hidden card shows the card back and requests nothing.
- **State goes beside the card.** Current power and toughness, damage, counters, attacking, blocking, tapped and summoning sickness sit in a strip below each permanent, never over the image.
- **Zoom.** Right-click, Z, or a click on a card with no options opens the large image beside every current characteristic. It credits the artist and Scryfall.

Images come from Scryfall by the card's name. The API fetches each once, keeps it on its own disk and serves it from the site, so browsers only talk to Commander Duels:
- `GET /api/v1/card-images?name=&size=normal|large` serves the image, for signed-in accounts;
- `GET /api/v1/card-images/info?name=` gives its artist and printing.

Scryfall's terms are kept:
- **No changes to the image.** Images are never cropped, covered, distorted or watermarked.
- **Spacing.** Requests to Scryfall's API are at least 120 ms apart.
- **No paywall.** Nothing is sold, so no Scryfall data sits behind a payment.
- **Notices.** The footer carries Wizards of the Coast's Fan Content notice and the credit to Scryfall.

**What a name lookup could reveal.** It maps a name the browser already knows to an image. Nothing prefetches deck lists, so probing the cache cannot reveal another seat's deck. Tokens and names Scryfall does not know show their text frame, and are asked about again after a week.

## Answering prompts (UI04, UI08)

The engine's open prompt lists every option. The screen offers exactly those options and nothing more:
- **On the board.** A card, a stack object or a player with options is outlined in gold and marked ◆. Clicking it answers its one option, or opens a menu when it has several. Chosen options (targets, attackers) are outlined in teal and marked ✓.
- **In the prompt panel.** Every option is a button there too, so the keyboard reaches each one:
  - the primary option (pass priority, done, keep or yes) comes first;
  - the rest follow in groups: play and cast, abilities, mana, combat.
- **Amounts.** Damage assignment and X use a form, filled with the engine's suggestion and checked against each entry's limits and the total.
- **Piles.** Fact or Fiction shows each pile's cards.
- **Revealed and looked-at cards** show in the panel, with the engine's messages.
- **Unsupported choices.** A choice the screen cannot show yet says so and offers to concede.

The engine still checks every answer. A refusal leaves the prompt open, and the panel says why in words.

## Keyboard (UI04)

| Key | Effect |
| --- | --- |
| Tab | Moves between zones and controls. Each zone of cards is one tab stop |
| Arrow keys, Home, End | Move between the cards of a zone |
| Enter or Space | Answers a card's option, or opens its menu |
| Z | Zooms the focused card |
| P | Answers the primary option: pass priority, done, keep or yes |
| Escape | Closes a menu or a dialog |

When a new prompt opens while focus is in the prompt panel, focus moves to its first control.

## The connection

The page speaks the protocol of [games through the API](games.md#the-websocket):
- **Opening.** It sends the hello with the CSRF token, and resynchronizes by revision on every reconnect.
- **Commands.** Each answer has a new action ID, and the controls are disabled until its result arrives.
- **Dropped connections.** The page reconnects with backoff. A command whose reply was lost is resent with the same action ID once the tab holds the lease again, so the engine applies it once and returns its first result (T14).
- **Two tabs.** A tab opened while another plays the seat watches, and says so. "Play here" takes the lease, and the first tab then watches until it takes the lease back.
- **The session.** If it ends, the page says so. If the account's roles change, the page renews the session and reconnects.

## SysOp's inspection

SysOp's inspection switch opens the inspection view beside the board: every player's hand and library in order, top first, refreshed with each revision. The panel states that opening it is recorded in the audit trail, which it is (`game.inspection_opened`). SysOp can also start games from deck lists and observe other players' running games.

## The practice notice

The bots still search a full copy of the game, including the player's hand (AI02). Until that audit is done, the table opens with a notice saying so, which the player may dismiss for the session.

## Accessibility

- **Names.** Every card is a button named with its name, type, power and toughness, current state and options.
- **Not colour alone.** Actionable and chosen cards also carry a mark (◆, ✓), and attacking and blocking are written in the strip.
- **Focus.** Focus is always visible.
- **The log** is a live region.
- **Settings.** Larger text and reduced motion apply as on every page; the sideways turn of a tapped card is not animated with reduced motion.

## Verification

Browser journeys in `web/e2e/game.spec.ts` play against the real engine (CI's engine job, with `CD_E2E_GAMES=1`):
- **By mouse.** A Legacy game played to the end, with the board at 1920, 1366 and 390 px partway through.
- **By keyboard.** A Legacy game played to the end by keyboard alone.
- **Commander.** A four-player Commander table played to its turn limit, at the three sizes.
- **A second tab and a lost reply.** The second tab watches until "Play here", and a reply lost with the connection is resent once with the same action ID and returns the first result.
- **Every frame is checked (T13 in the browser).** No seat or service token. The hand holds only the seat's own deck. Opponents carry counts only. No card that only another seat's deck holds is named, as a card, an option or a phrase in the log or a prompt, before it has been public.

Results are in [the release notes](releases/0.1.0.md) and [verification](verification.md#v010).

## Not in v0.1.0

- Human opponents, lobbies and matchmaking (NET02–NET03); recovery journals (NET08–NET09).
- Stops you choose, passing to the end of turn and full control (the rest of UI07); timers.
- Animation (UI09), sound, help and glossary (UI10–UI11), gamepads (UI12) and drag and drop.
- Printing-exact images (they arrive with M1's catalog) and grouping of equivalent tokens (UI02).
