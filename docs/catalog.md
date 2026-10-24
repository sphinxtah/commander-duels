# The card catalog (v0.2.0)

Since v0.2.0 the site keeps its own card catalog, imported from Scryfall's bulk data and mapped to the cards the engine implements (the scope's CAT01–CAT10). Decks are built from it ([decks](decks.md)), and its statuses decide which cards a game may use. The catalog never plays a card: the engine does, and a card is playable only when the engine's implementation of it passed the automatic checks.

## What is imported (CAT01–CAT04)

Four of Scryfall's bulk files, English only, downloaded by the worker:

| Dataset | Holds | Size (2026-10-20, gzip) |
| --- | --- | --- |
| `oracle_cards` | One record per card concept: names, costs, types, Oracle text, colors, legalities, EDHREC rank | 25 MB |
| `default_cards` | One record per English printing: set, collector number, rarity, release date, image links | 80 MB |
| `rulings` | Rulings by Oracle ID | 5 MB |
| `oracle_tags` | Scryfall Tagger's functional tags ("removal", "ramp", "card-draw"), with their parents | 6 MB |

Each card concept gets the site's own ID, mapped to Scryfall's Oracle ID, and each printing gets its own, mapped to Scryfall's card ID, with the set, the collector number (as text), the language and the image links. Faces, related cards (tokens, meld parts) and aliases (face names, flavor names and printed names) are kept beside them; deck imports also read the "Fire/Ice" spelling of a split card. The construction key, the name decks count copies by, is the normalized name: casefolded, accents and ligatures removed, quotes straightened.

Each card's commander, partner (including "Partner with", partner groups, "Choose a Background", Doctor's companions), companion, copy-limit ("A deck can have any number") and activated-ability roles are derived from its type line, keywords and Oracle text when it is imported, so validation reads them from the record instead of from text.

## Revisions (CAT05)

Every successful import is a **catalog revision**, written in one transaction, so a failed import leaves the previous catalog in use (T20):
- **Validation first.** The files are read once and checked before anything is written: no Oracle ID twice, no printing without its concept, and no dataset that shrank by more than 10 % since the last import (`unexpected_record_count`). A record over 1 MiB, a malformed line or a file over its limit (1 GiB compressed, 4 GiB decompressed) stops the run.
- **Nothing is deleted.** A card or printing Scryfall drops is marked removed in that revision and kept, so old deck revisions and games still resolve their cards. A card that comes back is restored.
- **Change records.** Each revision records what changed per card: added, removed, restored, Oracle text changed, legality changed, printing added or removed, status changed. Each game and each deck revision names the catalog revision it was built on.
- **Banned lists.** Each change to a format's banned or restricted list is a new **format version** with its date. The format rules also carry the site's role bans: Lutri, the Spellchaser may not be a Commander companion.
- **Fenced.** The job row is locked and its generation checked inside the transaction that writes the revision, so a run that lost its lease cannot write (status `fenced`).

On the real data (2026-10-20): validation took 15 s and the import about 2 minutes; the first sync, downloads included, took 2 minutes 3 seconds and made the database 489 MB.

## The daily sync

The worker keeps today's and tomorrow's sync queued as scheduled jobs, one per day:
- **When.** `CD_CATALOG_SYNC_TIME` (default `10:00` UTC) plus a jitter of up to `CD_CATALOG_SYNC_JITTER_MINUTES` (default 30). The jitter is the same for every worker on a given day. A new installation's first run is due at once.
- **Unchanged days.** Scryfall publishes each file with its update time. A file with the same time and SHA-256 as the last import is reused from `CD_CATALOG_DIR`; when no file changed and the engine build is the same, the run ends `unchanged` without a revision.
- **Downloads.** Only from `data.scryfall.io` and `api.scryfall.com` over HTTPS, without redirects, to a `.part` file renamed when complete. `CD_CATALOG_MAX_DOWNLOAD_MB` (1024) and `CD_CATALOG_MAX_DATASET_MB` (4096) bound each file.
- **Failures.** A transient failure (network, Scryfall, a short download) retries after 1 minute, doubling to an hour, six attempts in all. The run records its error code and message.
- **Leases.** A run renews its lease every 20 seconds from a heartbeat thread, so a long import keeps its claim, and a worker that dies loses it.
- **Run now.** Administrators queue a run from Administration → Card catalog, unless one is queued or running already.

`CD_CATALOG_DIR` empty turns the sync off (tests, and the API, which never downloads). Compose and the live site set it to the worker's `catalog_data` volume.

## Statuses (CAT06–CAT09)

Each card concept has one status, with a reason when it cannot be played:

| Status | Meaning | Reasons |
| --- | --- | --- |
| `certified` | The engine implements it and the implementation passed every automatic gate: **playable** | |
| `implemented` | The engine implements it, but a gate failed or the engine's card differs from the Oracle card | `engine_gate_failed`, `characteristics_differ` |
| `mapped` | The engine knows the name, but the card does not load | `engine_load_failed` |
| `catalog_only` | In the catalog, not yet checked against the engine | `engine_unchecked` |
| `unsupported` | Not in the engine, in a layout this version does not know, or not a card a deck holds (tokens, emblems, art cards, schemes, memorabilia) | `not_implemented`, `unknown_layout`, `not_a_deck_card` |
| `suspended` | Held back by an administrator; no new game may start with it | `suspended_by_staff` |

### Only playable cards are in the game (v0.4.5)

At the owner's decision of 2026-10-21 ("If the engine can't play a card, and we can't make the engine play it, then we can remove it from the game entirely, for everyone"), a card that is not certified, or that Scryfall no longer lists, is out of the game for every account, players, administrators and SysOp alike. Search, card pages and their printings, the deck builder's finder, guided creation, deck imports, libraries, the alliance lists, Leng's packs and SysOp's deck lists know nothing of it; tokens, emblems and the other objects no deck holds leave search too. Only Administration's catalog review still lists such cards, because accepting or restoring one is how it comes back.

- **The catalog keeps every card**, with its status and reason, so a card comes back by itself when a release of the engine implements it (the next sync certifies it), or when an administrator accepts or restores it.
- **What went.** Until v0.4.5 such cards stayed searchable and labeled (T18), and since v0.3.0 the Cards page hid them until asked. "Show cards not playable yet", the "Playable here" filter, the "Not playable" badges and the search terms that named playability (`is:playable`, `is:unsupported`, `status:`) are gone; `GET /api/v1/cards` lost its `playable` and `extras` parameters, and `GET /api/v1/cards/{id}` answers 404 for a card out of the game, as for one that does not exist.
- **What follows.** Deck drafts lose such cards, with a note ([decks](decks.md#cards-that-leave-the-game-v045)); a pack that would pull one draws another from the same sheet ([shop](shop.md#buying-and-opening)); library copies of one stay recorded but hidden ([progression](progression.md#the-library)).
- **The game is untouched.** The table still names and pictures any card the engine puts on it, tokens included: the image cache looks every name up in the whole catalog ([the game screen](game-screen.md#cards)). Games, and the deck versions they played, keep their cards.
- **On 2026-10-22** about 2,600 deck cards were out (351 of them legal in Commander, mostly Un-cards and Attractions; the rest digital-only and playtest cards), with the 4,161 objects no deck holds. No starter deck and no engine fixture deck holds one.
- **Until v0.6.2.** Since then the deck cards the engine lacks are back in the game as stand-ins ([below](#stand-ins-v062)); what stays out is listed there.

### Stand-ins (v0.6.2)

The owner's decision of v0.6.2, after a pack summary showed Farmstead (Alpha) "In place of a card the game cannot play": "when tearing packs, I want the actual card to be there. No more replacing cards. In casual play, players should still be able to play those "illegal" cards, so let them have it." A deck card the engine cannot play as written is in the game again, for every account, players, administrators and SysOp alike, as a **stand-in**.

- **Which cards** (`catalog/statuses.py` `stand_in()`): a card a deck holds, still in Scryfall's catalog, whose status is `unsupported` (not implemented, or a layout this version does not know), `mapped` (its class does not load), `implemented` (held back by the gates) or `catalog_only` (not checked yet). `in_game()` is the certified cards and the stand-ins; `playable()` still means certified, where the engine must truly implement the card (the coverage counts, guided creation's proposals, the bots' starter decks).
- **Still out:** tokens, emblems, art cards and the other objects no deck holds (`NOT_A_DECK_CARD`, a meld's back face), cards Scryfall no longer lists, and cards the staff suspended. Administration's review lists them as before.
- **Where they show:** search and the Cards page, card pages and their printings, the deck builder's finder, deck imports, libraries and the alliance tab, Leng's packs, the auction house and SysOp's deck lists. Every card says whether it is one (`stand_in`, with `stand_in_note`), and the browser shows a "Stand-in" badge wherever a card's status shows (the Cards page, the card page, the library, the deck editor's rows and finder, the pack summary), titled "The game has no rules for this card yet: in casual games it plays as a stand-in with its cost, types, power and toughness."
- **How they play** ([games](games.md#stand-ins-v062)): with their printed cost, card types, subtypes, supertypes, power and toughness, loyalty and defense, and their own picture; their rules text has no effect. Casual tables, practice games and the queues take them; tournament rules refuse them ([the table's rules](tables.md#the-tables-rules-v045)), as they refuse banned cards.
- **A card the engine learns** becomes certified at the next sync and plays as written; nothing else changes for the decks and libraries that hold it.

### Prepare cards (v0.4.5)

Scryfall's `prepare` layout (Secrets of Strixhaven, Reality Fracture and their Alchemy cards; 72 cards on 2026-10-22) is a creature with a spell on its second face, which it may cast a copy of while it is prepared. Until v0.4.5 the catalog quarantined them (`unknown_layout`). It now reads them as it reads an adventure, which is how XMage implements them (its kind `adventure`): the front face names the card in a game and decides whether it may be a commander, both faces' names resolve in imports, and the wording check counts the spell's cost, which the engine prints among the card's rules. XMage 1.4.62 implements 66 of the 72. The six it lacks are not implemented: Whiplash Wordsmith // Vicious Verse (Reality Fracture), and five digital-only Alchemy cards, Crescendo Conductor // Boltwave, Galathul Galecaller // Corvid Squall and Ursine Guide // Ranger's Merit (Alchemy: Secrets of Strixhaven), Rootha, Ardent Artisan // Next Iteration and Zimone the Calculating // Simple Subtraction (Alchemy: Reality Fracture).

A version that learns a layout the last revision quarantined imports again as soon as its worker starts, from the files at hand, waiting for the engine as a first import does, so those cards are decided at once rather than at the next day's run (`catalog/sync.py`, `ensure_relearned`).

### The engine's implementation list

The engine image builds the list when it is built: every card XMage implements, listed once under its own name, with five gates run on each: its class resolves, an instance is created, its rules text is described, its faces are present, and a copy works. The engine serves the list at `GET /v1/service/implementations` (gzip, service token), and its build ID in `/health`. A sync fetches it when the build changed and compares each card with the Oracle record:
- **Characteristics.** Mana cost, card types and, for creatures, power and toughness must match (`*` and X values are skipped). A difference holds the card at `implemented`.
- **Wording.** The engine's rules text may still use older wording than today's Oracle text. A heuristic compares the symbols, numbers and words that matter after removing reminder text and names; a card that differs keeps its status and is marked `text_differs`, which the card details show. On the real data 92 cards are marked.
- **Oracle changes after certification (CAT08).** A certified card whose Oracle text changes stays playable and goes on the review list. An administrator accepts it (the engine still plays it as written) or suspends it.
- **Cards the checks held back (v0.4.5).** A card the engine implements whose gates failed, or whose characteristics differ from the Oracle card (`implemented`; 12 on 2026-10-22, mostly Un-cards and playtest cards), is out of the game and goes on the review list with what held it back. An administrator who finds that the engine plays it right accepts it: it is certified from then on, audited (`catalog.card_accept`), and the acceptance rides in the card's capabilities (`accepted`), which every sync keeps, as it keeps a suspension and the status it set aside. Like any certified card's, a later Oracle change puts it back on the review list.
- **Suspensions** take a card out of the game, and out of every deck's draft (v0.4.5), until an administrator restores it.

Coverage on 2026-10-20, engine build `1.4.62-eb69d05b-7909ff1a7bd0`: the engine lists 32,486 cards, all passing the gates; 32,089 card concepts are playable. Of the deck cards legal in Legacy, 31,711 are playable, 351 are not implemented and 67 used a layout that version did not know yet (`prepare`, read since v0.4.5: above). `GET /api/v1/catalog/coverage` gives the counts by format.

## Search (DECK03, DECK04)

`GET /api/v1/cards` takes filters (name, text, type, colors with exact/including/within, identity, mana value range, rarity, set, format) and a query in Scryfall's syntax, and finds only cards in the game (v0.4.5), the stand-ins among them since v0.6.2. Words are ANDed, `or` and parentheses group, and `-` negates. At most 500 characters, 40 terms and 8 levels of parentheses.

| Key | Example |
| --- | --- |
| `t:` `type:` | `t:legendary t:creature` |
| `o:` `oracle:` `text:` | `o:"draw a card"` |
| `name:` (or bare words) | `name:bolt`, `lightning` |
| `c:` `color:` | `c:rg`, `c>=w`, `c:colorless`, `c:azorius` |
| `id:` `identity:` `ci:` | `id<=wub` |
| `mv:` `cmc:` `manavalue:` | `mv<=3`, `mv:even` |
| `r:` `rarity:` | `r>=rare` |
| `s:` `set:` `e:` | `s:dmu` |
| `f:` `format:` `legal:`, `banned:` | `f:commander`, `banned:legacy` |
| `is:` | `commander`, `companion`, `partner`, `background`, `reserved`, `gamechanger`, `permanent`, and layouts (`split`, `mdfc`, `adventure`, `prepare`, ...) |
| `k:` `keyword:` | `k:flying` |
| `otag:` `function:` | `otag:removal` (includes the tag's children) |
| `year:` | `year>=2020` |

`is:playable`, `is:unsupported` and `status:` went in v0.4.5: every card found is one a game can play.

An unknown key or a malformed term is refused with a message that says what was wrong. Results sort by name, mana value, release date, popularity (EDHREC rank) or color, 60 a page by default (at most 100). Warm searches on the real catalog took 39–71 ms (median per query) and at most 120 ms; the first `otag:` query after a start takes about 450 ms while the tag tree loads.

## Routes

| Route | Who | |
| --- | --- | --- |
| `GET /api/v1/cards` | signed-in players | Search. Since v0.3.1 each card carries `owned`, the copies in the player's library (null when not limited), and `owned=true` keeps to the library ([the Planeswalker Alliance](progression.md#the-library)); since v0.5.0 `editions`, the editions it holds of the card |
| `GET /api/v1/cards/{id}` | signed-in players | A card with its faces, rulings, related cards, legalities, tags, status and newest 60 printings; `?printing=<id>` also lists that printing of the card when it is older (since v0.3.0, for a deck entry's chosen printing). Since v0.4.5 a card out of the game answers 404 (since v0.6.2 a stand-in is in it). Since v0.5.0 `printings=owned` lists only the editions the player's library holds (every printing for a basic land, or an account that builds from the whole catalog), `printings=chosen` only the `printing` given, and the card carries `editions`, the editions the library holds with their copies |
| `GET /api/v1/cards/{id}/printings` | signed-in players | Its English printings, newest first (404 for a card out of the game) |
| `GET /api/v1/sets` | signed-in players | Sets holding a card in the game, for the set filter |
| `GET /api/v1/catalog` | signed-in players | The current revision, the last run, the next scheduled run, whether it is stale (no successful run for 48 hours), format versions and counts |
| `GET /api/v1/catalog/coverage` | signed-in players | Counts per format, status and reason |
| `GET /api/v1/admin/catalog/runs` | `catalog.manage` | Recent runs |
| `POST /api/v1/admin/catalog/sync` | `catalog.manage` | Queue a run now (audited) |
| `GET /api/v1/admin/catalog/reviews` | `catalog.manage` | Cards to review: Oracle changes, since v0.4.5 the cards the checks held back, and suspended cards |
| `POST /api/v1/admin/catalog/cards/{id}/review` | `catalog.manage` | Accept (an Oracle change, or a card the checks held back), suspend (the card leaves every deck's draft) or restore a card (audited) |

`catalog.manage` belongs to administrators and SysOp. The Godlike tier's custom cards (v0.3.1) are not part of the catalog: they live in a table of their own, which no route above reads ([the custom cards](progression.md#the-godlike-tiers-custom-cards)). Card images for catalog printings come through the API's image cache at `GET /api/v1/card-images/printings/{id}`, so the browser still makes no request to Scryfall ([the game screen](game-screen.md#cards)).

## On screen

- **Cards** (the navigation's Cards page): every card in the game, with search, the syntax help, filters, sorting and pages; each card opens its details: images of every printing, Oracle text, legality, rulings, tags, the engine's wording when it may differ, and the illustrator of the image on show.
- **Its three tabs:** My library ([progression](progression.md#the-library)); All cards; and since v0.4.2 the allied Planeswalker's cards, named for them ("Teferi's cards"), which follow the alliance ([progression](progression.md#alliances)). Since v0.5.0 My library is the first tab and the page opens on it (the owner's request); an account that builds from the whole catalog, with no library to show, opens on All cards.
- **Which printings a card's details list** (v0.5.0, [the library by edition](progression.md#the-library-by-edition-v050)). Opened from All cards or the alliance's tab, every printing, and for a player who builds from a library the "Your library" line names each edition it holds with its copies. Opened from My library, only the editions the library holds, starting at the one opened. Opened from a pack at Leng's counter or in "Packs you opened", only the edition the pack held. The server decides: `GET /api/v1/cards/{id}?printings=all|owned|chosen` (below).
- **Pictures or a list** (v0.5.0, the owner's request that the library show the cards themselves). Every tab shows its cards' pictures first, My library included, where each tile says its copies and where they came from. A Pictures/List switch at the end of the result line turns a tab into a list (name and cost, type, and the copies a library holds); the switch is the same on all three tabs and the browser remembers it (`cd.cards.view.v1` in local storage, pictures when the browser keeps nothing). The Godlike tier's custom cards keep their picture beside their text either way.
- **My library's filters** (v0.6.2): set, type, mana value, rarity, finish, colour and a sort under its Filters button, beside "Find in your library" and "From", applied in the browser ([progression](progression.md#my-librarys-filters-v062)).
- **A card's picture, big** (v0.5.1, the owner's request: "click the cards ... to make them bigger and easier to read"). A click on a card's picture, on any of the three tabs and on the Godlike tier's custom cards too, shows the picture alone, as large as the screen allows, over a dimmed page (`CardZoom.tsx`): Scryfall's png, or the large image where a printing has none, of the edition the tile shows; a two-faced card turns over. A click anywhere, Escape or × closes it, and **Card details** opens the details the click opened before. A card with no picture opens its details at once. The picture in a card's details enlarges the same way, and in the list view a card's name still opens its details.
- **Images as Scryfall serves them.** A card image is never dimmed, recoloured, blurred, cropped or covered over its artist or copyright line (Scryfall's image rules).
- **Administration → Card catalog:** the sync's state and recent runs, "Run the catalog sync now", the engine's coverage per format, and the cards to review, with accept, suspend and restore (since v0.4.5 the cards the checks held back too, each with what held it back and Accept), and a search to suspend any other card.

## Testing without Scryfall

`tests/fixtures/scryfall` holds a 71-card slice of the four files, taken on 2026-10-20, and `tests/fixtures/engine_implementations.json` the engine's list for the same cards. Since v0.4.5 it holds a second prepare card, Abigale, Poet Laureate // Heroic Stanza (a legendary one), as Scryfall's API gave it on 2026-10-22, with XMage 1.4.62's implementation of it. The tests import them into a fresh database. `python scripts/load_fixture_catalog.py` imports the same slice into `CD_DATABASE_URL` for the browser journeys, which CI runs that way; it leaves a database that holds a catalog alone.
