# Tivit's Auction House (v0.6.0)

Since v0.6.0 players auction cards to each other at Tivit's Auction House, a market that works like Madden Ultimate Team's transfer market: a starting bid, an optional Buy Now price, bids held from the bidder's tokens, and the screens Madden has for it (the market's search, the transfer list, the transfer targets, comparing prices). The owner's decisions are in [the v0.6.0 plan](plans/0.6.0.md#decisions-at-the-start-of-v060). Tokens are play money: nothing here is worth real money, and no price in dollars is ever shown (PROG03, PAR18).

## What is sold

- **One copy per auction:** one card in one edition (printing) and one finish (nonfoil, foil, etched). Editions and finishes are separate items, and are not worth the same; searches and listings name both. A listing request may name a quantity of 1 to 20, which makes that many auctions of the same edition and finish at once.
- **Any granted copy:** from a pack, a starter deck (chosen free or bought), a grandfathered deck (v0.3.1), or bought here. Since v0.6.0 basic lands are copies like any card ([the library by finish](progression.md#the-library-by-finish-and-basic-lands-v060)), so they are sold like any.
- **Never** an unopened pack, an alliance's cards (they are in the library while the alliance lasts; they are no granted copy), a one-of-a-kind printing (`ONE_OF_A_KIND`, [one of a kind](progression.md#one-of-a-kind-v051)), or the Godlike tier's custom cards (`422 not_sellable`, with the reason).
- **SysOp** has full access (the owner's standing rule): its library is the whole catalog, so it may list any printing, in any finish the printing was printed in, without holding a copy, the one-of-a-kind printing aside. An unsold SysOp listing returns nothing, as it took nothing.
- **Administrators** build from the whole catalog too, but list only the copies actually granted to them.

## A listing

- **The seller sets** the starting bid (at least 1 token), an optional Buy Now price (more than the starting bid) and the length: 1 hour, 3 hours, 12 hours, 24 hours, 3 days, 7 days, 30 days (7 and 30 since v0.6.3) or unlimited. There is no limit on prices beyond 10,000,000,000 tokens (`422 invalid_price`).
- **Unlimited listings** (v0.6.3, the owner's choice: Buy Now only, as eBay's Good 'Til Cancelled). An unlimited listing needs a Buy Now price (`422 buy_now_required`), which is its starting bid too, and has no end (`ends_at` is null; `duration` is `unlimited`). It takes no bids (`409 buy_now_only`), so it never comes due and never expires: it runs until someone pays Buy Now, the seller withdraws it (at any time, as it has no bids) or SysOp cancels it. The market sorts it after every auction with an end, and "time left" filters leave it out. Relisting may change its length either way.
- **The copy leaves the library at once.** A library is its grants less the copies on its live and sold listings (since any reset). A deck that relied on the copy becomes collection-locked by the usual validation, and the seller's decks are revalidated, as opening a pack does. Unsold, withdrawn or cancelled, the copy comes back and the decks are revalidated again.
- **Withdrawing** is the seller's, until the first bid (`409 has_bids` after it).
- **Relisting** an unsold auction (expired, withdrawn or cancelled) makes a new auction for the same copy, with new prices and length, if the library still holds it (`409 not_enough_copies`); an auction is relisted once (`409 not_relistable`).

## Bids

- **The next bid** is the starting bid for the first bid; afterwards the current bid and 5% more, rounded up, at least 1 token more (`current + max(1, ceil(current × 0.05))`). `next_bid` says it.
- **Bids are held.** A bid takes its whole amount from the bidder's balance at once (a ledger entry of kind `bid`); when it is outbid, the amount comes back (`bid_return`). The balance must cover it (`409 not_enough_tokens`) and never goes below zero.
- **Refused:** a bid on one's own auction (`409 own_auction`), a bid by the leading bidder (`409 already_leading`), a bid under the next bid (`409 bid_too_low`, naming it), a bid on an auction that ended (`409 auction_ended`).
- **Anti-snipe.** A bid in the last 30 seconds pushes the end to 30 seconds after the bid.
- **Buy Now** buys at the Buy Now price and ends the auction at once; the leading bid, if any, comes back. A bid at or above Buy Now buys at Buy Now, for the Buy Now price. An auction with no Buy Now price refuses it (`409 no_buy_now`).
- **Unlimited auctions take no bids** (`409 buy_now_only`): only Buy Now.
- **Watching.** Any auction can be watched (a star); a bid watches it too.

## The end

- **Sold:** to the leading bid when the time runs out, or at once by Buy Now. The winning bid's hold is the payment, and the seller is paid exactly that amount: **no fee**, the buyer's tokens go 100% to the seller (`sale`). The buyer's library is granted that edition and finish for good (`library_grants`, source `auction`, key `auction:<id>`), and their decks are revalidated. A copy bought is a granted copy: it may be listed again. It is not a copy printed again, so print runs do not count it ([print runs](shop.md#print-runs-v051)).
- **Unsold:** with no bid, the auction expires and the copy comes back.
- **Cancelled:** SysOp cancels any live auction with a reason, audited: the leading bid comes back, and the copy.
- **Settlement.** Auctions end by time. The worker settles the ended ones every 10 seconds, and every read of the auction house (the market, an auction, the lists, comparing, the log) first settles any auction past its end, so none shows as active after it ended. Settling re-reads the auction under its row's lock and does nothing to one already settled, so the worker and a read settling the same auction at once settle it once.

## Accounts reset or deleted

A reset ([identity](identity.md#resetting-an-account-v045)) or a deletion of an account first ends that account's live auctions, as SysOp's cancellation does (the cards back, the leading bids returned to their bidders; one past its end but not settled yet settles as it would have), and returns that account's own leading bids to it; another player's auction it led goes on without a bid, its next bid the starting bid again. This happens before the account's row is locked, and once more after, for a bid that came in meanwhile. A reset's tokens are then counted with the bids returned. The auctions before a reset no longer count in the account's library, transfer list or targets, as its grants do not.

## The ledger

| Kind | Amount | Key | Reason |
| --- | --- | --- | --- |
| `bid` | the bid, negative | `bid:<bid>` | "Bid on Lightning Bolt (Revised Edition #162, foil)"; a Buy Now "Bought …" |
| `bid_return` | the bid | `bid_return:<bid>` | "Outbid on …"; "Bid returned: … (cancelled)", "(account reset)", "(account deleted)" |
| `sale` | the winning bid, to the seller | `sale:<auction>` | "Sold … to bob" |

A nonfoil copy's reason names no finish. `GET /me/tokens` carries `auctions`, the net of these three kinds (sales less bids held and paid). Every sale is in both players' ledgers: the buyer's `bid`, the seller's `sale`.

## Locks and retries

- **Every change locks the auction's row first** (`SELECT … FOR UPDATE` on PostgreSQL, re-read under the lock), **then the accounts whose tokens move, in the order of their IDs**, as paying a game's winners does: the bidder, the leading bidder, and on a sale the seller. So two bids at once, a bid racing Buy Now, a bid racing the end, and settlement racing a read queue one after the other. A reset or deletion locks the account's auctions first, by ID, then the accounts.
- **A listing locks the seller's row**, so two listings never take the same copy.
- **Every POST carries the client's `key`** (8 to 64 letters, digits, `-` or `_`): a retried listing, relisting, bid or Buy Now finds what its key made and makes nothing more, as the shop's purchases do. A bid's key used on another auction is refused (`409 key_reused`).
- SQLite (the tests' database) runs one request at a time; the races are checked on PostgreSQL.

## The bell

Five kinds ([the bell](social.md)), each naming the auction (its `auction`: the auction's ID, the card's name, set code and number, the finish, and a price) and linking to the auction house:
- `auction_outbid`: your bid was outbid (the actor is the new bidder; the price the leading bid now). To `/auctions/targets`.
- `auction_won`: you won an auction (the actor is the seller; the price paid). To `/auctions/targets`.
- `auction_sold`: your auction sold (the actor is the buyer; the price). To `/auctions/list`.
- `auction_unsold`: your auction ended with no bid. To `/auctions/list`.
- `auction_cancelled`: SysOp cancelled an auction you sold or led, or the seller's account was reset or deleted. To `/auctions/list` or `/auctions/targets`.

## Administration

- **The log** (`GET /admin/auctions`, administrators with the permission `auctions.manage`, and SysOp): every auction, newest first, filtered by status: with `status=sold`, every sale with its seller, buyer, card, edition, finish, price and time; the cancelled ones with their reason in the audit trail.
- **Cancelling** (`POST /admin/auctions/{id}/cancel`, with a reason of 3 to 200 characters) is SysOp's alone (`economy.manage`).
- **Audit events:** `auction.listed` (each auction, with its prices and length, and the auction relisted), `auction.withdrawn`, `auction.sold` (the buyer as actor, the seller as target, the price, whether by Buy Now), `auction.cancelled` (SysOp as actor, or none for a reset or deletion, with the reason).

## Data

Migration `0028_auction_house`:
- `auctions`: the seller, the card and its printing and finish, the starting bid, Buy Now and length, the status (`active`, `sold`, `expired`, `withdrawn`, `cancelled`), the leading bid and bidder kept on the row with the count of bids, the buyer and price, the client's key and the listing's index (unique per seller), the auction relisted (unique), the cancellation's reason and actor, when the seller cleared it from the transfer list, and its times (made, ends, ended).
- `auction_bids`: each bid's bidder, amount, whether it was Buy Now, its status (`held`, `returned`, `won`) and the client's key (unique per bidder).
- `auction_watches`: an account's watched auctions, and when it cleared an ended one from its targets.
- `library_grants.finish`, the source `auction`, the ledger's three kinds (a `bid` is never positive) and the bell's five kinds; see [progression](progression.md#the-library-by-finish-and-basic-lands-v060) for the back-fill.
- Its downgrade ends the live auctions (the leading bids back, as grants of tokens), takes each sold copy out of its seller's grants and keeps the buyers' as grandfathered copies, turns the auction house's ledger entries into grants (what they moved stays in the balances), and drops the tables.

## The API

Prefix `/api/v1`; JSON; times ISO-8601 UTC; tokens integers; errors `{code, message}`.

- `GET /auctions`: the market, live auctions only, never the viewer's own unless `include_mine=true`. Filters: `q` (the card's name contains), `set` (set code), `rarity`, `finish`, `color` (W, U, B, R, G, C for colorless; any of them) repeatable, `type` (the type line contains), `min_bid`/`max_bid` (on the current bid, else the starting bid), `min_buy_now`/`max_buy_now`, `buy_now_only`, `max_time_left` (seconds). `sort`: `ending` (default), `newest`, `price_low`, `price_high`, `buy_now_low`. Pages: `cursor` (opaque) and `limit` (24, at most 60). → `AuctionPage {items, next_cursor, total}`.
- `GET /auctions/{id}` → `AuctionItem`, in any state.
- `GET /auctions/compare?printing_id=&finish=` → `{items, recent_sales}`: the same edition and finish's live listings, lowest price first (20), and its last 10 sales `{price, sold_at}`.
- `POST /auctions` `{printing_id, finish, starting_bid, buy_now, duration, quantity, key}` → `{items}` (201).
- `POST /auctions/{id}/bids` `{amount, key}`; `POST /auctions/{id}/buy-now` `{key}` → `AuctionItem`.
- `DELETE /auctions/{id}`: the seller withdraws → `AuctionItem` (403 `not_your_auction` for anyone else).
- `PUT` / `DELETE /auctions/{id}/watch` → 204.
- `GET /auctions/targets` → `{active, won, lost}`; `POST /auctions/targets/clear` `{which: won|lost}` → 204.
- `GET /auctions/mine` → `{active, sold, unsold}`; `POST /auctions/mine/clear` `{which: sold|unsold}` → 204.
- `POST /auctions/{id}/relist` `{starting_bid, buy_now, duration, key}` → `AuctionItem` (201).
- `GET /auctions/sellable?q=&cursor=&limit=` → `{items: {card, finish, copies, sellable}[], next_cursor}`: what the viewer may list, by name. For SysOp, any printing the game can play in each finish it was printed in, `sellable` the most one listing takes (20) and `copies` those granted.
- `GET /admin/auctions?status=&cursor=&limit=` → `AuctionPage`; `POST /admin/auctions/{id}/cancel` `{reason}` → `AuctionItem`.

An `AuctionItem` carries the card (`concept_id`, `printing_id`, name, type line, colours, set code and name, collector number, rarity, release date, and the edition's picture on this site), the finish, the seller's handle, the prices and bids (`starting_bid`, `buy_now`, `current_bid`, `high_bidder`, `bids`, `next_bid`), the length and times, the status, `sold_price` and `buyer`, and the viewer's side: `mine`, `leading`, `outbid` (bid and not leading), `watching`, `my_bid` (the viewer's highest bid).

## On screen

The web side of the auction house. It looks and moves like Madden Ultimate Team's transfer market, in the app's dark green and gold, with the royal purple of Tivit's robes as its own accent (Buy Now, foils, the viewer's own listings). The code is in `web/src/auctions/`.

### Where it opens

- **The main menu's tile** "Tivit's Auction House", beside Leng's card shop, over the owner's painting (`web/public/menu/auctions-640.webp` and `-1280.webp`, made from `auction.house.background.png` as the other tiles' were; [asset-provenance.csv](asset-provenance.csv)). Tables, Leng's shop and the auction house share the second row of the menu; the top bar kept its six pages until v0.6.1 ([the menus](menus.md#the-top-bar)).
- **The address** `#auctions`, with the tab in it: `#auctions/search`, `#auctions/list`, `#auctions/targets`. Back and Forward move between the tabs. The band above the page says "Auctions".
- **My library's Sell** (below), and **the bell**, whose auction notifications lead to the targets or the list.

### The page

- **The banner** is the painting, Tivit at his desk on the right, the title and the account's numbers over the dark hall on the left: the viewer's tokens, the market's live auctions, their own listings, and the auctions they are winning (with how many they have been outbid on). On a phone the painting sits above the words.
- **Madden's three screens** are three large tabs, each with what waits there (the market's count; active, sold and unsold listings; winning and outbid), the targets' tab with a red count when the viewer has been outbid. **Sell a card** sits beside them on every tab.
- **How it works**, a short list under the screens: one copy of one print in one finish per auction, basic lands included; held bids; the 5% step; the 30-second extension; no fee.

#### Search the market

- **Filters** at the side (folded under a "Search filters" bar on a narrow window, with how many are set): card name, set code, type, rarity chips, finish chips, colour pips (W, U, B, R, G and colourless), bid and Buy Now ranges, "Only with Buy Now", time left (under 1 minute to under 24 hours) and the sort (ending soonest, newest, price low and high, Buy Now low). **Search** applies them; **Reset** clears them and searches again.
- **The viewer's own listings are on the market too** (since v0.6.1, the owner's report: two cards listed and not found there; until then the market left them out, as Madden's does). The page asks with `include_mine=true`; each is badged **Your listing**, counted in the banner's live auctions, and opens the item panel without bidding. The API's default is unchanged.
- **The results** are Madden's item cards: the edition's picture (a foil shimmers and glows, an etched foil is marked "Etched" too), the name, the edition ("Revised Edition 3ED #162"), rarity and finish chips, and a plate with the bid (or the starting bid), Buy Now and the time left counting down every second, red under a minute. A badge says **Winning**, **Outbid** or **Your listing**, and the card's edge takes its colour. The **star** watches or stops watching an auction, which puts it in the transfer targets.
- **Paging** by the API's cursor, Previous and Next. The page shown is asked for again every 5 seconds while the tab is visible (marked as the page's own request, so it does not count as the player's activity).

#### The item panel

An auction opens in a drawer at the right of a wide window, or a sheet from the bottom of a phone's. It holds the big picture (a click shows it full size, with Card details a button away), the name, edition, rarity, finish and where the viewer stands; the seller; the current or starting bid, Buy Now, the time left, the bids and the highest bidder, the viewer's own bid and the length. It asks for the auction again every 5 seconds.

- **The bid stepper** starts at the least bid the auction takes (`next_bid`); + and − move by the 5% step, never under the least bid, and the box takes any amount typed. It says what the bid does: too low, a bid whose tokens are held, or a bid that reaches Buy Now. **Make bid** keeps one client key until it succeeds, so Try again bids once. Holding the high bid, the viewer cannot bid against themself.
- **Buy Now** asks first, with the price and what the viewer will have left (their held bid, if they lead, comes back).
- **Watch**, **Compare price** (the same edition and finish's live listings, lowest first, each opening in the panel, and its recent sales with their average) and **Card details** (the catalog's details of that printing).
- **Withdraw**, on the viewer's own listing while it has no bid.
- A live region speaks the countdown only at its milestones: under an hour, ten minutes, a minute, ended.

#### Transfer list

The viewer's own listings in three sections with counts: **Active** (Withdraw while there is no bid), **Sold** (the buyer and the price; Clear sold) and **Unsold**, expired, withdrawn or cancelled (Relist, which opens the Sell dialog prefilled with the last prices and length; Clear unsold, which only tidies the list: the card is back in the library already).

Since v0.7.0 the sections fold, here and in the targets: each heading is a button (`aria-expanded`), every section starts folded, and its count and Clear button stay on the folded bar, so a seller with a hundred active listings reaches Sold without scrolling past them (the owner, 2026-10-30). The fold is the page's for the visit: it is not kept.

#### Transfer targets

The auctions the viewer watches or bid on: **Active**, each marked winning or outbid, **Won** and **Lost**, with Clear won and Clear lost.

#### The Sell dialog

Opened from Sell a card, from Relist, or from My library. It finds what the viewer may sell (`GET /auctions/sellable`, searched by name) and offers each edition and finish with how many copies are free to sell; from My library it offers only that edition's finishes, and a single one is chosen already. Then: **Set a Buy Now price**, the copies to list (up to 20, each its own auction), the starting bid (at least 1 token) and Buy Now (above the starting bid), and the length, 1 hour, 3 hours, 12 hours, 24 hours, 3 days, 7 days, 30 days or Unlimited. Unlimited hides the starting bid and asks only for the Buy Now price; its summary says the listing is Buy Now only, with no end. An unlimited auction's panel shows its Buy Now, "No end" for its time and no bid stepper, only Buy Now. The summary says **"You receive 100% — no fee"** and what will be listed. One client key per listing until it succeeds.

### My library

Each edition's tile says its copies by finish when it holds a foil or etched one ("2 + 1 foil", in the foil's colours), and glows; the list's Copies column says the same for every edition. An edition with copies the viewer may sell (`sellable`) has a **Sell** button on its tile and in the list, which opens the Sell dialog on that edition. An account without a library (administrators, SysOp) is pointed to the auction house's Sell, which offers what it may list.

### The foil glow

Every card picture whose copy is known to be foil or etched glows, outside games only (the owner's choice; decks ignore the finish): `web/src/catalog/foilGlow.ts` and its CSS, a breathing drop-shadow that follows the card's corners, cool for foil and warm for etched, still under reduced motion. It is on the library's tiles, card details and the enlarged picture opened from them, every auction picture (the market, the panel, Compare price, the transfer list and targets, the Sell dialog, Administration's log) and the cards of a pack turned up at Leng's counter and its summary. The game table never uses it.

### The bell

Five kinds, each a link without a player's picture, as the quests' and achievements' are:

| Kind | Says | Opens |
|---|---|---|
| `auction_outbid` | You were outbid on *card (foil)*; your *n tokens* came back. | Transfer targets |
| `auction_won` | You won *card* for *n tokens*. It is in your library. | Transfer targets |
| `auction_sold` | *Card* sold for *n tokens*. The tokens are yours. | Transfer list |
| `auction_unsold` | *Card* did not sell. It is back in your library. | Transfer list |
| `auction_cancelled` | The auction of *card* was cancelled by SysOp: *reason*. Cards and bids were returned. | Transfer list |

The words read the notification's `auction` object (`id`, `name`, `set_code`, `collector_number`, `finish`, `price`), and fall back to plain words without it.

### Administration

An **Auctions** tab for SysOp and administrators with `auctions.manage`: every auction, newest first, filtered by status (sales by default; live, cancelled, unsold, withdrawn or everything), with when it was listed, the card with its edition, finish and picture, the seller, the buyer (or the high bidder), the price and the status. **SysOp alone** has Cancel on a live auction, which asks for a reason kept in the audit log; the card goes back to its seller and the high bid to its bidder.

### Accessibility

Every control is a button, link or form field with its label; a tile and a row are read as one sentence (name, edition, finish, price, Buy Now, time left, standing). The countdowns are not live regions; only the panel's milestone line speaks. Chips and pips are toggle buttons (`aria-pressed`), the lengths and the pick list radio groups. Tokens show with thousands separators and a coin, and are read as "1,200 tokens". It works at phone width (two item cards a row, the panel as a sheet, the filters folded), and global.css's reduced motion stops the shimmer, the glow's breathing, the red pulse and the drawer's slide.

## Checked by

`tests/test_auctions.py`: listing takes the copy out of the library (a deck that used it collection-locked) and withdrawing brings it back; a retry lists once; what may not be sold (prices, an alliance's card, a one-of-a-kind printing, a copy not held), basic lands sold, SysOp's and an administrator's listings and the sell dialog's list; bids held and returned, the increment, the refusals, the bell; Buy Now and a bid above it, the seller paid exactly, the buyer's grant; withdrawing before the first bid only, by the seller only; anti-snipe and a read settling an auction past its end once; the worker settling, an unsold copy back, relisting once, the transfer list; the targets; the market's filters, sorting and pages, and comparing; SysOp's cancellation, the log and its permission; a reset and a deletion ending auctions and returning bids; finishes kept apart from a pack and print runs not counting a copy bought; and migration 0028's back-fill and downgrade on SQLite and PostgreSQL. On PostgreSQL also four bids at once, a retried bid four times at once, bids racing Buy Now, and a bid racing the end while reads settle it. On screen: Vitest for the helpers, the page's tabs and item panel, Sell, Administration's tab, and My library's Sell and finishes; the browser journey `web/e2e/auctions.spec.ts` (in CI's engine job, which has the second player) lists a card as one player, bids and buys it now as SysOp, and checks the seller paid in full and the sale in the log.
