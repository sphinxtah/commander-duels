# Finding players, friends and notifications (v0.4.3)

Since v0.4.3 players find each other with a search in the top bar, open each other's profiles, become friends, see what their friends are doing, and hear of it through a notification bell. The owner's decisions are in [the v0.4.3 plan](plans/0.4.3.md#decisions-at-the-start-of-v043). The API is `api/social.py`; the web app's part is `web/src/social/`. Since v0.4.4 friends write to each other, and new messages come to the bell too ([chat](chat.md)).

## The player search

- **Where.** A search field in the middle of the top bar, on every page of the app (`PlayerSearch.tsx`). On a phone it takes its own row under the status line.
- **By handle.** A handle matches in part, case aside, as it is typed: two letters at least, a moment (300 ms) after the last key. The closest come first: the whole handle, then handles that start with the text, then the rest, alphabetically; 20 at most. `_` and `%` are only themselves, never wildcards.
- **By email.** Text with an `@` is an email address. It matches only typed in full, case aside, and it is sent only on Enter, so an address typed letter by letter spends no searches. A player may turn this off in their privacy settings (it is on by default, as the owner asked for search by email). No answer ever holds an email address: a result shows the handle, the portrait or avatar, the tier, whether the two are friends, and the presence the searcher may see.
- **Who is found.** Active players who have chosen a handle. Never SysOp, a pending, denied or deleted account, the one searching, or a player who has blocked the one searching.
- **Who may search.** Every active account. An account searches at most 60 times a minute, and by email at most 30 times a day (`429 search_limited`); SysOp has no limit. The counts live in the API process's memory (it runs as one process), so a restart forgets them.
- **A result** opens the player's profile.

`GET /api/v1/players?q=<text>` answers `{players, by_email, unnamed}`.

### A player with no handle yet (v0.5.1)

The owner reported on 2026-10-22 that a whole gmail.com address of an active player found no one. The live data, read with the owner's leave, showed why: the search lists only players with a handle, and that player had none. One tester was approved on 2026-10-22 (UTC) and chose a handle only the next day; another has had none since SysOp reset the account ([resetting an account](identity.md#resetting-an-account-v045)). Neither address held anything else that could miss (dots, capitals, `googlemail.com`), and nobody had blocked anyone.

The owner chose to say so and to let the searcher ask anyway:
- **The search says so.** When an email search finds no player with a handle but finds an active player who allows the search by email and has not chosen a handle yet, the answer's `unnamed` names only that player's ID and what is between the two accounts. The field says "That player hasn't chosen a player name yet", with **Add friend**. Nothing else about them shows, and they still have no profile. A search by handle never finds them.
- **A request that waits.** **Add friend** there (`PUT /api/v1/friends/waiting/{id}`) sends a friend request that waits unseen: no notification, and nothing on the player's side. It counts against the 50 waiting requests. The asker's Friends page lists it under **Waiting for a player name**, as "A player still choosing a name" with the day it was asked, and **Withdraw** (`DELETE /api/v1/friends/waiting/{id}`, also allowed once the player no longer lets the search find them).
- **It reaches them with their handle.** When the player chooses a handle, each request that waited becomes an ordinary request: the bell tells them, in the same commit as the handle, once a day at most per asker, and never from a player they have blocked. The asker sees the player under **Requests you sent**.
- Asking needs the asker's own handle (`409 handle_required`); anyone else (with a handle, not active, not letting the search find them, or having blocked the asker) is not found (`404`).

## Profiles

`#player/<id>` shows any active account with a handle, SysOp's included (the search never lists SysOp, but its notifications link to it): the handle, the portrait or avatar, the tier, the wins, the month the account began, the presence when shared, and what is between the two accounts. On a player's own profile it says so, with a link to Profile. Any other account is not found (`404`, as for a missing one). `GET /api/v1/players/{id}`.

Since v0.5.0 a profile also shows the player's badges (the three they pinned first, then every one earned) and their record: games won, lost and drawn, by format and against bots or players. Their games one by one show only on their own profile and to SysOp ([quests, achievements and statistics](quests.md#statistics-and-the-match-history)).

## Friends

- **Mutual** (the owner's decision). **Add friend** sends a request; the asker sees **Pending** until the other player accepts it, from the bell, the history, Friends or the asker's profile, or adds the asker back, which is the same thing. Either may withdraw or decline a request, or end a friendship (after a confirmation); since v0.5.1 ending one also ends an invitation to the Two-Headed Giant queue either sent the other ([queues](queues.md#two-headed-giant-v051)). `PUT /api/v1/friends/{id}` asks or accepts; `DELETE /api/v1/friends/{id}` withdraws, declines or ends.
- **A request's notification** goes to the other player once a day at most, however often the request is withdrawn and sent again. A request withdrawn stays in their notifications, no longer waiting; a request declined is marked read.
- **Limits.** An account may have 50 requests waiting for others' answers (`429 too_many_requests`); answering a request is never limited. An account needs its handle before it can ask (`409 handle_required`).
- **The Friends page** (`#friends`, in the navigation) lists the requests waiting for your answer, your friends by what they are doing (in a game, online, idle, offline, then those who share nothing), and your requests waiting for theirs. It asks again every 30 seconds while shown. `GET /api/v1/friends`.

## Blocking

A block (from the player's profile, after a confirmation) ends any friendship or request between the two, and since v0.5.1 any invitation to the Two-Headed Giant queue either sent the other, and removes the notifications the blocked player caused. Afterwards the blocked player no longer finds the blocker in the search and never sees their presence; their friend requests wait unseen, with no notification, and are dropped when the block ends. The blocker cannot ask them either until unblocking. Blocked players are listed in the privacy settings on Profile, each with Unblock. `PUT` and `DELETE /api/v1/blocks/{id}`, `GET /api/v1/me/blocks`.

## Presence

- **The states.** In a game (a practice game against bots, or a human table, with its format), since v0.5.0 in a public queue, with its format ("Looking for a Commander game", [queues](queues.md)), online, idle, or offline. Friends in a queue are listed with those in a game.
- **Where it comes from.** Every open tab of the app checks in every 30 seconds (`POST /api/v1/presence`, `presence.ts`), on every screen, the table's too. The check-in says only one thing, about its own player: whether they have left that tab (it is hidden, or untouched for 5 minutes). The server works out the rest: offline after 90 seconds with no check-in from any tab; idle when no tab in use has checked in for 90 seconds; in a game while the account holds a seat in a running game. Nothing the browser says about anyone else is used.
- **Not activity.** Check-ins never keep a session from its idle limit (`identity.BACKGROUND_PATHS`), and they are not among the requests a problem report attaches.
- **Who sees it** (the owner's decisions): friends, by default; every player, when the player chooses "Every player" in their privacy settings. A blocked player never does.
- **Appearing offline** shows the player offline to everyone, friends included, and their friends are not told when they come online. Administrators and SysOp (permission `players.presence`) still see the real state, passively and silently, with a note that the player appears offline; nothing records or tells the player that they looked. The player sees their own real state with the same note.
- **Two tabs at once** count once: the account's row is locked during a check-in, so coming online is announced once.

## Notifications and the bell

- **The bell** sits in the top bar's right-hand corner, on every page of the app, with the count of unread notifications (also in the browser tab's title, with Administration's counts). It opens a bubble with the newest six and, at its bottom, **See all notifications**, the full history (`#notifications`), a page of 20 at a time with "Show older notifications". Opening either marks what it shows read. Escape, a click elsewhere or another page closes the bubble.
- **What it tells** (`NotificationItem.kind`): a friend request (with Accept and Decline while it waits), a request accepted, and a friend coming online. The last goes only to friends online at that moment, and at most once in 30 minutes for the same friend. Since v0.4.4, `message`: new messages from a friend, one notification while unread with their count (`messages`), renewed by each message and read with the conversation; it opens the conversation ([chat](chat.md#friends-messages)). Since v0.5.0, `quest_completed` and `achievement_earned`: a daily quest completed or an achievement earned, with no other player behind it, naming it and what it paid (`award`); the first opens the main menu, the second Profile ([quests](quests.md)). Also since v0.5.0, `rematch`: another player of a table's game offers a rematch. It names the game (`game_id`), opens its result screen, where it is answered, waits (`request_pending`) while the offer stands, and is marked read once the rematch starts or ends ([rematches](queues.md#rematches)).
- **Pop-ups.** A notification that arrives while the app is open pops up beside the bell for 8 seconds, from the check-in's answer (`fresh`: unread notifications newer than the newest the page knew of). Nothing from before the page opened pops up. A message from a friend pops up the moment it arrives, from the chat's own connection, so its notification does not pop up again.
- **Kept** 90 days, and at most the newest 200 per account; older ones go when a new one arrives. The bell alone: no email, no browser notifications.
- `GET /api/v1/notifications?limit=&cursor=`, `POST /api/v1/notifications/read {up_to}`.

## Privacy settings

On Profile, under "Privacy" (`PrivacySettings.tsx`): who sees whether you are online, idle or in a game (your friends, or every player); appear offline; let players find you by your email address; and the players you blocked. Each change saves at once. `GET` and `PATCH /api/v1/me/privacy`. The [privacy policy](../web/public/pages/privacy.html) says all of this to players.

## Deleting an account

Deleting an account ([accounts](../api/accounts.py), `CLEANUPS`) removes its friendships and requests, its blocks either way, and the notifications it received or caused; since v0.4.4 also its conversations and its lines in tables' chats ([chat](chat.md#kept-and-removed)).

Resetting an account (v0.4.5, [resetting an account](identity.md#resetting-an-account-v045)) keeps all of them, and its privacy settings. It clears the handle, so until the player chooses one again the search does not find the account and other players' lists of friends leave it out, as for any account without a handle; the friendships and requests stay and show again with the new handle.

## The data

Migration `0015_friends`: `friendships` (one row a pair, whichever asked: `user_low` is the lower ID; `pending` or `accepted`), `player_blocks`, `notifications`, and on `users` the presence (`presence_at`, `active_at`) and the privacy settings (`presence_visibility`, `appear_offline`, `email_searchable`). Migration `0021_quests_achievements` gives notifications their `subject`, the quest or achievement they name.

## Tests

`tests/test_social.py` (SQLite, and PostgreSQL when `CD_TEST_POSTGRES_URL` is set), `web/src/social/social.test.tsx`, and the browser journey `web/e2e/social.spec.ts`, which CI's engine job runs with SysOp and the test player of the human table's journey: a search, a request, the bell, accepting, presence both ways, and appearing offline seen by SysOp.
