# Large boards (v0.9.12)

A Commander game can hold hundreds of permanents: thirty tokens to attack with, thirty triggers of one enchantment. This is the foundation for playing such a board without thirty answers a step: the specification's section 14. The finished player-facing workflow (section 27) is v1.0.0's; what is here is in the game now, and each part is exercised by a test.

| Part | Where | Tested by |
| --- | --- | --- |
| [What a pile may hide](#what-a-pile-may-hide) | `web/src/game/table/groups.ts` | `groups.test.ts` |
| [Batch declarations](#batch-declarations) | `engine/…/Automation.java`, `api/games.py`, `web/src/game/batch.ts` | `AutomationTest`, `LargeBoardsTest`, `tests/test_games.py`, `batch.test.ts`, `PromptPanel.test.tsx` |
| [Yields](#yields) | `engine/…/Automation.java`, `Prompts.java` | `AutomationTest`, `LargeBoardsTest`, `PromptPanel.test.tsx`, `PriorityPanel.test.tsx` |
| [Animation speed and reduced clutter](#animation-speed-and-reduced-clutter) | `web/src/game/table/types.ts`, `layout.ts` | `layout.test.ts`, `tableSettings.test.ts` |
| [Pace policies](#pace-policies) | `api/table_profiles.py` | `tests/test_table_profiles.py` |
| [Performance fixtures and baselines](#performance-fixtures-and-baselines) | `LargeBoardsTest`, `largeBoard.test.ts` | themselves |

## What a pile may hide

The table stacks identical lands into a pile and identical tokens into a group (since v0.3.0). The rule for "identical" is now one definition, checked against the engine's contract:

- **Every field is classified.** Each field of a permanent and of its card in the seat's view (`contracts/engine-seat-view.schema.json`) is one of:
  - **which**: says which object it is, never what it is like (`id`). It is no part of a pile's key.
  - **alike**: two permanents in one pile have the same value: controller, owner, name, mana cost, type line, power, toughness, rules text, tapped, summoning sick, damage, counters.
  - **alone**: a permanent with it set stands on its own: attacking, blocking, attached to something, hidden from the seat.
- **And what the prompt offers.** Two permanents share a pile only when the open prompt offers the same choices for both, in the same words. One chosen in the prompt stands alone.
- **A new field cannot slip through.** `PERMANENT_FIELDS` and `CARD_FIELDS` must name every field of the TypeScript types (the build fails otherwise), and `groups.test.ts` reads the contract and fails when it holds a field they do not. So nothing a player could tell two permanents apart by is left out of a pile's key by oversight.
- **Fixed with it.** A land's pile was keyed by its name, its controller, whether it is tapped and its choices. A land an effect had turned into another type, or given an ability, hid among its namesakes. Lands are now held to every "alike" field, as tokens were.
- **Identity is kept.** A pile is drawing only. Every member is still its own card, with its own button and its own choices; a pile past its cap opens to all its members ("Show all 7 Soldier Token"). Commanders, attackers, blockers and anything with something attached are never piled.

## Batch declarations

At a `declare_attackers` or `declare_blockers` prompt a seat may name several of the creatures the prompt offers in one command, instead of one command a creature:

```json
{"type": "submit_choice", "prompt_id": "…", "payload": {"batch": {"objects": ["o41", "o42", "o43"], "then": {"seat": 2}}}}
```

- **Checked whole, first.** Every object must be one the open prompt offers to declare (or, with `"declare": false`, one already declared), and none twice. A batch that fails is refused whole (`422 invalid_batch`, naming the object) and declares nothing: the prompt and its revision are as they were.
- **Declared as one alone is.** The first object is the command's own answer. The rest follow as the prompt opens again, each answered by the engine with the option the prompt itself offers. XMage declares each attacker or blocker exactly as it does one given by hand, so a batch cannot make a declaration the rules do not allow.
- **Never confirmed for the player.** A batch does not press Done. The prompt comes back with the creatures declared, and Done stays the seat's own: XMage checks the whole declaration then, as it always has.
- **The question after a declaration.** XMage may ask which player, planeswalker or battle an attacker attacks, or which attacker a blocker blocks. A batch may carry the answer (`then`: an `object_id` or a `seat`). One that does not leaves the first such question to the seat, and gives the seat's answer to the questions that follow for the rest of the batch: the seat is asked once.
- **When it ends early.** With what it has declared left declared, and a line in the seat's messages saying how far it got and why: when the game asks anything else (a cost to pay), when the answer it carries is not offered, when one of its creatures can no longer be declared, or when the seat answers the declaration itself.
- **At most 250** objects a batch.
- **In the journal** each step is an ordinary answer (marked `"automatic": "batch"`), so a game taken up again plays them as it plays any other. The batch itself is not kept: a recovery in the middle of one leaves the seat its prompt, with what was declared.
- **In the web** the prompt panel offers one button for each name the declaration offers two or more of, the declared apart from the undeclared: "Attack with all 12 Goblin", "Stop attacking with all 8 Goblin", "Block with all 5 Saproling". They are ordinary buttons in the panel, in the tab order with every other choice.

## Yields

A priority prompt with an object on top of the stack offers **yield**: "Pass, and keep passing for Impact Tremors". It passes now, and the engine passes again for the seat each time priority comes with an object of the same source, the same words and the same controller on top.

A yield ends:

- **when what the seat can do has changed** since it yielded: the prompt's choices other than its passes are not the ones it had then (a card drawn, a land untapped, a new ability). The prompt is then the seat's to answer, with a line saying why;
- **at the end of the turn** it was made in;
- **when the seat cancels its passes** (`set_priority` with `cancel_passes`, the panel's "Stop yielding", or Escape).

And it never does more than it says:

- Anything else on top of the stack is the seat's to answer, and leaves the yield as it is.
- It never answers for a player whose turn the seat controls, and never anything but a priority prompt.
- It is a choice of the prompt, not of the stack object: a click on the stack cannot pass.
- It is named by what the seat reads on the stack. A spell or a source hidden from the seat is "this spell" or "this ability".
- The seat's view says what it yields to (`priority.yields`).
- In the journal each pass is an ordinary answer (`"automatic": "yield"`). Yields are not kept across a recovery.

XMage's own pass modes ("pass until the stack resolves" and the rest, UI07) are unchanged. They pass for everything until a point in the turn; a yield passes for one source only, and stops as soon as the seat has something new to do.

## Animation speed and reduced clutter

Both are the table's device settings (`cd.table.v1`, Settings › Display & accessibility and the Game menu):

- **Animation speed**: Normal, Fast or Faster (since v0.3.0). Reduce motion stills the table whatever it says.
- **Reduced clutter** (v0.9.12): a pile of like lands or tokens is drawn as one card with its count, instead of a fan of up to five. Nothing is hidden: the count opens every member, and each is still chosen by itself.

## Pace policies

A table's pace is a word its players agreed to (the [Rule Zero profile](../tables.md#rule-zero-table-profiles-v0912)'s `pace`). A **pace policy** says what the word means in numbers (`GET /api/v1/me/table-presets`, `paces`):

| Pace | The table says who it waits for after | The others may nudge after |
| --- | --- | --- |
| Relaxed | never | never |
| Steady | 60 s | 120 s |
| Brisk | 30 s | 60 s |

- **More time for a player who asks.** Each threshold is doubled (`extended_factor`).
- **Defined, not enforced.** Nothing measures a decision against them in v0.9.12 (`enforced` is false).
- **Apart from the response timer.** The response timer is a player's own device passing for its own player when it has nothing to answer, by that player's setting ([the game screen](../game-screen.md#the-response-timer-v030)). A pace policy belongs to the table, and never passes, concedes or moves for anyone.

## Performance fixtures and baselines

Three fixtures build a board of 600 permanents and measure what it costs. Each prints its numbers and fails only above a ceiling several times what was measured, so that a real regression fails it and a slow machine does not.

| Fixture | Board | Measured | Ceiling |
| --- | --- | --- | --- |
| `LargeBoardsTest.aBoardOfHundredsOfTokensIsBuiltAndSentWithinBudget` | Duel, 300 Goblin tokens a seat | A seat's snapshot built and serialized: median 2.8 to 3.7 ms, worst 10.6 to 20.1 ms over three runs; 264,295 bytes of JSON; `declare_attackers` offers 302 choices | 250 ms median, 2 MB |
| `LargeBoardsTest.sixSeatsOfTokensAreBuiltAndSentWithinBudget` | King's Table, six seats, 100 Goblin tokens each | 137 snapshots: median 2.7 ms, worst 24.3 ms; 310,905 bytes; `declare_attackers` offers 102 choices | 250 ms median, 2 MB |
| `largeBoard.test.ts` | The table's model and layout of 300 tokens a seat, one in ten unlike every other | 600 permanents in 68 units; model and layout median 22.3 ms, worst 33.0 ms | 1.5 s median |

Measured on the development machine on 2026-11-13 (the engine on Java 21, the table in Node). The hosted checks print the same lines in the engine job's and the web job's logs.

What the numbers say:

- **The engine is not the limit.** A view of 600 permanents costs a few milliseconds to build and is about 300 kB of JSON before any compression.
- **The choices were.** Declaring 300 attackers by hand is 300 commands; a batch is one, and Done.
- **The table stays readable.** 600 permanents are 68 units on the table, because like tokens pile.

## Keyboard

Every part is reached without a pointer:

- Each member of a pile keeps its own button, and a pile's count is a button that opens all of them.
- The batch buttons and the yield are ordinary buttons in the prompt panel, which lists every choice of the open prompt ([the game screen](../game-screen.md#keyboard-ui04)).
- "Stop yielding" is a button in the priority panel, and Escape cancels passes and yields alike.
- Reduced clutter and animation speed are ordinary form controls.

## Not yet

For v1.0.0 (section 27): choosing the defender before a batch on the table itself, batch buttons on a pile where it stands, repeated targets, pace policies shown and enforced with the accommodation as an account setting, and yields that outlast the turn where that is safe.
