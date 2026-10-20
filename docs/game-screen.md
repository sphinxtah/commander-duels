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
- **Your side.** Your header, your battlefield and your hand. Creatures and other permanents sit on one row and lands on another. Attachments follow what they are attached to. Tapped permanents turn sideways and take the turned card's footprint, so they never cover their neighbours or the strip beneath them.

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

Both routes give back the database connection their sign-in used before any lookup, so a slow Scryfall never holds one.

Scryfall's terms are kept:
- **No changes to the image.** Images are never cropped, covered, distorted or watermarked.
- **Spacing.** Requests to Scryfall's API are at least 550 ms apart, because Scryfall allows its named-card search 2 requests a second.
- **Rate limiting.** After a 429 the API asks Scryfall nothing for as long as its `Retry-After` says: 30 seconds at least, an hour at most. Retry-After is read as seconds or as an HTTP date. A number too large to hold means the longest pause; an unreadable value counts as no header (30 seconds). Meanwhile, new names answer 503 `card_images_unavailable` with `Retry-After`, and cached images are still served.
- **No paywall.** Nothing is sold, so no Scryfall data sits behind a payment.
- **Notices.** The footer carries Wizards of the Coast's Fan Content notice and the credit to Scryfall.

**The queue.** Each new name waits its turn for Scryfall, so one account may have 8 new names waiting and everyone together 24. Beyond that, a request is answered at once, before Scryfall is asked or a row is recorded, and the card keeps its text frame:
- 429 `card_images_busy` with `Retry-After` when the account is over its share;
- 503 `card_images_unavailable` with `Retry-After` when the total is reached.

Cached names, and names recorded as missing, are never refused. SysOp is never refused.

**What a name lookup could reveal.** It maps a name the browser already knows to an image. Nothing prefetches deck lists, so probing the cache cannot reveal another seat's deck. Tokens and names Scryfall does not know show their text frame, and are asked about again after a week. Their rows are deleted once more than a week old, whenever another name is recorded as missing.

**Failed images on the page.** The page remembers a name the server has no image for (404 `card_image_missing`) for an hour. Any other failed image (Scryfall busy or slow, a deploy, an expired session) is asked for again up to five times. It waits with backoff, at least as long as the server's `Retry-After`, and spread a little so the cards on a board do not all ask at once. If the server has the image by the time the page asks why it failed, the page draws it at once.

## Answering prompts (UI04, UI08)

The engine's open prompt lists every option. The screen offers exactly those options and nothing more:
- **On the board.** A card, a stack object or a player with options is outlined in gold and marked ◆. Clicking it answers its one option, or opens a menu when it has several. Chosen options (targets, attackers) are outlined in teal and marked ✓.
- **In the prompt panel.** Every option is a button there too, so the keyboard reaches each one:
  - the primary option (pass priority, done, keep or yes) comes first;
  - the rest follow in groups: play and cast, abilities, mana, combat. A special payment (convoke, delve, improvise) is listed under mana with the other payment options.
- **Amounts.** Damage assignment and X use a form, filled with the engine's suggestion and checked against each entry's limits and the total. Each prompt starts from its own suggestion, and a new revision of the same prompt keeps what the player typed.
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

When a new prompt opens while the player works in the prompt panel, focus moves to its first control. While an answer is sent or the table waits, focus rests on the panel's heading. After a refused answer it returns to the control the player was on. A card's menu gives focus back to the card when a choice or Escape closes it; a press outside the menu closes it.

## The connection

The page speaks the protocol of [games through the API](games.md#the-websocket):
- **Opening.** It sends the hello with the CSRF token, and resynchronizes by revision on every reconnect.
- **Commands.** Each answer has a new action ID, and the controls are disabled until its result arrives. Each answer names the prompt and revision on screen. An answer to a prompt that has since been replaced is refused in the page, never sent as an answer to the new one.
- **Dropped connections.** The page reconnects with backoff. A command whose reply was lost is resent with the same action ID once the tab holds the lease again, so the engine applies it once and returns its first result (T14). If the server still holds the dropped connection's lease, the tab watches until the server lets it go (about 20–40 seconds), then takes the lease back by itself, unless another tab took it. Coming back online reconnects at once, and never opens a second socket.
- **Two tabs.** A tab opened while another plays the seat watches, and says so. "Play here" takes the lease, and the first tab then watches until it takes the lease back. When the tab playing the seat closes or drops, a tab that was watching takes the lease by itself, unless another tab's "Play here" took the lease from it. If several tabs are watching, the last one to claim the lease keeps it.
- **Too many tabs.** The server lets an account hold 4 connections to a game, and a game 8 (SysOp's are not counted). A tab refused for that says the game is open in too many tabs, keeps retrying with backoff, and connects by itself once another tab closes.
- **The session.** If it ends, the page says so. If the account's roles change, even mid-game, or another request rotated the cookie, the page renews the session and reconnects.

## SysOp's inspection

SysOp's inspection switch opens the inspection view beside the board: every player's hand and library in order, top first, refreshed with each revision. The panel states that opening it is recorded in the audit trail, which it is (`game.inspection_opened`). SysOp can also start games from deck lists and observe other players' running games. When SysOp observes another player's game, the screen names that player instead of "You", and the result reads "Game over" with the winner's name.

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
- **Every frame is checked (T13 in the browser).** No seat or service token. The hand holds only the seat's own deck. Opponents carry counts only. No card that only another seat's deck holds is named, as a card, an option or a phrase in the log or a prompt, before it has been public. Since v0.1.1 the check is strict again: a card named in the log must be public in the same view or an earlier one, because the engine sends each view with the log as it stood when that view was built.
- **Test hooks.** The prompt panel carries `data-prompt` (the prompt ID on screen) and `data-revision` (the snapshot revision on screen). The page answers only the prompt on screen, so the journeys wait for these before they act.

Unit tests (Vitest, since v0.1.1) cover the connection (answers to replaced prompts, taking the lease back, the session refresh's backoff, too many tabs, one socket at a time), the prompt panel (focus, amounts, the special payment), card-image retries, the card menu and the observer's wording.

Results are in [the release notes](releases/0.1.0.md) and [verification](verification.md#v010); the v0.1.1 fixes are in [their release notes](releases/0.1.1.md).

## Not in v0.1.0

- Human opponents, lobbies and matchmaking (NET02–NET03); recovery journals (NET08–NET09).
- Stops you choose, passing to the end of turn and full control (the rest of UI07); timers.
- Animation (UI09), sound, help and glossary (UI10–UI11), gamepads (UI12) and drag and drop.
- Printing-exact images (they arrive with M1's catalog) and grouping of equivalent tokens (UI02).
