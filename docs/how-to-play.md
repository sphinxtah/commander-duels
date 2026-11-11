# How to play (v0.8.6)

How to play is the game's own guide to Magic: The Gathering, for a player who has never played and for one who wants a rule settled. It has two parts:

- **The guide**: Magic explained in plain words, with real cards, the real table and worked examples, in twelve chapters and thirty-six topics, from "What Magic is" to "At the Commander Duels table". It is this repository's own writing (`web/src/howToPlay/guide.ts`). Each topic names the official rules it explains, and any "rule 702.19" in its words links to that rule.
- **The official rules**: Wizards of the Coast's Comprehensive Rules, whole, searchable and linkable by rule number, with the glossary. The text is not in this repository: the owner's private web image serves it, and the public images show the guide alone.

The owner is adding the official text to the licensing agreement with Wizards of the Coast (decided 2026-11-01). If Wizards says no, the text is removed from the private repository before the official release; How to play then shows the guide and a link to Wizards' rules page, as the public images do already.

## Where it opens

- **The account's menu** in the upper right (with the player's name, Settings and Sign out): How to play.
- **Signed out**: `#how-to-play` and every address under it open for anyone, signed in or not, waiting for approval or not, as a page of its own with the mark (back to the sign-in), the Fan Content notice and the public pages' links. Nothing there asks the API for anything but the guide's card pictures.
- **"What's this?"** under every prompt at the table (`web/src/game/PromptPanel.tsx`): the topic that explains that kind of choice (priority, mulligan, targets, attackers, blockers, damage assignment, paying mana, ordering triggers, modes…), in a new tab so the game goes on. The table is `PROMPT_TOPICS` in `guide.ts`.
- **The tutorial**: each page of the Novice's Magic refresher and each lesson of the Beginner's guided game has "More in How to play" to its topic (`web/src/tutorial/LearnMore.tsx`, `TUTORIAL_TOPICS` in `guide.ts`). Since v0.9.8 it is a button that opens the topic in a pop-up over the tutorial (`TopicDialog.tsx`): the topic's own words, cards and examples, with no links in it, and Close, Escape or a click beside it to go back. Until then it opened the guide in a new tab, and a new tab for an account still in its setup opens the welcome again, so the link led in a circle (the owner's report). The guided game's "Play on its own" waits while the pop-up is open.

## Addresses

| Address | Shows |
|---|---|
| `#how-to-play` | The guide's contents, and the official rules' |
| `#how-to-play/<topic>` | One topic, such as `#how-to-play/combat-damage` |
| `#how-to-play/rules` | The official rules' contents: sections and chapters |
| `#how-to-play/rules/<number>` | The chapter holding that rule, scrolled to it and marked (`#how-to-play/rules/702.19b`), or a whole chapter (`#how-to-play/rules/702`) |
| `#how-to-play/glossary` | The official glossary, with a filter |

The search at the side finds the guide's topics by their words, and with the official text the rules (by number, or by every word given) and glossary terms. A rule number goes straight to its rule.

## The guide's pieces

- **Example cards** are real cards, drawn from the API's Scryfall cache over a text frame of their name, cost, type and text, so a missing picture never hides the card's words. The guide's cards are listed in `content/how-to-play-cards.json`; `GET /api/v1/how-to-play/card-images?name=&size=` serves those names' pictures, and no others, to anyone (`api/how_to_play.py`). Signed-out readers share one place in the Scryfall queue; a signed-in account takes its own; each name is fetched once and then served from disk, as the table's are ([the game screen](game-screen.md#cards)).
- **Reading a card** points at Serra Angel's parts with numbered pins and arrows to their labels. The arrows are drawn from where the labels actually are on the page, measured, and again whenever the layout changes; on a phone the labels follow the card as a numbered list.
- **Screenshots of the table** are the tutorial's guided game on the real table, taken by `web/e2e/how-to-play-shots.spec.ts` with numbered pins at the places the guide names. The spec records where each place is (the centre of its elements on the page), and `scripts/how_to_play_shots.py` makes the pictures in `web/public/how-to-play/` and the positions in `web/src/howToPlay/shots.json`:

  ```sh
  CD_E2E_HOW_TO_PLAY_SHOTS=1 CD_E2E_SYSOP_PASSWORD=… pnpm --dir web exec playwright test e2e/how-to-play-shots.spec.ts
  python scripts/how_to_play_shots.py web/test-results/how-to-play
  ```

  Card pictures need the API's Scryfall cache (`CD_CARD_IMAGE_DIR`). The prompt's shot needs a running engine: it starts a practice game and takes its mulligan.
- **Examples** are short, numbered situations with their cards and a result; tables list card types, keywords, zones and the steps of a turn with their rule numbers.

## The official text

`web/src/howToPlay/rules.ts` parses the plain-text release as Wizards publishes it: the title and "These rules are effective as of <date>.", the introduction, the contents (skipped), then the numbered sections ("1. Game Concepts"), chapters ("100. General"), rules ("100.1.") and subrules ("100.1a", and the odd "704.5aa" or "119.1d."), each followed by its "Example:" lines, then the glossary and the credits. Blank lines are no-break spaces, and a few rules break into a second paragraph with a line separator (U+2028); both are read as spacing. A text without sections or rules is refused, so a wrong file (the app's own page, say) is never shown as rules. The parser's test fixture, `web/src/howToPlay/rules.fixture.txt`, is a few made-up rules in the same shape; when the gitignored `rules/` folder holds the official file, the tests parse it too and check that every rule the guide names exists.

The page fetches `/rules/comprehensive-rules.txt` once per visit, when How to play first opens (about 1 MB, compressed by nginx), and asks again on every visit (`no-cache`), since a new release replaces the file under the same name. It shows the effective date and Wizards' name beside the text. A 404 is a build without the text: "Official rules not included in this build", and a link to Wizards' rules page.

| Where | The text comes from |
|---|---|
| The live site | The owner's private web image: `rules/comprehensive-rules.txt` in `sphinxtah/commander-duels-sphinx`, copied to `/usr/share/nginx/html/rules/` ([the live site](deployment.md#the-web-image-with-the-music-v072)) |
| The public images | Nowhere: a 404, and the guide alone |
| The local Docker stack | The gitignored `rules/` folder beside `compose.yaml`, which Compose mounts into the web container |
| `pnpm dev` and `vite preview` | The same folder, served by `web/plugins/rules.ts` |

`web/nginx.conf` serves `/rules/` as UTF-8 text, gzip-compressed, with `expires -1`.

### The weekly check

The private repository keeps its copy current: `.github/workflows/rules.yml` runs every Monday at 06:17 in Phoenix (13:17 UTC) and on demand, reads Wizards' rules page for the current release (its link and name change with each release), downloads it and compares it with the committed copy. A new release becomes a branch and a pull request naming its effective date; merging it builds the private web image at once, and the next `upgrade.sh` deploys it. A page or file it cannot find or recognise fails the run, so GitHub tells the owner. The private repository's README has the details, including the one repository setting it needs.

## Not yet

- The guide is in English only.
- The prompt's screenshot is taken from a practice game; it needs the engine running when the shots are made.
