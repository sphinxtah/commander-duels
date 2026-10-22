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

Your decks show their format, color identity, card count, commanders and state: "Ready to play", "Legal, not playable yet" (since v0.4.5 only a Godlike card the running engine has not loaded) or "Draft" (problems to fix), and since v0.4.5 how many cards left the game ([below](#cards-that-leave-the-game-v045)). A deck that holds banned cards, or cards not legal in its format, is tagged "Casual tables only" with "Banned cards" or "Not legal in Commander" (or Legacy). From the list a deck can be opened, duplicated, archived (and brought back) or moved to the trash, from where it can be restored. Nothing is deleted for good in v0.2.0.

**Starter decks.** The practice table's six fixture decks can be copied to make them yours.

## Building (DECK03, DECK05, DECK07)

- **Finding cards.** The editor's card finder uses the catalog's search syntax and filters ([search](catalog.md#search-deck03-deck04)), and since v0.4.5 finds only cards the game can play, whatever its settings. "Only cards this deck can use", on by default, limits it to cards legal in the format and, in Commander, within the commanders' color identity; since v0.4.5, unticking it also finds banned cards and cards not legal in the format, for casual tables. Since v0.3.1 a player's finder starts on their library (`owned=true`), and every card says how many copies the library holds; "All cards" browses the rest.
- **Choosing printings.** A card's details list its English printings; choosing one sets the entry's printing, which the deck's images use (in games too, for your own seat). Copies count across printings.
- **Statistics.** Counts per location, lands, average mana value, the mana curve, colored symbols in costs against the lands that make each color, card types, and opening-hand odds: the chance of each number of lands in seven cards (the hypergeometric distribution), plus a sample hand to draw again and again. The page says that numbers describe the cards, not how well the deck plays.

## Validation (DECK08, T03–T05)

The server validates every save, preview and revision, and each problem says what is wrong and how to fix it (its remedy), with the cards it concerns, which the editor highlights. A deck is **legal** when no rule of its format's deck rules is broken, and **playable** when it is legal, every card is playable here, and (since v0.3.1) the player's library holds every copy. Only playable decks start games, and since v0.4.5 only at tables whose rules take their cards.

- **Every card.** It must be a card a deck holds, not removed from the catalog, and released. Restricted cards count as one allowed copy.
- **Banned cards and cards not legal in the format** (v0.4.5). They no longer make a deck illegal: each table's host chooses whether its decks may hold them ([the table's rules](tables.md#the-tables-rules-v045)). Such a card is a note, kind `banned` (`card.banned`, and `companion.banned` for Lutri as a Commander companion) or `not_legal` (`card.not_legal`: Un-cards, playtest and digital-only cards), and the validation lists the table options the deck needs in `needs` (`banned`, `not_legal`). The editor's verdict says which tables take the deck ("Ready to play at tables that allow banned cards."), and its notes say "Casual tables only". The format's deck rules still count these cards: copies, singleton, color identity.
- **The flags kept with each deck** (`legal`, `playable`, `collection_locked`, and since v0.4.5 `needs`) are those of its last validation, so the list needs none. A deck last validated before v0.4.5 is validated again, once, when its owner's list is read: a deck held back only by a banned card becomes legal, and tagged.
- **Copies.** By construction key, across printings: four in Legacy, one in Commander, basic lands and "any number" cards unlimited, and cards such as Seven Dwarves at their own limit.
- **Legacy.** At least 60 cards in the main deck, at most 15 in the sideboard. 250 main-deck cards is the technical maximum.
- **Commander.** Exactly 100 cards with the commanders, and no sideboard. One commander, or two that may pair: Partner, Partner with each other, the same partner group (Partner—Friends forever, for one), Choose a Background with a Background, or a Doctor's companion with a Time Lord Doctor. Each must be able to be a commander. Every card must fall within the commanders' color identity.
- **Companions.** The ten companion conditions (Gyruda, Jegantha, Kaheera, Keruga, Lurrus, Lutri, Obosh, Umori, Yorion, Zirda) are checked against the deck; Lutri may not be a Commander companion. A companion the rules do not know yet is a warning.
- **Not playable yet.** A legal card the engine cannot play is listed as "Not playable here yet", with its status reason; it makes the deck legal but not playable. Since v0.4.5 a draft never holds such a card ([below](#cards-that-leave-the-game-v045)), so this concerns a version that games played, a list sent to `POST /decks/validate`, and a Godlike card the running engine has not loaded.
- **Collection-locked** (v0.3.1). More copies of a card than the player's library holds, counting every printing and Oracle version together, outside the maybeboard (`collection.locked`, kind `collection_locked`). The message says what the library holds; the deck stays legal and saved but is not playable. A game revalidates its deck against the library as it is then, and each deck's stored flags are refreshed whenever its owner's library changes (an alliance joined or left, starter decks chosen). Administrators and SysOp are never limited.

`POST /api/v1/decks/validate` validates a list without saving it.

## Cards that leave the game (v0.4.5)

A card the game cannot play is out of the game ([catalog](catalog.md#only-playable-cards-are-in-the-game-v045)), and decks follow, as the owner decided on 2026-10-21:

- **Drafts hold only cards the game can play.** When a card stops being playable (a catalog sync that takes its playability away, or a staff suspension), it leaves every deck's draft at once, archived and trashed decks too, from every location, the maybeboard included. Each such deck is revalidated against its owner's library, so its stored flags (card count, legal, playable, collection-locked, identity) say where it stands, and its draft gets a new version: an editor open elsewhere then shows the change, as an edit from another tab, rather than saving over it. A save that names such a card, from an old tab or a script, keeps it out the same way.
- **The note.** The deck names what left and why ("Cards that left this deck" in the editor, each card with its copies and reason, such as "The game engine has no implementation of this card yet."; "1 card left the game" in the list) until its owner dismisses it.
- **When v0.4.5 deployed.** The worker takes such cards out of the drafts each time it starts, which is each deploy, and after every catalog sync that makes a new revision; a suspension does it at once. On the v0.4.5 deploy the worker first imports the catalog again so the prepare cards are decided ([catalog](catalog.md#prepare-cards-v045)), and only then empties the drafts, so a draft holding one of the 66 the engine plays keeps it.
- **Versions keep their cards.** A deck version that a game played, or that was saved before, is the history it is and keeps every card; a game started from a deck plays a version of its draft as it is now.
- **A card that comes back** (a newer engine, an administrator's acceptance or restoration) is in the game again, but goes back into no draft by itself: its owner adds it again.
- **SysOp too.** Until v0.4.5 SysOp's own decks, like its deck lists, could hold any card the engine implements; now they hold cards in the game, as everyone's do ([games](games.md)).

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
- **Resolving names.** Exact names, face names, aliases and the "Fire/Ice" spelling resolve to cards, only cards the game can play since v0.4.5. A line that matches several cards, or none, is listed in the preview with suggestions to choose from, or to leave out. A line naming a card the game cannot play (a token, a card the engine lacks, one Scryfall no longer lists) is "not in the game": left out, with the reason. The preview validates the result before anything is saved.
- **Export** as text (Commander and Deck sections, or main deck and `SB:` lines) or as a deck file.

## Sharing (DECK11)

A deck is private until its owner shares it by link. The link (`#shared/<code>`) opens the deck's cards and validation, read-only, for any signed-in player, who can export it or copy it into their own decks. The owner's notes are never shared. Turning sharing off, or moving the deck to the trash, ends the link; turning it on again makes a new one.

## At the practice table

The practice table's deck choices list "Your decks"; since v0.3.1 the engine's fixture decks are offered to SysOp only, and a player's two starter decks are among their own. A deck that is not playable yet is shown but cannot be chosen. "Play it at the practice table" in the editor opens the table with the deck chosen, in its format. A deck of the wrong format is refused (`invalid_deck`), as is a deck that is not playable (`deck_not_playable`, which says so when the library is short of copies). Since v0.4.5 a practice game takes the same rules as a human table, casual unless the player chooses others, and a deck holding cards they do not allow is greyed with the reason and refused (`deck_not_allowed`, naming the cards). Each bot plays a deck chosen for it (one of the player's playable decks, or SysOp's fixture deck or deck list) or, by default, a starter deck in Commander and a fixture deck in Legacy (AI06). The game records each seat's deck revision, the catalog revision and the format version. Games use the main deck and the commanders: a companion, the sideboard and the maybeboard stay out of the game in v0.2.0.

SysOp's own decks may hold any card in the game (until v0.4.5, any card the engine implements), as its deck lists may ([games through the API](games.md)).

## The Godlike tier's custom cards (v0.4.0)

An account at the Godlike tier (100,000 wins, SysOp included) may put the owner's custom cards in its decks ([the Planeswalker Alliance](progression.md#playing-them-v040)). Nothing about the cards themselves is in this repository.

- **Finding them.** The search never finds them. The finder lists them under "Godlike cards" above its results, each with its image, its copies in the library, whether the running engine has loaded it, and Add (and Commander, where it may lead). "Only cards this deck can use" keeps to the commander's color identity there too. Opening one shows its own image and text, since the catalog has no page for it.
- **Validation.** Legal in Legacy and Commander; copies by the format and the library, as for any card (a playset while allied with their Planeswalker; administrators and SysOp unlimited). A legendary creature, or a card that says it can be your commander, may lead; its identity is the colors of the mana symbols in its cost and rules text. A card the running engine has not loaded is "Not loaded by this engine": legal, not playable.
- **Statistics, versions, export and import** treat them as other cards. Revisions store them as custom cards (`custom_card_id`). The owner's text export names them, and a deck file lists them by name without an Oracle ID. An import resolves their exact names for a Godlike owner only; for anyone else such a line is an unknown card.
- **Below the tier.** When SysOp lowers the owner's wins below 100,000, the owner's decks are revalidated. A deck holding a custom card becomes collection-locked (`custom.godlike_only`, kind `collection_locked`), shows each such card as a hidden "Godlike card" and its commander as "Godlike card", and exports without them. Reaching the tier again opens them again.
- **Games.** A deck holding one starts a game only where the running engine has loaded every such card; the API asks the engine at each start and otherwise refuses (`422 custom_not_loaded`). Bots never play them (`422 custom_cards_for_bots`).
- **Nobody else sees them.** A shared deck shows, exports and copies without them, whoever looks.

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
| `DELETE /decks/{id}/removed-cards` | Dismiss the note of cards that left the game (v0.4.5) |
| `GET /decks/{id}/export?kind=text\|json` | Export |
| `POST /decks/import/preview`, `POST /decks/validate`, `POST /decks/guided` | Preview an import, validate a list, propose a guided deck |
| `GET /shared-decks/{code}`, `/export`, `POST /shared-decks/{code}/copy` | A shared deck |
