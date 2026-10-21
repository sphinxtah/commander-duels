# Human seat and per-seat views (v0.0.3)

> **Since v0.0.6** the API's own games use the same seats on the engine's service routes; see [games through the API](../games.md). The development endpoints below stay for scripts.
>
> **Since v0.0.4** a game seats two to four players, any mix of human and bot, in Legacy or Commander. Each human seat has its own token, prompt and view. The prompt mechanics and view rules below still hold; the endpoint shapes, results and seat rules are updated here for v0.0.4. The Commander tables, new prompt kinds and commander fields are in [Commander tables](commander-tables.md).

v0.0.3 is the second slice of milestone M0. A human seat plays a Legacy Two Player Duel against an XMage computer player through XMage's own `HumanPlayer`. Each blocking choice becomes a typed prompt with an ID, stale answers are refused, and the seat receives only an authorized view. Development endpoints on the internal engine carry it; FastAPI still refuses game actions, and there is no game UI. [The engine spike](xmage-spike.md) records how XMage's human player waits for answers; this document records what was built on that.

What it proves:
- XMage's unmodified `HumanPlayer` can be driven headless through its query events and response setters.
- Every request the two fixture decks produce has a typed prompt.
- Per-seat views can be built field by field without disclosing concealed cards. Scripted games check this against XMage's own state at every published view.

What it does not prove:
- Anything about a browser client, sign-in or seat ownership.
- Recovery, timers, multiplayer, or prompt families the fixture decks never reach.
- That the bot plays fairly. The bot still searched a full copy of the game state, including the human's hand (AI02; fixed in v0.3.1, see [fair bots](fair-bots.md)).

## How a prompt works

1. **XMage asks.** On the game thread, `HumanPlayer` fires a `PlayerQueryEvent` and then blocks in `waitForResponse`.
2. **The engine publishes.** A listener on the same thread builds the typed prompt and the seat's view. It publishes both at a new revision with a fresh prompt ID (a UUID). XMage's own server builds its views on the game thread too, because the state is only consistent there.
3. **The seat answers.** The answer names the prompt ID, the expected revision and one option ID. The engine checks it under a lock in this order:
   - a repeated action ID returns its first result, or `action_id_reused` if the body differs;
   - a finished game returns `game_over`;
   - a prompt that is not the open one returns `stale_prompt`;
   - a wrong revision returns `stale_revision`;
   - an unsupported prompt returns `unsupported_prompt`;
   - an unknown option returns `invalid_option` (or `invalid_amounts`).
   Refusals leave the prompt open. An accepted answer closes it and bumps the revision.
4. **XMage receives.** Outside the lock, the option's mapped answer goes to XMage through one of `setResponseUUID`, `setResponseBoolean`, `setResponseString` or `setResponseManaType`. XMage validates it again and, if it disagrees, asks again, which publishes a new prompt.

The seat never sends XMage identifiers. Option IDs are numbers scoped to one prompt, and each maps to the exact value `HumanPlayer` expects.

### Prompt kinds

| Kind | XMage request | Options | Answer sent to XMage |
| --- | --- | --- | --- |
| `priority` | `SELECT` from `firePriorityEvent` | `pass`; one option per playable object (`play_land`, `cast`, `activate`, `activate_mana`), from `getPlayable`; since v0.2.0 the pass modes (`pass_until_stack_resolved` with a non-empty stack, `pass_until_next_main`, `pass_until_end_of_turn`, `pass_until_next_turn`, `pass_until_end_step_before_my_turn`, `pass_until_my_turn`) | boolean; object UUID; a pass mode is XMage's matching `PlayerAction`, sent as its client does |
| `mulligan` | `ASK` with Mulligan/Keep buttons | `mulligan`, `keep` | boolean |
| `yes_no` | `ASK` (optional effects, "mana will be lost" confirmations) | `yes`, `no`, with XMage's button labels | boolean |
| `choose_target` | `PICK_TARGET` (targets, the starting player, the attacker to block, cards to put on the bottom or discard) | `choose` per candidate (players by seat, objects by opaque ID, already chosen ones marked `selected`); `done` when not required | UUID; boolean |
| `pay_mana` | `PLAY_MANA` | Since v0.1.1 only sources and pool mana that can pay part of the unpaid cost (read from XMage's message, "Pay {R}{R}…"; when it cannot be read, or an effect lets mana be spent as another type, nothing is left out). With nothing that can pay, the detail says "Nothing you control can pay {R}{R}." and only `cancel` is offered. Options: `tap_source` per permanent with a usable mana ability, and (since v0.1.1) per hand card whose mana ability works from the hand, labelled with that ability ("Exile Simian Spirit Guide from your hand: Add {R}."); `use_pool` per mana type in the pool; `special_payment` ("Special payment (convoke, delve, improvise)") whenever XMage's own condition for its Special button holds, that is, the seat controls mana special actions during the payment; `cancel` | UUID; mana type; "special"; boolean |
| `declare_attackers` | `SELECT` with possible attackers | `toggle_attacker` per creature; `all_attack`; `done` | UUID; "special"; boolean |
| `declare_blockers` | `SELECT` with possible blockers | `toggle_blocker` per creature; `done` | UUID; boolean |
| `assign_amounts` | `MULTI_AMOUNT` (combat damage among blockers, with or without trample) | `suggested` (XMage's default split); `cancel` when allowed; or a payload of one amount per entry | space-separated amounts; boolean |
| `choose_defender`, `choose_ability`, `choose_choice`, `choose_mode`, `choose_amount`, `order_triggers`, `choose_pile` | Added in v0.0.4; see [Commander tables](commander-tables.md#prompts) | | |
| `choose_name` | Added in v0.4.0; see [Commander tables](commander-tables.md#prompts) | | |
| `unsupported` | `CHOOSE_CHOICE` key choices longer than 1,000 entries, and `PLAY_X_MANA`, which XMage's human player never sends at the pin | none | The game waits until the seat concedes or the game is closed |

None of the unsupported families occurred in the scripted games: the fixture decks have no modal spells, X costs, named choices, piles or simultaneous triggers that need ordering. XMage's `PERSONAL_MESSAGE` events ("You have to attack with...") become the view's `messages`, not prompts.

**Paying beyond the battlefield** (since v0.1.1). XMage lists a spell as castable when mana from the hand (Simian Spirit Guide) or a special payment (convoke, delve, improvise) could pay for it. Before v0.1.1 the payment prompt offered neither, so such a cast could end at a payment whose only option was cancel. After `special_payment`, XMage asks with `choose_ability` which special payment to use, then with `choose_target` which creatures, cards or artifacts it uses, and for convoke sometimes with `choose_choice` for the colour. Pay with mana abilities first: once a special payment is used, XMage refuses further mana abilities for that spell, as its own client does.

## Priority controls

Since v0.2.0 (UI07), on XMage's own human player, so XMage's rules for when a pass ends are the engine's:
- **Pass modes** are options of the priority prompt (above). Choosing one sends XMage the player action its client sends, which passes now and keeps passing until its end. XMage ends a pass early when an object is put on the stack (if the seat stops for new stack objects), and at the declare attackers and declare blockers steps (if it stops there). Choices the seat must make, such as blockers, are still asked.
- **`set_priority`** changes the seat's settings, in the command envelope with no `prompt_id`, so it works while the engine is passing. Its payload holds at least one of:
  - `your_turn` and `opponent_turn`: the steps where an empty stack gives the seat priority, from `upkeep`, `draw`, `main1`, `before_combat`, `end_of_combat`, `main2` and `end_of_turn` (XMage's default: `main1` and `main2` in every turn);
  - `stop_on_new_stack_objects`, `stop_on_attackers`, `stop_on_blockers`: what ends a pass;
  - `pass_after_casting`: false (the default) holds priority after the seat casts or activates;
  - `full_control`: true stops at every step and every new object and holds priority after casting; false restores XMage's defaults;
  - `cancel_passes`: true ends a pass in progress.
- **The reply** (200) carries the seat's controls as `priority`, the same object as the view's `priority`: the settings above plus `passing`, the pass in progress (`until_my_turn` and the like) or null. A finished game refuses with 409 `game_over`; an unknown step or setting is a 400 `invalid_command`. A repeated action ID returns its first result, as for every command.
- **Views.** Each seat's view has `priority`; a spectator's view has null. The settings live in the seat's XMage `UserData` and last for the game.

`PriorityControlsTest` holds priority with a spell on the stack and with a nested stack, passes until the next turn and checks no prompt follows in that turn, turns full control on (the seat is then asked in its upkeep) and off again, cancels a payment, and checks the command's validation.

## Authorized views

`SeatView` is built field by field from the game state; nothing is a filtered copy of a full snapshot. [The contract](../../contracts/engine-seat-view.schema.json) closes every object, so it cannot carry these:

- another player's hand, or any library: each player shows counts only;
- the shuffle seed;
- XMage identifiers.

| Shown | Rule |
| --- | --- |
| Your hand | Full cards |
| Battlefield, stack, graveyards | Public, except face-down objects, which only their controller sees (none in the fixture decks) |
| Exile | Face-up cards; face-down exiled cards are hidden |
| Revealed cards | Everyone, while XMage keeps them revealed (it clears them at each human priority prompt) |
| Looked-at cards | Only the player who looked |
| Players | Life, counters, library and hand counts, mana pool, lost/won |
| Combat | Attackers, the defender and blockers |
| Log | XMage's public log, with HTML and XMage's short object IDs removed, up to the entries that existed when the seat's current view was built (since v0.1.1), so it does not arrive with an older view. In the browser a line can still name a bot's card one view before the board shows it (CI run #30), which the browser check allows as the engine's does. The finished game's snapshot carries the whole log. Engine error lines stay in the engine's own log, because their details are not seat-safe. XMage's own recovery lines ("Auto-restored to … due game error: …" and "Game stopped due critical error …") are replaced by "The rules engine hit an internal error and rolled the game back" and "The rules engine stopped the game after an internal error"; the details stay in the engine's ERROR entries and in XMage's console log |

Objects get opaque IDs (`o` and 16 hex digits) from `SecureRandom`. The key is the XMage UUID plus its zone-change counter, so a card that changes zones becomes a new object (rule 400.7) and gets a new ID. IDs are minted only when an object is first shown.

Two deliberate differences from XMage's own client views:

- XMage's `PlayerView` shows a computer opponent's sideboard to the human. The seat view never shows a sideboard.
- XMage's `GameView` carries raw object UUIDs. The seat view never does.

## Engine endpoints

These exist only when `CD_ENGINE_DEV_ENDPOINTS=true`, which Compose sets. The engine publishes no port, and the web proxy forwards nothing to it.

| Request | Purpose | Responses |
| --- | --- | --- |
| `POST /v1/games` | Start a game: optional `format` (`legacy` or `commander`), `seats` (players in turn order, each `{"player": "human" or "bot", "deck"?}`), `seed`, `skill` (1–6), `turn_cap` (1–200) and `idle_timeout_seconds` (5–3600); out-of-range numbers are clamped | 201 `game_id`, `seats` (each with its `seat_token`, returned once, or `null` for a bot) and `settings`; 400 for a malformed table; 429 `games_busy` with `Retry-After` |
| `GET /v1/games/{id}/view` | The seat's snapshot, or with the spectator token the public one (since v0.0.4). `since` and `wait_ms` (up to 30 s) long-poll for a newer revision; `log_from` pages the log (up to 200 lines) | 200 snapshot |
| `POST /v1/games/{id}/commands` | `submit_choice`, `concede` or (since v0.2.0) `set_priority`, in the [command envelope](../../contracts/engine-command.schema.json) | 200 accepted; 400 `invalid_command`; 409 or 422 refusals as listed above, plus 409 `eliminated` for a second concession |
| `POST /v1/games/{id}/close` | End the game for every seat: all seats concede, and the result records `closed` | 200 `finished` or `closing` |

Every game request needs `Authorization: Bearer <seat_token>`, and the token alone selects the seat: the view, prompt and commands are that seat's. No body field can choose one: the envelope rejects unknown fields such as `seat`. An unknown game and a wrong token both return 404 `not_found`.

Since v0.1.1, a number past JSON-number limits (`1e10000`, `1e99999999999`, more than 10,000 digits) is a 400 `invalid_request` or `invalid_command`, like any other bad number. An unexpected failure inside the engine answers 500 `{"code": "internal_error"}` instead of dropping the connection; the details go to the engine's log.

The seed is never returned. It decides every shuffle, so knowing it would reveal library order (SEC03). The seed input exists for reproducible development tests only.

A command:

```json
{"v": 1, "game_id": "…", "action_id": "…", "expected_revision": 184, "prompt_id": "…",
 "type": "submit_choice", "payload": {"option_id": "2"}}
```

The snapshot's `status` is one of `starting`, `your_prompt`, `unsupported_prompt`, `waiting` (another player is acting or XMage is processing), `eliminated` (this seat has lost and the game goes on) or `finished`. A finished game has a `result`:
- `kind` is `completed`, `turn_limit`, `closed`, `idle_timeout`, `humans_eliminated` or `error`;
- `conceded_seats` lists the seats that conceded, in order;
- for a completed game, also `winner_seat` and `draw`;
- for an `error`, `error` says what happened in plain words: "The engine stopped the game after an internal error" when the engine's game thread failed (since v0.1.1; the stack trace goes to the engine's log), or "XMage ended the game after an internal error".

## Lifecycle and threads

- **Seats.** Seats are in turn order, as the request lists them (in v0.0.3 the human always sat in seat 0). A seeded coin decides who chooses the starting player. The human seat uses XMage's default user settings: it stops in both main phases, at declare attackers and blockers, and whenever something new is on the stack, and it confirms before passing with mana in the pool. Configurable stops (UI07) are later work.
- **Threads.** Each game runs on its own `GAME human_game <id>` platform thread, which blocks while it waits for the seat. Views are built on that thread; request threads only read the published snapshot.
- **Capacity.** At most `CD_ENGINE_MAX_GAMES` games run at once (default 2, at most 8). XMage's AI shares one search pool and one random generator across games, and each game holds a thread. Bot matches keep their own single slot.
- **Watchdog.** It checks every second. A game with no activity for its idle timeout (default 15 minutes) is closed with `idle_timeout`. Finished games stay readable for 10 minutes (at most 16), then are dropped.
- **Concede and close.** These go through XMage's `setConcedingPlayer`, as its server does, and wake a waiting choice with `signalPlayerConcede`. If the game thread has not ended 5 seconds after a close, the engine ends the game and interrupts the thread until it exits, as bot matches do. Since v0.1.1, a seat that concedes before the game starts is never shown a prompt: at its first XMage request it leaves the game, and its status becomes `eliminated`. While a game is closing, no new prompt opens.
- **Memory only.** Games live in memory. There is no journal, snapshot or recovery yet, and a restart loses them.

## Verification

Leak checks run on the game thread for every published view, against XMage's own state, in the scripted JUnit games (`HumanGameTest`):

1. **No XMage UUIDs.** No UUID appears in a view or prompt other than the prompt's own ID.
2. **IDs by zone.** Every opaque ID in a payload resolves to an object visible to the human by an independent zone check. The opponent's hand and both libraries, minus revealed and looked-at cards, are concealed.
3. **Names.** A card name that only the opponent's deck contains appears in a payload only once a card of that name has been public. The fixture decks share no card names, so this catches a concealed card by name.
4. **Log lines.** Every log line naming an opponent-only card must name a card that is public by the next event. XMage logs a discard just before moving the card. Since v0.1.1, every log line served to a seat may also name only cards that seat's views have already shown, checked at every new log line and every published view.
5. **Counts.** Hand and library counts, and the human's hand contents, match XMage.
6. **No hidden errors** (since v0.1.1). Any error XMage recovered from (a rollback) fails the checks, and so does a failure to build the final views. XMage plays on after most exceptions, so a game would otherwise still finish.

Results:
- **JUnit `HumanGameTest`:** 6 complete games, 3 with each deck, at AI skill 1. About 1,400 views checked per run, with no failures. Every fixture prompt family seen: `priority`, `mulligan`, `yes_no`, `choose_target`, `pay_mana`, `declare_attackers`, `declare_blockers` and `assign_amounts`, the last both suggested and custom. No unsupported request. The first answer of each game also probes a forged prompt, a stale revision, an unknown option, a repeated action ID and a reused action ID.
- **JUnit, other human-game tests:**
  - concede (the bot wins, `conceded` is true);
  - close while the seat is waiting;
  - idle timeout;
  - the game cap;
  - HTTP: tokens, 404s, envelope refusals including a `seat` field, long-polling, concede and close;
  - parsers.
- **Compose:**
  - `scripts/engine_human_game.py` played 6 games at the default skill 4, 3 with each deck. Every payload was validated against the seat-view contract plus client-side checks, with no problems.
  - The documented one-liner played a 13-turn game: 106 prompts and 300 payloads.
  - Afterwards the engine had no game threads, and the heap after GC was 57 MB, with 7 finished games retained.
- **CI:** the engine job now runs one scripted game with schema validation after the bot match.
- **Since v0.1.1:** `SpecialPaymentTest` pays for spells with convoke and with mana from the hand (Simian Spirit Guide). `CommanderGameTest` concedes a seat before the start, and `HumanGameTest` makes XMage recover from an error, which the checks must catch and the seat's log must report without its details. The engine's JUnit suite has 81 tests.

## Findings

- **XMage settings.** `HumanPlayer` needs `UserData`. XMage's server sets it when a user connects, and without it the first priority throws. The engine sets `UserData.getDefaultUserDataView()`.
- **Damage assignment.** It is reachable with simple decks: a trampler, or an attacker blocked by two creatures, makes XMage ask for a `MULTI_AMOUNT` split. It is typed as `assign_amounts`.
- **Pool mana.** XMage spends usable pool mana automatically. Answering a payment with pool mana that cannot pay the cost repeats the request indefinitely, and a source whose mana cannot pay is still tapped. Since v0.1.1 the payment prompt offers neither (see `pay_mana` above).
- **Optional costs are asked before they are checked.** Chain Lightning asks the player it hit "Pay {R}{R} to copy the spell?" whether or not they can pay. CI run #24's keyboard journey said yes with only Forests: it tapped a Forest, then answered with the green pool mana 600 times. A replay of the journey's table reproduced it in 11% of games (45 of 408); with the v0.1.1 payment prompt, 1,000 games had no payment loop.
- **XMage's token list fills lazily, without a lock.** Every game creates its helper emblems at the start, and games starting together on a freshly started engine could fail with a `ConcurrentModificationException` (2 of 6 fresh starts lost a game with two games at once). Since v0.1.1 the engine fills the list once, after loading the card database.
- **Cancelled casting.** `done` on a required target with nothing chosen cancels the spell. XMage treats it as cancelling the cast.
- **No active player before turn 1.** Seat lookups must tolerate nulls (`List.of` throws on `indexOf(null)`).
- **Revealed cards are cleared at each human priority prompt.** The view built for that prompt still shows them.
- **Reproducibility.** With the same seed, the scripted client replayed the same game twice: 13 turns and 106 prompts. That is consistent but not guaranteed; the AI's tie-breaks still depend on random UUIDs (see the spike's determinism section).

## Open items

- **AI hidden information (AI02).** The bot's search read the human's hand. Fixed in v0.3.1 ([fair bots](fair-bots.md)).
- **Recovery.** Journals, snapshots, reconnect and worker fencing (NET08–10).
- **Seats.** The human is always seat 0, with no seat ownership, sign-in or controller lease. FastAPI does not route game actions yet.
- **Timers.** No timers or clocks (NET11–12). Configurable stops and pass modes arrived in v0.2.0 (UI07).
- **Prompt families.** The unsupported families above, plus multiplayer and watcher views.
- **Browser interface.** That is v0.1.0, the first version with a UI you can use.
