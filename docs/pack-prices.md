# Pack prices for Leng's card shop

Research for v0.4.0, recorded on 2026-10-21. The data is in [`content/pack-prices.json`](../content/pack-prices.json). For each set and booster type in the shop, it holds the approximate US market price of one sealed English pack, with its source. The shop maps these USD prices onto its token curve (a current pack costs 500 tokens, a Revised pack 150,000). They are a snapshot of a moving market, not appraisals.

## What is in the list

- **392 products in 182 sets**, from Unlimited, Arabian Nights and Antiquities (1993–94) to Mystery Booster Commander Edition (released 2026-10-19). Reality Fracture (FRA, 2026-10-02) is the current set. Star Trek (TRK, 2026-11-13) and later sets are not out yet and are left out.
- The product list comes from MTGJSON 5.3.0+20261021 (MIT licence). It covers every set's `data.booster` entry that is a physical English pack. `set` is MTGJSON's set code and `booster` is MTGJSON's booster name, exactly as given, so the shop can join on them.
- **By booster type:** draft 136, theme 87 (35-card theme boosters, 2018–22), collector 51, default 21, six-card 19, play 19, set 18, tournament 13, Jumpstart 11 (`jumpstart` and `jumpstart-v2`), starter 7. One each: `premium`, `mirran`, `phyrexian`, `convention`, `convention-2021`, `vip`, `compleat`, `collector-special`, `value`, `chocobo-bundle`.

## How the prices were found

| Method | Count | Meaning |
|---|---|---|
| `pack` | 349 | A market price for one pack. 347 are TCGplayer market prices; 2 are PriceCharting prices (Unlimited and Arabian Nights, which have no TCGplayer market price). |
| `box` | 9 | A TCGplayer booster box (display) market price divided by the number of packs in it. All 9 are theme boosters with no sales of the pack itself. The displays hold mixed colours, so each pack gets the display average. |
| `estimate` | 34 | No usable market price. The `basis` gives the reasoning; `source` is null. |

**Sources**
- **TCGplayer** (356 rows): the "market price", which TCGplayer works out from recent completed sales. MTGJSON's sealed-product data gives each pack's TCGplayer product id. The 20 starter and tournament decks and Mystery Booster Commander Edition have no id in MTGJSON, so their ids were found with TCGplayer's own search. The price was read from the product data that the product pages load (`mp-search-api.tcgplayer.com/v2/product/<id>/details`). `source` links the product page, `https://www.tcgplayer.com/product/<id>`, which shows the same figure. `basis` records the TCGplayer product name and how many listings it had.
- **PriceCharting** (2 rows): its ungraded price, taken from completed sales.

**The 34 estimates**
- 19 six-card boosters (2009–13). They have no sales. Each is priced at 6/15 of its set's draft booster.
- 10 theme boosters with no sales of the pack or of its display. Each takes the average of its set's other theme boosters. The five Dominaria theme boosters have no sales at all, so they take the average of the theme boosters from the next three sets.
- Five one-offs:
  - **Summer Magic: $10,000.** A guess. There is no sale or listing anywhere; most of the print run was destroyed.
  - **Unlimited Starter Deck: $9,200.** Revised's starter-deck-to-pack ratio applied to the Unlimited pack.
  - **Ravnica Allegiance Collector Booster: $1,800.** A test-market product. The figure is the lowest of three TCGplayer asking prices; there are no sales.
  - **Compleat Edition booster: $257.** Sold only inside the Compleat Bundle, so it is the bundle's market price minus its 12 Set Boosters and extras.
  - **Bloomburrow Value Booster: $4.25.** Half a Bloomburrow Play Booster.

**Anchors check out.** Revised is $343.28 (earlier research said about $300). Current Play Boosters are $4–7; Reality Fracture's is $6.07.

**Cheapest and dearest.** The cheapest product is the Dragon's Maze six-card pack ($2.13, estimate). The cheapest priced from sales is the Aetherdrift Play Booster ($4.12). The dearest are Summer Magic ($10,000, estimate), the Unlimited Starter Deck ($9,200, estimate), the Unlimited booster ($3,383) and the Arabian Nights booster ($2,551).

## Judgement calls: included

MTGJSON describes each of these as a booster, and each was sold, or can be bought, as a single sealed item. Drop any of them by booster name if the shop should not sell it.

- **Starter decks** (`starter`: 2ED, 3ED, 4ED, ICE, MIR, 5ED, TMP) and **tournament packs** (`tournament`: 13 sets, 1998–2008). They are random 60- and 75-card sealed products, sold one at a time. MTGJSON calls Tempest's a "Starter Deck"; TCGplayer sells the same product as the "Tempest Tournament Pack".
- **Six-card boosters** (`six`, 19 sets). They are real packs, but they have no market today, so every one is an estimate.
- **Theme boosters** (`theme-*`, 87 products in 16 sets).
- **Boosters sold only inside a bigger product:**
  - Compleat Edition booster (`ONE/compleat`, from the Compleat Bundle)
  - Final Fantasy Chocobo Booster (`FIN/chocobo-bundle`, from the Chocobo bundle, $188.05 on TCGplayer)
  - Ravnica: Clue Edition booster (`CLU/default`, from the Clue Edition box)
- **Special packs:**
  - Mystery Booster convention editions (`MB1/convention`, `MB1/convention-2021`)
  - Double Masters VIP Edition (`2XM/vip`)
  - The Lord of the Rings Special Edition Collector Booster (`LTR/collector-special`)
  - 30th Anniversary Edition (`30A/draft`)
  - Bloomburrow Value Booster (`BLB/value`)
- **Sets outside the core set types whose physical English packs MTGJSON describes:**
  - Doctor Who and Fallout collector boosters (`WHO`, `PIP`, set type commander)
  - Avatar Eternal Jumpstart (`TLE`, eternal)
  - 30th Anniversary Edition (`30A`, memorabilia)
  - Secret Lair x MSCHF: The Zeta Set (`SLZ`, box): a 7-card booster pack

## Excluded, and why

| Excluded | Booster names or sets | Why |
|---|---|---|
| Alpha, Beta | LEA, LEB | Owner's decision: kept for tournaments. |
| Non-English sets | REN (French, German), RIN (Italian); FBB, FWB, 4BB, BCHR have no booster data either | No English printings. |
| Digital boosters (45) | `arena`, `play-arena`, `treasure-chest` | MTG Arena and MTGO only. |
| Japanese boosters (6) | `jp`, `set-jp`, `collector-jp`, `box-topper-jp` | Japanese-language packs. |
| Prerelease packs (135) | `prerelease`, `prerelease-*` | Prerelease promo packs and seeded prerelease kits; not sold as retail packs. |
| Promotional packs (71) | `promo`, `promo-foil`, `buyabox`, `duelspromo`, `showdown`, `preview` | Store and event giveaways. |
| Bundle and fat-pack inserts (30) | `fat-pack`, `bundle-*`, `gift-bundle-*`, `nightmare`, `codex-bundle`, `commander-bundle`, `pizza-bundle`, `secret-lair-bundle-promo`, `chocobo-bundle-scene` | 1–5 promo cards packed into a bundle, not a booster. |
| Collector samples (21) | `collector-sample` | 2-card sample inserts. |
| Box toppers (13) | `box-topper`, `box-topper-foil` | Only come inside booster boxes. |
| Beginner Box booster | `FDN/beginner` | Part of the Foundations Beginner Box; not sold on its own. |
| Signature Spellbooks | SS1, SS2, SS3 | A fixed 9-card box set (8 set cards and 1 foil), not a booster. |
| Secret Lair Drop | SLD | Its MTGJSON "boosters" are bonus-card inserts for each drop. |
| Not downloaded | promo, token and alchemy set types; online-only sets; sets released after 2026-10-21 | None of them sells physical English packs on sale by 2026-10-21. |

## Gaps in MTGJSON's booster data

**In-scope sets with no booster data.** These 35 sets have no booster entry in MTGJSON:

- **Foreign-only, excluded anyway:** FBB, FWB, 4BB, BCHR.
- **Sold as packs, with no booster data:** Starter 2000 (S00). MTGJSON lists its sealed "Advanced", demo and sampler packs, but no booster.
- **No packs of their own:**
  - Subsets drawn from other sets' boosters: TSB, BIG, H1R, H2R, SLX, PLST, ULST, CMB1, CMB2.
  - Decks and box sets: ITP, CP1–CP3, W16, W17, UND.
  - Promotional or unusual products: HHO, H17, PTG, UNK, PUNK, SUNF, PHTR, PH17–PH23.

**Packs that MTGJSON lists as sealed products but gives no booster for.** None of these is in the shop:

- Marvel Super Heroes "Jumpstart 2" booster (TCGplayer 707093)
- "Jumpstart 2022 2" booster (704142)
- Seventh, Eighth and Ninth Edition "Advanced" boosters
- Portal and Portal Second Age demo-game packs

Hanger, sleeved, retail and minimal-packaging versions are the same boosters in other packaging. Their prices were not used.

**One link added by hand.** MTGJSON does not link the Mystery Booster Commander Edition pack to its `draft` booster, so the link was made by hand.

## Prices to treat with care

These have thin or odd data. The flags come from TCGplayer's listing counts and lowest asking prices, read on the same day.

- **Very uncertain:**
  - Summer Magic and the Unlimited Starter Deck (guesses; see above)
  - Ravnica Allegiance Collector Booster (asking prices only)
  - Unlimited booster: PriceCharting $3,383, but ungraded sales in 2026 ranged from $3,383 to $5,700, and TCGplayer asks $13,888.88
  - Arabian Nights: PriceCharting $2,551; TCGplayer asks $2,600–4,500
- **Market price probably stale** (asking prices are now over twice the market price):
  - Portal ($35.29 against $89.97 asked)
  - Portal Three Kingdoms ($538.73 against $1,299.90 asked)
  - Throne of Eldraine black, blue and white theme boosters (about $12 against $35)
  - Adventures in the Forgotten Realms white theme booster ($10.80 against $22)
- **No more than one listing:**
  - Decks: Classic Sixth Edition, Mercadian Masques and Shadowmoor tournament decks
  - Packs: Shards of Alara Premium Foil, 30th Anniversary Edition ($371.90)
  - Theme boosters: many 2018–22 ones (Guilds of Ravnica, Ravnica Allegiance, War of the Spark, Core Set 2020, Ikoria, Zendikar Rising Party, Kaldheim, Midnight Hunt Werewolves) and the Guilds of Ravnica theme display behind three `box` rows
- **Low concern:** a few current products have a stray cheap listing far below the market price. They are Marvel Super Heroes Play ($0.50 listed) and Jumpstart, Innistrad Remastered Play, and March of the Machine Jumpstart. The market price looks right.
- **Mapped to TCGplayer by name:** the 20 starter and tournament decks and Mystery Booster Commander Edition. Check them if the names matter.

Prices move. TCGplayer market prices of old sealed product can swing 20–50% in a few months, so refresh the list before each pricing review.
