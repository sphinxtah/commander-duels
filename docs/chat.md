# Chat between friends and at the table (v0.4.4)

Since v0.4.4 friends write to each other while the app is open, and the players at a human table talk to the whole table or, once they have made an alliance, to their allies alone. Since v0.5.1 friends' conversations live on a chat bar along the bottom of every page, with the friends list, instead of a Messages page. The owner's decisions are in [the v0.4.4 plan](plans/0.4.4.md#decisions-at-the-start-of-v044). The API is `api/chat.py` (friends) and `api/table_chat.py` (tables); the web app's parts are `web/src/chat/` and the table's chat panel in `web/src/game/`.

## Decisions

Agreed with the owner on 2026-10-22, at the start of v0.4.4:
- **Allies are agreed during the game.** A player offers an alliance from another player's portrait; it starts when they accept, and either may end it at any time. Everyone sees who is allied with whom; only the allies read their messages.
- **Friends' chat lives on a Messages page and in small windows** docked at the bottom right that stay open from page to page. New messages count on the bell and pop up beside it. (Replaced by the chat bar in v0.5.1, below.)
- **Administrators read a message only when a player reports it**, with the 20 messages before it in that chat that the reporter saw.
- **Quick emotes at the table.** No mute, word filter, or typing and seen marks in this version.

Defaults stated at the start, which the owner did not change:
- Chat is between friends only; a block, or a friendship that ends, stops new messages.
- Messages reach open tabs at once, over a connection the app keeps open.
- SysOp reads every chat, allies-only messages at the tables it watches included, as its standing full access says ([SysOp](identity.md#sysop-the-local-root-account)). Every reading through its reader is audited.
- Bots never read or send chat. Practice games, which seat one player against bots, have none.
- A player out of the game (conceded, removed or eliminated) still reads and writes the table's chat, as the scope asks (NET13).
- Friends' messages are kept a year; a table's chat 30 days.

Asked by the owner on 2026-10-23, during v0.5.1, with a screenshot of a docked window on a player's profile:
- **The chat bar replaces the Messages page.** "Messages should always appear on the bottom bar … and not in an actual messages page." The conversations stay on a bar along the bottom of every page, beside a friends list that shows who is online and opens (or reopens) each friend's conversation. Each conversation can be closed, and opened again from the list. Nothing needed changing in the API.
- **The friends list folds, and the bar is everywhere, games included** (later the same day): "The Friends on the bottom bar should also be able to be collapsed, and the chat bar should be available everywhere in the app, including during games." The list folds to its title bar and unfolds again, as the browser remembers; at the table the bar folds away into a diamond on the band and comes out on demand, so it covers nothing of the table ([the game screen](game-screen.md#friends-chat-at-the-table-v051)).

## Friends' messages

- **Who.** Two players write to each other while they are friends ([friends](social.md#friends)). Once the friendship ends, or either blocks the other, neither may write (`409 not_friends`); what was written stays readable to both, and the conversation says why the box is closed.
- **Where: the chat bar (v0.5.1).** Along the bottom of every page of the app (`web/src/chat/ChatBar.tsx`), a landmark named "Friends and messages"; at the table, folded away into the band's diamond (below):
  - **The friends list**, at the bar's right end. Its title bar, "Friends · 3 online" with the count of unread messages (the count the top bar's Messages icon showed until v0.5.1), opens and folds it, as a window's does, and Escape in it folds it too. It stays as the player left it, open or folded, from page to page and when the page reloads (the browser remembers it); a click elsewhere leaves it be. It lists the friends with their portraits and presence (in a game or a queue, online, idle, offline, then those who share nothing, by handle within each; the same rules and privacy as everywhere, [presence](social.md#presence)), each with their unread messages. Players who are no longer friends (a friendship ended, or a block) whose conversations remain are listed under **Earlier conversations**, so their history stays readable. At its foot, a link to the Friends page, saying how many friend requests wait there. The friends are asked for again every 30 seconds while the tab is shown, as the Friends page does (`GET /api/v1/friends`); the unread counts when the list opens and, while it is open, whenever the socket tells of a message or a read mark (`GET /api/v1/conversations`).
  - **The conversations.** A click on a player in the list opens their conversation in a window docked on the bar, beside the list, or opens it again after it was closed; so do **Message** on a friend's profile and on the Friends page, the bell's notification of new messages, and a message's pop-up. Focus moves into the window that opens: to the box to write in, or to the messages when the two are no longer friends. Each window can be folded to its title bar (a tab on the bar, counting what is unread) or closed; closing one gives focus back to the list's title bar. Up to three stay open, as many side by side as the screen has room for (three from 1,240 px wide, two from 930 px, else one); the others wait their turn and come back, the newest first, as the screen widens or when opened again. They stay open as the player moves between pages and when the page reloads (the browser remembers which, never what was written). The window's history loads a page of 50 at a time ("Show older messages"), and its title bar shows the presence the list last saw.
  - **On a phone** (narrower than 820 px, as for the bar of pages) the bar is one round button above the bar of pages, with the unread count; it opens the list across the whole width of the screen. Choosing a player shows their conversation instead, the whole width, alone (the newest of those open); folded, it sits as a tab beside the button.
  - **At the table** (every game: practice, human tables, the queues' games, matches, SysOp observing) the bar folds away into a **Friends and messages** diamond on the band, with the unread count, so it covers nothing of the table; each game starts so. The diamond brings it out over the table's lower right, below the band, with focus in it, and puts it away; so does Escape anywhere in it. Folded away it asks the API for nothing, and each new message is said to screen readers from the bar, since the table has no bell; its pop-up waits for the pages. At the table nothing in the bar leads to another page, and the table's keys (P, F, T, Space, Escape) leave alone every key pressed in it. The game's own table chat stays in its drawer, as before ([the game screen](game-screen.md#friends-chat-at-the-table-v051)).
  - **The Messages page's old addresses.** `#messages/<player id>` opens that player's window, and `#messages` the friends list, over the page the player was on (an address opened afresh shows the main menu under it); before sign-in, the address waits as any does.
- **Sending.** Enter sends, Shift+Enter starts a new line. A message is at most 500 characters and 13 lines. A message waits greyed until the server has it; one that fails says so, with **Try again**, which sends it under the same `client_id`, so it lands once.
- **Read.** A conversation shown in a window on the bar, unfolded (on a phone not under the friends list, and at the table only while the bar is out), in a tab in use, is read: the page tells the server up to the newest message it shows. Every tab of the account then shows it read.
- **The bell.** New messages from a friend are one notification while unread, "Ada sent you 3 messages", renewed by each new message so it comes first; it opens the conversation's window. Reading the conversation marks it read. A message that arrives while the app is open pops up beside the bell for 8 seconds unless its conversation is shown, and screen readers hear the pop-up. One whose conversation is shown is said to screen readers from the bar instead ("ada: …").
- **Reporting.** Each message from the other player has a **Report** in its menu (⋯), which opens a short form: why (optional), and what is sent with it.

### Routes

| Route | What |
| --- | --- |
| `GET /api/v1/conversations` | The account's conversations (100 at most), the latest first: the friend (as a search result: handle, portrait, tier, presence), whether you may still write, the last message and the unread count; and `unread`, in all |
| `GET /api/v1/conversations/{player_id}?limit=&cursor=` | The messages between you and a player, the newest page (50 by default, at most 100), oldest first, with `next` for the older page; `friends` and `unread`. A player never written to has an empty one; another account that is not active, or has no handle, is not found (404) |
| `POST /api/v1/conversations/{player_id}/messages` | `{text, client_id}`: writes to a friend (201, the message). The same `client_id` again answers the message already sent |
| `POST /api/v1/conversations/{player_id}/read` | `{up_to}`: marks their messages up to that time read (all when null), with the bell's notification; answers `{unread}` |

Refusals: 401 signed out, 403 not active or without the CSRF token, `409 handle_required`, `409 own_account`, `409 not_friends`, `422` for text that breaks the rules below, `429 chat_limited` with `Retry-After`.

### The chat's WebSocket

`/api/v1/chat/events` tells each open tab of the app, at once, of new messages and read marks. Like a game's socket ([games](games.md#the-websocket)) it is signed in by the session cookie and refused from another site's origin; its first message must be `{"type": "hello", "csrf_token": "..."}` within 10 seconds. An account holds at most 8 at once (a tab each). The page only listens; it may send `{"type": "ping"}` (answered `pong`) to keep proxies from closing the connection.

| Message | When |
| --- | --- |
| `{"type": "welcome", "unread": 3}` | After the hello: unread messages in all conversations |
| `{"type": "message", "player_id": "...", "player": {...}, "message": {...}, "unread": 4}` | A message stored, to the recipient's tabs and the sender's: `player_id` and `player` (handle, avatar, alliance) are the other player of the conversation, as the tab's account sees it, and `unread` that account's new total |
| `{"type": "read", "player_id": "...", "unread": 0}` | The account read a conversation, in any of its tabs |
| `{"type": "error", "code": "..."}` | Before a close: as for a game's socket (`authentication_required`, `session_refresh`, `csrf_failed`, `origin_refused`, `too_many_connections`, `hello_required`) |

The connection closes when the session ends, is revoked or expires, as a game's does. The page reconnects with backoff and, each time it connects, reloads the conversations it shows, since nothing is resent. The presence check-in also carries `messages_unread` ([presence](social.md#presence)), so the count stays right while the socket is down.

## The table's chat

At a human table's game ([human tables](tables.md)) the band has a chat diamond, **Table chat**, with the count of lines not read yet; it opens the chat as a drawer at the right of the table, like the log, and Escape folds it again (`web/src/game/table/TableChat.tsx`). The drawer has two tabs, **Table** and **Allies**, each with its messages and its own unread count; under the Table tab, a row of the emotes; and the alliances, with a button for each thing the player may do. New lines from others are spoken through the table's polite announcer, folded or not. A practice game has no diamond, drawer or alliance controls.

- **The table.** Every player of the game writes to all of them, in text or with an emote: Hello!, Good luck, have fun!, Your turn., Thinking…, Nice play!, Thanks!, Oops!, Sorry!, Good game!. SysOp watching the game writes there too, shown as watching.
- **Alliances.** Each other player's plate has an **Alliance** menu (named "Alliance with <handle>"), as the drawer's list does: **Offer an alliance** sends an offer only the two see ("Offer sent", "Offers alliance" on the plates); the other player accepts or declines it, or offers one back, which is accepting. Either may then **End the alliance** at any time. The table's chat says when an alliance starts or ends, and each plate shows its player's allies ("Ally", "Allied with …"). A player out of the game makes no alliance, and leaving the game ends theirs. Bots, SysOp watching, and a finished game make none.
- **Allies only.** A player with allies may write to them alone, on the Allies tab: the message goes to the sender's allies at that moment and to no other player's connection, like a hand. Each such line shows whom it went to ("bob to you and cara").
- **Writing.** Enter sends, Shift+Enter starts a new line; each tab keeps its own draft. A line waits greyed until the server sends it back; one refused says why, with **Try again** (the same `client_id`) and **Discard**. A line sent just before the connection dropped, and missing from the history the reconnected tab is sent, is marked as not sent.
- **History.** A tab that connects (or reconnects) is sent the latest 200 lines it may see, then each new one.
- **Reporting.** As for friends' messages, from a line's menu; the report keeps the 20 lines before it that the reporter saw.

### The team's channel (v0.5.1)

The owner's decision at the start of v0.5.1 ([plan](plans/0.5.1.md#decisions-at-the-start-of-v051)): at a Two-Headed Giant table ([tables](tables.md#two-headed-giant-v051)) the allies-only channel is the team's, fixed (FMT10's team chat).

- **Fixed from the start.** A team of two players is allied when the game starts, for the whole game, whoever concedes or is removed. No alliance can be offered, accepted or ended (`fixed_teams`), and the plates show no alliance and no Alliance button: they name the teammate already ([the game screen](game-screen.md)).
- **The Team tab.** The drawer's Allies tab is called **Team**; its box says "Message to your team" and "Only bob will read it". Where the alliances would be, the panel says "You and bob: only the two of you read the Team tab, never the other team." A player whose teammate is a bot has nobody to write to there ("Your teammate is a bot, so nobody reads this tab."; the server answers `no_allies` with the same reason).
- **The other team never reads it.** A team line goes to its sender's teammate's connections and to SysOp's (watching, or inspecting), and to no connection of the other team, live or in the history a tab is sent. The table's own lines and emotes reach everyone, as at any table. SysOp's reader keeps every line, team lines included.

At a four-player Commander table, the Alliance button on a plate stands left of the plate's count diamonds since v0.5.1, where it no longer covers them.

### On the game's WebSocket

Sent by the page:

| Message | Meaning |
| --- | --- |
| `{"type": "chat", "channel": "table" or "allies", "text": "...", "client_id": "..."}` | A message to the table, or to the sender's allies |
| `{"type": "emote", "emote": "good_game", "client_id": "..."}` | An emote, to the table: `hello`, `good_luck`, `your_turn`, `thinking`, `nice_play`, `thanks`, `oops`, `sorry`, `good_game` |
| `{"type": "alliance", "action": "offer", "seat": 2}` | `offer`, `accept` (their offer), `decline` (their offer), `withdraw` (your offer) or `end`, with the other player's seat |

Sent by the API, to a table's connections only:

| Message | Meaning |
| --- | --- |
| `{"type": "chat_history", "messages": [line, ...]}` | On connecting: the latest lines the connection may see, oldest first |
| `{"type": "chat", "message": line}` | A new line the connection may see |
| `{"type": "alliances", "alliances": [[0, 1]], "offers": [{"from": 0, "to": 2}], "fixed": false}` | On connecting and after every change: every alliance (pairs of seats), and the offers its own seat made or received; since v0.5.1 `fixed`, true at a Two-Headed Giant table, whose alliances are its teams of two players |
| `{"type": "error", "code": "...", "message": "...", "client_id": "...", "seat": 2}` | A refusal: `no_chat` (a practice game), `invalid_message` (text that breaks the rules, an unknown emote), `chat_limited` (with `retry_after` in seconds), `no_allies`; for alliances `not_a_player`, `not_in_game`, `invalid_alliance` (no such player, yourself, or a bot), `already_allied`, `no_offer`, `not_allied`, and since v0.5.1 `fixed_teams` (a Two-Headed Giant table) |

A line: `{"id", "channel": "table" or "allies", "kind": "text", "emote" or "event", "seat" (the sender's; null for SysOp watching), "sender": {"id", "handle"} or null, "body", "seats", "client_id", "created_at"}`. For a text, `body` is the text; for an emote, its name; for an event, `allied` or `alliance_ended`, with `seats` the two allies and `sender` and `seat` whoever ended it (null when leaving the game ended it). An allies-only line's `seats` are those it went to besides the sender.

Who receives a line: every connection of the game for the table's; for an allies-only one, the sender's seat's and its recipients' connections, and SysOp's (watching, or inspecting from its own seat). The API tests read every frame each player's connections receive and check that no allies-only line reaches another player's.

## Rules for the text

- At most 500 characters and 13 lines, trimmed; never empty.
- No control characters except line breaks and tabs (`422`); NUL is refused everywhere.
- Unicode's direction overrides and isolates (U+202A–U+202E, U+2066–U+2069) are dropped, so a message cannot draw itself backwards to pass for someone else's words. Emoji, accents and joiners stay.
- The page shows every message as text, never as HTML or a link (SEC01's chat injection).
- **How fast.** An account sends at most 5 messages in 5 seconds and 30 a minute, friends' messages, table lines and emotes together (`429 chat_limited`, or the socket's error, with the seconds to wait). The counts live in the API process's memory. SysOp has no limit.

## Reports of a message

`POST /api/v1/reports` takes `message: {"kind": "direct" or "table", "id": "..."}` beside the usual fields ([reports](reports.md)). The API copies the reported message, and the 20 messages before it in that chat that the reporter saw, into the report (`chat`), with who sent it (`reported_user`). Only a message the reporter received or saw may be reported (another's is not found, `404`), never one's own (`409 own_message`) or an alliance's event (`409 not_reportable`). Reports count against the 20 a day as any report.

Administrators and SysOp read the copy in Administration → Reports, the reported message marked. The copy stays with the report, whatever later becomes of the messages or the account; deleting the reporter's account deletes their reports, as before.

## SysOp's reader

`chat.read_all`, SysOp's alone. Administration → **Chats** lists the latest conversations and table chats, or one player's, with their players and how many messages they hold; listing reads no message. Opening one shows its messages (the newest 1,000), allies-only lines included, and records `chat.conversation_read` or `chat.table_read` in the audit trail, with the conversation's players or the game. `GET /api/v1/admin/chats?player_id=`, `GET /api/v1/admin/chats/conversations/{id}`, `GET /api/v1/admin/chats/games/{game_id}`.

## Kept, and removed

- Friends' messages 365 days, and their conversation once it has none left; a table's lines 30 days (a game lasts hours). The worker's daily job removes them, with the requests never approved ([accounts](identity.md)).
- Deleting an account removes its conversations, with both sides' messages, and its own lines in tables' chats ([deleting an account](social.md#deleting-an-account)). Resetting one (v0.4.5) keeps them ([resetting an account](identity.md#resetting-an-account-v045)).
- Alliances live only with the running game, in the API's memory.
- The [privacy policy](../web/public/pages/privacy.html) says all of this to players, and the [terms](../web/public/pages/terms.html) say what may not be written.

## The data

Migration `0017_chat`: `conversations` (one row a pair, `user_low` the lower ID, with each side's read mark), `direct_messages` (with the sender's `client_id`, unique per sender), `table_messages` (game, sender, seat, channel, kind, body, seats), the notification kind `message`, and on `problem_reports` the reported message's copy (`chat`) and sender (`reported_user_id`). It only adds, so the previous version runs on it.

## Tests

`tests/test_chat.py` (friends' messages, the socket, reports, SysOp's reader, deletion and the daily job; SQLite, and PostgreSQL when `CD_TEST_POSTGRES_URL` is set), `tests/test_table_chat.py` (the table's chat, alliances and the allies-only leak check on the fake engine of the table tests), `tests/test_team_play.py` (since v0.5.1 the team's channel: the teams as fixed alliances, alliance actions refused, each team's lines in no frame of the other team's connections, live or in a late tab's history, SysOp watching and its reader reading both, and the channel refused beside a bot teammate), `web/src/game/table/TableChat.test.tsx` and `Alliance.test.ts` (the Team tab, the team in words, no alliance on the plates, and the Alliance button's place), the web app's tests in `web/src/chat/` (since v0.5.1 the chat bar and its list, its remembered fold, the room for windows, a phone's one thing at a time, and the bar at the table) and `web/src/game/` (the band's diamond, and the table's keys and P leaving the bar alone), `web/src/App.test.tsx` (the bar on every page, folded away at the table, the old addresses), and the browser journeys `web/e2e/social.spec.ts` (two friends write to each other, the player from the bar's list), `web/e2e/chatbar.spec.ts` (v0.5.1: the bar and its list on Vite's dev server with the API and the socket answered by the journey, at a desktop's and a phone's width, with screenshots), `web/e2e/table.spec.ts` (v0.5.1: on the fake table at every size the bar waits in its diamond and the reach check stays empty; at 1280 × 720 and 1920 × 1080 it comes out below the band, keeps its keys from the table's, and goes away with Escape) and `web/e2e/tables.spec.ts` (the table's chat).
