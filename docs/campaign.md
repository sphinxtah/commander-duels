# The campaign (v0.8.0)

**The Final Concordance** is the game's story campaign, from the owner's handoff of 2026-10-31 (the gitignored `campaign/` folder beside `compose.yaml`: the campaign guide and its fourteen deck builds; the guide names the Godlike tier's custom cards, so it never enters this repository). Fourteen one-on-one Commander duels lead through the wards of the Archive of Concordance, a stolen pocket realm, and since v0.9.6 a fifteenth ward, [The Unbound Court](#the-unbound-court-ward-15-v096), a King's Table game against The Sphinx's court: thirteen wardens, each an incarnation of a Planeswalker, and then The Sphinx on his throne, who at 15 life crosses into the duel himself. Between the duels the story is told in cut scenes: the speakers' portraits at either side of the screen, their lines in speech bubbles, over painted, moving scenery, with effects. The owner's decisions are in [the v0.8.0 release notes](releases/0.8.0.md).

## Where it is

- **The main menu's Campaign tile** (`#campaign`), under the greeting in the left column (the owner's layout: the greeting about 70% of the column, the tile the rest), over the owner's painting of the throne, with the account's progress ("3 of 13 seals claimed", or "A new story begins").
- **The Campaign page**: the title and the map's line ("Defeat each warden to reach the throne"), the thirteen seals and the throne, Continue (the next open ward) or Return to your duel, the journal and Replay the opening; the map, by chapter (Bronze 4 wards, Silver 4, Gold 2, Platinum 2, Mythic 1, the Throne 1), each ward a medallion with its opponent's portrait (a dark silhouette while locked, its title hidden), its seal once won; and the refuge beside it: Kaya, the way to the decks and the alliance, the story settings, the rewards and the campaign's rules.
- **The first visit** plays the opening cinematic (FC.OPEN: the village's lamps failing, the five suns, the gold thread, the High Priest and the voice from the throne) and the refuge's introduction; with Kaya as the account's ally, her own line follows. After the finale is won, the next visit plays the replay's framing once.

## A duel

1. **The scene before it.** Choosing a ward plays its scene (FC.E01.PRE and so on): the title card (the encounter, its title, tier, place and seal), the place as the player arrives, then the dialogue. Before the first ward whose opponent is the account's ally, the handoff's alliance scene plays first; before the finale, an ally of The Sphinx gets The Sphinx's own.
2. **The deck.** Learn Commander (the first ward only: the loaner deck, the disclosed training seed `20261031` for the shuffles, the handoff's training seven as the opening hand (since v0.9.1: three Plains, Sol Ring, Arcane Signet, Raise the Alarm and Pacifism, which the engine puts on top of the library after the first shuffle; `content/campaign.json` `training_hand`, the deck list's `opening`), and Kaya's hints; since v0.8.3 the API refuses it on any other ward with `422 invalid_seat`, since a disclosed seed there would show a player who lost once both decks' order for the replay), the campaign's loaner (Adeline's Vanguard, mono-white, led by Adeline, Resplendent Cathar; it never touches the collection and stays offered for every ward), or one of the player's own playable Commander decks. "I know how to play" skips the teaching, never the duel. After a duel lost, Kaya's advice for that ward (the handoff's counterplay) heads the choice.
3. **The duel** is a practice game against one bot, `POST /api/v1/campaign/encounters/{n}/start`: the player in seat 0, the encounter's opponent in seat 1 with its commander and 99-card deck from `content/campaign.json`, the bots' skill rising with the tiers (1 for Tibalt, 2 to 3 in Bronze, 3 to 4 in Silver, 4 to 5 in Gold, 5 in Platinum, 6 for Liliana and The Sphinx; [fair bots](engine/fair-bots.md#skill-and-habits-v071)), Commander's two-player rules, a 60-turn cap. At the table the opponent is named and drawn by their own portrait ("Tibalt, Warden of the Archive"), and the table's way out says "Back to the campaign". Campaign duels are not offered a rematch: they are played again from the map.
4. **The voices at the table** ([below](#at-the-table)): the opponent's barks and Kaya's, by their portraits; in the first duel with hints on, Kaya's lessons; in the finale, The Sphinx's crossing.
5. **After it** (`#campaign/game/<id>`): a win plays the ward's victory scene, and on the first win its seal claimed (the seal cracks into light) then the warden's spoils (their deck and tokens, below) and, when the win completes a chapter, the chapter's card (its badge giving way to the next tier's) with its rewards. What the seal revealed goes to the journal. A loss plays the opponent's line, then the retreat: Retry, Edit a deck, the defeat's review (Kaya's advice and the game's board and log) and Return to the campaign. A draw holds the ward; a closed, timed-out or turn-limited duel ends without a result and changes nothing.

## The spoils

The owner, 2026-10-31: "As you advance in the campaign, beating a planeswalker also means the player wins the planeswalker's deck. It will show up in the players deck inventory. Each planeswalker defeated also grants tokens, starting with 1,000 tokens for beating the first, 2,000 for the second, and keep doubling it each time."

- **The deck.** A warden's first defeat gives the player that warden's deck: a Commander deck of their own named for the warden ("Tibalt's Deck"), its notes naming the ward, the 99 cards and commander the duel served the warden (the bot seat's deck list, `game_seats.deck_list`; for the private finale the owner's own list when its content gives one), with every copy of its 100 cards granted to the library for good (source `campaign`, "Won in the campaign" on My library, sellable at the auction house like a starter deck's). Each card is in its default edition; a card the catalog lacks is left out, and since v0.9.3 the server logs each such card by name, as every warden's deck is won whole (the owner, 2026-11-09: "By the end, the player wins all of the decks they had to face"). On 2026-11-09 all fourteen decks and the loaner resolved card for card in the live catalog. The deck limit never refuses a prize. The Sphinx's deck comes with the commander he played (the owner, 2026-10-31: "The Sphinx is the final boss and he needs that High Priest custom card as the Commander. ... The High Priest will be awarded with the deck to the player if they win."): with the owner's engine content, the High Priest, the Godlike tier's custom card, recorded on the duel when it starts (`campaign_games.prize_card`, the custom card by the name the engine served) and granted to the winner for good (`custom_card_grants`, one copy, under the deck's key). Its winner sees it by name and image in the deck builder, and plays it in their decks, whatever their tier: the library counts it as theirs, validation opens it to them, the engine gets its name, and its image is served to them. Without the owner's content the finale's deck comes with the public stand-in (Morophon, the Boundless). If no custom card carries the name the engine served when a private finale is won, the win counts (the ward, its seal, its chapter) but the spoils wait, and the server logs it: the first win of the finale after SysOp uploads the card under that name gives them, the High Priest included. Refusing to start the duel instead would block the campaign's last ward on an upload; recording the spoils without the card would give the stand-in for good. The spoils call the High Priest by the story's word ("The High Priest", `private_commander_title`), as this repository never holds its name.
- **The tokens**: 1,000 for the first warden, doubling with each: 1,000, 2,000, 4,000, 8,000 (the bronze wards), 16,000 to 128,000 (silver), 256,000 to 2,048,000 (gold to mythic), 4,096,000 for Liliana and 8,192,000 for The Sphinx: 16,383,000 in all. `content/campaign.json` names each ward's `tokens`. They are a `campaign` entry in the token ledger (keyed `campaign:<account>:<campaign>:<progress>:tokens:<ward>`, the rule `campaign-v1`, the reason naming the warden and the ward), counted with tokens won on the profile.
- **Once.** The spoils are recorded with the seal in the transaction that records the win (the reward `spoils:<ward>`), so a replayed result, a second win or a retry gives nothing again; after an account reset the campaign starts over and its spoils can be won again, as a starter deck's cards are granted again.
- **Opening the deck** (v0.9.5, the owner's request). After the first win the player opens the warden's deck as a pack, as if they had bought a 100-card deck at Leng's shop: the duel's end, then the cut scene with its seal, then the opening, then the spoils card and the chapter's rewards. The deck box is the warden's portrait over a fanned deck; it tears open, and the cards are dealt face down and turn over one at a time, commons first, then uncommons, rares and mythic rares, the commander last of all (for The Sphinx, the High Priest). The opening is recorded with the spoils in the win's transaction, under the spoils' key (`warden_openings`: the cards as given, one per copy, in the order they reveal), so it only shows what was given: it grants nothing, and it can be watched again from the map's "Warden decks" ("Open Tibalt's Deck again"). A player who leaves before opening finds the deck waiting there, and the bell says so (`warden_deck`, leading to the campaign). Routes: `GET /api/v1/campaign/openings`, `GET /api/v1/campaign/openings/{id}`, `POST /api/v1/campaign/openings/{id}/open` (marks it opened, once); `api/warden_openings.py`, `web/src/campaign/WardenOpening.tsx`.
- **Where they show**: each ward on the map and the duel's setup ("Win it for Tibalt's Deck (led by Judith, the Scourge Diva) and 1,000 tokens, once"); after the first win, the spoils card (the warden's portrait over their fanned deck, the deck's name and commander, the tokens); the campaign's rules; the deck in Decks, the cards in My library, the tokens on the profile.

## The cut scenes

`web/src/campaign/Cutscene.tsx`, a modal dialog over the whole window:
- **The scenery** (`scenery/Scenery.tsx`): seventeen places drawn in SVG and CSS, layered and drifting, each with its accent colour: the refuge, the village, the fairground, the foundry, the broken streets, the tribunal, the mirror garden, the revel hall, the transit works, the prism observatory, the nightmare archive, the amphitheater, the gallery of bound champions, the counterfeit citadel, the chamber of names, the throne and the dawn. Some have phases a line switches: the village's lamps going out, the fairground's shadows returning to their owners, the revel falling silent, the names dimming, the throne intact, fractured or empty. Letterbox bars, a vignette, a colour grade and film grain sit over it.
- **The stage**: the player's side at the left (Kaya, the player as their ally's portrait or, with no ally, the Wayfarer, and Liliana once her seal is won), the opponents at the right, facing them. The one speaking steps forward, lit in the scene's accent; the others dim. The Sphinx is a black silhouette in gold light, "A voice from the throne", until the finale reveals him. The High Priest, a survivor and the Wayfarer are drawn figures (`Figures.tsx`); the High Priest's staff holds a light of each colour, which the ending puts out one by one.
- **The words**: each line in a speech bubble pointing at its speaker, typed out (Slow, Normal, Fast or Instant), the speaker's name above it; the narrator's lines and a place's description are captions; titles, seals, chapters and the end are cards of their own.
- **The effects**, played as a line begins: a flash, a shake, the lamps failing, five suns, the gold thread to the doorway, Tibalt's laugh, the shadows coming home, sparks, the REJECTED stamp, a mirror's sheen, the silence, the nightmare's glitch, the prism's rays, chains, the severing of Bolas, the names burning and dimming, The Sphinx's reveal, the fracture of gold, the staff's lights going out, the lights returning across the worlds.
- **The music** (v0.8.1, the owner's track): `/music/campaign.mp3`, one long track (32 minutes) under every cut scene, fading in as a scene opens and out as it ends, and going on from where it stopped at the next scene. The menu playlist holds its place meanwhile and plays on after the scene. Its level is the menu music's (the box's volume and mute, and Mute all sound); the cut scene's Music button and Story settings' "Music in the cut scenes" turn it off. It is not in this repository: the owner's private web image carries it ([the live site](deployment.md#the-web-image-with-the-music-v072)); elsewhere the scenes are quiet. Locally, copy it to `music/campaign.mp3` beside `compose.yaml`.
- **The controls**: Next (Enter, Space, →, or a click on the picture) shows the whole line, then the next; Auto (A) reads on by itself, waiting by the line's length; Text cycles the speed; Skip scene (Escape) ends it. Skipping changes presentation only: never a duel, a seal or a reward. The settings are the device's (`cd.campaign.v1`: the text speed, Auto, and whether opponents speak during duels). Reduce motion stops every movement and effect and shows the lines whole; screen readers hear each whole line at once.
- **The journal** (`Journal.tsx`): every scene seen, in full, so a skipped scene can be read; for each ward reached, what its seal revealed and Kaya's advice; the tutorial's lessons, seen or not, and Kaya's help.

The script (`web/src/campaign/script.ts`) holds every line of the handoff under its scene keys (FC.OPEN.01 to FC.REPLAY.03: 247 lines), the barks with their triggers, the tutorial's twelve prompts, and the staging: each scene's scenery and phase, a line's effect or change of scenery. It names neither custom card.

## At the table

`web/src/campaign/CampaignLayer.tsx`, over the table in the stage's units, never taking a click but on a lesson's buttons, never over the stack:
- **Barks** (`barks.ts`): the handoff's two per ward, from the opponent beside their portrait at the top right, or from Kaya at the upper left, each once a duel, one at a time, for a few seconds by its length. Their triggers are read from what changed between the seat's views and the public log, as the table's effects are: a first creature, the boss's life at 10 or 5, a haste or large attack, a block, a counterspell, a second spell in a turn, a theft and its undoing, a commander cast a second time, a recursion, a graveyard exiled, a five-colour permanent, a land lost, exile or milling, a low library, a drain or sacrifice, a sweep rebuilt from, a protected attempt, a combination stopped. A moment the views cannot show plays at its nearest sign or not at all, as the handoff allows. Settings can silence them.
- **The finale**: the boss's commander cast and your commander's return bring the first phase's lines. When the owner's finale runs, a planeswalker of The Sphinx's entering at 15 life or less is his crossing: a fracture of gold over the table, the arrival's lines, and the handoff's tooltip ("The Sphinx is now a planeswalker on the battlefield. Removing this form buys time. Win the duel to end his claim."); its first removal plays the removal's lines, its first return the recast's, and later returns a single line at most each two turns. The escalation's barks follow his tutor (+2), a counter, a regeneration, an army, loyalty at ten and his life at five. The table remembers the crossing for the ending (sessionStorage): a win before it plays the early ending.
- **Kaya's lessons** (the first ward, hints on): the handoff's T01 to T11, each once, as the board calls for it: the command zone at the start, the mulligan, a land to play, a payment, the commander castable, a creature entering, attackers, blockers, a spell to answer, the commander's return, the opponent low. Got it closes one; Turn off hints ends them (and the account's setting). Each lesson seen is recorded for the journal. Kaya's help lines come as barks. Since v0.9.1 a lesson whose moment came while another showed is looked at again when that one closes, comparing the board with the last look, so a creature that entered meanwhile still counts; during the mulligan T02 comes before T01, whose moment doesn't pass with the keep; and T11 also comes at a declare-attackers step whose offered attackers' power would be lethal unblocked.

## The finale's incarnation

The Sphinx's commander (the Godlike tier's custom creature) and the incarnation (his custom planeswalker) are private: the owner's private engine image carries them in its plugin, with `commander-duels/content/campaign-finale.json` naming both and the threshold. The public engine serves any plugin's content at `GET /v1/service/content/<name>` (service token; 404 when no plugin has it), and the API asks for `campaign-finale` when the finale starts (kept five minutes). The final opponent then plays the handoff's final list (99 cards, public in `content/campaign.json`) with the private commander and a `reserve` in its deck list: `{"name", "threshold": 15}`.

The engine's `CampaignReserve` (engine/src/main/java/com/commanderduels/CampaignReserve.java) is the handoff's rule for any card: before the game starts, the seat's player gets an emblem, "Incarnation in reserve", which:
- the first time the player is at 15 life or less (any life loss, payments included; healing later does not undo it), puts a trigger on the stack that brings the card into the game in the player's reserve and casts it from there without paying its mana cost, whatever the timing, as a spell the player may answer. Countered (the trigger or the spell), the free cast is spent;
- whenever the card would leave the battlefield or the stack for anywhere but the battlefield (it dies, is exiled, bounced or tucked, or its spell is countered), returns it to the reserve instead, without restoring any life;
- lets it be cast from the reserve again for its own mana cost ({W}{U}{B}{R}{G}), with a planeswalker's timing and no commander tax.

The reserve is the command zone, where XMage keeps commander cards and casts them from by the same rules; the card is not a commander (no tax, no commander damage, none of the commander's replacements), and only one copy ever exists. Its loyalty, its abilities and its −10 ("You win the game", the owner's emblem) are the card's own, and every result the game reaches stands: a lethal hit before the crossing ends the duel. `CampaignReserveTest` plays it with a public planeswalker standing in.

Since v0.9.3 `IncarnationRemovalTest` checks the replacement against each way off the battlefield, on a seated table with a public planeswalker in reserve: destroyed, sacrificed, exiled by the opponent, bounced, tucked into the library and put into the graveyard, each sends it back to the reserve, with one copy in the game, no life changed, and the reserve never spent. Since v0.9.4 it also counters the spell on the stack, on its first cast and on a recast: the card goes back to the reserve, not the graveyard, and the Commander object that lets it be cast from the command zone for its mana cost stays. The incarnation's own abilities, its ultimate and the bot's choice to recast it stay the rules' and XMage's, untested in a scripted game.

An engine without the owner's content (the public images, a local stack) plays the finale with the same 99 cards, Morophon, the Boundless as the stand-in commander, and no incarnation; the campaign can still be finished there, and the game's summary says which finale ran (`campaign.finale`: `private` or `public`).

## The Unbound Court: ward 15 (v0.9.6)

The owner's request of 2026-11-10: The Sphinx no longer loses the duel. At the moment he would lose, he recalls Liliana and Nicol Bolas and flees, keeping his deck, and the player follows him into a fifteenth ward, a [King's Table](kings-table.md) game. The owner's decisions are in [the v0.9.6 release notes](releases/0.9.6.md).

- **Ward 14's end.** A win of ward 14 is his flight: the engine's result is the moment he would lose (0 life, commander damage, an empty library, a concession). The win records `campaign_progress.fled_at` and opens ward 15, and pays nothing yet: no seal, no spoils, no chapter. The map shows ward 14 as **fled**: after the flight's scene (FC.E14.FLIGHT: his fury, the High Priest, the recall by the names Liliana and Bolas signed, the gold seam the tether pulls you through), its medallion plays The Sphinx shaking furiously, then fleeing, and leaves the Fled marker ("its spoils wait with the court's"). Reduce motion shows the marker alone.
- **One run.** Wards 14 and 15 are one run. Losing the court (or a draw) clears the flight: the player is back at ward 14 (`highest_unlocked` 14) and must win it again. Winning the court wins both, in the transaction that records its end: ward 14's seal, its spoils (The Sphinx's deck with the commander he played: the High Priest with the owner's engine) and the Throne's chapter (Concordance Breaker, Fractured Throne), then ward 15's seal (Sovereignty, mythic), its spoils and its chapter. A closed, idle or turn-limited court changes nothing, as anywhere in the campaign.
- **The court** is a King's Table game with Commander decks, everyone at 40 life, and the house rule off (a King attacks no one: the court falls General by General). The player is **King A** (seat 1). **Team B** is The Sphinx as King (seat 4) with Nicol Bolas (seat 3, Right General) and Liliana (seat 5, Left General), each a named bot with their portrait and their own deck, at skill 6: The Sphinx's deck is ward 14's (`cards_from`), led by the owner's commander with the owner's engine or the public stand-in; Bolas and Liliana play the decks he gifted them (`court.generals` in `content/campaign.json`: *Nicol Bolas's Gift*, Grixis power led by Nicol Bolas, the Ravager, and *Liliana's Gift*, mono-black power led by Liliana, Heretical Healer, both built for XMage's AI and checked against its card database). Every bot of the game plays at the ward's skill, the player's bot Generals too: the engine has one skill a game.
- **The incarnation** (the owner, 2026-11-10: "free, unlimited, put onto battlefield"). With the owner's engine, The Sphinx's reserve card comes in court mode (`{"name", "mode": "court"}`, [below](#the-finales-incarnation)): it is on the battlefield from the start, at its printed loyalty; whenever it is gone at the beginning of his upkeep, it is put onto the battlefield again, for free, every time; it is never cast, so it can't be countered or cast from the reserve; and leaving the battlefield for anywhere else sends it to the reserve, as in the duel. At the table its first sight plays the court's arrival lines and tip, its removal and return their own. The Sphinx himself starts at 40 life, as every seat.
- **Generals: bots or friends.** The ward's setup offers the loaner or one of the player's Commander decks with **bots as Generals** (the start route, a King's Table game at once), or **friends as Generals**: one or two friends invited to a private table the campaign opens (`POST /api/v1/campaign/encounters/15/court`, one of the player's own Commander decks). The player hosts it, seated as King A; team B's seats are the court's bots, by name and portrait; a General's seat waits for each friend invited and the other is a bot's. The court's settings and seats are fixed (`409 campaign_table`); the host may still give an open General's seat to a bot, and starts the court from the table's page as any table. Its game is the campaign's: its end is read as the court's, the friends see a table's game (no campaign reference), and it counts no win, tokens, quests or achievements for anyone.
- **The helpers.** Each friend who played the won court to its end (never left) and is still the player's friend is paid **10,000 tokens, once ever per player and friend** (`campaign-helper:<campaign>:<player>:<friend>`), and only for a win. Their own campaign is untouched.
- **Players who won ward 14 before v0.9.6** (only SysOp) play the court alone, the run's one exception: it opens at once, losing it never sends them back, and its win pays ward 15's own rewards.
- **Ward 15's rewards**: 16,384,000 tokens (doubling ward 14's), the two gifted decks, each opened as a warden's deck is (with ward 14's, three openings after the win, The Sphinx's first), the mythic seal Sovereignty, and its chapter, *The Unbound Court*: the **Courtbreaker** title and the **Unbound Court** card back (`web/public/brand/backs/unbound-court.svg`: the King's crown and the Generals' circlets broken under a mythic seal). The ending scenes (FC.E15.POST, then the standard ending) follow the court's win.
- **Barks for three speakers**: the court's barks come from The Sphinx, Nicol Bolas, Liliana and Kaya, read from the King's seat (`bossSeat` 4 in the script), not the first opponent.
- **Data.** Migration 0042: `campaign_progress.fled_at` and `challenge_fled_at`; `campaign_games.seat` (1 at the court) and `opponents` (team B's names and portraits by seat, for the game's summary); `game_tables.campaign` (the court's table). The campaign's state: ward 14's status `fled`, each encounter's `court` (the player's seat, the allies' seats, team B, the helpers' pay) and `spoils.decks`; `challenge.at`.

## Progress and rewards

`api/campaign.py`; migration 0032:
- **campaign_progress**, one row an account: the furthest ward open, the wards won (their seals), the ending seen (standard or early), the scenes seen (at most 200 keys, for the journal and the first-time scenes) and the tutorial (hints, skipped, lessons). Made on the account's first look; an account reset (SysOp's, v0.4.5) after it starts it again.
- **campaign_games**: each duel's encounter, the opponent's name, portrait and title, the deck chosen (own, loaner or learn), the hints, the finale run and the outcome. The outcome is written in the transaction that records the game's end (`games.record_end`), and a win records the ward, its seal, the next ward and a completed chapter's rewards there too, once: a replayed result or a second win earns nothing again, and a duel begun before an account reset belongs to the old progress. A campaign duel counts no win towards the account's tier, pays no win's tokens, advances no quest or achievement and keeps no record in the history: the handoff's separation of the campaign from progression. Account wins never gate a ward either. A warden's first defeat pays the spoils instead ([below](#the-spoils)).
- **campaign_rewards**, keyed by the account, the campaign, the progress and the reward: each ward's seal; Bronze's Broken Writ card back, Silver's Unclaimed World card back, Gold's Unbowed title, Platinum's Broken Throne card back, Mythic's Witness of the Unbound title, and for the finale the Concordance Breaker title and the Fractured Throne card back. The Campaign page lists those earned, and since v0.8.8 they can be used ([below](#cosmetics-v088)).

### Cosmetics (v0.8.8)

`api/cosmetics.py`; migration 0037 adds `users.card_back` and `users.title`. Under the Campaign page's Rewards, "Your rewards in use" offers the card backs earned (drawn small, beside the official back) and the titles earned.
- **A card back** replaces the official Magic card back on the player's own table: their library, their opponents' hands, every face-down card, on the canvas and on the page. The four designs are `web/public/brand/backs/<slug>.svg`, drawn for v0.8.8: Broken Writ (a torn writ under a broken seal, bronze), Unclaimed World (a world with an empty standard, silver), Broken Throne (a throne split in two, its crown on the floor, platinum) and Fractured Throne (The Sphinx's golden throne cracked by the five colours). Showing each player's back to the others at a shared table is for v0.8.9.
- **A title** stands under the player's name on their profile (`title` on `GET /api/v1/players/{id}`), for everyone who may open it.
- **Only what's earned** in the current progress may be chosen (409 `not_earned`), and what is shown is checked on every read: a reset of the account or of its campaign takes it away with the reward.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/v1/me/cosmetics` | signed in | The card back and title in use, and every card back and title the campaign rewards with whether it is earned |
| `PUT /api/v1/me/cosmetics` | signed in | `{"card_back", "title"}`: each an earned slug or null |

### Apex Unbound (v0.9.3)

The handoff's optional post-campaign challenge: "An optional Apex Unbound challenge can reuse the unrestricted AI with tutorial aids off. It awards a separate cosmetic badge and does not replace the campaign's completed ending."

- **When.** Once the finale is won, the Campaign page offers *Apex Unbound* beside its rewards: "Take the challenge" (or "Take the challenge again" once its badge is earned). It opens the finale's setup as the post-campaign challenge, with the loaner or one of the player's own decks.
- **The duel** is the finale as it stands (the owner's own finale where the engine serves it, else the stand-in), with Kaya's hints off. It tells no story: its end shows a line on the map, never the endings again.
- **The badge.** A win earns the reward `badge:apex-unbound`, once (campaign_rewards, keyed by progress like every reward). It never gives a seal, spoils, tokens or chapter rewards again, and a duel with passive bots gives nothing. The badge shows under Rewards and on the player's profile (`badges` on `GET /api/v1/players/{id}`, read without making anyone's campaign progress). An account reset takes it away with the rest.
- **Refused.** On any encounter but the finale (`422 invalid_seat`), and before the finale is won (`409 challenge_locked`).
- **Data.** `campaign_games.challenge` (migration 0040); `challenge` on the game summary's `campaign` and in the campaign's state (`name`, `open`, `earned`).
- **Since v0.9.6 a dual level**: wards 14 and 15 as one run, run as the campaign's. It opens once the court is won; it starts at ward 14, whose win is The Sphinx's flight again (`challenge_fled_at`), then stands at the court (`challenge.at` 15; the challenge on ward 14 is then refused, `409 challenge_locked`); a lost court sends it back to ward 14; the court won earns the badge, once. The court's challenge may be played with friends too.

### Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/v1/campaign` | `games.play` | The campaign: its encounters (status locked, open or won; the finale's commander null), chapters with their rewards earned, the progress and the tutorial, and the account's campaign duel still running |
| `POST /api/v1/campaign/encounters/{n}/start` | `games.play` (own decks: `decks.edit`) | `{"deck_id"}`, `{"loaner": true}` or `{"learn": true}`, and since v0.9.3 `"challenge": true` on the finale (Apex Unbound): the duel, as a game summary (201). 409 `encounter_locked`, `challenge_locked`, `game_limit`; 422 `invalid_seat` (no deck or two), `invalid_deck`, `deck_not_playable`, `custom_not_loaded`; 429 `games_busy`; 503 as practice games |
| `POST /api/v1/campaign/encounters/15/court` | `decks.edit` | Since v0.9.6: `{"deck_id", "friends": [1–2 friends], "challenge"}`: the court's private King's Table table, the player seated as King A and the friends invited (201, the table). 409 `encounter_locked`, `challenge_locked`, `at_a_table`, `in_queue`; 422 `not_friend`, `invalid_deck` |
| `POST /api/v1/campaign/scenes` | `games.play` | `{"scene": "FC.E01.POST"}`: a scene seen (to its end or skipped); FC.END.WIN or FC.END.EARLY after the finale's win records the ending |
| `PUT /api/v1/campaign/tutorial` | `games.play` | `{"hints", "skip", "lessons"}`: the hints, the teaching skipped (never the duel), lessons seen added |

A game's summary (`GET /api/v1/games/{id}`) names its encounter (`campaign`: encounter, opponent, name, title, hints, deck, finale, outcome), and its bot seat carries the opponent's name and portrait. `POST /api/v1/games/{id}/rematch` answers 409 `campaign_game`.

## Difficulty, measured (v0.9.1)

The handoff's difficulty contract is a target to measure. `CampaignDifficulty` (engine tests, run only with `-Dcampaign.measure=<games per pairing>`) plays a reference deck suite, each deck a fair bot at a fixed skill, against every ward's deck at that ward's skill, on the real engine, and writes a JSON report; `scripts/campaign_difficulty.py` sums it up by ward. The finale plays its public stand-in.

```sh
cd engine && mvn -Dmaven.repo.local.tail=/xmage/m2 -Dtest=CampaignDifficulty -Dsurefire.failIfNoSpecifiedTests=false \
  -Dcampaign.measure=3 -Dcampaign.references=loaner -Dcampaign.out=/tmp/difficulty.json test
python scripts/campaign_difficulty.py /tmp/difficulty.json
```

Options: `campaign.reference.skill` (default 3), `campaign.references` (`loaner` and starter deck IDs, default the loaner, `starter_rg_v1` and `starter_wu_v1`), `campaign.wards`, `campaign.budget` (seconds a game, default 300). "Hit" is the reference player's own turn when it first lost life; "lethal" is its own turn when the warden's creatures first had power enough on the battlefield to kill it.

**The first run (2026-11-07):** the loaner, Adeline's Vanguard, at skill 3, three games a ward.

| Ward | Skill | Reference won | Warden won | Other | Median turns | First hit | First lethal |
|---|---|---|---|---|---|---|---|
| 1 Tibalt | 1 | 2 | 1 | 0 | 20 | 2 | 7 |
| 2 Daretti | 2 | 3 | 0 | 0 | 24 | 4 | – |
| 3 Domri | 2 | 2 | 1 | 0 | 24 | 3 | 6 |
| 4 Dovin | 3 | 2 | 1 | 0 | 14 | 3 | 6 |
| 5 Oko | 3 | 3 | 0 | 0 | 21 | 2 | – |
| 6 Xenagos | 3 | 2 | 1 | 0 | 19 | 3 | 8 |
| 7 Tezzeret | 4 | 3 | 0 | 0 | 11 | – | – |
| 8 Arzakon | 4 | 3 | 0 | 0 | 13 | 4 | – |
| 9 Ashiok | 4 | 3 | 0 | 0 | 15 | 3 | 11 |
| 10 Ob Nixilis | 5 | 3 | 0 | 0 | 14 | 3 | 7 |
| 11 Geyadrone Dihada | 5 | 3 | 0 | 0 | 17 | 3 | – |
| 12 Nicol Bolas | 5 | 3 | 0 | 0 | 17 | 1 | – |
| 13 Liliana | 6 | 3 | 0 | 0 | 16 | 3 | – |
| 14 The Sphinx (stand-in) | 6 | 2 | 0 | 1 | 8 | – | – |

**What it says.** The curve runs backwards: the bronze and silver wardens (skill 1 to 3) won 4 of 18, and the wardens from ward 7 on (skill 4 to 6) won none of 24, most losing by turn 17 without ever threatening lethal. Skill isn't the lever that's missing: Liliana is already at 6. The later decks (artifact, five-colour, value and combo plans) are ones XMage's AI pilots poorly against a fast white weenie deck. Tibalt's first lethal threat came no earlier than the reference player's seventh turn, inside T04's "not before the sixth". The finale's first game ran out of the engine's 2 GB heap, and one of its games ended on turn 2 with both players at 40, which wants a look. Three games a pairing is a small sample. The skills were left unchanged: the decks are the lever, and they are the owner's content ([v0.9.2's plan](plans/0.9.2.md)).

## Difficulty, measured again (v0.9.3)

The owner chose the lever at v0.9.3's start: rework the late wardens' decks toward plans XMage's AI plays well. The handoff gives no rates, only a forgiving first ward (at least 95% of assisted novices beat Tibalt the first time), a clear rise within every chapter, and a finale beaten only rarely by strong prepared decks. Measured with fair bots against three reference decks at skill 3, those became these targets for the reference decks' wins:

| Tier | Wards | Target |
|---|---|---|
| Bronze | 1–4 | 85% falling to 65% |
| Silver | 5–8 | 60% falling to 45% |
| Gold | 9–10 | 40% to 35% |
| Platinum | 11–12 | 30% to 25% |
| Mythic | 13 | about 20% |
| Godlike | 14 | about 10% |

**What changed.**
- **Wards 7 to 13** were rebuilt around their commanders, colours and themes as decks the AI pilots: dense creature curves, ETB removal, evasive threats, few loops, a few tutors for bombs rather than combo pieces, the power rising by tier. Each still produces its ward's two bark triggers (the audit of `web/src/campaign/barks.ts` against the new lists put Tezzeret's artifact recursion, Ashiok's library pressure and Ob Nixilis's sweep back).
- **The finale's 99** kept its unrestricted power and lost the combo lines (the owner's go-ahead).
- **Skills.** Daretti 2 → 3 and Dovin 3 → 2. Bronze's decks are as the handoff wrote them.
- **Along the way**, the bots stopped losing on their own (Demonic Consultation and the Pacts) and heavy games search shallower ([fair bots](engine/fair-bots.md)). Wards 7, 10 and 13 needed second passes: Tezzeret's first rebuild was too weak, then too strong; Ob Nixilis's Blasphemous Act beside Blood Artist and Zulaport Cutthroat was a one-card kill (0 of 9 for the references); Liliana's loop fodder made her turns crawl past the harness's five minutes, and with it gone she measured too easy (50% in 6 games), so four of her weakest cards became threats and removal.

**The results** (2026-11-09; 9 games a ward, three per reference deck: the loaner, `starter_rg_v1`, `starter_wu_v1`; reference skill 3; each ward's final list; ward 13 with a 15-minute budget):

| Ward | Skill | Reference won | Target |
|---|---|---|---|
| 1 Tibalt | 1 | 67% | 85% |
| 2 Daretti | 3 | 89% | 80% |
| 3 Domri | 2 | 56% | 75% |
| 4 Dovin | 2 | 56% | 65% |
| 5 Oko | 3 | 44% | 60% |
| 6 Xenagos | 3 | 67% | 55% |
| 7 Tezzeret | 4 | 44% | 50% |
| 8 Arzakon | 4 | 33% | 45% |
| 9 Ashiok | 4 | 44% | 40% |
| 10 Ob Nixilis | 5 | 22% | 35% |
| 11 Geyadrone Dihada | 5 | 33% | 30% |
| 12 Nicol Bolas | 5 | 22% | 25% |
| 13 Liliana | 6 | 20% (1 of 5 decided; a sixth game passed 15 minutes) | 20% |
| 14 The Sphinx (stand-in) | 6 | 38% (8 games) | 10% |

v0.9.1's run had the late wardens winning none of 24 games; now every ward from 7 on wins most of its games against the references, and the curve falls by tier. Nine games a ward leave about ±16 points of noise, so within a tier the order is not settled (Oko measures harder than Xenagos). The finale's stand-in plays without the incarnation; the live finale adds the High Priest and The Sphinx crossing at 15 life. Tibalt's 67% is a skill-3 bot's, not an assisted novice's; his deck and skill (1) stay the handoff's.

## Difficulty on GitHub's runners (v0.9.4)

A run of 30 games a ward takes hours on one machine, so `.github/workflows/campaign-difficulty.yml` runs it on GitHub's: one job a ward, in parallel, each building the engine's card database stage from the engine job's cache and playing `CampaignDifficulty` for its ward (`-Dcampaign.wards`, a budget of 900 seconds a game), then one job that merges the fourteen reports and writes `scripts/campaign_difficulty.py`'s table into the run's summary; the merged report is the run's `campaign-difficulty` artifact. It runs on demand (Actions › Campaign difficulty › Run workflow, with the games per reference and the wards) or when a branch named `difficulty/<anything>` is pushed (10 games per reference, all wards).

**The first run** (2026-11-10, v0.9.4 on XMage 1.4.63, [Actions run 42863855360](https://github.com/sphinxtah/commander-duels/actions/runs/42863855360); 30 games a ward, ten per reference deck, the same three as v0.9.3, at skill 3; noise about ±9 points). Ward 13 at skill 6 finished after v0.9.4's close (three hours); its row is from the run's report.

| Ward | Reference won (v0.9.4, 30 games) | v0.9.3 (9 games) | Target |
|---|---|---|---|
| 1 Tibalt | 90% | 67% | 85% |
| 2 Daretti | 100% | 89% | 80% |
| 3 Domri | 67% | 56% | 75% |
| 4 Dovin | 53% | 56% | 65% |
| 5 Oko | 73% | 44% | 60% |
| 6 Xenagos | 47% | 67% | 55% |
| 7 Tezzeret | 40% | 44% | 50% |
| 8 Arzakon | 43% (3 games to the turn cap) | 33% | 45% |
| 9 Ashiok | 40% | 44% | 40% |
| 10 Ob Nixilis | 23% | 22% | 35% |
| 11 Geyadrone Dihada | 43% | 33% | 30% |
| 12 Nicol Bolas | 23% | 22% | 25% |
| 13 Liliana | 33% (4 games to the turn cap) | 20% | 20% |
| 14 The Sphinx (stand-in) | 30% | 38% | 10% |

With thirty games a ward the curve holds by tier, and most wards sit within the noise of their targets. Out of line: Daretti (100%) and Oko (73%) are easier than their places, Dovin (53%) and Ob Nixilis (23%) a little harder, Geyadrone Dihada (43%) easier than Platinum's 30%, and the finale's public stand-in (30%) far easier than 10%, though the live finale adds the High Priest and the incarnation at 15 life. Tuning them is for v0.9.5 ([the plan](plans/0.9.5.md#the-campaign)).

**Tuned in v0.9.5.** The decks are the lever, skills staying with their tiers (players who already won a ward keep the deck they won):
- **Daretti** (Bronze, stronger): Ornithopter, Memnite, Manakin, Hedron Crawler and Shredded Sails give way to Wurmcoil Engine, Goblin Welder, Sol Ring, Thought Vessel and Vandalblast.
- **Oko** (Silver, stronger): Scryb Sprites, Flying Men and Slither Blade to Mystic Snake, Rhystic Study and Hullbreaker Horror.
- **Geyadrone Dihada** (Platinum, stronger): Fain, the Broker and Walking Ballista to Dockside Extortionist and Mana Drain.
- **Dovin** (Bronze, weaker): Sun Titan, Sphinx's Revelation and Swords to Plowshares to Kor Skyfisher, Divination and Arrest.
- **Ob Nixilis** (Gold, weaker): Sheoldred, the Apocalypse, Inferno Titan, Grave Pact and Skullclamp to Vampire Nighthawk, Charging Monstrosaur, Butcher of Malakir and Bonesplitter.
- **Liliana** (33%) and **the finale's public stand-in** (30%) are left as they are: Liliana is within reach of its 20% at this sample's noise once the turn-cap games are counted out, and the live finale plays with the High Priest and the incarnation at 15 life, which the public run cannot measure.

The workflow ran again on the tuned decks from the branch `difficulty/v0.9.5` (10 games a reference); its table goes here when it finishes.

**The run on v0.9.5's tuned decks** (2026-11-10, branch `difficulty/v0.9.5`, [Actions run 42912720584](https://github.com/sphinxtah/commander-duels/actions/runs/42912720584); 30 games a ward, the same references at skill 3). Ward 13 was still playing at v0.9.6's close; its row comes with the next version. Read in v0.9.6 from the wards' reports:

| Ward | Reference won (v0.9.5) | v0.9.4 | Target |
|---|---|---|---|
| 1 Tibalt | 87% | 90% | 85% |
| 2 Daretti (stronger deck) | 100% | 100% | 80% |
| 3 Domri | 73% | 67% | 75% |
| 4 Dovin (weaker deck) | 47% | 53% | 65% |
| 5 Oko (stronger deck) | 70% | 73% | 60% |
| 6 Xenagos | 50% | 47% | 55% |
| 7 Tezzeret | 40% | 40% | 50% |
| 8 Arzakon | 53% | 43% | 45% |
| 9 Ashiok | 33% | 40% | 40% |
| 10 Ob Nixilis (weaker deck) | 37% | 23% | 35% |
| 11 Geyadrone Dihada (stronger deck) | 50% | 43% | 30% |
| 12 Nicol Bolas | 20% (1 game to the turn cap) | 23% | 25% |
| 14 The Sphinx (stand-in) | 43% (1 game to the turn cap) | 30% | 10% |

Ob Nixilis is now on target. Daretti still loses every game to the references, Dihada measured easier rather than harder (within the noise of ±9 points of v0.9.4's 43%), and Dovin harder than before; these three and the stand-in finale are carried to v0.9.7's tuning. The court (ward 15) is a King's Table game the duel harness doesn't play; `CourtDecksTest` (opt-in) plays its decks under the leak checks.

## Content

`content/campaign.json`: the campaign's ID and content version (`final_concordance_v1`, 1), the turn cap, the training seed, the training hand (v0.9.1), the loaner deck, the six chapters with their rewards, and the fourteen encounters (number, opponent's roster ID, name, title, tier, place, seal, the bots' skill, commander and 99 cards; the finale's commander null, its stand-in and its private content's name). Every card of the thirteen decks and the loaner was checked against XMage's card classes at the pinned commit (`eb69d05b`) when they were written, and the decks rebuilt in v0.9.3 against XMage's card database and their commanders' colour identities, and on the live site's catalog; the engine refuses a game naming a card it lacks (`unknown_cards`). `tests/test_campaign.py` checks the decks' counts, singletons and commanders, and that neither custom card is named.
