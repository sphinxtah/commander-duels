# The game screen (v0.3.0: the Magic Duels table)

v0.1.0 put the practice games on screen and v0.2.0 added the priority controls. v0.3.0 redraws the screen during play to look like Magic Duels, with Commander and this site's own features added ([the plan](plans/0.3.0.md), [the design](plans/0.3.0-design.md)). The table is drawn with PixiJS in WebGL, behind a layer of real, named buttons that the mouse, the keyboard and screen readers use. The protocol underneath is unchanged ([games through the API](games.md)).

## Starting a game

The Play page opens with the owner's banner. Below it, the practice table offers:
- **the format.** Legacy against one bot, or Commander against one to three bots;
- **your deck, and each bot's:** a starter deck, or one of your own playable decks ([decks](decks.md#at-the-practice-table)). "Play it at the practice table" in the deck builder opens the table with that deck chosen;
- **the bots' skill** (1–6) and a turn limit;
- **for SysOp, a deck list.** Any card the engine implements, with card-name lookup that adds a line per click.

The table also lists your running games (resume or close) and your recent ones with their results. SysOp may list every player's games and observe any running one.

**Full screen.** Start, Resume and Observe put the window in full screen, and Escape belongs to the game there (Chrome and Edge hold it with the Keyboard Lock; holding Escape for two seconds still leaves). F, the band's full-screen diamond and the Game menu turn it on and off at any time. Settings › "Full screen when a game starts" turns the automatic part off. A table opened without a click (a reload, a typed address, the installed app's window) plays in the window and says once, on the band: "Full screen: F".

Signed-out visitors, and accounts waiting for approval or not approved, never reach the table: they see [the landing page](identity.md#before-the-app-the-landing-page-v030) at every address, `#game/<id>` included. An active account that may not play sees why.

## The table

`#game/<id>` opens one 16:9 table designed at 1920 × 1080. It scales to the window, from 1280 × 720 to 4K (3840 × 2160), and keeps its proportions: a wider window shows more stone at the sides, a taller one at the top and bottom. Nothing scrolls. Below 1280 × 720 the table still scales and says that it is designed for 1280 × 720 at least. Phones and tablets are not supported for play since v0.3.0.

- **The band.** A red band crosses the middle. At its left are the HUD diamonds: the Game menu, the game log, the priority controls, full screen and (SysOp) the inspection. Then the turn ("Turn 7 · Bot 2’s turn"), the connection's state when it is not connected, the stack at its centre, and at its right the step, the combat icons and the five phase pips. A big diamond emblem with a caption marks a new turn, attacks and blocks.
- **Opponents** sit above the band: one across the top in a duel, two or three side by side at three and four seats. Each has a grey sigil portrait in a diamond, life in a red diamond, hand, graveyard and library counts in black diamonds, name and title, the pills (active turn, priority, out, winner), counters, mana pool and commander damage. Their battlefield has creatures near the band and lands behind. Graveyard, exile, command zone and library sit on the stone beside it. At three and four seats, Expand opens one opponent's board in place and shrinks the others to chips.
- **Your side** is below: your portrait, life and counts at the bottom left, with the phase and the response timer's purple bar beside them; creatures near the band and lands behind; your command zone, exile, library and graveyard at the right. "Show the board" lists any battlefield in a drawer.
- **The hand** fans along the bottom edge, partly off screen. The card under the pointer, or with keyboard focus, rises and grows.
- **The stack** lies on the band: the next to resolve at the centre, older objects fanned behind it, a "+N" for the rest. A curved line runs from each spell to its caster and to its targets.
- **The prompt column** at the left (below the band's HUD) holds the prompt (see below), a pass in progress and the result.
- **Drawers** at the right hold the game log, the priority controls, SysOp's inspection, the table options (from the Game menu) and the zone browser (graveyard, exile, command zone, a battlefield, a pile, the stack). One is open at a time; they are part of the page, never dialogs, so the game goes on beside them.

**Portraits.** Since v0.3.1 a player allied with a Planeswalker is shown by that Planeswalker's portrait (`GameSeat.portrait`, and `me.alliance` for your own seat until the game's summary arrives): fitted whole into the diamond's box, never cropped, standing slightly above its frame, in colour for you and grey for opponents, with the life badge over its foot. The 256- or 512-pixel file is chosen by the screen's resolution. A bot, a player with no alliance, or a portrait that is missing, slow (over 10 seconds) or not an image shows the sigil generated from the account (a bot's from its seat) instead. The plain table shows the same portrait as an image with the same fallback. Each portrait has its own accessible name ("Rowan portrait"), apart from the player's life ([the Planeswalker Alliance](progression.md#alliances)).

**Token grouping (UI02).** Identical tokens, and identical untapped basic lands, lie in one pile with a count; their options are offered for each card. Up to five members show; "+N" opens the pile in a drawer.

**Animation (UI09).** Cards move between zones, tap and untap, and fly to the stack and back; damage and life changes float up as numbers; a loss cracks the player's portrait. Animation never holds back an answer: every control on screen is the newest prompt's, and a revision the tab missed while hidden is simply drawn. Settings › "Animation speed" (Normal, Fast, Faster) sets the pace, and Reduce motion stills it.

**Sound.** Generated Web Audio effects for drawing, playing a land, casting, resolving, entering, dying, tapping, counters, damage, life, attacks, blocks, phases and your turn, and chimes for victory, defeat and a draw. Nothing sounds before the first click or key press on the page. Settings › "Sound effects volume" and "Mute all sound"; Mute is also in the Game menu.

**The plain table.** Without WebGL, or with Settings › "Draw the table with" › "Plain table without WebGL", the same buttons paint the cards themselves on a plain stone and band. A WebGL context the graphics driver loses draws the plain table until it comes back (a new one is made after 3 seconds, at most three times in five minutes).

## Cards

Every card is a printed image, drawn over a text frame built from the engine's view: name, cost, type, rules, power and toughness.
- **The frame stays underneath.** A missing or slow image never hides the rules text or blocks a choice (UI03); the frame stays until the image has faded in.
- **Hidden cards.** A face-down or hidden card shows the card back and requests nothing.
- **State on the card.** Power and toughness sit in a tag over the printed box (never over the artist or copyright line), counters as pips, and attacking, blocking, summoning sickness and choices as badges. The card's name says all of it in words.
- **Highlights.** A card you can act on glows purple; one you can play from your hand glows pink; chosen cards (targets, attackers) glow teal.
- **Rounded corners** (v0.5.1, the owner's report of square corners in the hand). Scryfall's normal and large pictures, which the board and the hand draw, are JPEGs whose rounded corners are filled in; only the png, which the magnifier shows, has them transparent. The WebGL table cuts each picture to the card's rounded outline once, as it decodes it (`scene/corners.ts`, a radius of 5.5% of the card's width, the dom painter's), so the scene still never masks a card; the glows and the teal ring follow the same corners. The dom painter rounds its faces with CSS at that radius, as before. Nothing of the printed card is cut: only the corners' fill, which the png leaves out too.
- **Images by resolution.** Each card is asked for at the size it is drawn on this screen: the normal image (488 × 680) for most of the table at 1080p, the large one (672 × 936) where cards are drawn bigger, and for the magnifier the 745 × 1040 PNG where the large one would be stretched (level 2 at 1440p, both levels at 4K), once the card has stayed magnified for 250 ms.
- **Zoom.** Right-click, Z, or a click on a card with no options opens the large image beside every current characteristic. It credits the artist and Scryfall.

Images come from Scryfall by the card's name. The API fetches each once, keeps it on its own disk and serves it from the site, so browsers only talk to Commander Duels:
- `GET /api/v1/card-images?name=&size=normal|large|png` serves the image, for signed-in accounts. The PNG is checked as a PNG and kept up to 8 MB; a printing without one is served at the next size down and never recorded as missing (v0.3.0);
- `GET /api/v1/card-images/info?name=` gives its artist and printing.

The Godlike tier's custom cards (v0.4.0) are never asked of Scryfall. Their names get each card's own image from the database (`private, no-store`), for a Godlike account and for anyone seated in, or observing, a game where some seat's deck holds the card; anyone else gets the answer of a name Scryfall does not know ([progression](progression.md#playing-them-v040)).

Both routes give back the database connection their sign-in used before any lookup, so a slow Scryfall never holds one.

Scryfall's terms are kept:
- **No changes to the image.** Images are never cropped, blurred, recoloured, skewed or watermarked, nor covered over the artist or copyright line. The table lies in perspective, but cards are drawn flat over it at a uniform scale; a tapped card only turns.
- **Spacing.** Requests to Scryfall's API are at least 550 ms apart, because Scryfall allows its named-card search 2 requests a second.
- **Rate limiting.** After a 429 the API asks Scryfall nothing for as long as its `Retry-After` says: 30 seconds at least, an hour at most. Meanwhile, new names answer 503 `card_images_unavailable` with `Retry-After`, and cached images are still served.
- **No paywall.** Nothing is sold, so no Scryfall data sits behind a payment.
- **Notices.** The zoom credits the artist and Scryfall, and the site's footer carries Wizards of the Coast's Fan Content notice.

**The queue.** Each new name waits its turn for Scryfall, so one account may have 8 new names waiting and everyone together 24. Beyond that, a request is answered at once with 429 `card_images_busy` (the account is over its share) or 503 `card_images_unavailable` (the total is reached), and the page asks again after the `Retry-After`. Cached names and names recorded as missing are never refused; SysOp is never refused.

**Downloads** (v0.4.4). A catalog printing's image, or a name the catalog already knows, needs no search, only a download from Scryfall's image host, which is not rate limited. Downloads wait their turn instead of being refused: 4 at once for one account and 16 in all, with up to 128 of an account's waiting; only beyond that is one refused (429 `card_images_busy`). Until v0.4.4 they took the search's share of 8, so a pack of new cards, or a page of the Cards list, drew its first 8 pictures and kept text frames for the rest (the owner's report).

**What a name lookup could reveal.** The table asks only for names in the seat's current view: nothing prefetches deck lists, so probing the cache cannot reveal another seat's deck. Tokens and names Scryfall does not know show their text frame, and are asked about again after a week.

**Failed images on the page.** The page remembers a name the server has no image for (404 `card_image_missing`) for an hour. Any other failed image is asked for again up to five times, with backoff at least as long as the server's `Retry-After`. Since v0.4.4 every card picture does the same (`web/src/game/RetryingImage.tsx`): the Cards page and card details, the pack opening, and the starter decks' commanders, which until then gave up at the first failure.

## The magnifier

The card under the pointer, or the one with keyboard focus, is drawn large at the side of the table away from it, as in Magic Duels, with what it is now beside it: its name and cost, type, power and toughness, state, what it is attached to or enchanted by, who controls and owns it, a commander's tax and damage, and a stack object's controller, targets and text. The mouse wheel over a card makes it larger (level 2) or smaller and then away; Escape closes level 2. The magnifier never takes a click: a click always reaches the table beneath it. Screen readers hear the same facts in each card's own name.

## Answering prompts (UI04, UI08)

The engine's open prompt lists every option. The screen offers exactly those options and nothing more:
- **On the table.** A card, a stack object or a player with options glows. Clicking it answers its one option, or opens a menu when it has several. A player's portrait and life are their target button.
- **Drag and drop (UI04).** Drag a land or a spell from your hand onto your side of the table to play it, a creature onto an opponent's side to attack, or a blocker onto an attacker. A drop with several answers opens the card's menu; one that cannot go there snaps back and says why. A drop that also says the next choice (the defender, the attacker to block) answers it when it is asked within 2 seconds.
- **In the prompt column.** Every option is a button there too, so the keyboard reaches each one. The moment's main choices lead as big black diamonds with an icon and a word, as in Magic Duels: the primary option (**Continue** for passing priority, **Attack** or **No Attacks**, **Block** or **No Blocks**, **Keep Hand**, **Yes**, **Done**), then **Attack With All** when it is offered, then **Stop Timer** while the response timer runs. A diamond whose word says less than the option keeps the option's own words in its accessible name ("Continue (Pass priority)"). The rest follow in groups: play and cast, abilities, mana, combat, keep passing.
- **Amounts.** Damage assignment and X use a form, filled with the engine's suggestion and checked against each entry's limits and the total.
- **Piles.** Fact or Fiction shows each pile's cards.
- **Revealed and looked-at cards** show in the column, with the engine's messages.
- **Unsupported choices.** A choice the screen cannot show yet says so and offers to concede.

The engine still checks every answer. A refusal leaves the prompt open, and the column says why in words.

## The response timer (v0.3.0)

As in Magic Duels, when an opponent's spell or ability is on top of the stack, or an opponent attacks, and you hold priority with nothing to do but pass, a short timer runs (8 seconds by default) and continues for you when it ends. A purple bar beside your phase and a ring around Continue count down; the last three seconds tick. **Stop Timer**, T or Space stops it for that moment, and so does anything you do: a key, a click on a control, a menu, a drawer, a dialog or a drag. It pauses while the tab is hidden, the window is in the background or an answer is on its way.

It never runs for a choice of your own (mulligan, targets, modes, amounts, piles, ordering, payment, attackers or blockers), for your own object on top, at an empty-stack stop, while a pass is in progress, with full control on, in a tab that is watching, or for SysOp observing. It answers only the pass of the prompt on screen, through the same check as every other answer, and changes nothing on the engine's side: the engine still waits for the seat however long it takes. Settings › "Response timer" sets it to 5, 8, 15, 30 or 90 seconds, or off.

## Priority controls (UI07)

The rest of UI07: where the game gives the seat priority, and how long it passes for the player. They are in the Priority drawer (the band's third diamond).
- **Keep passing.** A priority prompt also offers, in its "Keep passing" group: pass until the stack resolves, until the next main phase, until the end of the turn, until the next turn, until the end step before your turn, and until your next turn. Something new on the stack, attackers or blockers stop the pass, as the stops below say, and a choice the player must make is still asked.
- **A pass in progress** shows at the top of the prompt column ("Passing until your next turn."), with **Stop passing**; Escape does the same anywhere on the table once no menu, drawer or magnified card is open.
- **Full control** stops at every step, in every turn, and holds priority after each spell. Turning it off restores the default stops.
- **Hold priority after casting** (on by default): after casting a spell or activating an ability, the player keeps priority to respond to it.
- **Stops…** opens the list of steps where the game gives the seat priority with an empty stack, for its own turns and the others', and whether new stack objects, declared attackers and declared blockers stop a pass.

Changing a control sends a `set_priority` command ([the human seat](engine/human-seat.md#priority-controls)). The controls belong to the seat: the tab playing it changes them, a tab watching it shows them disabled, and a spectator has none.

## The Game menu

The band's first diamond opens it, above the HUD: **Table** (back to the Play page), **Full screen**, **Mute**, **Table options** (the timer, animation speed, sound and how the table is drawn, in a drawer) and **Concede**. A click elsewhere or Escape closes it.

## Keyboard (UI04)

| Key | Effect |
| --- | --- |
| Tab | Moves between zones and controls, in order: the HUD, the opponents, the stack, your side, the hand, the prompt column, the drawers. Each zone of cards is one tab stop |
| Arrow keys, Home, End | Move between the cards of a zone |
| Enter or Space | Answers a card's option, or opens its menu |
| Z | Zooms the focused card |
| P | Answers the primary option: pass priority, done, keep or yes |
| T or Space | Stops the response timer while it runs (Space then presses nothing) |
| F | Full screen on and off |
| Mouse wheel over a card | Magnifies it more, or less |
| Escape | Closes one layer per press: a drag, the Game menu, a drawer, the magnified card at level 2, an expanded board. With none open, it stops a pass in progress. A card's menu and the dialogs keep their own Escape |

When a new prompt opens while the player works in the prompt column, focus moves to its first control. While an answer is sent or the table waits, focus rests on the prompt's heading. After a refused answer it returns to the control the player was on. Stopping the timer from its button moves focus to Continue. Closing a drawer returns focus to its diamond.

## The connection

The page speaks the protocol of [games through the API](games.md#the-websocket):
- **Opening.** It sends the hello with the CSRF token, and resynchronizes by revision on every reconnect. The first snapshot after a reconnect is drawn without replaying any animation.
- **Commands.** Each answer has a new action ID, and the controls are disabled until its result arrives. Each answer names the prompt and revision on screen; an answer to a prompt that has since been replaced is refused in the page.
- **Dropped connections.** The page reconnects with backoff. A command whose reply was lost is resent with the same action ID once the tab holds the lease again, so the engine applies it once and returns its first result (T14). Coming back online reconnects at once, and the band says "Offline" meanwhile.
- **Two tabs.** A tab opened while another plays the seat watches, and says so. "Play here" takes the lease, and the first tab then watches.
- **Too many tabs.** The server lets an account hold 4 connections to a game, and a game 8. A tab refused for that says so and connects by itself once another tab closes.
- **The session.** If it ends, the page says so. If the account's roles change, or another request rotated the cookie, the page renews the session and reconnects.

## The installable app (v0.3.0)

Chrome and Edge on a PC can install Commander Duels as an app with its own window and desktop icon:
- **The banner.** A signed-in, active player in a browser tab sees a drop-down banner under the top bar: "Play Commander Duels in its own window, with a desktop icon." **Install** opens the browser's own install window; **Not now** hides the banner for 30 days on this device. When the browser holds its install offer back, the banner and Settings › "Install the app" explain its menu instead. The banner never shows on the landing page, during a game or in the app's own window.
- **The app.** The installed window opens on the Play page. Opening it again while it runs brings that window forward instead of starting a second one, and a live game in it stays on screen.
- **Updates never reload a game.** A new version's service worker waits. On the Play page the top bar offers **Update**; at the table the band only says "Update ready: it applies when you leave the table." While any window or tab holds a live game, the update waits for it ("A game is running in another window."), and applies as the player leaves the table. The browser's Back, or the app opening its Play page, keeps a live game on screen.
- **The worker** caches only the site's own shell, scripts and brand images: never the API, the game's WebSocket, card images or Google's sign-in.

## SysOp's inspection

SysOp's Inspection drawer has the inspect switch: every player's hand and library in order, top first, refreshed with each revision. The drawer states that opening it is recorded in the audit trail, which it is (`game.inspection_opened`). When SysOp observes another player's game, the screen names that player instead of "You", and the result reads "Game over" with the winner's name.

## The practice table

Since v0.3.1 the bots plan only with what their seat may see ([fair bots](engine/fair-bots.md)), and the notice that said they read the player's hand is gone. A player is offered their own decks only (their two starter decks among them; the engine's fixture decks are SysOp's), the table opens on a format they have a playable deck for, and a player with none is pointed to Decks. A deck that needs cards the library does not hold says so. A bot's deck left to the table is chosen by the server: in Commander, one of the ten starter decks.

## Human tables (v0.4.0)

A table's game ([human tables](tables.md)) uses the same screen. The other players go by their handles, on the board, in the turn line, the result and the log. Above the prompt, a Players panel says who is away and for how long, and once they may be voted out offers "Vote to remove" and "Keep waiting" with the votes so far. It also says who conceded or was removed, and tells a removed player so when they come back. Conceding says the other players play on; the result and its dialog lead back to the lobby. Every finished game's result, practice or table, shows the tokens it paid you. Since v0.5.0 the result and its dialog offer Rematch to the game's players: a practice game starts again at once, and a table's asks its other players, with their answers shown as they come ([rematches](queues.md#rematches)).

Since v0.4.4 a table's game has its chat: a diamond on the band opens it as a drawer at the right, with the Table and Allies tabs, the emotes and the alliances, and each other player's plate has an Alliance menu ([chat](chat.md#the-tables-chat)).

## Best-of-three matches (v0.5.0)

A match's game ([matches](matches.md)) shows its number and the score, from the player's side, as a chip on the table ("Game 2 · 1–0"). The Game menu's Concede becomes "Concede the game", and "Concede the match" follows it, behind its own question. The result, beside the board and in its dialog, says where the match stands ("Match 1–1. Game 3 is next: sideboard, then get ready.") and leads to the match's page; while the match goes on, the screen goes there by itself 6 seconds after the result is recorded, unless the player chose "Review the board". The practice table and the lobby offer best of three in Legacy.

## Two-Headed Giant (v0.5.0, v0.5.1)

v0.5.0 seated a Two-Headed Giant game as any four-player table, with the teammate's plate marked and life called the team's ([Two-Headed Giant](engine/two-headed-giant.md)). v0.5.1 makes it the teams' table, for four humans as for humans with bot teammates or opponents:
- **Each team together.** You sit below as always; your teammate sits first above, in the left column, and the other team in the middle and right columns, in turn order. It is the same whichever seat you hold: until v0.5.1 the seats followed turn order alone, which put the teammate of seats 1 and 3 at the right. A spectator's table and SysOp's are arranged around the player below the same way.
- **The team on every plate.** Your teammate's plate keeps "Your teammate" and its "Teammate" pill; the other team's plates say "Other team" in a warm red. Your team's portraits are in colour and the other team's grey. SysOp observing and spectators read "Team 1" and "Team 2" on every plate, and in each player's article name ("Bot 3, seat 3, team 2").
- **Life and poison are the team's.** Both plates of a team show its one life total ("24 team life"), and both show its poison counters added up ("7 team poison"; 810.10a: a team with 15 loses).
- **Your teammate plays with you.** Their spells, targets and attacks are drawn in your gold, not the opponents' crimson, and their area takes no attack dropped on it. A turn your teammate holds is yours too (805.4a): the turn line says "Your team’s turn", the emblem "Your Turn" with its chime, and the response timer does not run for your own team's attack. The other team's turn reads "Other team’s turn" ("Other Team’s Turn" on the emblem); SysOp reads "Team 2’s turn". While connected the turn line also takes the hidden status chip's place, so "Turn 12 · Your team’s turn" is never cut short.
- **The result names the winning team:** "You and bram won in 9 turns." to its players, the winners' names to the other team, and "Team 2 won in 9 turns: Bot 3 and Bot 4." to SysOp. Concede says "You and your teammate lose this game at once: a team wins and loses together."
- **Prompts that involve your teammate** need nothing of their own on the table: the engine asks each player of the attacking team for their own attackers in turn, with the first player's attackers already drawn attacking, and a choice of a player, such as Assist's helper, is a player option on the plates and in the prompt column like any other. The table's own checks below run without the engine, so neither is among them.

### Your teammate's hand (810.5, FMT10)

Teammates may look at each other's hands. The seat view carries the teammate's hand to the teammate alone (`PlayerView.hand`), and since v0.5.1 the table lays it out as cards:
- **Where.** Face up, in a small fan along the near edge of your teammate's area, between their front row and the band, as your own hand fans along the stage's bottom edge. Their rows sit a little higher to make room (row centres at y 220 and 344 instead of 232 and 384; when their board is expanded, 180 and 326), and the fan's cards, 62 × 86.6 su, rest from y 396, clear of the stack's lane.
- **Why there.** A fan reads as a hand at a glance, as Magic Duels shows a player's hand by their portrait, and the cards stay with the teammate's board rather than near yours, where they could be taken for cards you may play. It needs no drawer: a drawer, the other way considered, shows whole cards but covers the table's right while it is open, closes when any other drawer opens, and must be opened again to see what the teammate drew. The left column is never under a drawer, nor under the magnifier of a card on the left half.
- **How many.** As many cards as keep a 36 su hit each: fifteen. Beyond, the last place is a "+N" that opens the zone browser on the whole hand ("bram’s hand"), as your own hand's does past twenty cards.
- **Like any card the seat can see.** Each card is a named button ("Lightning Bolt, Instant") in a "bram's hand" group that follows the teammate's battlefield in their article: one tab stop, the arrow keys moving along it. The pointer or keyboard focus magnifies it at the side, with "In bram’s hand" among its facts; a click, Z or a right-click opens its details. The PixiJS scene draws it with the board, and the dom painter paints it on its button.
- **Never playable.** A teammate's card carries no options and no drag, whatever a prompt names: it never glows, and pressing it only shows it. The prompt column may still name it, since the index knows it.
- **Live.** The fan follows each view: a card the teammate draws flies in face down from their library and turns over; one they cast or play leaves the fan for the stack or the battlefield.
- **Nobody else.** The engine sends no hand to the other team or to a spectator, so their tables draw none: the other team's hands are counts. SysOp observing sees what the watched seat sees, its teammate's hand included; SysOp's inspection is unchanged. While another board is expanded, the teammate's plate is a chip and their hand waits, undrawn, until the board is collapsed.

**How it was checked (v0.5.1).** Vitest: the table model (the teammate's cards keyed, named and never offered, even when a prompt names them; the seats by team from each of the four seats; the team pills for a player, SysOp and a spectator; team poison; colours; your teammate's lines as yours), the layout (the fan in the left column under the raised rows, every card a hit up to fifteen and a "+6" at twenty, the expanded board and the chip, no attack drop on the teammate, the invariants on 300 random Two-Headed Giant boards with hands of 0–20), the plates, the DOM layer (the hand's group, names, Tab and arrow keys, the magnifier on hover and on focus, a press zooming and choosing nothing), the zone browser, the magnifier's facts, the events (the teammate's draws by key, their cast and land from the fan, the team's turn), the sound's Your Turn, the response timer, the scene (the fan face up, a draw flying in, the emblem) and the result's words. The fake table (`web/e2e/table.spec.ts`): four humans at 1280 × 720 with WebGL and at 1920 × 1080 with the plain table (the teams, the six cards named and painted, hover, keyboard, a press that sends nothing, the fan following a draw and a land played, every card reachable), the turn line and the result by team, SysOp's numbered teams and the watched seat's teammate's hand, and the Two-Headed Giant table among the 1920 × 1080 boards.

## Accessibility

- **Names.** Every card is a button named with its name, type, power and toughness, current state, owner when someone else controls it, and options. Players, zone tiles, the stack's objects and "+N" are named buttons too, in the table's order.
- **Not colour alone.** Highlights also change the card's name ("Options: …"), and attacking and blocking are written in it.
- **Focus.** Focus is always visible, at least 3 screen pixels however small the table is drawn.
- **Live regions.** The turn line, the connection's state, the log (in its drawer, still announced when closed) and one polite announcer for the timer ("Bot 2's Lightning Bolt. Continuing in 8 seconds. Press Space or T to stop the timer.") and refused drops.
- **Settings.** Larger text enlarges the table's text; Reduce motion stills the animation and shows the timer as seconds; forced colours keep the diamonds' edges.

## Verification

Unit tests (Vitest) cover the table's model and layout (every arrangement, piles, the hit-box invariants), the events between views, the scene's host, the DOM layer and its names, the pointer, drag and drop, the magnifier, the response timer and its keys, sound cues, the prompt column's diamonds, the drawers and Escape, settings, full screen, the install banner, the service worker's rules and the live-game lock.

Browser journeys:
- **The fake table** (`web/e2e/table.spec.ts`, the verify job, Vite's dev server with no engine): the table from fixtures at 1280 × 720 (1× and 1.5×), 1366 × 768, 1920 × 1080 (1× and 2×), 2560 × 1440 and 3840 × 2160, two to four players, a 240-permanent board, a long stack, a 25-card hand and since v0.5.1 Two-Headed Giant with a teammate's hand, with WebGL and with the plain table. At each: the scale, nothing scrolling, the canvas at the screen's pixels, and every card and option reachable where it is drawn (the element at its centre is itself). Also P and a card's option answering the prompt on screen, the timer passing once and Space stopping it, Escape closing one layer per press, the magnifier never taking a click, and a lost WebGL context.
- **Against the real engine** (`web/e2e/game.spec.ts`, CI's engine job, with `CD_E2E_GAMES=1`): Legacy games by mouse (with the table at 1280 × 720 to 4K mid-game) and by keyboard (reduced motion), a four-player Commander table at 2560 × 1440, a second tab with a lost reply, a deck of the player's own with the priority controls, the response timer at a real response moment, and full screen. Every WebSocket frame, every text and name on the table (except the log) and every card image asked for is checked for cards that are not yet public (T13).
- **The installable app** (`web/e2e/pwa.spec.ts`, the engine job, the built image behind nginx): the manifest, icons and worker headers, the worker controlling the page but never answering the API, and the install banner with Not now. The update that waits for a live game is checked by hand ([verification](verification.md)).

Results are in [the release notes](releases/0.3.0.md) and [verification](verification.md#v030).

## Not yet

- Human opponents, lobbies and matchmaking (NET02–NET03); recovery journals (NET08–NET09).
- The owner's Planeswalker portraits and the Planeswalker Alliance levels (v0.3.1).
- Help and glossary (UI10–UI11) and gamepads (UI12).
