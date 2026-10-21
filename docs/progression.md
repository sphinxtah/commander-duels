# The Planeswalker Alliance (v0.3.1)

Since v0.3.1 a player's game wins raise their level, each level opens more of the owner's 98 Planeswalkers to ally with, and the alliance brings that Planeswalker's cards into the player's card library. Players build decks from their own library, which starts with two of ten Commander starter decks; administrators and SysOp build from the whole catalog. The owner's decisions are in [the v0.3.1 plan](plans/0.3.1.md#decisions-at-the-start-of-v031). This is the scope's earned collection policy (PROG01), with the ledger and the result rules of PROG03–PROG05.

## Wins and levels

- **What counts.** A win is a game the engine reports as `completed` with a player's seat as the winning seat: against bots of any skill, in Legacy or Commander. A turn limit, a concession, an idle timeout, a closed game or a draw has no winner and counts for no one.
- **Counted once, from the server's own record** (PROG04, PROG05, NET10). When the API records a finished game, the same database transaction writes one entry in the progression ledger, keyed `win:<game>:<seat>`. A replayed end, a retry or a restart finds the game no longer active and the key taken, and writes nothing. The browser never reports a result.
- **The ledger** (`progress_ledger`) is append-only: PostgreSQL refuses updates and deletes. Each entry records its kind, the change in wins, its unique key, the game, the rule it was counted under (`wins-v1`), and for a setting its reason and who made it. An account's wins are the sum of its entries.
- **SysOp's settings.** SysOp starts at 100,000 wins, so every tier is open to it. In Administration it may set any account's wins, its own included: the API adds the difference as a `wins_set` entry with a required reason, and audits it (`progress.wins_set`, PROG03). Settings stay apart from counted wins, and the profile shows both. Administrators see each player's wins, level and alliance but cannot set them.
- **Games before v0.3.1 count.** Migration 0007 entered every finished game a player won, from the result the API had recorded.

| Tier | Reached at | Opens | Open in all |
| --- | --- | --- | --- |
| Bronze | the start | 40 Planeswalkers | 40 |
| Silver | 10 wins | 25 more | 65 |
| Gold | 100 wins | 21 more | 86 |
| Platinum | 1,000 wins | 10 more | 96 |
| Mythic | 10,000 wins | Jace and Liliana | 98 |
| Godlike | 100,000 wins | The Sphinx, the owner's custom Planeswalker | 98 + 1 |

The roster is `content/planeswalkers.json`: each Planeswalker's stable ID, name, tier, Planeswalker subtype, first Planeswalker card and a one-line description of its portrait, used as alternative text. `scripts/planeswalkers.py roster` makes it from the owner's tier list (`docs/plans/0.3.1-planeswalkers.csv`) and the portrait folder's data files. Changing a tier is a commit, not an administrative setting.

## Alliances

- **One at a time, any time.** A player allies with a Planeswalker their tier has opened, and may switch or leave whenever they like. Each change is audited (`alliance.joined`, `alliance.left`). An alliance stays if SysOp later lowers the account's wins: it was a choice the tier allowed.
- **Its cards.** While the alliance lasts, the library holds a playset (4) of each of the Planeswalker's own Planeswalker cards: every deck card in the catalog with a face whose types include Planeswalker and whose subtypes include the roster's subtype (Tibalt's cards include the back face of Valki, God of Lies). The Wanderer, whose card has no subtype, is matched by name. Cards that only name a Planeswalker ("Chandra's Outrage") are not included. 17 of the 97 regular Planeswalkers have no card that can be played here: Un-set and promotional characters, the set first printed on 2026-10-19 (not Commander-legal in Scryfall's data yet), and Urza. They stay in the roster for their portraits, and the picker says so.
- **Leaving** takes the cards out at once, except copies owned from another source. Every deck of the player is revalidated then, so a deck that needed the alliance's cards is shown as collection-locked straight away.
- **The portrait is the alliance's.** The allied Planeswalker's portrait is the player's picture on the profile, in the sidebar and at the table. With no alliance, the generated sigil stays.

## The library

A player's library is what they may build from (PROG01's earned policy, DECK08):

| Source | Copies | For how long |
| --- | --- | --- |
| The two starter decks chosen at onboarding | every copy of every card in both | for good |
| Decks saved before v0.3.1 (migration 0007) | per card, the most any one of the player's decks held outside its maybeboard | for good |
| The alliance | 4 of each of the Planeswalker's cards | while allied |
| Basic lands | without limit | always |
| Packs (v0.4.0) | the cards pulled | for good |

- **Copies count, as in Magic Duels.** A deck may hold no more copies of a card than the library does, within the format's own limit, counting every printing and Oracle version of the card together. Copies are a limit per deck: two decks may each hold the same owned card.
- **Grants are recorded.** Every grant is a row in `library_grants` with its source and a key naming what granted it (`starter:<deck>`, `grandfathered:0.3.1`); PostgreSQL refuses updates and deletes. A starter grant is made once, whatever retries. The alliance's cards are not granted: they are in the library while the alliance lasts.
- **Collection-locked decks.** Validation reports a deck holding more copies than the library as `collection.locked` (kind `collection_locked`), with what the library holds. Such a deck is legal and stays saved, but it cannot start a game until it is fixed. The deck's stored flags are refreshed whenever the library changes.
- **Administrators and SysOp** hold `library.unlimited`: they build from the whole catalog, and only the format's rules apply. SysOp keeps its any-card deck lists.
- **Where it shows.** Every card in search results and card details says how many copies the player's library holds (`owned`; null when not limited). The deck builder's finder starts on the library, and the Cards page browses the whole catalog with an "In my library" filter and a library view.

## The starter decks

- **The ten decks** are `content/starter-decks.json`: one 100-card Commander deck per two-colour pair, each with its commander, colours, description, how to play it and what it teaches, and the printing the owner chose for every card. `scripts/starter_decks.py` makes it from the owner's workbook, which stays out of git: the workbook also holds private production notes (reference prices, and which card is each deck's guaranteed bonus) that must not reach players or the client, and the script keeps none of them. Each list was checked against the catalog on 2026-10-20: every card is certified and Commander-legal, and none is a Game Changer.
- **Choosing two.** After choosing a handle, a player chooses two of the ten (`onboarding` goes `handle`, then `starters`, then `complete`). Both become decks of their own, with every copy of their cards granted to the library for good, and the choice is audited (`library.starters_chosen`). Players who had finished onboarding before v0.3.1 choose theirs at their next visit.
- **The six old starter decks** (the engine's fixture decks) are no longer offered to players. They remain the engine's test decks: SysOp sees them at the practice table, and the browser journeys and the engine's smoke games play them.
- **The bots** at the practice table play the ten in Commander, a different one each, when no deck is chosen for them; Legacy bots keep the two Legacy fixture decks. `CD_BOT_DECKS=fixtures` keeps Commander bots on the fixture decks too, as CI's browser game journeys need: their leak checks tell concealed cards apart by name, and the starter decks share cards. A starter deck whose cards the catalog cannot all map to the engine falls back to a fixture deck.

## The Godlike tier's custom cards

The Godlike tier opens a Planeswalker of the owner's own making and its cards, available only by reaching 100,000 wins. Nothing about them is in this repository: not their names, text or images, in code, tests, docs or logs. Tests use made-up stand-ins.

- **SysOp uploads them** in Administration, over the site's HTTPS (permission `custom_cards.manage`). The browser fits each image to Scryfall's 745 × 1040 card size and encodes it as WebP under 800 KB, so a request stays under the proxies' 1 MB limit; the API checks it is the image it claims to be, at most 900 KB. A card of the same name is replaced. The audit trail records each upload and removal by the card's ID, never its name or text.
- **A table of their own** (`custom_cards`), outside the catalog's: no search, card page, deck, import, export, image route or catalog count can reach them. The images are stored in the database, so they are in the nightly backups.
- **Only Godlike accounts see them.** `GET /api/v1/custom-cards` and each card's image answer only an account with 100,000 wins or more (SysOp included); to everyone else they answer exactly as a route that does not exist. Images are sent `Cache-Control: private, no-store`.
- **In the library.** An alliance with The Sphinx puts them in the library. None can be played yet, so they cannot be added to decks: playing them needs their engine implementations, in a private repository built into a plugin the public engine loads, and the owner's answers to their rules questions. That, and what opponents may see of them in a game, is a later version's work.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/v1/me/progress` | any active account | wins (counted and set), tier, next tier, alliance |
| `GET /api/v1/planeswalkers` | any active account | the roster, with what the account's tier opened and each one's card counts |
| `PUT /api/v1/me/alliance`, `DELETE /api/v1/me/alliance` | any active account | join (403 `alliance_locked` above the tier), leave |
| `GET /api/v1/decks/starters` | `decks.edit` | the ten starter decks, with the two chosen |
| `POST /api/v1/me/starters` | `decks.edit` | choose two (409 `starters_chosen`, `handle_first`; 422 `same_starter`) |
| `GET /api/v1/library` | any active account | the library's cards, copies and sources |
| `GET /api/v1/cards?owned=true` | any active account | search within the library |
| `POST /api/v1/admin/users/{id}/wins` | SysOp (`progress.manage`) | set an account's wins, with a reason |
| `GET`, `POST /api/v1/admin/custom-cards`, `DELETE /api/v1/admin/custom-cards/{id}` | SysOp (`custom_cards.manage`) | the custom cards |
| `GET /api/v1/custom-cards`, `GET /api/v1/custom-cards/{id}/image` | Godlike accounts | the custom cards; 404 to everyone else |

## The portraits and badges

- **Portraits.** The owner's 98 portraits (1254 × 1254, transparent) stay outside the repository. `scripts/planeswalkers.py portraits` writes their web sizes, WebP with alpha at 128, 256 and 512 pixels, contain-fitted and never cropped, to `web/public/portraits/<id>-<size>.webp` (about 12 MB). The installed app does not precache them: a screen fetches one when it shows it, and the web server lets browsers keep them for a week. `docs/asset-provenance.csv` records them.
- **Badges.** Until the owner's own arrive, each tier's badge is a generated metal crest (bronze, silver, gold and platinum metal, Mythic in the mythic rarity's orange-red, Godlike prismatic in the five colours), drawn as SVG in the page.
