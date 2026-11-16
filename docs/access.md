# Access, consent and temporary entitlement (v0.9.10)

One table of grants for every kind of access one account gives another, for a while: the specification's §8, the foundation v1.0.0's deck lending, spectators, coaching, replay sharing and sandbox are built on (`api/access.py`, `access_grants`, migration 0046). Since v0.9.13 each kind of access is behind its workflow's gate ([below](#behind-the-gates-v0913)).

## A grant

| Field | What it holds |
| --- | --- |
| `grantor_id`, `subject_id` | Who gives, and to whom: two accounts |
| `resource_kind`, `resource_id` | What: `deck` (a deck, to play), `spectator` (a game, to watch), `replay` (a finished game, to replay), `hand` (a seat's hand, to coach), `sandbox` (cards, for testing; no resource). The table also takes `group` and `pool`, named in v0.9.10 for the playgroups and leagues the owner dropped on 2026-11-14: nothing writes them |
| `scope` | What within it: the seat (`{"seat": 0}`) for a replay or a hand |
| `consent` | `given` (the grantor's own to give: their game, their seat's view); or `offered`, then `accepted` or `declined` by the subject (a deck lent) |
| `expires_at`, `revoked_at`, `revoked_by` | When it ends, and who ended it |

Who may give what: a deck, its owner; a game to watch, one of its players; a seat's view (a replay, a hand), that seat's player alone; the sandbox's cards, SysOp alone. Never to oneself, never between two accounts one of which blocks the other, never to or from an account that is not active, never ending before it begins. A group and a pool are refused in words (`not_available`), always. Every change (given, offered, accepted, declined, revoked) is audited (`access.<change>`).

## Behind the gates (v0.9.13)

Each kind of access belongs to one of v1.0.0's unfinished workflows, and every workflow is off until SysOp stages it ([the gates](operations.md#the-gates)): a deck to `deck_lending`, a spectator's seat to `spectators`, a seat's hand to `coaching`, a replay to `replays`, the sandbox's cards to `sandbox`.

- **Giving.** `access.offer` refuses (`not_available`) unless the workflow is available to both accounts: at `staff`, between SysOp and administrators alone.
- **Using.** `access.active` gives nothing to a subject its workflow is not available to, whatever grants stand. Switching a workflow off stops its access at once, as an expiry does; switching it on again gives it back, since the grants were never touched.
- **Counted.** Each refusal is counted for the operator by its code and the kind of access, never by the account ([the counts](operations.md#the-counts)).

`tests/test_rollout.py` shows each of these; `tests/test_access.py` is access itself, with every gate open.

## When it works

`access.active` is asked each time access is decided, and nothing of a grant is written anywhere else. A grant works while it is consented to (`given` or `accepted`), has not expired, has not been revoked, both accounts are active, neither blocks the other, and, for a deck, the deck is still its grantor's and not deleted. So access ends, with nothing to sweep, at the expiry; when the grantor takes it back, the subject gives it up or SysOp ends it; when either account is disabled or deleted; when either blocks the other; and when a lent deck is deleted or changes hands.

| What happens | Its effect |
| --- | --- |
| Expiry, revocation, a block, an account disabled or deleted | No new access from that moment: the next request is refused |
| A game already started with a lent deck | Plays on as it started: the game holds the deck revision it started with (`game_seats.deck_revision_id`), so editing the deck or revoking the loan changes nothing in it |
| A card the sandbox lends | Never a `LibraryGrant`: the library, the shop and the auction house read libraries only, so it can reach neither a collection nor an auction |
| Group removal, invitation revocation (v0.9.12) | A revocation, as above |

## Read where access is decided

In v0.9.10 grants open a game's structured events ([events](engine/events.md)), which is where spectators, coaches and replays will read the game from:

| Grant | Perspective through which the subject reads the game's events |
| --- | --- |
| `spectator` | A spectator's: only what every seat may see |
| `hand` (a seat) | That seat's, while the game runs: a coach sees the hand the player shows them |
| `replay` (a seat) | That seat's, once the game is over |

and `access.deck_usable` answers whether an account may play a deck: its own, or one lent to it now. v1.0.0's lending seats a borrowed deck through it.

No route makes a grant in v0.9.10: the workflows that offer, accept and show them (lending, spectating, coaching, sharing a replay) are v1.0.0's, so nothing unfinished can be reached.

**Since v1.0.0 a deck is lent by one** ([friend deck lending](decks.md#friend-deck-lending-v100)): `POST /api/v1/decks/{id}/loans` offers a friend the `deck` grant, bound to one saved version (`scope`: `revision`, `number`) and expiring in seven days; the friend's answer is the grant's consent, and accepting sets its seven days again; `DELETE /api/v1/loans/{id}` revokes it, by either of them. `access.lent_out` answers whether a deck is with a friend now, which keeps its owner from playing it (the owner's decision of 2026-11-15).

**Since v1.0.0 a coach is given one** ([coaching](games.md#coaching-v100)): `POST /api/v1/games/{id}/coaches` gives a friend the `hand` grant for the player's own seat, with no expiry: it ends when either of them ends it (`DELETE …/coaches/{player}`), and gives nothing once the game is over, the gate is closed, an account is disabled or one blocks the other. The game's view and its socket are read through the grant's seat, as its events already were.

**A spectator is given none.** Who may watch a table's game is the table's own to say ([spectators](tables.md#spectators-v100)): its host's setting and its list of invitations (`table_spectators`), asked at every reading as a grant would be. The `spectator` grant stays modelled and checked where events are read, and no route makes one.

**Since v1.0.0 a replay is shared by one** ([replays](replays.md#sharing)): `POST /api/v1/games/{id}/replay/shares` gives a friend the `replay` grant for the sharer's own seat, expiring with the game's events; `DELETE …/shares/{grant}` revokes it, by its player or by the friend. The replay's routes read the game through the grant's seat and nothing else; the timeline's route honours the same grant.

## Tested

`tests/test_access.py`, across accounts for each kind: who may give what; a lent deck usable only between its acceptance and its expiry or revocation, by its subject alone, and not across a block, a disabled account or a deleted deck; every change audited; a revocation changing no game started with the deck; a sandbox grant writing nothing where ownership lives; and spectator, coach and replay grants opening a game's events through the right perspective, and closing it again when revoked or blocked. The account-data test writes grants at migration 0046 and compares them across every migration after it.
