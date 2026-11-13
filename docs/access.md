# Access, consent and temporary entitlement (v0.9.10)

One table of grants for every kind of access one account gives another, for a while: the specification's §8, the foundation v1.0.0's deck lending, spectators, coaching, replay sharing and sandbox, and v0.9.12's playgroups and league pools, are built on (`api/access.py`, `access_grants`, migration 0046).

## A grant

| Field | What it holds |
| --- | --- |
| `grantor_id`, `subject_id` | Who gives, and to whom: two accounts |
| `resource_kind`, `resource_id` | What: `deck` (a deck, to play), `spectator` (a game, to watch), `replay` (a finished game, to replay), `hand` (a seat's hand, to coach), `group`, `pool` (v0.9.12), `sandbox` (cards, for testing; no resource) |
| `scope` | What within it: the seat (`{"seat": 0}`) for a replay or a hand |
| `consent` | `given` (the grantor's own to give: their game, their seat's view); or `offered`, then `accepted` or `declined` by the subject (a deck lent, a group, a pool) |
| `expires_at`, `revoked_at`, `revoked_by` | When it ends, and who ended it |

Who may give what: a deck, its owner; a game to watch, one of its players; a seat's view (a replay, a hand), that seat's player alone; the sandbox's cards, SysOp alone. Never to oneself, never between two accounts one of which blocks the other, never to or from an account that is not active, never ending before it begins. Groups and pools are refused in words (`not_available`) until v0.9.12 makes them. Every change (given, offered, accepted, declined, revoked) is audited (`access.<change>`).

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

## Tested

`tests/test_access.py`, across accounts for each kind: who may give what; a lent deck usable only between its acceptance and its expiry or revocation, by its subject alone, and not across a block, a disabled account or a deleted deck; every change audited; a revocation changing no game started with the deck; a sandbox grant writing nothing where ownership lives; and spectator, coach and replay grants opening a game's events through the right perspective, and closing it again when revoked or blocked. The account-data test writes grants at migration 0046 and compares them across every migration after it.
