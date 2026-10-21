# Decks (v0.2.0)

Since v0.2.0 approved players build their own Legacy and Commander decks from [the card catalog](catalog.md), check them against the format's rules, and play them at the practice table (the scope's DECK01–DECK11; languages other than English are later work). The Decks page needs the `decks.edit` permission, which every approved player, and SysOp, holds.

Since v0.3.1 players build from their own **card library**: two starter decks chosen at onboarding, their alliance's Planeswalker cards, cards of decks saved before v0.3.1, and basic lands; packs follow in v0.4.0. Copies count, and a deck holding more copies than the library is collection-locked. Administrators and SysOp build from the whole catalog. See [the Planeswalker Alliance](progression.md#the-library).

## A deck and its versions (DECK01, DECK02)

- **The draft.** A deck is edited as a draft: its entries (card, optional printing, quantity, location) and its title, notes and sharing. The editor saves the draft by itself 1.2 seconds after the last change and says when it is saved.
- **Edits from two places.** Each save names the draft version it was based on. If another tab or window saved in between, the save is refused (`409 draft_conflict`) and nothing is lost: the editor lists the differences and offers to keep this version, use the saved one, or combine them (the larger count of each card).
- **Versions.** "Save a version" stores the draft as an immutable revision, numbered, with its validation, the catalog revision and the format version it was checked against. A trigger refuses any change to a stored revision or its entries in PostgreSQL. Saving an unchanged draft again returns the same revision.
- **Games keep their version.** Starting a game with a deck stores a revision first (or reuses the latest, if unchanged), and the game records it, so later edits never change a game in progress or its record.
- **Locations.** Main deck, sideboard, companion and maybeboard in Legacy; commander, companion, main deck and maybeboard in Commander. The maybeboard is never validated or played.
- **Limits.** 250 decks an account (the trash included), 400 entries a deck, 1–250 copies an entry, notes up to 10,000 characters.

## The list (DECK01)

Your decks show their format, color identity, card count, commanders and state: "Ready to play", "Legal, not playable yet" (a card the engine cannot play yet) or "Draft" (problems to fix). From the list a deck can be opened, duplicated, archived (and brought back) or moved to the trash, from where it can be restored. Nothing is deleted for good in v0.2.0.

**Starter decks.** The practice table's six fixture decks can be copied to make them yours.

## Building (DECK03, DECK05, DECK07)

- **Finding cards.** The editor's card finder uses the catalog's search syntax and filters ([search](catalog.md#search-deck03-deck04)). "Only cards this deck can use", on by default, limits it to playable cards legal in the format and, in Commander, within the commanders' color identity. Since v0.3.1 a player's finder starts on their library (`owned=true`), and every card says how many copies the library holds; "All cards" browses the rest.
- **Choosing printings.** A card's details list its English printings; choosing one sets the entry's printing, which the deck's images use (in games too, for your own seat). Copies count across printings.
- **Statistics.** Counts per location, lands, average mana value, the mana curve, colored symbols in costs against the lands that make each color, card types, and opening-hand odds: the chance of each number of lands in seven cards (the hypergeometric distribution), plus a sample hand to draw again and again. The page says that numbers describe the cards, not how well the deck plays.

## Validation (DECK08, T03–T05)

The server validates every save, preview and revision, and each problem says what is wrong and how to fix it (its remedy), with the cards it concerns, which the editor highlights. A deck is **legal** when no rule is broken, and **playable** when it is legal, every card is playable here, and (since v0.3.1) the player's library holds every copy. Only playable decks start games.

- **Every card.** It must be a card a deck holds, not removed from the catalog, released, legal in the format and not banned. Restricted cards count as one allowed copy.
- **Copies.** By construction key, across printings: four in Legacy, one in Commander, basic lands and "any number" cards unlimited, and cards such as Seven Dwarves at their own limit.
- **Legacy.** At least 60 cards in the main deck, at most 15 in the sideboard. 250 main-deck cards is the technical maximum.
- **Commander.** Exactly 100 cards with the commanders, and no sideboard. One commander, or two that may pair: Partner, Partner with each other, the same partner group (Partner—Friends forever, for one), Choose a Background with a Background, or a Doctor's companion with a Time Lord Doctor. Each must be able to be a commander. Every card must fall within the commanders' color identity.
- **Companions.** The ten companion conditions (Gyruda, Jegantha, Kaheera, Keruga, Lurrus, Lutri, Obosh, Umori, Yorion, Zirda) are checked against the deck; Lutri may not be a Commander companion. A companion the rules do not know yet is a warning.
- **Not playable yet.** A legal card the engine cannot play is listed as "Not playable here yet", with its status reason; it makes the deck legal but not playable.
- **Collection-locked** (v0.3.1). More copies of a card than the player's library holds, counting every printing and Oracle version together, outside the maybeboard (`collection.locked`, kind `collection_locked`). The message says what the library holds; the deck stays legal and saved but is not playable. A game revalidates its deck against the library as it is then, and each deck's stored flags are refreshed whenever its owner's library changes (an alliance joined or left, starter decks chosen). Administrators and SysOp are never limited.

`POST /api/v1/decks/validate` validates a list without saving it.

## Guided creation (DECK06)

"Build one with help" asks for the format, a commander (and partner) or colors, a theme (aggro, midrange, control, tokens, +1/+1 counters, graveyard, spells, ramp, tribal with a creature type, artifacts, enchantments, life gain) and the player's experience. It proposes a whole deck of playable cards, each with the reason it was picked:
- **Commander:** 37 lands, 10 ramp, 10 card draw, 8 removal, 2 sweepers, and the theme's cards for the rest.
- **Legacy:** 20 lands for aggro, 24 for control, 22 otherwise, and four copies of the theme's best cards.
- **From the library** (v0.3.1). A player's proposal uses only cards their library holds, at most the copies it holds.
- **Size.** Basic lands fill whatever the spells leave, so a proposal always has 100 cards with its commanders, or 60.
- **Order.** Roles come from Scryfall Tagger's tags and the cards' text; popularity on EDHREC orders the candidates, and for a new player shorter, simpler cards come first. The basic lands follow the colors the spells ask for.

The rules are written down and deterministic, no language model or paid service is used, and the dialog says they make a start, not a strong deck. Nothing is saved until the player keeps the proposal as a new deck.

## Import and export (DECK09–DECK11)

- **Text.** One card per line (`4 Lightning Bolt`, `4x Lightning Bolt`, or a name alone for one copy), with optional `Commander`, `Deck`, `Sideboard`, `Companion` and `Maybeboard` headings, `SB:` prefixes, `*CMDR*` or `[Commander]` marks, and set annotations (`Lightning Bolt (M10) 146`) that choose the printing. Without headings, a blank line starts the sideboard in Legacy. At most 64 KB and 600 lines.
- **Deck files.** JSON, `{"format": "commander-duels-deck", "version": 1, ...}`, with card and printing IDs, so a file always resolves to the same cards.
- **Resolving names.** Exact names, face names, aliases and the "Fire/Ice" spelling resolve to cards. A line that matches several cards, or none, is listed in the preview with suggestions to choose from, or to leave out. The preview validates the result before anything is saved.
- **Export** as text (Commander and Deck sections, or main deck and `SB:` lines) or as a deck file.

## Sharing (DECK11)

A deck is private until its owner shares it by link. The link (`#shared/<code>`) opens the deck's cards and validation, read-only, for any signed-in player, who can export it or copy it into their own decks. The owner's notes are never shared. Turning sharing off, or moving the deck to the trash, ends the link; turning it on again makes a new one.

## At the practice table

The practice table's deck choices list "Your decks"; since v0.3.1 the engine's fixture decks are offered to SysOp only, and a player's two starter decks are among their own. A deck that is not playable yet is shown but cannot be chosen. "Play it at the practice table" in the editor opens the table with the deck chosen, in its format. A deck of the wrong format is refused (`invalid_deck`), as is a deck that is not playable (`deck_not_playable`, which says so when the library is short of copies). Each bot plays a deck chosen for it (one of the player's playable decks, or SysOp's fixture deck or deck list) or, by default, a starter deck in Commander and a fixture deck in Legacy (AI06). The game records each seat's deck revision, the catalog revision and the format version. Games use the main deck and the commanders: a companion, the sideboard and the maybeboard stay out of the game in v0.2.0.

SysOp's own decks may hold any card the engine implements, as its deck lists may ([games through the API](games.md)).

## Routes

All under `/api/v1`, for the signed-in owner only; another account's deck answers 404, as a deck in the trash does except for restoring it.

| Route | |
| --- | --- |
| `GET /decks?view=active\|archived\|trash` | The list |
| `GET /decks/starters` | The ten starter decks (v0.3.1), with the two the player chose |
| `POST /decks` | Create: empty, from a starter, a duplicate, an import or a guided proposal |
| `GET /decks/{id}`, `PATCH /decks/{id}` | The deck with its draft, validation, versions and cards; change its title, notes or sharing |
| `PUT /decks/{id}/draft` | Save the draft (`version` must match, else 409) |
| `POST /decks/{id}/revisions`, `GET /decks/{id}/revisions/{n}` | Save a version; read one |
| `POST /decks/{id}/archive`, `/unarchive`, `DELETE /decks/{id}`, `POST /decks/{id}/restore` | Archive, trash and restore |
| `GET /decks/{id}/export?kind=text\|json` | Export |
| `POST /decks/import/preview`, `POST /decks/validate`, `POST /decks/guided` | Preview an import, validate a list, propose a guided deck |
| `GET /shared-decks/{code}`, `/export`, `POST /shared-decks/{code}/copy` | A shared deck |
