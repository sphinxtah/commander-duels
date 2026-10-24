# The menus (v0.4.5)

Since v0.4.5 the app's menus and pages take the look of Magic Duels' front end, as v0.3.0 did for the table ([the game screen](game-screen.md)): a title screen, a main menu of large tiles under a game-style top bar, and a title band over every page. The owner's decisions are in [the v0.4.5 plan](plans/0.4.5.md#decisions-at-the-start-of-v045). The art is the owner's own: the Planeswalker portraits, the banner, the mark, Leng's painting and, since v0.5.1, the paintings behind four of the main menu's tiles. Card art never appears in the menus.

## The look

- **Colours and type.** The site's deep green-black and gold, burnished: titles in Cinzel (self-hosted from the `@fontsource-variable/cinzel` package, SIL Open Font License, so the strict content security policy stays as it was) in gold leaf, with an ember orange for calls to act. The colours and the panel frame are CSS variables in `web/src/global.css`, which every page's stylesheet reads.
- **Buttons.** The main buttons are bevelled gold, lit from above, with a sheen that crosses them under the pointer. The others are dark glass in a gold frame.
- **Panels.** Panels and tiles have a gold hairline, a lit top edge and a deep shadow.
- **Motion.** A page rises in as it opens; the main menu's tiles come in one after another, lift and glow under the pointer, and embers drift up behind it. The ally's portrait floats gently. Reduce motion (Settings) and the system's own setting stop all of it, as before.
- **Sound.** The menus make generated sounds, like the table's (no recorded audio): a soft tick when the pointer or the keyboard reaches a tile (or, until v0.6.1, a page in the top bar), a whoosh into a bell when one is chosen, and a falling whoosh back to the main menu. They follow the table's sound settings (Settings → the table's volume and mute). As browsers require, no sound plays before the first click or key press. There is no music.

## The title screen

Before an account is active, every address shows the title screen: the owner's mark in the middle of the window, haloed in light over the owner's banner, dimmed and blurred far behind it and drifting slowly, with embers rising. Below the mark is only what to do next: the Google sign-in, SysOp's entrance, or the account's wait for approval; then the links to About, Privacy and Terms ([identity](identity.md#before-the-app-the-landing-page-v030)).

## The top bar

At the top of every page, and staying there as the page scrolls:
- **The mark and the wordmark**, which lead to the main menu.
- **The player search** ([finding players](social.md)), centred over the main menu's tiles on every page (v0.6.1): its column is worked out from the main column's width and the main menu's two columns. Where the account's corner needs the room (between about 1,180 and 1,500 px wide) the search gives way to the left; where the tiles span the page (narrower than 1,100 px) it is centred on the bar.
- **The account's corner:** its tokens (a gold coin and the balance, leading to the shop), Friends, the notification bell, and the account's own button: its portrait (its ally's, else its avatar), its handle and its tier with its wins, and a dot for the connection to the service. The button opens a menu of Profile, Settings, Administration (for administrators and SysOp, with what waits there counted on the button and on the item), Report a problem and, since v0.6.1, Sign out (on Profile before; the owner's request), with the connection and the version. Messages, with its unread count, sat between Friends and the bell until v0.5.1; the count is now on the chat bar.

**The page links are gone** (v0.6.1, the owner: "it's time to retire the menu items at the very top left. I want Home to be the main card/tile area in the middle"). Until then the bar held the main menu's six pages (Home, Play, Tables, Decks, Cards and Shop), and a phone had them again in a bar along the bottom of the window. Now the main menu's tiles lead to every page, and every other page's title band leads back to them ("Main menu"). On a phone that is all it needs: phones matter for the shop, opening packs, the auction house and the social features, which the tiles and the account's corner reach ([the owner's decision](plans/0.6.1.md#the-top-bar-the-owner-2026-10-24)).

On a phone (narrower than 820 px) the search takes a row of its own, the wordmark gives way to the mark, and the handle and tier to the portrait.

## Profile in tabs (v0.6.1)

At the owner's request ("the scrolling goes on for too long"), Profile keeps the account's card at the top and puts the rest in tabs: **Achievements** (first, and where it opens), **Alliance** (the progress to the next tier, the alliance and its picker; SysOp's own wins), **Record** (the totals and the games one by one), **Tokens** (the ledger; SysOp's own grants), **Details** (the profile form), **Privacy** and **Sign-ins** (where the account is signed in, *Sign out everywhere*, SysOp's password). Until the setup is done the page shows its setup panel, with Privacy and Sign-ins only.

## The chat bar (v0.5.1)

Along the bottom of every page: the friends list at the right end, "Friends · 3 online" with the count of unread messages, folded to a tab or open as the player left it, and friends' conversations docked beside it, each folded to a tab or open above it. At the game's table it folds away into a diamond on the band ([the game screen](game-screen.md#friends-chat-at-the-table-v051)). They take the look of the menus' panels: dark glass in a gold hairline, the list's title in Cinzel. On a phone the bar is one round button at the bottom right (above the bar of pages until v0.6.1), and the list or one conversation opens the whole width of the screen. The page keeps room at its foot so its end scrolls clear of the bar. [Chat](chat.md#friends-messages) says what it does.

## The main menu

The app opens on the main menu (`#home`; any address that names no page, the old Campaign, Learn and Collection ones included, opens it too, and so does the installed app). As in Magic Duels, the account's ally greets it: the allied Planeswalker's portrait stands large in a pool of light, with "Welcome back" and the account's handle, its tier, its wins and a bar of the way to the next tier. With no alliance, the owner's mark stands there, with a word to choose an ally on Profile. Since v0.6.0 (the owner's request) the whole greeting is a link to the profile. Beside it, the tiles:
- **Play**, the largest, over the owner's banner: practice games against the bots, and since v0.5.0 the public queues. When one of the account's games is still running, it says so and leads back to it; while the account waits in a queue, it says "Looking for a Legacy game" and leads to the wait ([queues](queues.md)).
- **Tables**, with the number of open tables.
- **Leng's Card Shop**, over Leng's painting, with the week's sale.
- **Tivit's Auction House** (v0.6.0), over the owner's painting of Tivit at the auctioneer's desk, beside the shop ([the auction house](auctions.md)).
- **Decks**, with the number of the account's decks.
- **Cards.**
- **Friends**, with the number of friends online.

Since v0.5.1 Tables, Decks, Cards and Friends lie over the owner's paintings too, as Play and the shop do: a round table set for a game, a deck and a hand on a desk, three cards floating over a library's chest, and friends laughing at a table (`web/public/menu`, each at 640 and 1280 pixels wide for sharp screens). Each is darkened where the tile's words lie: from the left for Tables, from the bottom for the others.

Since v0.5.0, **Today's quests** runs across the main menu below them: the day's three quests, each with its reward and a bar of the wins counted so far, the time until the next day's quests, and Swap on each quest not done while the day's swap is unused ([quests](quests.md#daily-quests)).

## Every other page

A title band runs across the top of every other page: **Main menu**, the way back, and the page's name engraved large across the band. The page's own title follows it. A new page opens at its top, its title focused for screen readers, as following a link does.

**Play** keeps the owner's banner, now with the practice table below it and a button to the tables (since v0.5.0 "Find a game" first, the public queues, with buttons to it, the practice table and the tables), and the formats: Commander and Legacy, open to play, and Two-Headed Giant, coming soon (since v0.5.0 marked "Early": a practice game with a bot teammate against two bots, [Two-Headed Giant](engine/two-headed-giant.md); since v0.5.1 also at tables and in "Find a game", alone or with a friend, its details saying so and that a few cards do not follow the team rules yet). Each format's details say how many seats it takes.

## Gone in v0.4.5

- **Campaign, Learn and Collection.** Placeholder pages since v0.0.1; a player's cards are on Cards → My library.
- **A test build's words.** "Testing preview", the milestone labels over page titles ("M1 · CARD CATALOG"), "planned" formats and the "foundation is taking shape" section. Settings' list of what the site offers is now "In this version", and says "Coming later" for what it does not offer yet.
- **The sidebar.**
