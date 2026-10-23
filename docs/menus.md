# The menus (v0.4.5)

Since v0.4.5 the app's menus and pages take the look of Magic Duels' front end, as v0.3.0 did for the table ([the game screen](game-screen.md)): a title screen, a main menu of large tiles under a game-style top bar, and a title band over every page. The owner's decisions are in [the v0.4.5 plan](plans/0.4.5.md#decisions-at-the-start-of-v045). The art is the owner's own: the Planeswalker portraits, the banner, the mark, Leng's painting and, since v0.5.1, the paintings behind four of the main menu's tiles. Card art never appears in the menus.

## The look

- **Colours and type.** The site's deep green-black and gold, burnished: titles in Cinzel (self-hosted from the `@fontsource-variable/cinzel` package, SIL Open Font License, so the strict content security policy stays as it was) in gold leaf, with an ember orange for calls to act. The colours and the panel frame are CSS variables in `web/src/global.css`, which every page's stylesheet reads.
- **Buttons.** The main buttons are bevelled gold, lit from above, with a sheen that crosses them under the pointer. The others are dark glass in a gold frame.
- **Panels.** Panels and tiles have a gold hairline, a lit top edge and a deep shadow.
- **Motion.** A page rises in as it opens; the main menu's tiles come in one after another, lift and glow under the pointer, and embers drift up behind it. The ally's portrait floats gently. Reduce motion (Settings) and the system's own setting stop all of it, as before.
- **Sound.** The menus make generated sounds, like the table's (no recorded audio): a soft tick when the pointer or the keyboard reaches a tile or a page in the top bar, a whoosh into a bell when one is chosen, and a falling whoosh back to the main menu. They follow the table's sound settings (Settings → the table's volume and mute). As browsers require, no sound plays before the first click or key press. There is no music.

## The title screen

Before an account is active, every address shows the title screen: the owner's mark in the middle of the window, haloed in light over the owner's banner, dimmed and blurred far behind it and drifting slowly, with embers rising. Below the mark is only what to do next: the Google sign-in, SysOp's entrance, or the account's wait for approval; then the links to About, Privacy and Terms ([identity](identity.md#before-the-app-the-landing-page-v030)).

## The top bar

At the top of every page, and staying there as the page scrolls:
- **The mark and the wordmark**, which lead to the main menu.
- **The main menu's six pages:** Home, Play, Tables, Decks, Cards and Shop, each with its icon. The page shown is marked by a gold flare under it.
- **The player search** ([finding players](social.md)).
- **The account's corner:** its tokens (a gold coin and the balance, leading to the shop), Friends, Messages with its unread count, the notification bell, and the account's own button: its portrait (its ally's, else its avatar), its handle and its tier with its wins, and a dot for the connection to the service. The button opens a menu of Profile, Settings, Administration (for administrators and SysOp, with what waits there counted on the button and on the item) and Report a problem, with the connection and the version.

On a phone (narrower than 820 px) the six pages move to a bar along the bottom of the window, the search takes a row of its own, and the handle and tier give way to the portrait.

## The main menu

The app opens on the main menu (`#home`; any address that names no page, the old Campaign, Learn and Collection ones included, opens it too, and so does the installed app). As in Magic Duels, the account's ally greets it: the allied Planeswalker's portrait stands large in a pool of light, with "Welcome back" and the account's handle, its tier, its wins and a bar of the way to the next tier. With no alliance, the owner's mark stands there, with a link to choose an ally on Profile. Beside it, the tiles:
- **Play**, the largest, over the owner's banner: practice games against the bots, and since v0.5.0 the public queues. When one of the account's games is still running, it says so and leads back to it; while the account waits in a queue, it says "Looking for a Legacy game" and leads to the wait ([queues](queues.md)).
- **Tables**, with the number of open tables.
- **Leng's Card Shop**, over Leng's painting, with the week's sale.
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
