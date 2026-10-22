# Games through the API (v0.0.6)

v0.0.6 routes games through the API. A signed-in player starts a practice game against bots, plays it over a WebSocket, and sees only what the seat may see. The API, not the browser, holds the engine's seat tokens; one browser tab at a time controls the seat; and SysOp can inspect every hand and library. It covers AUTH07's match half, NET05–NET07 for practice games, T13 and T14 for routed games, and T29's match case. There is still no game interface: scripts play the games, and the interface arrives in v0.1.0.

## Decisions

Agreed on 2026-10-19 at the start of v0.0.6:
- **Transport.** WebSocket now, as the scope's protocol, not long-polling first.
- **Formats.** Legacy against one bot, and Commander against one to three bots.
- **SysOp's any-card decks.** In v0.0.6: a deck list on SysOp's practice game, any card the engine implements.
- **Persistence.** Games, seats, owners and results in PostgreSQL now; engine seat tokens stay in the API's memory.
- **Small fix.** PostgreSQL's host port is configurable (`CD_DB_PORT`).

The user also added the logo mid-thread: the full logo on the Play page, and the logo without words as the sidebar mark and the favicon (see [asset provenance](asset-provenance.csv)).

One change from [the v0.0.6 plan](plans/0.0.6.md): the plan offered SysOp's inspection for its own games only. SysOp's standing decision is full access with no exceptions, so SysOp may observe and inspect any running game. Every such opening is audited.

## How a game runs

```
browser ──HTTPS──▶ API ──service token + seat token──▶ engine (XMage)
   ▲                │
   └──WebSocket─────┘  views come back from the engine unchanged
```

1. **Start.** `POST /api/v1/practice-games` (needs `games.play` and the CSRF token). The API checks the table, the decks and the limits, then asks the engine for a service game with the account's seat first and the bots after it.
2. **Record.** The engine returns the game ID and the human seat's token, once. The API stores the game and its seats (owner account, bot, deck) in PostgreSQL. It keeps the seat token only in its own memory, and returns the game's summary. The browser never receives a seat token.
3. **Follow.** For each game, one task long-polls the owner's seat view in the engine and publishes every new revision to the game's WebSockets. When the game finishes, it records the result.
4. **Play.** The seat's owner opens the game's WebSocket, takes the controller lease and sends commands. The API checks the session, the lease and the command's schema, then forwards the command with the seat token.

Views and prompts come back from the engine unchanged, so the engine's leak rules ([the human seat](engine/human-seat.md), [Commander tables](engine/commander-tables.md)) still decide what a seat sees. The API adds nothing to a snapshot, and no payload it sends carries a seat token or the service token. The tests check this for every message.

### Human tables (v0.4.0)

A table's game ([human tables](tables.md)) seats every player of the table in one engine game. The API keeps one token per player's seat and follows each seat with its own task. Each seat's views go only to that seat's connections; an observer (SysOp) sees the first player's seat. Each seat has its own controller lease and its own concession. The game's kind is `table`, and every player's seat records its account, so wins and tokens count as for any game. The engine closes a table's game after an hour with nothing happening, not 15 minutes.

### Practice games

```json
POST /api/v1/practice-games
{"format": "commander", "deck": "commander-mono-red-raiders",
 "bots": [{}, {"deck": "commander-mono-blue-flyers"}, {}], "bot_skill": 4, "turn_cap": 60}
```

| Field | Meaning |
| --- | --- |
| `format` | `legacy` (one bot, the default) or `commander` (one to three bots, three by default) |
| `deck` | Your fixture deck. Without one, the engine picks the format's first unused fixture |
| `deck_id` | Since v0.2.0: one of your own decks instead ([decks](decks.md#at-the-practice-table)). The API stores a revision of it and sends the engine its main deck and commanders |
| `deck_list` | SysOp only (`cards.any`): a deck list as text, below |
| `bots` | One entry per bot, in turn order, each with an optional `deck`, `deck_id` (one of your decks) or (SysOp) `deck_list` |
| `bot_skill` | XMage's AI skill, 1–6 (default 4) |
| `turn_cap` | 1–200 turns (default 60) |
| `rules` | Since v0.4.5: which cards the game's own decks may hold, `{"banned": bool, "not_legal": bool}`, as at a human table ([the table's rules](tables.md#the-tables-rules-v045)). Both true, casual, by default. The bots' starter and fixture decks, and SysOp's deck lists, are not checked |

The account sits in seat 0. `GET /api/v1/practice-games/options` lists the formats, bot counts and fixture decks, whether the account may use deck lists, and (`own_decks`) whether it may play its own decks.

The engine checks no deck's legality in its format. Players' own decks and the bots' starter decks reach it as deck lists, which it loads without XMage's deck validator; only its own fixture decks, named by `deck`, pass XMage's Legacy or Commander validator as they load. So the table's rules (v0.4.5) are the API's alone, and a casual deck plays as any other.

Refusals:
- 401 signed out; 403 without `games.play`, or a deck list without `cards.any`; 403 `csrf_failed` without the token.
- 409 `game_limit` while the account already runs `CD_GAMES_PER_ACCOUNT` games (default 1). SysOp has no per-account limit.
- 422 for a bad table, a deck of the wrong format, a seat with both a deck and a deck list, a malformed deck list (`invalid_deck_list` with the line), or unknown card names (`unknown_cards`, with the names in `names`). For an own deck: `invalid_deck` when it is not one of yours or not of the format, `deck_not_playable` until it is legal and every card is playable, and since v0.4.5 `deck_not_allowed` when it holds cards the game's `rules` do not allow, named in the message. SysOp's decks need only cards the engine implements. Since v0.4.0, a deck holding Godlike custom cards the running engine has not loaded gets `custom_not_loaded` (their names in `names`), and a bot seat holding one gets `custom_cards_for_bots` ([progression](progression.md#playing-them-v040)).
- 429 `games_busy` with `Retry-After: 30` when the API runs `CD_GAMES_MAX` games (default 2) or the engine is full (`CD_ENGINE_MAX_GAMES`). Games still being created count toward `CD_GAMES_MAX`, so requests at the same moment cannot all pass the check.
- 503 `games_unavailable` without a service token; 503 `engine_unavailable` when the engine does not answer.

### Reading and ending games

| Request | Who | Returns |
| --- | --- | --- |
| `GET /api/v1/games` | Any player | Your games, newest first (50). SysOp may pass `scope=all` for everyone's |
| `GET /api/v1/games/{id}` | The seat's owner; SysOp | The summary, and the owner's current seat snapshot while the engine holds the game |
| `POST /api/v1/games/{id}/close` | The seat's owner; SysOp | Ends the game for every seat (result `closed`). The reply waits up to 5 seconds for the result to be recorded, so it shows the game finished. A game no task follows any more (left active by an earlier process) is marked `interrupted` and closed in the engine. A table's running game goes on for its other players: its players get 409 `table_game` and concede instead; SysOp may close it |
| `GET /api/v1/games/{id}/inspection` | SysOp (`games.view_concealed`) | The inspection view, below |
| `GET /api/v1/engine/cards?q=` | SysOp (`cards.any`) | Up to 50 card names the engine implements, for deck lists. It was `GET /api/v1/cards` until v0.2.0, which gave that path to [the card catalog](catalog.md#search-deck03-deck04) |

Any other account gets 404 for someone else's game, exactly as for a game that does not exist (T29's match case). A summary shows each seat's player and owner's handle, and since v0.3.1 the owner's allied Planeswalker (`portrait`), whose portrait stands for them at the table. A seat's deck is shown only to that seat's owner, and to SysOp. Since v0.4.0 a summary also gives the game's `kind` (`practice` or `table`), each seat's `left` (`conceded`, `removed` or `eliminated` while the game went on), and `tokens`, what the finished game paid you.

The account's running games, for `CD_GAMES_PER_ACCOUNT`, are the active games where its seat is still in play (since v0.4.0): a seat out of a table's game that goes on no longer counts.

Since v0.3.1 the transaction that records a finished game also counts its win, when a player's seat won it: one entry in the progression ledger, never two ([the Planeswalker Alliance](progression.md#wins-and-levels)).

## The WebSocket

`wss://<site>/api/v1/games/{id}/events`, authenticated by the session cookie. The web proxy passes the upgrade through.

**Opening.**
1. The handshake's `Origin` must be the site's own, as for any state-changing request. Browsers always send one.
2. The first message must arrive within 10 seconds and carry the session's CSRF token, which only the site's own pages can read from `/api/v1/me`:

   ```json
   {"type": "hello", "csrf_token": "…", "since": -1, "control": true, "inspect": false}
   ```

   - `since` is the last revision the client holds (-1 for none); the server sends a newer snapshot.
   - `control` asks for the controller lease.
   - `inspect` asks for SysOp's inspection views.
3. The server answers `welcome` with the connection's ID, the seat (null for an observer who does not own it) and whether another tab controls the seat. Then come the lease, if one was granted, the current snapshot and, for SysOp, an inspection.

**Refusals.** The server sends `{"type": "error", "code": …}` and closes, at the handshake and when it later closes an open connection because of its session:

| Close code | Error code | Meaning |
| --- | --- | --- |
| 4401 | `authentication_required` | No valid session. Also sent before an open connection is closed because its session was signed out, revoked or expired |
| 4401 | `session_refresh` | The account's roles changed, or an HTTP request rotated the cookie this connection opened with. That includes a connection opened with the old cookie during the rotation grace, once the grace has run out. Make any HTTP request (it rotates the cookie), then reconnect; an unanswered command is resent once control is taken again |
| 4403 | `origin_refused`, `csrf_failed`, `forbidden` | Another site; a wrong CSRF token; no `games.play`, or `inspect` without SysOp's permission |
| 4404 | `not_found` | Not your game, or no such game |
| 4410 | `game_not_live` | The API no longer follows the game (finished long ago, or interrupted); read it over HTTP |
| 4429 | `too_many_connections` | The account already holds 4 connections to this game, or the game holds 8 for each player's seat. SysOp's connections are not counted. Close a tab; the page retries with backoff |
| 4400 | `hello_required` | The first message was not a valid hello |
| 4408 | (none) | The client stopped reading. Reconnect and resynchronize |

**Messages from the client.**

| Message | Effect |
| --- | --- |
| `{"type": "command", "command": {…}}` | A command in the engine's envelope (`v`, `game_id`, `action_id`, `expected_revision`, `prompt_id`, `type`, `payload`): `submit_choice`, `concede`, or since v0.2.0 `set_priority` with no `prompt_id` ([priority controls](engine/human-seat.md#priority-controls)). Controller only |
| `{"type": "take_control"}` | Moves the lease to this connection (owner only) |
| `{"type": "release_control"}` | Gives the lease up |
| `{"type": "resync", "since": n}` | Sends the current snapshot if it is newer than `n`. New connections, resyncs and `GET /api/v1/games/{id}` share one engine view per revision, so they cost the engine nothing more |
| `{"type": "vote", "seat": n, "remove": true}` | Since v0.4.0, at a table: a player's vote on removing the away player in seat `n` (`false` votes to keep waiting). Any tab of a player still in the game may vote; the session is checked as for a command. Refusals come as `error` with the `seat` and a `message`: `not_a_player`, `invalid_vote`, `not_in_game`, `not_removable` (not away for 2 minutes), `removal_failed` |
| `{"type": "chat"}`, `{"type": "emote"}`, `{"type": "alliance"}` | Since v0.4.4, at a table: the table's chat and its alliances ([chat](chat.md#on-the-games-websocket)). The session is checked as for a command |
| `{"type": "ping"}` | Answered with `pong` |

**Messages from the server.**

| Message | Contents |
| --- | --- |
| `snapshot` | The seat's engine snapshot, unchanged ([seat-view contract](../contracts/engine-seat-view.schema.json)). Each new revision carries only the log lines since the last one, with their indexes; the first snapshot carries the latest page. Older revisions than one already sent are never sent |
| `command_result` | `action_id`, the engine's HTTP `status` and `body`, unchanged: `accepted` with the new revision, or a refusal such as `stale_prompt`, `stale_revision`, `invalid_option` or `game_over`. The API's own refusals are `not_controller` (409), `invalid_command` (400) and `engine_unavailable` (503) |
| `lease` | `role` (`controller` or `observer`), `controlled` (whether any tab holds the lease) and `reason`: `granted`, `taken_over`, `released` or `disconnected` |
| `inspection` | SysOp's inspection view, after each new revision, only to connections that asked to inspect |
| `presence` | Since v0.4.0, at a table only: `away_after` (120 seconds) and, for each player's seat, `connected`, `away_seconds` (since no tab of theirs has been connected), `left`, `removable`, the seats that voted `yes` and `no`, and the yes votes `needed`. Sent to every connection when it changes, when a seat has been away long enough to be voted on, and after the welcome |
| `chat_history`, `chat`, `alliances` | Since v0.4.4, at a table only: the table's chat and its alliances, each line only to the connections that may see it ([chat](chat.md#on-the-games-websocket)) |
| `interrupted` | The engine lost the game |
| `welcome`, `pong`, `error` | As above |

### The controller lease (AUTH07)

- **One controller.** Only the connection holding a seat's lease may command it. Every other connection of the same account observes. It receives every snapshot, and its commands get 409 `not_controller`.
- **Taking control.** Taking control moves the lease at once. The old controller receives `lease` with `reason: taken_over`, and its next command is refused. A command already forwarded completes.
- **Leaving.** A controller that disconnects frees the lease. Another tab, or the same one after reconnecting, takes it with `take_control` or `"control": true`.
- **Other accounts.** Only the seat's owner can take its lease. SysOp observes other players' games but cannot command their seats.

### Resends run once (T14)

The engine remembers each seat's last 512 action IDs with their results. A command resent with the same `action_id` and content returns its first result and changes nothing; with different content it is refused as `action_id_reused`. So a client whose connection drops before the reply arrives reconnects, takes control again and resends the same command. It then learns the result without applying it twice. The API forwards resends unchanged.

### Sessions

Every command checks that the session still stands, and counts as activity for its idle limit. An open connection alone does not extend the session. The server also rechecks the session every minute. It sends the error code, then closes with 4401:
- **`authentication_required`** when the session has ended: a sign-out everywhere, a revoked session, an expired one, or a SysOp session off its network.
- **`session_refresh`** when the session is due for rotation after a role change, or when an HTTP request has rotated the cookie since the handshake. A rotation is not a sign-out. Whether the cookie was rotated is always judged from the session behind the connection's own cookie, so this also covers a connection opened with the old cookie during the rotation grace ([identity](identity.md#sessions-auth03)). A command stopped by the check goes nowhere.

The page then asks `/api/v1/me`, which rotates the cookie, and reconnects at once the first time after a welcome; any later refresh waits out the backoff. A token rotated in the last 60 seconds stands for its successor and is never rotated again, so the server may keep answering `session_refresh` for up to a minute.

## SysOp's powers

- **Practice games against bots.** As for any player, without a per-account limit.
- **Inspection** (`games.view_concealed`, SysOp's exception to SEC05 and NET14). The inspection view shows the public view, every seat's deck, and every player's hand and library in order, top first.
  - **A type of its own.** It is a separate engine view type ([inspection contract](../contracts/engine-inspection.schema.json)), built field by field like the seat views, and served only on the engine's service route.
  - **When it is built.** The engine builds it only while XMage waits for a human seat's answer. The game thread is then parked, and an answer cannot close the prompt until the view is built, so XMage's state holds still. Otherwise the engine waits up to 3 seconds for that moment, then answers `unsettled` (409). A finished game keeps its final inspection.
  - **Where SysOp gets it.** With `"inspect": true` on the WebSocket, or from `GET /api/v1/games/{id}/inspection`.
  - **Audit.** Every opening is audited as `game.inspection_opened`. Observing another player's game is `game.observed`, and closing it `game.closed`.
- **Any card** (`cards.any`). A practice game's `deck_list` may name any card the engine implements, in any number, for SysOp's seat or a bot's.
  - **The text.** One card per line: an optional count (`4`, `4x`), then the name. `#` and `//` lines are comments. Deck sites' set annotations (`Lightning Bolt (M10) 146`) are ignored. A `Commander` heading or a `Commander: Name` line names the commander, and a `Sideboard` heading skips what follows.
  - **Names.** They match exactly first, then ignoring case, to XMage's preferred printing. Unknown names come back together in `names`.
  - **No format rules.** Nothing is checked beyond the shape: a Commander list names one or two commanders, at most 250 different cards, 250 copies of one card and 1,000 cards in all.
  - **Audit.** Using deck lists is audited as `game.deck_lists_used`.

## The engine's service routes

The engine serves the API's games under `/v1/service`, only when `CD_ENGINE_SERVICE_TOKEN` is set (at least 32 characters, the same value for the API and the engine). Every request there must carry the token in `X-Service-Token`. Without it, everything under the prefix answers 401 `service_unauthorized`.

| Route | Purpose |
| --- | --- |
| `POST /v1/service/games` | As the development `POST /v1/games`, with deck lists allowed and a 64 KiB body limit. Unknown card names return 400 `unknown_cards` |
| `GET` and `POST` under `/v1/service/games/{id}/` (`view`, `commands`) | As the development routes; the seat token still selects the seat |
| `POST /v1/service/games/{id}/close` | Ends the game; the service token alone suffices |
| `GET /v1/service/games/{id}/inspection` | The inspection view; `wait_ms` up to 30 000 |
| `GET /v1/service/cards?q=&limit=` | Card names containing `q`, ignoring case: names starting with it first |
| `GET /v1/service/implementations` | Since v0.2.0: every card the engine implements, with its gates, gzip-compressed, for [the catalog](catalog.md#the-engines-implementation-list) |

Service games and development games share one registry and the engine's game cap, but each belongs to its own route. A token or game ID from one route finds nothing on the other, and development games cannot be inspected. The development endpoints stay for scripts (`CD_ENGINE_DEV_ENDPOINTS`). The engine's `/health` reports `service_games_enabled`, which says only whether the service routes are on. Since v0.1.1 it also reports `gameplay_available: true` when the engine is ready (its card database is open) and its service routes serve the API's players' games. It is false while the engine loads, after a failed load, and on an engine without service games. The API passes the value through at `/api/v1/engine/status`.

## Data and restarts

Migration `0003_games` adds two tables:
- **`games`.** The engine's game ID, kind (`practice`), format, status (`active`, `finished` or `interrupted`), creator, bot skill, turn cap, times and the engine's result: kind, winner seat, draw, turns and conceded seats. Engine error details stay in the engine's log.
- **`game_seats`.** Each seat's player (`human` or `bot`), owner account and deck: a fixture name, or `custom` with the deck list as sent to the engine. A check constraint ties owners to human seats.

Migration `0006_decks` (v0.2.0) adds the deck revision to each seat played with an own deck, and the catalog revision and format version to each game.

Migration `0009_tables` (v0.4.0) adds the human tables and their seats, the `table` kind of game, and when and why a seat left a game that went on ([human tables](tables.md#data)).

One API process holds the running games. When it starts, every game still `active` in the database is marked `interrupted` and closed in the engine, because the seat tokens died with the old process. When the engine loses a game (a restart), the API marks it `interrupted` and tells its connections. A finished game stays followable for 10 minutes, then the API forgets its token. Recovery and replay journals (NET08–NET09) remain later work.

A short database outage cannot leave a game active and its owner blocked (since v0.1.1):
- **At startup.** If the database cannot be reached, the check for active games retries in the background, waiting 1 second and doubling up to 30. It spares the games this process started meanwhile.
- **A game's end.** Recording it retries the same way until it lands. Until then the game counts against its owner's limit.

## Configuration

| Key | Default / purpose |
| --- | --- |
| `CD_ENGINE_SERVICE_TOKEN` | Empty: games are off. API and engine; at least 32 characters. Generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"` and put it in `.env` |
| `CD_GAMES_PER_ACCOUNT` | 1 (1–8); SysOp is not limited |
| `CD_GAMES_MAX` | 2 (1–64 since v0.4.1): games the API runs at once |
| `CD_BOT_DECKS` | `starters` (v0.3.1): Commander bots with no deck chosen play the ten starter decks, a different one each. `fixtures` keeps them on the engine's fixture decks, as CI's browser game journeys need |
| `CD_CONTENT_DIR` | `content` (v0.3.1): the Planeswalker roster and the starter decks; the API image holds a copy in `/app/content` |
| `CD_DB_PORT` | Compose only: PostgreSQL's host port, default 5432. Set another (this computer uses 15432) when Windows reserves 5432 |

## Verification

- **API tests (`tests/test_games.py`).** These run against a fake engine that speaks the service routes.
  - **Ownership and T29.** Another account gets 404 for the game, its WebSocket and its close, and 403 for its inspection.
  - **The lease.** An observer's command is refused; a takeover moves the lease and the old tab is refused.
  - **T14.** A resend returns the first result and applies nothing, including after the tab dropped before reading its reply.
  - **Refusals.** Another origin, no session, a wrong CSRF token, no hello, and inspection by a player. Signing out everywhere ends a connection at its next command.
  - **Results and restarts.** A concession and a close are recorded, and a restart interrupts running games.
  - **SysOp.** Deck lists with unknown names, observing and inspecting another player's game, the audit entries, and SysOp's missing per-account limit.
  - **Limits and parsing.** The global limit, games off without a token, the fixture decks against `engine/decks`, and the deck-list parser.
  - **Leaks.** No payload carries a seat token or the service token. Only connections that asked to inspect receive inspection views.
  - **Since v0.1.1:**
    - Connection limits: 4 per account per game, 8 per game, SysOp's not counted. Connections and resyncs share one engine view per revision.
    - `session_refresh` mid-game in four cases: at a command, at the session check, after an HTTP rotation, and on a connection opened during the rotation grace with the pre-rotation cookie. `authentication_required` once the session ends with a sign-out everywhere.
    - The close reply shows the recorded end, also when the engine answers `closing`. Close interrupts a game nothing follows, and closes it in the engine.
    - A failed write of a game's end is retried. A startup check that cannot reach the database retries, and spares games started since. Games created at the same moment keep to `CD_GAMES_MAX`.
- **Engine tests (`ServiceGameHttpTest`).**
  - The service token guards every route, and a short token is refused at startup.
  - The two routes keep their games apart.
  - Deck lists take any card in any case and number, and name unknown cards; a custom commander reaches the command zone.
  - The inspection matches XMage's hands and libraries, in order and object by object, at several prompts and after the end.
  - Card names can be looked up.
- **The scripted client (`scripts/api_practice_game.py`).** It plays a whole game through the API and its WebSocket as SysOp, checking every snapshot for leaks and against the seat-view contract and every inspection against its contract. Along the way it proves the observer refusal, the lease takeover and a resend after a dropped connection. It also checks that inspection views reach only the tab that asked for them, and reads what the observer tab was sent before closing it. CI runs a Legacy and a Commander game with it.

Results are in [the release notes](releases/0.0.6.md) and [verification](verification.md#v006).

## Not in v0.0.6

- The game interface (v0.1.0).
- Lobbies, matchmaking, human opponents through the API, spectators through the API, timers and recovery journals.
- The AI hidden-information audit (AI02): the bots still search a copy of the full game.
