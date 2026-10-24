# Tivit's Auction House on screen (v0.6.0)

The web side of the auction house, written to be folded into [auctions.md](auctions.md) as its "On screen" section. It looks and moves like Madden Ultimate Team's transfer market, in the app's dark green and gold, with the royal purple of Tivit's robes as its own accent (Buy Now, foils, the viewer's own listings). The code is in `web/src/auctions/`.

## Where it opens

- **The main menu's tile** "Tivit's Auction House", beside Leng's card shop, over the owner's painting (`web/public/menu/auctions-640.webp` and `-1280.webp`, made from `auction.house.background.png` as the other tiles' were; [asset-provenance.csv](asset-provenance.csv)). Tables, Leng's shop and the auction house share the second row of the menu; the top bar keeps its six pages.
- **The address** `#auctions`, with the tab in it: `#auctions/search`, `#auctions/list`, `#auctions/targets`. Back and Forward move between the tabs. The band above the page says "Auctions".
- **My library's Sell** (below), and **the bell**, whose auction notifications lead to the targets or the list.

## The page

- **The banner** is the painting, Tivit at his desk on the right, the title and the account's numbers over the dark hall on the left: the viewer's tokens, the market's live auctions, their own listings, and the auctions they are winning (with how many they have been outbid on). On a phone the painting sits above the words.
- **Madden's three screens** are three large tabs, each with what waits there (the market's count; active, sold and unsold listings; winning and outbid), the targets' tab with a red count when the viewer has been outbid. **Sell a card** sits beside them on every tab.
- **How it works**, a short list under the screens: one copy of one print in one finish per auction, basic lands included; held bids; the 5% step; the 30-second extension; no fee.

### Search the market

- **Filters** at the side (folded under a "Search filters" bar on a narrow window, with how many are set): card name, set code, type, rarity chips, finish chips, colour pips (W, U, B, R, G and colourless), bid and Buy Now ranges, "Only with Buy Now", time left (under 1 minute to under 24 hours) and the sort (ending soonest, newest, price low and high, Buy Now low). **Search** applies them; **Reset** clears them and searches again.
- **The results** are Madden's item cards: the edition's picture (a foil shimmers and glows, an etched foil is marked "Etched" too), the name, the edition ("Revised Edition 3ED #162"), rarity and finish chips, and a plate with the bid (or the starting bid), Buy Now and the time left counting down every second, red under a minute. A badge says **Winning**, **Outbid** or **Your listing**, and the card's edge takes its colour. The **star** watches or stops watching an auction, which puts it in the transfer targets.
- **Paging** by the API's cursor, Previous and Next. The page shown is asked for again every 5 seconds while the tab is visible (marked as the page's own request, so it does not count as the player's activity).

### The item panel

An auction opens in a drawer at the right of a wide window, or a sheet from the bottom of a phone's. It holds the big picture (a click shows it full size, with Card details a button away), the name, edition, rarity, finish and where the viewer stands; the seller; the current or starting bid, Buy Now, the time left, the bids and the highest bidder, the viewer's own bid and the length. It asks for the auction again every 5 seconds.

- **The bid stepper** starts at the least bid the auction takes (`next_bid`); + and − move by the 5% step, never under the least bid, and the box takes any amount typed. It says what the bid does: too low, a bid whose tokens are held, or a bid that reaches Buy Now. **Make bid** keeps one client key until it succeeds, so Try again bids once. Holding the high bid, the viewer cannot bid against themself.
- **Buy Now** asks first, with the price and what the viewer will have left (their held bid, if they lead, comes back).
- **Watch**, **Compare price** (the same edition and finish's live listings, lowest first, each opening in the panel, and its recent sales with their average) and **Card details** (the catalog's details of that printing).
- **Withdraw**, on the viewer's own listing while it has no bid.
- A live region speaks the countdown only at its milestones: under an hour, ten minutes, a minute, ended.

### Transfer list

The viewer's own listings in three sections with counts: **Active** (Withdraw while there is no bid), **Sold** (the buyer and the price; Clear sold) and **Unsold**, expired, withdrawn or cancelled (Relist, which opens the Sell dialog prefilled with the last prices and length; Clear unsold, which only tidies the list: the card is back in the library already).

### Transfer targets

The auctions the viewer watches or bid on: **Active**, each marked winning or outbid, **Won** and **Lost**, with Clear won and Clear lost.

### The Sell dialog

Opened from Sell a card, from Relist, or from My library. It finds what the viewer may sell (`GET /auctions/sellable`, searched by name) and offers each edition and finish with how many copies are free to sell; from My library it offers only that edition's finishes, and a single one is chosen already. Then: **Set a Buy Now price**, the copies to list (up to 20, each its own auction), the starting bid (at least 1 token) and Buy Now (above the starting bid), and the length, 1 hour, 3 hours, 12 hours, 24 hours or 3 days. The summary says **"You receive 100% — no fee"** and what will be listed. One client key per listing until it succeeds.

## My library

Each edition's tile says its copies by finish when it holds a foil or etched one ("2 + 1 foil", in the foil's colours), and glows; the list's Copies column says the same for every edition. An edition with copies the viewer may sell (`sellable`) has a **Sell** button on its tile and in the list, which opens the Sell dialog on that edition. An account without a library (administrators, SysOp) is pointed to the auction house's Sell, which offers what it may list.

## The foil glow

Every card picture whose copy is known to be foil or etched glows, outside games only (the owner's choice; decks ignore the finish): `web/src/catalog/foilGlow.ts` and its CSS, a breathing drop-shadow that follows the card's corners, cool for foil and warm for etched, still under reduced motion. It is on the library's tiles, card details and the enlarged picture opened from them, every auction picture (the market, the panel, Compare price, the transfer list and targets, the Sell dialog, Administration's log) and the cards of a pack turned up at Leng's counter and its summary. The game table never uses it.

## The bell

Five kinds, each a link without a player's picture, as the quests' and achievements' are:

| Kind | Says | Opens |
|---|---|---|
| `auction_outbid` | You were outbid on *card (foil)*; your *n tokens* came back. | Transfer targets |
| `auction_won` | You won *card* for *n tokens*. It is in your library. | Transfer targets |
| `auction_sold` | *Card* sold for *n tokens*. The tokens are yours. | Transfer list |
| `auction_unsold` | *Card* did not sell. It is back in your library. | Transfer list |
| `auction_cancelled` | The auction of *card* was cancelled by SysOp: *reason*. Cards and bids were returned. | Transfer list |

The words read the notification's `auction` object (`id`, `name`, `finish`, `price`, `reason`) when the API sends one, and fall back to plain words when it does not.

## Administration

An **Auctions** tab for SysOp and administrators with `auctions.manage`: every auction, newest first, filtered by status (sales by default; live, cancelled, unsold, withdrawn or everything), with when it was listed, the card with its edition, finish and picture, the seller, the buyer (or the high bidder), the price and the status. **SysOp alone** has Cancel on a live auction, which asks for a reason kept in the audit log; the card goes back to its seller and the high bid to its bidder.

## Accessibility

Every control is a button, link or form field with its label; a tile and a row are read as one sentence (name, edition, finish, price, Buy Now, time left, standing). The countdowns are not live regions; only the panel's milestone line speaks. Chips and pips are toggle buttons (`aria-pressed`), the lengths and the pick list radio groups. Tokens show with thousands separators and a coin, and are read as "1,200 tokens". It works at phone width (two item cards a row, the panel as a sheet, the filters folded), and global.css's reduced motion stops the shimmer, the glow's breathing, the red pulse and the drawer's slide.

## Until the API merges

The screens were built against the contract alone: `web/src/auctions/types.ts` mirrors it by hand and `web/src/auctions/api.ts` makes the requests with the app's fetch and CSRF token. At the merge both become the generated types and `client` calls; `fixtures.ts` keeps the tests' data.
