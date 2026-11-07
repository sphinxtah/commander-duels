# Card sleeves (v0.8.9)

The owner, 2026-11-06: "the ability for players to upload an image for their virtual card sleeves, to replicate how people use real card sleeves in gameplay with cool designs on the backs. The default is just the normal MTG card back." `api/sleeves.py`; migration `0038_card_sleeves`.

## What a player has

- **The official card back**, the default.
- **Three default sleeves** every account has from the start, the owner's designs (`web/public/brand/sleeves/`): *Commander Duels: Varragoth*, *Commander Duels crest* and *The Sphinx*.
- **The campaign's card backs** the account has earned (v0.8.8, [the campaign](campaign.md)).
- **Up to 20 uploaded sleeves.** A PNG, BMP or JPEG of at most 5 MB, sent base64 in JSON as a report's screenshot is. The API reads the size from the header and refuses an image past 40 million pixels before unpacking it, turns it upright, crops it about its centre to a card's shape (63 by 88) and scales it to 504 by 704, then encodes it again as WebP from its pixels alone: nothing else of the file survives. It is kept in the database, so the nightly backups hold it.

## Choosing

Each deck wears one sleeve, chosen in the deck editor's "Card sleeve" section (This deck), where sleeves are uploaded and deleted too. `Deck.sleeve` is `sleeve:<id>`, `default:<slug>`, `back:<slug>`, or null. A deck with none shows the account's campaign back if it chose one on the Campaign page (v0.8.8), else the official back. Deleting a sleeve, or a moderator's removing it, puts every deck wearing it back to the default.

## At a table

Every human seat's sleeve shows to everyone at the table, players and spectators alike: the game's summary gives each human seat's picture (`seats[].sleeve`, a path on the site), and the table's canvas draws each seat's cards, library, hand backs and draws with their owner's sleeve, each seat's texture drawn again in place once its picture loads. Bots show the official back. The sleeve is the deck's when the summary is read, so a change shows at the next load. (The table drawn without WebGL still shows the viewer's own back on every card.)

## Reporting and removal

The owner chose "live at once, reportable".

- **At the table**, a click on another person's name opens their profile, small, over the game: their handle, title, wins, the sleeve they show here, a link to their full profile, and **Report this sleeve**. A report goes to Administration › Reports as any report does, naming the sleeve (`ReportCreate.sleeve`) and its owner; one's own sleeve can't be reported (`409 own_sleeve`).
- **In Administration › Reports**, the report shows the picture and **Remove from every table**, with a reason (`POST /api/v1/admin/sleeves/{id}/remove`, `reports.manage`, audited as `sleeves.removed`). A removed sleeve shows to nobody but staff, the decks wearing it go back to the default, and its owner sees it marked removed.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/v1/me/sleeves` | any account | the defaults, your sleeves, the limit and your earned campaign backs |
| `POST /api/v1/me/sleeves` | any account | upload one: `{name, image}` |
| `DELETE /api/v1/me/sleeves/{id}` | its owner | delete it; its picture is cleared |
| `GET /api/v1/sleeves/{id}/image` | anyone signed in | the picture, WebP; a removed one only to staff |
| `PUT /api/v1/decks/{id}/sleeve` | the deck's owner | `{sleeve}` |
| `POST /api/v1/admin/sleeves/{id}/remove` | `reports.manage` | `{reason}` |

Deleting an account deletes its sleeves' pictures (`api/accounts.py` CLEANUPS). Checked by `tests/test_sleeves.py`.
