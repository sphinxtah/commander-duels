# Replays and review (v1.0.0)

The third of v1.0.0's features ([the plan](plans/1.0.0.md#3-native-replays-and-review-23), the specification's §23): a game that is over, played back step by step through one seat's eyes, with the reader's own bookmarks and notes, and shared with friends by its player. It is built from [the timeline](timeline.md)'s parts over the game's structured events ([events](engine/events.md)).

**The events are the replay.** Nothing is run again: a bot's decisions are not reproducible, and the events already say what happened. So a replay needs no engine, no recording and no engine build, and an upgrade ends none. The specification's "compatible historical rules execution or a clear incompatibility message" has nothing to be incompatible with.

It is behind the gate `replays` ([the gates](operations.md#the-gates)): off until SysOp stages it, and to be tried at `staff` before it is `on`. The timeline itself has no gate and stays as it is.

## The owner's decisions (2026-11-15)

| # | Question | Decided |
| --- | --- | --- |
| 23 | What a replay shows | **The timeline played step by step, over a scoreboard**: each player's life, hand, library, battlefield and graveyard counts. The board itself is not drawn: the events do not hold it (no tapped state, no power and toughness), and drawing it would need the engine to record far more |
| 24 | Who a replay may be shared with | **Friends only**, picked from the friends list. Nobody receives a replay from a stranger |

## Where it is

- **`#replays`**: the account's replays. *Your games*: the games it played that are over and still have their events, newest first, each with its result, its turns, how many bookmarks and whether a note it holds, and how many friends it is shared with. *Shared with you*: the replays friends shared, each naming its friend. Opened by **Replays** on Your games (`#play/games`).
- **`#replay/<game>`**: the reader's own replay of a game they played. From **Replay** beside Timeline on Your games and in the match history, **Watch the replay** on a game's result, and **Play it back as a replay** on the timeline's page.
- **`#replay/<game>/<player>`**: the replay that player shared with the reader. From the list, and from the bell: "ada shared a replay with you."

Each is offered only where replays are open to the account (`useWorkflow("replays")`), and for as long as the events are kept. The page names the format, the players, the day, how the game ended for the seat it is read through, whose eyes those are, the deck that seat played with its saved version, and the day the replay goes.

## Playback

The replay stands at one step of the game and lists the steps that led to it, the current one last and marked (a frame and a pointer, not only a shade; `aria-current="step"`). **What comes next is not told before it is played.** A step is one of the timeline's lines, with its explanations and its rule links under it; the bookkeeping lines the timeline leaves out by default are left out here too. The list holds the last eighty steps (`WINDOW`); earlier ones are a step back or a turn away.

| Control | What it does | Key |
| --- | --- | --- |
| **Play** / **Pause** | Plays on from the step it stands at; at the end of the game it stops, and reads **Play again**, which starts from the first step | K, or Space outside a button |
| One step back, one step on | | Left, Right |
| Previous turn, next turn | Back goes to the first step of the turn it stands in, then to the turn before | Shift+Left, Shift+Right |
| | The first step, the last | Home, End |
| **Speed** | 0.5×, 1×, 2×, 4× | |
| **Turn** | Every turn with whose it was; choosing one goes to its first step | |
| The slider | Any step | |
| **Find a step** | A card, a player, any word of a step or of what explains it: Next and Previous go from match to match, and the count says which one of how many | Enter for the next |

A step stands 1.4 seconds at 1×, and 0.9 seconds longer for each of up to two explanations under it (`LINE_MS`, `NOTE_MS`). Going anywhere by hand pauses.

The whole game's events are read from the first on, 500 at a time, so playback begins with the first page while the rest arrives; the line under the slider says how far the reading is. Finding is done among the steps already read, which are only what the replay's seat saw: a card that was hidden from it is found by no name.

## The scoreboard

A table over the steps: each player's **life**, **hand**, **library**, **board** (the permanents they control) and **yard** (their graveyard), as they stood once the step the replay stands at had happened. The player whose turn it is is tagged "their turn"; one who lost or left, "out"; the winner, "won". The seat the replay is read through is underlined, as in the timeline.

**Where the counts come from.** The engine's events tell them (`tally`, [events](engine/events.md#every-seats-counts-v100)): every seat's five counts, on the first event of the game and again on each event that changed one. They are all public at a table (402.3, 401.3). The replay does not count the moves the events tell, because the opening hands and their mulligans are dealt before a game's first event: no count of the moves would find a hand's size. This was found while the feature was built, and is the one engine change in it.

**A game recorded before v1.0.0** has no counts in its events. Its life is counted from where each seat started (`starting` in the replay's header: 20 in Legacy, 40 in Commander, a team's 30 in Two-Headed Giant where a change of either player is the team's, King's Table by its settings) and the life gained and lost since; the other four columns read "–", and a line under the table says why.

Within one resolution the counts can be a step ahead of the sentence: XMage tells the moves of a simultaneous action after it has made all of them, so the first of three draws already says a hand of three more. They are never wrong once the action is told.

## Bookmarks and notes

- **Bookmark this step** keeps the step the replay stands at, with a name (80 characters) and a note (2,000). A bookmarked step says "★ bookmarked" in the list. The panel lists the bookmarks by turn; each goes to its place, and can be edited or removed. An account keeps fifty on one game (`MARK_LIMIT`).
- **Your note on this game** is one note on the game as a whole.

They are the reader's own (`replay_marks`: the account, the game, the event's number, 0 for the game's note). No route shows them to anyone else: another player of the same game has their own, and a friend a replay is shared with sees none of its sharer's and keeps their own on it.

## Sharing

**Share with a friend** (on one's own replay only) lists the account's friends. Sharing gives that friend the game through the sharer's seat: the sharer's hand as they saw it, and nothing that was hidden from them. The dialog says so before anything is shared, and that the bookmarks and notes stay the sharer's.

- It is an access grant ([access](access.md)): `replay`, the game, the seat in its scope, given at once by its player, audited. Friends only (the owner's decision 24): anyone else is refused (`not_a_friend`). Sharing twice shares once. At most twenty friends a replay (`SHARE_LIMIT`).
- The friend is told by a notification (`replay_shared`), which leads to the replay.
- **Take back** ends it: from then on the friend reads nothing of it. The friend can give it up too (**Remove it from my replays**). It also ends when either blocks the other, when either account is disabled or deleted, when the gate is closed (and comes back with it), and with the events.
- A shared replay cannot be passed on: only a seat's own player shares it.
- A player of the same game can be shown another seat's replay. Their own stays the one they get at `#replay/<game>`; the other is at `#replay/<game>/<player>`.

## How long, and what goes

A replay is kept as long as its game's events: **90 days** after the game ended (an interrupted game counts from its start), the owner's decision 2. The page and the list say the day.

| What | When it goes |
| --- | --- |
| The events | The worker's daily job, 90 days after the game (`events.sweep`) |
| Bookmarks and notes | The same job, the same day (`replays.sweep`); and with their account |
| A share | At the same moment, by its grant's expiry: nothing is swept for it |

A game that is running or saved has a timeline and no replay yet (`replay_not_ready`). A game played before v0.9.10 has no events, and no replay.

## Hidden information

Nothing new is shown. Every event of a replay leaves the API through the events' one filter ([events](engine/events.md#read-through-one-filter)) for the replay's seat, whatever number it is asked from and however many at once, so neither seeking nor sharing shows more than that seat saw. The counts are public. A reader who is neither a player of the game nor holds a share that works now is answered 404, as for a game that does not exist. The header shows the deck's title and version of the replay's seat only, and links the deck only to its own owner.

## The API

Behind the gate, on `rollout.router("replays")` (`api/replays.py`):

| Route | What |
| --- | --- |
| `GET /api/v1/replays?limit=` | `own` (newest first, `more` when older ones were left out) and `shared` |
| `GET /api/v1/games/{id}/replay?shared_by=` | The header: the game, `through` (the seat, whether it is the reader's own, who shared it, the grant), `deck`, `starting`, `events` (the last event's number), `turns`, `kept_until`, and the reader's `marks`, `note` and `shares` |
| `GET /api/v1/games/{id}/replay/events?shared_by=&since=&limit=` | The events after `since`, oldest first, through the replay's seat: the timeline's page shape |
| `PUT`, `DELETE /api/v1/games/{id}/replay/marks/{seq}` | A bookmark at an event (`label`, `note`); at 0 the game's note, which an empty note removes. Answers the header |
| `POST /api/v1/games/{id}/replay/shares` | `{player_id}`: shares with a friend. Answers the header |
| `DELETE /api/v1/games/{id}/replay/shares/{grant}` | Ends a share: its player's, or the friend's own |

Migration `0053_replay_marks` (expand only): the table `replay_marks`, and `replay_shared` among the notifications' kinds.

## Keyboard, screen readers and small screens

Every control is a native one: buttons with names ("One step back", "Next turn"), selects, a range input that says its step and turn, a search form, a dialog for sharing. The keys above work wherever in the player the focus is, and never while typing in a field. A hidden status line says the step the reader went to, with its turn and step ("Turn 5, ada. Declare attackers. Grizzly Bears attacked Bot 2."), and "Playing.", "Paused." and "The end of the game."; while it plays it says nothing, so that a screen reader is not flooded: pausing and stepping reads on. The scoreboard is a table with a caption and headed rows. Below 760 pixels the controls stack, the bookmarks, the note and sharing come under the steps, and the scoreboard scrolls sideways if it must.

## Where it is built

| Part | Where |
| --- | --- |
| The routes, the header, marks, shares, the sweep | `api/replays.py`; `ReplayMark` in `api/models.py`; migration `0053_replay_marks` |
| The notification | `replay_shared` in `api/social.py`; `web/src/social/social.ts` |
| The counts in the events | `GameEvents.tally` in `engine/src/main/java/com/commanderduels/GameEvents.java` |
| The scoreboard, the place and the pace, the reading | `web/src/replay/replay.ts` |
| The player | `web/src/replay/Replay.tsx`, `replay.module.css` |
| The pages | `web/src/replay/ReplayPage.tsx`; `#replay/…` and `#replays` in `web/src/App.tsx` |
| The steps' list, shared with the timeline | `TimelineLines` in `web/src/timeline/Timeline.tsx` |

Tests: `GameEventsTest.everySeatsCountsAreToldFromTheFirstEventAndWheneverTheyChange` (engine, a real Commander game); `tests/test_replays.py` (each seat's own reading, another's refused, marks, sharing with a friend and its end, the limits, the sweep, the gate); `web/src/replay/replay.test.ts` and `Replay.test.tsx`; the journeys in `web/e2e/replay.spec.ts`, and the Legacy game played to its end against the real engine opens its replay from the result and finds the scoreboard at the game's last life totals.

## What is not in it

- **A drawn board.** The events do not hold tapped state, power and toughness or where a permanent stands; the owner chose the scoreboard (decision 23).
- **Branching a replay into a practice game** is outside v1.0.0 ([not in v1.0.0](plans/1.0.0.md#not-in-v100)).
- **Sharing by a link**, or with someone who is not a friend (decision 24).
- **Inspection**: SysOp reading a game whole stays in the console's `python -m api.cli timeline`.
- **Bookkeeping lines** cannot be switched on in a replay; the timeline's page shows them.
