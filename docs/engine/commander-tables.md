# Commander tables and the multiplayer seat bridge (v0.0.4)

v0.0.4 is the third slice of milestone M0. It generalizes [the v0.0.3 human seat](human-seat.md) from one human against one bot to any mix of human and bot seats: Legacy at two seats, and Commander at two, three or four. Every human seat has its own token, prompt state and authorized view, and the leak checks run for every human seat against every other seat's concealed zones. Development endpoints on the internal engine carry it, as in v0.0.3. FastAPI still refuses game actions, and there is no game UI.

What it proves:
- XMage's `CommanderDuel` and `CommanderFreeForAll` play complete games through the bridge with up to four `HumanPlayer` seats, bots, or a mix.
- Views for four seats can be built field by field without disclosing any seat's hand or any library. Scripted games check this against XMage's state at every published view, for every human seat.
- Commander tax and commander damage in the views are XMage's own numbers, at every view, through death, recasting, control changes and a player leaving.
- Every XMage request the fixture decks reach is typed, including modes, X values, trigger order and piles, and a scripted game reaches each of those every time.
- A spectator can follow a game with public information only, optionally delayed (NET14).

What it does not prove:
- Anything about a browser client, sign-in, seat ownership or lobbies.
- Recovery, timers, Two-Headed Giant ([the feasibility note](two-headed-giant.md)), or choices too long to offer (naming a card).
- That the bots play fairly: they still searched a full copy of the game, including every human's hand (AI02). Fixed in v0.3.1: each search re-deals what the bot's seat cannot see ([fair bots](fair-bots.md)).

## Tables

| Format | Seats | XMage game | Rules profile (`settings.rules_profile`) |
| --- | --- | --- | --- |
| `legacy` | 2 | `TwoPlayerDuel`, 20 life, London mulligan | `legacy_two_player_duel` |
| `commander` | 2 | `CommanderDuel`, 40 life, London mulligan, no free mulligan; the starting player skips the first draw | `commander_two_seat` |
| `commander` | 3–4 | `CommanderFreeForAll`, 40 life, London mulligan with the first mulligan free; nobody skips the first draw; attack any opponent | `commander_free_for_all` |

The two-seat table is the scope's two-seat Commander profile, not the separate Duel Commander format (FMT02): 40 life, commander damage on, and the commander may be cast from the command zone any number of times. Mulligan and first-draw rules follow the table size, as the Comprehensive Rules do: a two-player game is not multiplayer, so it gets no free mulligan and the starting player skips the first draw. XMage's own Commander tables use the same game classes; the engine builds them directly with these settings. A JUnit test checks each table's game class, free mulligans, first-draw rule and starting life against XMage's state.

The engine image now also builds `Mage.Game.CommanderDuel` from the pinned commit (no patches). Decks are checked with XMage's `mage.deck.Commander` validator.

### Fixture decks

Four 100-card decks in `engine/decks`, each a commander plus 38 basic lands and 61 simple, singleton cards: vanilla and keyword creatures, burn, removal, bounce, counterspells, pump spells, a few auras, a planeswalker or steal effect, and a few cards that reach the rarer prompts. No card name appears in two decks, so the name-based leak check stays meaningful.

| Deck | Commander | Colour identity | Interactions it brings |
| --- | --- | --- | --- |
| `commander-mono-white-soldiers` | Isamaru, Hound of Konda | W | Exile and bottom-of-library removal (Swords to Plowshares, Path to Exile, Condemn), Mother of Runes, Ajani Goldmane, Valorous Stance (modes), Soul Warden and Attended Knight (trigger order) |
| `commander-mono-blue-flyers` | Tetsuko Umezawa, Fugitive | U | Bounce, counterspells, Control Magic, Jace Beleren, Fact or Fiction (piles) |
| `commander-mono-red-raiders` | Jeska, Warrior Adept | R | Burn, Act of Treason and Threaten, Abrade (modes), Blaze (X) |
| `commander-mono-green-stompers` | Lady Zhurong, Warrior Queen | G | Library searches (Rampant Growth, Cultivate), fight spells, Overrun, Garruk Wildspeaker, Mistcutter Hydra (X) |

## Seats

`POST /v1/games` takes a format and its seats in turn order:

```json
{"format": "commander", "seats": [{"player": "human"}, {"player": "bot"},
 {"player": "human", "deck": "commander-mono-red-raiders"}, {"player": "bot"}],
 "seed": 7, "skill": 1, "turn_cap": 40}
```

- **Defaults.** Legacy defaults to a human and a bot; Commander to a human and three bots. At least one seat must be human.
- **Decks.** A seat without a deck gets the format's first fixture that no other seat uses.
- **Refused.** Unknown formats, players or decks, a deck from another format, the wrong number of seats, and unknown fields (including any `seat` field) return 400.
- **Response.** The 201 response lists every seat: `{"seat", "player", "seat_token"}`, with a token for each human seat and `null` for bots. It also returns one `spectator_token`. Tokens are returned once.
- **Tokens.** Each token selects its seat; nothing in a request body can choose one. The engine compares the presented token with every seat's hash in constant time. A token that matches no seat, or the wrong game, returns 404.
- **Players.** Players are named by kind and seat number, seat + 1: "Human 1", "Bot 2".
- **Turn order.** Turns pass in seat order: 0, 1, 2, 3 (see the findings).

At most one prompt is open per game, because XMage asks one player at a time on the single game thread. Each human seat has its own revision, which moves only when that seat's view or prompt changes, so a seat's revision says nothing about other seats' choices. A seat's open prompt can be republished at a new revision when its view changes while XMage waits, for instance when another seat concedes. The answer must then name the new revision.

### Concessions, eliminations and the end of a game

- **Conceding.** A seat that concedes leaves the game, as in XMage's server. At a table of three or four, the others play on. XMage's cleanup removes the seat's cards and ends any control effects it had: a borrowed permanent goes back to its owner.
- **Conceding before the start** (since v0.1.1). A seat that concedes while the game is still starting is never shown a prompt. At its first XMage request it leaves the game, and its status becomes `eliminated`. Likewise, no new prompt opens while a game is closing.
- **Eliminated seats.** A seat that has lost has the status `eliminated`. It can still read its view, which then shows only public information, until the game finishes. Conceding again returns 409 `eliminated`.
- **No humans left.** When every human seat is out and two or more bots remain, the engine ends the game with the result `humans_eliminated` rather than letting the bots play it out unseen. When only one bot remains, XMage ends the game itself and the result is `completed`, with that bot as the winner (since v0.1.1; before, the engine's close raced XMage's own end). The close concedes each bot only while a player holds priority or a choice, waiting up to a second, so XMage applies it on its own thread.
- **Closing.** `POST .../close` with any seat's token ends the game for everyone: every seat concedes and the result is `closed`.
- **Results.** A result lists `conceded_seats` in order. For a completed game it also gives `winner_seat` and `draw`.

## Views

The seat view's `opponent` is now `opponents`: every other player in seat order, including eliminated ones. Each player state adds:

| Field | Contents |
| --- | --- |
| `color_identity` | The commanders' combined colour identity in WUBRG order. `null` outside Commander and before XMage has put the commanders in the command zone |
| `command_zone` | The commander cards and any emblems the player has in the command zone |
| `commanders` | Per commander (FMT01): `name`, `zone`, `object_id`, `cast_count` (casts from the command zone), `tax` ({2} per cast) and `damage_dealt` (combat damage to each player, by seat) |

Rules for the commander fields:
- **Source.** The numbers come from XMage's own watchers (`CommanderPlaysCountWatcher` and `CommanderInfoWatcher`), the ones that change XMage's costs and apply the 21-damage loss. The views show exactly what XMage applies.
- **Identity.** A commander's identity is public from the start of the game, so its name is always shown.
- **Hidden zones.** A commander in a hand or a library is `hidden` to everyone but its owner, with no object id. Otherwise a draw could reveal that the drawn card was the commander.
- **Players who left.** A commander whose owner left the game is `outside`. Its damage record stays, but it cannot add to it.
- **Control changes.** Commander damage counts for the commander, not its controller. A stolen commander's damage appears under its owner's entry.

Each seat's snapshot names only its own deck. `settings.seats` lists every seat's player kind, and other seats' decks are `null`. A deck name identifies a whole fixture list.

## Spectators

Every game has one spectator token (NET14). It reads `GET .../view` and nothing else: commands and close return 403 `read_only`.
- **Public information only.** A spectator's snapshot has no seat, no prompt and no `you`. Its view's `opponents` lists every player, and `hand`, `looked_at` and `messages` are always empty. The view is built field by field like a seat's, with no viewer: no hand, face-down object or looked-at card belongs to a spectator. `settings.seats` shows no deck.
- **Delay.** `spectator_delay_seconds` (0–300, default 0) makes the spectator's view, log and result run that far behind the game. The engine keeps about one public view per second of delay and serves the newest that is old enough.
- **Status.** A spectator's status is `spectating` while the game runs and `finished` once the delayed result arrives.
- **Verification.** Every public view is checked like a seat's, with every hand and library concealed. A JUnit test proves that no spectator snapshot is younger than the delay and that the result arrives only after it. An HTTP test proves the token is read-only.

## Prompts

Eight kinds are new; everything else is as in v0.0.3.

| Kind | XMage request | Options | Answer sent to XMage |
| --- | --- | --- | --- |
| `choose_defender` | `PICK_TARGET` from `TargetDefender`, when an attacker has more than one player, planeswalker or battle to attack | `choose` per defender (players by seat, planeswalkers and battles by object id). `detail` names the attacker the seat last toggled, because XMage's request does not | UUID |
| `choose_ability` | `CHOOSE_ABILITY`: which of an object's abilities to activate (a planeswalker's loyalty abilities, for instance), or which way to cast a card | `use_ability` per ability, labelled with its rules text; `cancel` | UUID; boolean |
| `choose_choice` | `CHOOSE_CHOICE` with at most 64 entries: a colour (Mother of Runes) or which replacement effect applies first | `choose` per entry; `cancel` when optional. Key choices answer with a key that stays on the server | string |
| `choose_mode` | `CHOOSE_MODE`: a modal spell or ability (Valorous Stance, Abrade) | `choose_mode` per available mode, labelled with its text; `done` when enough are chosen; `cancel`. XMage asks again for each further mode | UUID |
| `choose_amount` | `AMOUNT`: a number, such as X for Blaze or Mistcutter Hydra | `suggested` (the minimum), or a payload of one amount within `amounts` | integer |
| `order_triggers` | `PICK_ABILITY`: several of the seat's triggers at once with different texts, such as Soul Warden and Attended Knight's own trigger | `put_first` per trigger, labelled with its rules text and its source's object id; XMage asks again for the rest | UUID |
| `choose_pile` | `CHOOSE_PILE`: Fact or Fiction's two piles | `choose_pile` for each, with the visible card names; the prompt's `piles` lists each pile's object ids | boolean |
| `yes_no` | (unchanged) also covers Commander's "move it to the command zone?": the state-based choice for a graveyard or exile, and the replacement for a hand or library | `yes` moves it, using XMage's button labels | boolean |

Multiplayer targets need nothing new: `choose_target` already lists players by seat. A choice longer than 64 entries, such as naming a card, stays `unsupported`. So does `PLAY_X_MANA`, which XMage's human player never sends at the pinned commit (X costs arrive as `AMOUNT`).

## Verification

Every published view and prompt, for every human seat, is checked on the game thread against XMage's state (`SeatChecks`):

1. **No XMage UUIDs**, except the prompt's own id.
2. **Object ids by zone.** Every opaque id must resolve to an object the seat may see. Every other player's hand and every library are concealed, minus revealed and looked-at cards. A seat's own library may appear in that seat's prompts, because searching it shows it to the searcher.
3. **Names.** A card name only other seats' decks contain must not appear as a card name, an object option's label, or a phrase in free text until a card of that name has been public. Type lines are not checked, because a subtype can equal a card name ("Ogre Warrior").
4. **Log lines.** These are checked as in v0.0.3, for names concealed from any human seat. Since v0.1.1 each seat's log stops at the entries that existed when its view was built, so every line served to a seat may name only cards that seat's views have already shown ([the human seat](human-seat.md#verification)).
5. **State.**
   - Every player's hand and library counts, life and lost flag match XMage. So do the seat's own hand contents, and each permanent's controller and owner.
   - The opponents list is complete and in seat order.
   - Each commander's zone, object, cast count, tax and commander damage match XMage's watchers. Colour identity matches the fixture's.

`PromptFamiliesTest` makes four humans play a scripted game with arranged libraries that reaches `choose_mode` (Valorous Stance, Abrade), a custom `choose_amount` (Blaze, Mistcutter Hydra), `order_triggers` (Attended Knight entering next to Soul Warden) and `choose_pile` (Fact or Fiction, split by another seat) every time. Every seat's and every spectator's views are checked as usual.

Results are in [the release notes](../releases/0.0.4.md) and [verification](../verification.md#v004).

### The scenario test

`CommanderScenarioTest` makes four humans play a scripted game with arranged libraries (no opening shuffle, test only), so it reaches every time what random games reach only sometimes (T07 and T08 at the engine level):

1. Seat 1 casts Isamaru from the command zone.
2. Seat 2 kills it with Lightning Bolt, and seat 1 moves it from the graveyard to the command zone.
3. Seat 1 recasts it for {2} of tax. The next cast would cost {4} more.
4. Seat 0 steals it with Control Magic and attacks seat 2, choosing that defender. The 2 combat damage counts for Isamaru, under seat 1's commander entry.
5. Seat 0 concedes while it still controls the stolen commander. XMage's cleanup ends the control effect, and Isamaru returns to seat 1. Seat 0's status is `eliminated`, and the other three play on to the turn limit.

## Findings

- **Turn order is the reverse of joining order.** XMage's player list inserts each player it is given at the front. Players added 0, 1, 2, 3 take turns 0, 3, 2, 1. The engine adds seat 0 and then the others in reverse, so turns follow the seat numbers. A test checks the order at every table size.
- **Players are copied when XMage restores a state.** Cancelling a cast or payment rolls XMage back to a bookmark, which replaces each player object with a copy. The copies share the answer channel, but not the flag that says XMage is listening. An answer sent to the original object waited 30 seconds and was dropped, and the game hung. The engine now always answers the game's current object, as XMage's own server does (`game.getPlayer(id)`). v0.0.3 had the same exposure.
- **XMage treats a thread named `main` as a game thread.** This is for its own unit tests. A concession called from JUnit's main thread made XMage run the seat's cleanup on that thread, racing the real game thread. Real requests arrive on unnamed threads; the tests now rename their client thread.
- **An answer that arrives before XMage listens waits in 100 ms steps.** XMage holds an early answer and checks every 100 ms whether the player is listening yet. The engine used to open a seat's prompt and then build the other seats' views, so scripted answers often arrived first. With several humans, that cost about 100 ms per prompt, and a four-human test game took 32 s. Other seats' views now go out before the prompt opens, and the same game takes 3 s.
- **Life totals are set after the starting player is chosen.** Views before that show 0 life. The mulligans come after.
- **Defender choice is a plain target request.** XMage's `TargetDefender` arrives as `PICK_TARGET` with no attacker. The engine recognizes it by XMage's message and remembers which attacker the seat toggled.
- **Bots think longer at four seats.** At skill 1, the MAD AI logged "thinks too long" a few times on boards of 30-plus permanents in four-seat games. Games still finished.

## Open items

- **Two-Headed Giant (FMT08–FMT10).** See [the feasibility note](two-headed-giant.md).
- **AI hidden information (AI02).** Unchanged here; fixed in v0.3.1 ([fair bots](fair-bots.md)).
- **Lobbies and settings.** Readiness (NET02–NET03) and Rule Zero settings (FMT03–FMT04) are not built.
- **Prompt families.** Only choices longer than 64 entries (naming a card) are still `unsupported`.
- **Spectator delay.** Delay is in seconds. Delays counted in turns, and replays (NET14), are later work.
- **Recovery.** Games live in memory only.
