# King's Table (v0.8.7)

King's Table is the owner's six-player mode: Magic's Emperor variant (rule 809) with the owner's settings and one house rule, which since v0.9.7 has a guard. Two teams of three each have a **King**, the variant's emperor, and two **Generals**. A team wins when the other team's King is out. "King" and "General" are player roles, apart from commanders and the monarch: losing a commander changes neither.

It is played at [tables](tables.md#kings-table-v087), with humans in any seats and bots filling the rest, and on the practice table, one player and five bots. It isn't in the public queues. The owner asked for it on 2026-11-03 as "Emperor", renamed King's Table the same day.

## The settings

The host picks them before the game. Every combination plays. The table shows them before anyone readies, changing a setting or a seat clears every seat's readiness, and they lock when the game starts.

| Setting | Choices | Default |
| --- | --- | --- |
| Deck format, for all six players | Legacy or Commander | Commander |
| Starting life | Everyone 20, everyone 40, or Generals 20 and Kings 40 | Everyone 40 |
| House rule: "King can attack anyone" | Off or on | Off at a table; on in a practice game (v0.9.1) |
| The house rule's guard: "Generals guard their King" (v0.9.7) | Off or on, with the house rule on | Off; on at [the campaign's court](campaign.md) |

- **Legacy decks.** They use the format's own legality and banned list: at least 60 cards and four copies at most. There are no commanders, no commander tax and no commander damage. Single games have no sideboard.
- **Commander decks.** They use the format's own legality and banned list: 100 cards with a commander or a legal pair, singleton and colour identity. Every player has their own commander, Generals included, with the command zone, commander tax and 21 combat damage from one commander (903.10a). That 21 holds at any starting life and counts across control and zone changes. Noncombat damage doesn't count.
- **No King's Table banned list.** There is none of its own.
- **Starting life.** It overrides the deck format's. Each player's own is kept: cards that read "your starting life total" read the player's own (XMage patch 0011, below).

## Seats and teams

The six seats go around the table in this order, and every distance and every neighbour is counted around it, whatever the screen draws:

| Seat | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- | --- |
| Team A | Left General | **King** | Right General | | | |
| Team B | | | | Right General | **King** | Left General |

Seat 5 sits beside seat 0, so the Generals face each other in pairs: seat 0 against seat 5, and seat 2 against seat 3.

- **Own resources.** Each player has their own life total, library, hand, mana, permanents, graveyard and counters, and controls their own things.
- **Teammates.** They are allies, not opponents. They may look at each other's hands, and an effect that says "player" may reach a teammate when its words and range allow.
- **Blocking.** Nobody blocks for a teammate.

## Turns

- **Order.** Each player takes their own turns in seat order, skipping players who are out. There is one stack and normal multiplayer priority.
- **First turn.** A King chosen at random takes it, and draws in it.
- **Mulligans.** London mulligans, and the first one is free (103.5c).
- **Attacking several players.** A player may split their attackers among the players they may attack (802).

## Range of influence

A General reaches one seat each way and a King two (809.4a). A player is always in their own range.

- **When range is set.** As each turn begins, every player's range is set again, around the players still in the game (801.2c). It then holds for the turn.
- **What range limits.** Spells, abilities, targets and effects keep to it, "each player" and "each opponent" included.
- **What the screen shows.** It shows the whole table: what a player may see is the same as anywhere else. The game marks which players are in your range and which you may attack.

## Attacking

**Practice games default it on (v0.9.1).** With it off a King has no one to attack while both of its Generals stand, and a practice table of bots could stall for dozens of turns (v0.9.0's 37 turns at 40 life). The practice options and a practice request without settings take it on; a table's host still chooses, off by default.

**With the house rule off (809.4b).** A player may attack only an opponent beside them who is also in their range, and that player's planeswalkers and the battles they protect.

- **At the start.** Each General faces the opposing General beside them, and neither King can attack.
- **After eliminations.** A player leaving opens new neighbours at once, and new range at the next turn. Eliminating a General never opens the whole table.

**With the house rule on.** Either King's creatures may attack any opponent still in the game, the other King included, even while all four Generals live. That also covers the planeswalkers and battles those opponents defend. The King's attackers may be split among them. Every other attack requirement, restriction and cost still applies.

- **The Generals.** They keep the usual restriction.
- **Who the permission follows.** It goes with the attacking player, the creatures' controller: a King's creature that a General controls attacks as the General's.

**With the house rule's guard on (v0.9.7, "Generals guard their King").** The owner's rule of 2026-11-10 for the campaign's court: "Kings can attack anyone, except other kings, unless a general is defeated."

- **From the start.** Either King's creatures may attack either opposing General, and the planeswalkers and battles they defend, but not the other King.
- **Once a General is out.** A King may attack the other King as soon as one of *that* King's Generals is out of the game: defeated, conceded or removed. Which of the two doesn't matter. The guard is each King's own: beating one of team B's Generals opens team B's King to team A's King, and team A's King stays guarded while both of its Generals stand.
- **The Generals** attack as ever: the opponent beside them and in range, which is the opposing King once the General facing them is out.
- **It belongs to the house rule.** With the house rule off the guard changes nothing: by 809.4b the two Kings sit beside each other only once the Generals on one side of the table are both out, one of each King's. The setting is offered only with the house rule on, and turning the house rule off in the app turns it off.
- **In the engine** it is one more test in the single attack hook (`KingsTable.attackable`, `KingsTable.guarded`), so the seat views' `attackable` flags, the bots' attack plans and combat across range follow it.

**Choosing whom to attack (fixed in v0.9.8).** When an attacker has more than one thing it may attack, the player is asked which: every player the rules above let them attack, with the planeswalkers and battles those players defend, whatever the range.

- **The owner's report.** At the campaign's court, Liliana's Contract made both of The Sphinx's Generals lose at the player's upkeep, and in that turn's combat neither The Sphinx nor his planeswalker could be chosen. The guard had fallen and the combat named both, but the choice kept to the attacking player's range, which is set as a turn begins, so it offered nothing.
- **Who else it reached.** Any King the house rule let a human King attack across range, whenever there was a second thing to attack: the faraway King beside the Generals (without the guard, since v0.8.7), or a King with a planeswalker or a battle. With one thing to attack nothing is asked, which hid it.
- **What stays.** Range still holds for spells, abilities and effects until the next turn begins: only the attack reaches across it.

**Combat across range.** An attack that the house rule sends out of range is a whole combat:

- The defender blocks with their own creatures.
- Both sides deal and are dealt combat damage.
- Unblocked attackers damage the player or permanent they attack.
- Combat keywords and combat-only restrictions work.
- Both players' abilities see that combat's attacks, blocks and damage, and commander damage counts.

Outside that combat, range holds. The King still can't aim a burn spell at the faraway King, and the defender can't aim removal back. A trigger the combat sets off keeps to range in what it targets and does.

## Deploying creatures (804)

Each creature has "{T}: Target teammate in your range gains control of this creature. Activate only as a sorcery."

- **What it changes.** Control, not ownership. The creature stays tapped, and the usual rules for a creature that has just changed control apply.
- **Afterwards.** The creature plays by its new controller's role and range.
- **Commanders.** A deployed commander stays a commander.
- **When it works.** In both deck formats, with the house rule on or off. The table's command zone shows it as each player's "Deploy" emblem.
- **The bots.** They never deploy, by the owner's choice, but they may be given creatures.

## Winning and losing (809.5)

- **Losing.** Every usual way of losing applies: life, poison, drawing from an empty library, commander damage in Commander, and cards.
- **A General who loses.** They leave the game (800.4). Their permanents and everything else leave with them, nothing passes to the King, and their team plays on.
- **A King who loses or concedes.** Their whole team loses, and the other team wins. Both Kings at once is a draw.
- **Simultaneous losses.** They are seen together, as state-based actions see them.
- **"Can't lose" and "can't win" effects.** They apply to each player as usual.
- **"You win the game" effects.** A player who wins by an effect makes their opponents in range lose (801.16), and wins only if that leaves no opponent. So a faraway King still has to be beaten.
- **The team's result.** It counts for all three of its players, a General who left earlier included: the win or loss, the record and the pay ([tables](tables.md#kings-table-v087)).

## In the engine

- **Game classes.** `KingsTableGame` (Legacy decks) and `KingsTableCommanderGame` (Commander decks) share `KingsTable`'s rules. `KingsTableRules` holds the settings and the seats.
- **The request.** `"format": "kings_table"`, six seats, and `"kings_table": {"deck_format", "life", "king_attacks_anyone", "guarded_kings"}` (the last since v0.9.7; each left out takes its default). A starting seat must be a King's. Without one, a King drawn at random starts. A request without a `turn_cap` takes 240 turns, 40 for each of the six players (v0.9.7).
- **The seat views.** Each player carries `team`, `role`, `starting_life`, `in_range` and `attackable`. The settings echo `kings_table` ([the seat-view contract](../contracts/engine-seat-view.schema.json)).
- **XMage patch 0011** ([the patches](../engine/xmage/patches/README.md)):
  - **Allies.** Players of a team who keep their own turns, apart from patch 0001's shared-turn teammates.
  - **Attack hooks.** The game's own attack rules, and combat across range.
  - **Starting life.** Each player's own, read by the 17 cards and the one condition that name it.
  - **Bots.** They spare allies, score allies' permanents with their own, and plan attacks only at players the game lets them attack.

  Every default keeps other formats as they were.
- **XMage patch 0016** (v0.9.8): the choice of a defender (`TargetDefender`) offers every defender the combat names that is still there, in place of those among them in the attacking player's range. Other games name only defenders in range, so their choice is unchanged.
- **`KingsTableTest`.** It covers the owner's acceptance checks:
  - every setting combination, each seat's starting life, team and range;
  - the Kings' attacks with the house rule off and on;
  - the guard (v0.9.7): a King attacking the opposing Generals from the start and the other King only once one of that King's Generals is out, each King by its own Generals, and the guard changing nothing with the house rule off;
  - a General's exit opening neighbours at once and range at the next turn;
  - a King's loss ending the game for the whole team, a General out earlier included, and both Kings at once as a draw;
  - a King's attack across range: blocks, and no new targets or "each opponent";
  - a deployed King's creature attacking by the General's rules;
  - six bots playing whole games in both deck formats, every attack checked against the rules;
  - a human King with five bots under every leak check.
- **`KingsTableAttackChoiceTest`** (v0.9.8). It plays the owner's report through a human seat: the Contract and four Demons beat both opposing Generals at the upkeep, and in that turn the other King and his planeswalker are both offered and the attack lands. `KingsTableTest` checks the choice itself, with and without the guard. Both fail without patch 0016.

## Not built, or to watch in play

- **Bots and the house rule.** A bot King rarely uses it: the bots plan attacks at every player they may attack, but seldom choose the faraway King.
- **Effects that make a player win or stop a player losing.** Cards rarely do this, and these edge cases follow XMage's own range rules (801.14 to 801.16). If a General of a beaten team "can't lose", the game still ends and their team still loses.
- **XMage's range of influence.** Range is XMage's own for every card. A few cards' code may not follow limited range (XMage's own note on `getPlayersInRange`). Watch for any card that reaches a player out of range.
