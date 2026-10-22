# Leng's card shop (v0.4.0)

Since v0.4.0 players spend the tokens their wins earn on booster packs in Leng's card shop. A pack opens at Leng's counter in the Magic Duels style, and its cards join the player's library for good. The owner's decisions are in [the v0.4.0 plan](plans/0.4.0.md#decisions-at-the-start-of-v040). There is no real money anywhere: tokens are play money, and no price in dollars is ever shown to a player (PROG03, PAR18).

## Products

- **The list.** `content/pack-prices.json` lists 392 booster products in 182 sets, from Unlimited to the current set ([how it was made](pack-prices.md)). Each is an MTGJSON set code and booster name, with the market price of one sealed pack in US dollars, its method and its source.
- **Every booster type** MTGJSON describes is a product of its own: draft, set, collector, play and Jumpstart boosters, theme boosters, six-card boosters, starter decks, tournament packs and the special packs.
- **Unlimited, Arabian Nights and Antiquities are sold**, at the top of the price list. **Alpha and Beta never are**: they are kept for tournaments. The API refuses them even if a list named them.
- **Sets after the list.** The booster data job adds the expansions, core sets, Masters and draft sets that MTGJSON's set list shows released since the list's date (`as_of`), with their play, draft, set, collector, Jumpstart and plain boosters. They cost 500 tokens until priced.
- **The shop's page** groups the products on sale by era (Play Boosters, Set and Collector Boosters, the M15 frame, Mythic rares, the modern frame, the old border, the first years), with filters by year and booster type, a search by set name or code, and sorting by date or price.

## The booster data

- **Source and licence.** Pull ratios come from [MTGJSON](https://mtgjson.com)'s set files (MIT licence): `data.booster.<name>` gives each booster's layouts, each with a weight and how many cards it takes from each sheet, and its sheets, each a weighted list of cards with its foil flag and rules. Each card's Scryfall ID ties it to our catalog. The shop says where its data comes from.
- **The job.** The worker runs the booster data job weekly, on Monday an hour after the catalog's daily sync, and when an administrator asks ("Run the booster data job now" in Administration). The first run waits for the catalog's first import. A run:
  1. brings the products up to the price list, and adds sets released since it;
  2. fetches each product's set file, and the files of the sets its sheets draw from (The List, Special Guests and so on), one at a time with a half-second pause, from `https://mtgjson.com/api/v5/<SET>.json.xz` (Conflux is `CON_`). It asks only for files changed since the last fetch (ETag and If-Modified-Since); an unchanged file is read from the worker's folder (`<CD_CATALOG_DIR>/mtgjson`);
  3. resolves every sheet card through its Scryfall ID to a catalog printing, and so to its card;
  4. stores each product's **collation** (`booster_collations`): its layouts and weights, and its sheets with each card's printing, weight, colours and finish, the sheets' foil flags and rules, the MTGJSON version and the files' SHA-256. A collation that differs from the current one is a new revision; the old ones stay, since the packs opened from them name them (PROG02).
- **How long.** On a copy of the development database (the full catalog) on 2026-10-21, the first run fetched 241 set files and the set list (94 MB) and stored 392 collations in 2 minutes 31 seconds; every product resolved. A second run downloaded nothing (every file "not modified") and stored nothing new, in 2 minutes 47 seconds, most of it the pauses between requests.
- **Gaps.** A product with any card the catalog cannot resolve is **not sold until it can be**. Administration lists the product and the first 25 such cards. A product whose booster MTGJSON does not describe is marked missing and not sold either. Packs already held still open with the last good collation.
- **Failures.** MTGJSON unreachable, slow or limiting is retried with backoff, up to six attempts; the last good collations stay in use. The final transaction holds the job's lease, as the catalog's does, so a run another worker took over writes nothing.
- **Tests and the browser journeys** never fetch MTGJSON. `tests/fixtures/mtgjson/ZNR.json` is a made-up set file whose Zendikar Rising draft booster draws from the test catalog's cards; `scripts/load_fixture_catalog.py` loads it with the test catalog.

## Prices

- **The curve.** A product's price in tokens follows its market price on a curve anchored at the current set's Play Booster (Reality Fracture, $6.07: 500 tokens) and Revised ($343.28: 150,000 tokens):

  `tokens = 500 × (usd / 6.07) ^ k`, with `k = ln 300 / ln(343.28 / 6.07)` (about 1.41),

  rounded to two significant figures. Some examples: the cheapest pack ($2.13) 110 tokens, Zendikar Rising Draft ($4.97) 380, Antiquities ($566.75) 300,000, Unlimited ($3,383) 3,800,000.
- **No market price** (a set after the list): 500 tokens until priced.
- **Staff's prices.** SysOp and administrators (permission `shop.manage`) may set any product's price in tokens, or return it to the curve, and take any product off sale or put it back. Each change needs a reason, is stored in the database apart from the content file, and is audited (`shop.price_changed`, `shop.sale_changed`). A product off sale can still be given, and packs already held still open.

## Buying and opening

- **Buying** (PROG02, PROG03, SEC03). The price leaves the balance and an unopened pack joins the inventory in one transaction. The account's row is locked, so two purchases at once cannot spend the same tokens, and a balance never goes below zero. The ledger entry's key is `pack:<pack id>`. The browser sends a key of its own making with each purchase: a retried request finds the pack that key bought and buys nothing more.
- **Opening** takes one pack from the inventory. In one transaction the server:
  - draws its contents from the product's current collation with the operating system's secure randomness: a layout by weight, then each slot from its sheet by weight. Nothing the browser sends reaches the draw;
  - records the opening: the collation revision, the layout, and each card's printing, finish and sheet, in the order the pack is revealed (commons first, the rarest last, foils after them);
  - grants the cards to the library for good (`library_grants`, source `pack`, key `pack:<opening id>`), counting copies per card;
  - revalidates the player's decks, so a deck the new cards complete is no longer collection-locked.
  A pack opens once: asking again returns the same cards, and two requests at once open it once. Openings are append-only, as the ledgers are.
- **The draw's rules**, from MTGJSON's data:
  - **fixed** sheets give their cards as listed (a Jumpstart theme, a pair always packed together);
  - **colour-balanced** sheets taking five or more cards give one card of each colour first, then the rest from the whole sheet;
  - a pack never holds the same printing twice in the same finish, unless the sheet allows duplicates (a foil copy of a card in the pack may come too);
  - foil sheets give foils, etched foils where the sheet or the printing says so.
- **"New"** marks a card the library held no copy of for good before (an alliance's cards come and go, so they do not count). Basic lands are in every library already, and tokens or art cards are no deck's: they are revealed but not granted.
- **The opening** at Leng's counter: the pack (its own picture since v0.4.3) tears open, the cards are dealt face down and turn over one at a time (a click, or Space), rares glow gold and mythic rares orange, foils shimmer, each with a sound generated in the browser through the table's sound module and at its volume; "Reveal all" turns the rest. A summary follows, with new cards marked and each card's details a click away. With reduced motion every step is immediate and nothing moves; larger text enlarges the cards.
- **History.** "Packs you opened" lists every opening, newest first; each can be shown again.

## Starter decks (v0.4.2)

The shop's second tab, beside the packs, sells the ten Commander starter decks ([progression](progression.md#the-starter-decks)), at the owner's request at the start of v0.4.2.

- **The first two are free.** A new account chooses them in the setup wizard; until then the tab shows each deck as free, with a button that opens the wizard, and sells none (`409 starters_first`). The 1,000 welcome tokens stay for packs.
- **After them, each sells once** (`POST /api/v1/shop/decks`, with the deck's ID; permission `decks.edit`). In one transaction the price leaves the balance, the deck becomes a deck of the player's own, and every copy of its cards joins the library for good, exactly as choosing it would have (`library_grants`, source `starter`, key `starter:<deck>`). The ledger entry is a shop purchase (kind `pack`), keyed `deck:<account>:<deck>` and named "Starter deck: <title>", so a retried request buys nothing more and answers with the deck it bought (`repeated`). A deck chosen or bought shows "In your decks" (`409 deck_owned`). Each shows its commander's card.
- **Priced by its cards.** `content/starter-deck-prices.json` holds the market value of the cards each deck grants, basic lands left out (a library holds those without limit), each at the market price of the printing the owner chose for it, as Scryfall gave it on 2026-10-21 (TCGplayer's market price); a printing with no price takes the cheapest printing of the same card. `scripts/starter_deck_prices.py` reads them again. The API turns a deck's value into tokens at the current pack's rate, 500 tokens for $6.07, so a dollar of cards costs what a dollar of a current pack does, rounded to two significant figures as packs are (`api/products.py`). A deck the file does not price is not sold. Players never see the dollars.
- **What that gives.** Each deck holds one Revised dual land, which is most of its value: on 2026-10-21 the ten cost from 35,000 tokens (Forged in Battle, $423.02) to 94,000 (Graveyard Shift, $1,145.58). Without their dual lands their cards come to about $30–46, about 2,500–3,800 tokens.

## SysOp gives packs

SysOp gives unopened packs to any account, its own included (permission `economy.manage`): 1 to 100 of one product at a time, with a reason, audited (`shop.packs_granted`). Administration's Card shop tab has the form. Administrators see the shop's data but give nothing.

## The scope's notes

- **PROG02** asks that virtual packs not imply retail odds. The owner wants real ratios, so the shop follows MTGJSON's published collation and says where it comes from: it describes real packs as well as the community has recorded them, not a promise of any retail product's odds.
- **PROG03.** Purchases are ledger entries with unique keys, the balance is the ledger's sum, and staff's changes are audited. Grants of packs carry a reason and an audit entry.
- **Ownership** is an application progression concept, not ownership of a physical or licensed card (scope section 2). Pulled cards stay in the library whatever the alliance.

## Pack artwork (v0.4.3)

Every product on the shelves shows a picture of its sealed pack: on the shelf, among "Your packs", in "Packs you opened", and at Leng's counter, where the pack that tears open is the product's own picture, its top strip torn from the rest. The starter decks keep their commanders' cards.

- **The real packs.** At the start of v0.4.3 the owner chose the real pack designs, retailers' images included, and accepted the licence risk of copying a retailer's product photos (2026-10-22). `scripts/pack_art.py` copied them once from TCGplayer: the product the price list names (its `source`, or a product id in its `basis`), checked by its name to be the pack itself, not a box, display, bundle or case; TCGplayer's search otherwise. Wizards of the Coast's own pages were to fill the gaps, but on 2026-10-22 they showed none of the packs TCGplayer lacks, so the script's Wizards path (a per-product override) is unused so far. The site serves its own copies, `web/public/packs/<set>-<booster>-160.webp` and `-480.webp`, and never hotlinks; `content/pack-art.json` records each picture's TCGplayer page, image address and product name.
- **What it found** on 2026-10-22: a picture for 365 of the 392 products, all from TCGplayer, 10.1 MB for both sizes. TCGplayer holds only about 200 × 350 pixels of many packs from before 2015; their large file keeps that size rather than being enlarged. The other 27 are drawn (below), each with its reason in the manifest: the 19 six-card boosters, Summer Magic, the Bloomburrow Value Booster and the Compleat Edition booster (no pack of their own on TCGplayer), the Alara Reborn and Worldwake draft boosters (TCGplayer's pictures are missing), Coldsnap (three packs fanned out, too small to cut one from), Scars of Mirrodin (TCGplayer shows the set's logo) and The Zeta Set (a promotional layout).
- **The cut-out.** Each picture's plain background becomes transparent: only background-coloured pixels connected to the picture's border go, so white inside a pack stays; for the older, smaller pictures, whose silver crimps are as light as the background, everything outside the pack's outline goes. Every picture was looked at on contact sheets; the script's overrides turn Conspiracy upright and find Unlimited and Arabian Nights by their TCGplayer ids, which its search misses.
- **The drawn pack.** A product with no picture, a picture that fails to load, and every set the booster data job adds after the price list are drawn in the browser (`web/src/shop/PackArt.tsx`): a crimped pack in the set's own colours (a hue from its code, the same every time, with its era's saturation and lightness), its era's texture (cross-hatching in the first years, then speckles, pinstripes, the mythic era's rays, a lattice, a foil sheen and the play-booster era's broad bands), the set's name, its expansion symbol in a medallion (an oval before 2003), and a band naming the booster type in that type's colour (a theme booster in its colour, a guild's in both). A set without a symbol shows its code.
- **Set symbols** are Scryfall's set icons (`icon_svg_uri`), reduced by the script to plain shapes, with no scripts, styles, links or references: `web/public/sets/<set>.svg` for 180 of the 182 sets (Scryfall has none yet for Mystery Booster and Mystery Booster Commander Edition, whose packs have pictures anyway). Conflux's file is `con_.svg`, since Windows refuses CON as a file name.
- **The API** reads the manifest, and every answer that names a product (the shelves, the packs held, purchases, openings, the history, Administration) carries its `art` (both files with their sizes, and the origin; null when the pack is drawn) and its set's `symbol`. Only files under `/packs/` and `/sets/` count.
- **Loading.** A picture loads when it comes into view, at its known size, so nothing shifts; a screen with twice the pixels takes the large file. The pictures, symbols and Leng's painting are outside the installed app's precache, as the portraits are, and browsers keep them for 7 days.
- **Running it again:** `python scripts/pack_art.py` (it needs Pillow; the API image has it) fetches only what its cache, `.local/pack-art` (git-ignored), lacks, one request at a time, half a second apart. `--only ZNR` or `--only znr:draft` redoes some products, `--sheets <folder>` writes contact sheets of the small pictures to look at before committing, and `--offline` uses the cache alone. A set the booster data job adds stays drawn until the price list names it and the script runs again.

## Leng's counter (v0.4.3)

Leng behind his counter is the owner's painting (supplied 2026-10-22): a hooded old shopkeeper at a wooden counter, with shelves of booster packs behind him. It stands at the top of the shop, in three sizes (`web/public/shop/leng-640.webp`, `-960.webp` and `-1448.webp`), and, blurred and dimmed, behind every pack opened at the counter. It replaced the SVG placeholder of v0.4.0 and is listed in [asset provenance](asset-provenance.csv).
