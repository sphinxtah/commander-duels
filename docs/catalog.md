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
| `catalog_only` | In the catalog, not in the engine | `not_implemented`, `unknown_layout`, `engine_unchecked` |
| `unsupported` | Not a card a deck holds: tokens, emblems, art cards, schemes, memorabilia | `not_a_deck_card` |
| `suspended` | Held back by an administrator; no new game may start with it | `suspended_by_staff` |

Unsupported and uncertified cards stay searchable and labeled, and are blocked from play (T18). Since v0.3.0 the Cards page hides them by default, at the owner's request: it opens on playable cards, and "Show cards not playable yet" beside the result count, the "Playable here" filter, or a search that names playability (`is:unsupported`, `status:catalog_only`) shows them, each with its “Not playable” badge (the reason is in the card's details, and screen readers hear it with the badge). "Clear filters" goes back to playable cards. The deck editor's finder shows only playable cards while “Only cards this deck can use” is ticked, as it is by default. SysOp's own practice decks may still use any card the engine implements.

### The engine's implementation list

The engine image builds the list when it is built: every card XMage implements, listed once under its own name, with five gates run on each: its class resolves, an instance is created, its rules text is described, its faces are present, and a copy works. The engine serves the list at `GET /v1/service/implementations` (gzip, service token), and its build ID in `/health`. A sync fetches it when the build changed and compares each card with the Oracle record:
- **Characteristics.** Mana cost, card types and, for creatures, power and toughness must match (`*` and X values are skipped). A difference holds the card at `implemented`.
- **Wording.** The engine's rules text may still use older wording than today's Oracle text. A heuristic compares the symbols, numbers and words that matter after removing reminder text and names; a card that differs keeps its status and is marked `text_differs`, which the card details show. On the real data 92 cards are marked.
- **Oracle changes after certification (CAT08).** A certified card whose Oracle text changes stays playable and goes on the review list. An administrator accepts it (the engine still plays it as written) or suspends it.

Coverage on 2026-10-20, engine build `1.4.62-eb69d05b-7909ff1a7bd0`: the engine lists 32,486 cards, all passing the gates; 32,089 card concepts are playable. Of the deck cards legal in Legacy, 31,711 are playable, 351 are not implemented and 67 use a layout this version does not know yet (`prepare`). `GET /api/v1/catalog/coverage` gives the counts by format.

## Search (DECK03, DECK04)

`GET /api/v1/cards` takes filters (name, text, type, colors with exact/including/within, identity, mana value range, rarity, set, format, playable) and a query in Scryfall's syntax. Words are ANDed, `or` and parentheses group, and `-` negates. At most 500 characters, 40 terms and 8 levels of parentheses.

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
| `is:` | `commander`, `companion`, `partner`, `background`, `playable`, `unsupported`, `reserved`, `gamechanger`, `permanent`, and layouts (`split`, `mdfc`, `adventure`, ...) |
| `k:` `keyword:` | `k:flying` |
| `otag:` `function:` | `otag:removal` (includes the tag's children) |
| `year:` | `year>=2020` |
| `status:` | `status:implemented` |

An unknown key or a malformed term is refused with a message that says what was wrong. Results sort by name, mana value, release date, popularity (EDHREC rank) or color, 60 a page by default (at most 100). Warm searches on the real catalog took 39–71 ms (median per query) and at most 120 ms; the first `otag:` query after a start takes about 450 ms while the tag tree loads.

## Routes

| Route | Who | |
| --- | --- | --- |
| `GET /api/v1/cards` | signed-in players | Search. Since v0.3.1 each card carries `owned`, the copies in the player's library (null when not limited), and `owned=true` keeps to the library ([the Planeswalker Alliance](progression.md#the-library)) |
| `GET /api/v1/cards/{id}` | signed-in players | A card with its faces, rulings, related cards, legalities, tags, status and newest 60 printings; `?printing=<id>` also lists that printing of the card when it is older (since v0.3.0, for a deck entry's chosen printing) |
| `GET /api/v1/cards/{id}/printings` | signed-in players | Its English printings, newest first |
| `GET /api/v1/sets` | signed-in players | Sets, for the set filter |
| `GET /api/v1/catalog` | signed-in players | The current revision, the last run, the next scheduled run, whether it is stale (no successful run for 48 hours), format versions and counts |
| `GET /api/v1/catalog/coverage` | signed-in players | Counts per format, status and reason |
| `GET /api/v1/admin/catalog/runs` | `catalog.manage` | Recent runs |
| `POST /api/v1/admin/catalog/sync` | `catalog.manage` | Queue a run now (audited) |
| `GET /api/v1/admin/catalog/reviews` | `catalog.manage` | Cards to review, and suspended cards |
| `POST /api/v1/admin/catalog/cards/{id}/review` | `catalog.manage` | Accept, suspend or restore a card (audited) |

`catalog.manage` belongs to administrators and SysOp. The Godlike tier's custom cards (v0.3.1) are not part of the catalog: they live in a table of their own, which no route above reads ([the custom cards](progression.md#the-godlike-tiers-custom-cards)). Card images for catalog printings come through the API's image cache at `GET /api/v1/card-images/printings/{id}`, so the browser still makes no request to Scryfall ([the game screen](game-screen.md#cards)).

## On screen

- **Cards** (the navigation's Cards page): playable cards by default, with search, the syntax help, filters, sorting and pages; each card opens its details: images of every printing, Oracle text, legality, rulings, tags, why it is or is not playable here, and the illustrator of the image on show.
- **Its three tabs:** All cards; My library ([progression](progression.md#the-library)); and since v0.4.2 the allied Planeswalker's cards, named for them ("Teferi's cards"), which follow the alliance ([progression](progression.md#alliances)).
- **Images as Scryfall serves them.** A card image is never dimmed, recoloured, blurred, cropped or covered over its artist or copyright line (Scryfall's image rules); a card that is not playable says so in its caption and badge instead.
- **Administration → Card catalog:** the sync's state and recent runs, "Run the catalog sync now", the engine's coverage per format, and the cards to review, with accept, suspend and restore, and a search to suspend any other card.

## Testing without Scryfall

`tests/fixtures/scryfall` holds a 70-card slice of the four files, taken on 2026-10-20, and `tests/fixtures/engine_implementations.json` the engine's list for the same cards. The tests import them into a fresh database. `python scripts/load_fixture_catalog.py` imports the same slice into `CD_DATABASE_URL` for the browser journeys, which CI runs that way; it leaves a database that holds a catalog alone.
