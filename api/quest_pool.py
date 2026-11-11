"""The quest boards' pools (v0.9.5): the daily board's quests by step, and the weekly board's
canned goals by family and tier. api/quests.py draws from them and reads progress; docs/quests.md
lists them for players and staff.

- **Daily quests** are all wins (or games played) read from the results of api/stats.py, so every
  one can be done against bots alone. The board's five slots are its five steps, each harder than
  the one before: more wins, a stronger bot, a bigger table. Each pays its step's tokens.
- **Weekly goals** are each a family's variant at a tier (easy, medium or hard). A week's twenty
  come from twenty different families: six from the games, fourteen from outside them (Leng's card
  shop, Tivit's Auction House, decks, sleeves, the campaign). Every goal can be finished by one
  player alone: none asks for a friend, another player at the table or a buyer.
- **IDs are stable.** A goal's ID is its family and parameters; the reward and target are copied
  onto the drawn row, so a later change to the pool changes no board already drawn.
"""

from dataclasses import dataclass, field
from typing import Literal

from api.stats import Rule

# The rule boards are drawn and paid under, recorded on each quest and payment (PROG05).
POLICY = "quests-v2"

# What each daily step pays (the owner's choice at v0.9.5's start: "rich").
DAILY_TOKENS = (150, 250, 350, 500, 750)
Tier = Literal["easy", "medium", "hard"]
WEEKLY_TOKENS: dict[Tier, int] = {"easy": 250, "medium": 400, "hard": 650}
# A week's board: how many goals at each tier, and how many from the games.
WEEKLY_TIERS: dict[Tier, int] = {"easy": 6, "medium": 9, "hard": 5}
WEEKLY_IN_GAME = 6
WEEKLY_GOALS = sum(WEEKLY_TIERS.values())
DAILY_QUESTS = len(DAILY_TOKENS)

# Board bonuses with their streaks (the owner, 2026-11-10): a first full board pays the base, each
# board in a row a step more, up to the cap.
DAILY_BONUS = (400, 100, 1_000)
WEEKLY_BONUS = (2_000, 200, 5_000)

COLOURS = (("W", "white"), ("U", "blue"), ("B", "black"), ("R", "red"), ("G", "green"))

# What a weekly goal reads, from the server's own records (api/quests.py measures each):
# - wins, games: the account's results, as daily quests read them (games: any finished outcome);
# - table_games: games finished at a table (kind table), any outcome but no result;
# - campaign_wins: campaign duels won, replays and Apex Unbound included;
# - packs_bought: packs bought with tokens (not given), optionally on the weekly sale or of an era;
# - tokens_spent: tokens spent at Leng's card shop;
# - packs_opened: packs opened;
# - pulls: cards pulled from packs opened, optionally foil, of a rarity, new to the library, of a
#   colour or a card type;
# - listings: cards listed at Tivit's Auction House that stayed up an hour or sold;
# - auctions_won: auctions won from another account, at 50 tokens or more;
# - bids: other accounts' auctions bid on;
# - decks_built: decks that are legal with a full list and lasted a day;
# - sleeves: card sleeves uploaded and still kept.
Metric = Literal[
    "wins",
    "games",
    "table_games",
    "campaign_wins",
    "packs_bought",
    "tokens_spent",
    "packs_opened",
    "pulls",
    "listings",
    "auctions_won",
    "bids",
    "decks_built",
    "sleeves",
]
IN_GAME: frozenset[str] = frozenset({"wins", "games", "table_games"})


@dataclass(frozen=True)
class Params:
    """A goal's own conditions on what its metric counts."""

    sale: bool = False
    era: str | None = None
    finish: str | None = None
    rarities: tuple[str, ...] = ()
    new: bool = False
    color: str | None = None
    card_type: str | None = None
    format: str | None = None
    colors_at_least: int = 0
    buy_now: bool = False


@dataclass(frozen=True)
class DailyQuest:
    id: str
    name: str
    step: int
    # No two of a day's quests come from one family.
    family: str
    rule: Rule = Rule()
    target: int = 1
    metric: Literal["wins", "games"] = "wins"

    @property
    def tokens(self) -> int:
        return DAILY_TOKENS[self.step - 1]


@dataclass(frozen=True)
class WeeklyGoal:
    id: str
    name: str
    tier: Tier
    family: str
    metric: Metric
    target: int = 1
    rule: Rule = Rule()
    params: Params = field(default_factory=Params)

    @property
    def tokens(self) -> int:
        return WEEKLY_TOKENS[self.tier]

    @property
    def in_game(self) -> bool:
        return self.metric in IN_GAME


# A count as every quest and goal writes it (v0.9.8): in words below ten, in digits from ten, as
# the daily quests always did ("Win two games"). Until v0.9.8 the weekly goals from the games
# wrote digits ("Win 3 Commander games") and the others words up to six ("Buy two packs").
WORDS = {
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
}


# What a goal's name leaves unsaid (v0.9.8), by family: a way to it that nothing else shows. Every
# weekly goal can be finished alone; a table is the one that does not say how, since every table
# but a King's Table one needs two players' seats.
HINTS = {
    "tables": "Alone? Open a King's Table table and give every other seat to a bot.",
}


def in_words(count: int) -> str:
    return WORDS.get(count, f"{count:,}")


def number(count: int, one: str, many: str | None = None) -> str:
    """A count of things: "a pack", "an auction", "three packs", "12 games"."""
    if count == 1:
        return f"{'an' if one[0] in 'aeiouAEIOU' else 'a'} {one}"
    return f"{in_words(count)} {many or one + 's'}"


# The daily pool.


def daily_pool() -> tuple[DailyQuest, ...]:
    quests: list[DailyQuest] = []

    def add(
        step: int, family: str, name: str, rule: Rule = Rule(), target: int = 1, **kw: object
    ) -> None:
        quest_id = f"d{step}-{family}" + (f"-{target}" if target > 1 else "")
        quests.append(DailyQuest(quest_id, name, step, family, rule, target, **kw))  # type: ignore[arg-type]

    # Step 1: a single win, any way.
    add(1, "win", "Win a game")
    add(1, "play", "Play two games to the end", target=2, metric="games")
    add(1, "commander", "Win a Commander game", Rule(format="commander"))
    add(1, "legacy", "Win a Legacy game", Rule(format="legacy"))
    add(1, "skill-2", "Beat a bot of skill 2 or higher", Rule(skill_at_least=2))
    for color, word in COLOURS:
        add(1, f"colour-{word}", f"Win with a {word} deck", Rule(color=color))

    # Step 2: two wins, a bigger table or a stronger bot.
    add(2, "win", "Win two games", target=2)
    add(2, "play", "Play three games to the end", target=3, metric="games")
    add(2, "skill-3", "Beat a bot of skill 3 or higher", Rule(skill_at_least=3))
    add(2, "mono", "Win with a mono-coloured deck", Rule(mono=True))
    add(2, "two-colours", "Win with a deck of two or more colours", Rule(colors_at_least=2))
    add(2, "four-players", "Win a four-player Commander game", Rule(format="commander", seats=4))
    add(2, "two-headed", "Win a Two-Headed Giant game", Rule(format="two_headed_giant"))
    for color, word in COLOURS:
        add(
            2,
            f"colour-{word}",
            f"Win a Commander game with a {word} deck",
            Rule(format="commander", color=color),
        )

    # Step 3: three wins, or skill 4.
    add(3, "win", "Win three games", target=3)
    add(3, "skill-4", "Beat a bot of skill 4 or higher", Rule(skill_at_least=4))
    add(3, "commander", "Win two Commander games", Rule(format="commander"), target=2)
    add(3, "legacy", "Win two Legacy games", Rule(format="legacy"), target=2)
    add(3, "three-colours", "Win with a deck of three or more colours", Rule(colors_at_least=3))
    add(3, "kings-table", "Win a King's Table game", Rule(format="kings_table"))
    add(3, "play", "Play five games to the end", target=5, metric="games")
    for color, word in COLOURS:
        add(3, f"colour-{word}", f"Win two games with a {word} deck", Rule(color=color), target=2)

    # Step 4: skill 5, or several wins against skill 4.
    add(4, "skill-5", "Beat a bot of skill 5 or higher", Rule(skill_at_least=5))
    add(4, "win", "Win four games", target=4)
    add(4, "skill-4", "Beat bots of skill 4 or higher in two games", Rule(skill_at_least=4), 2)
    add(
        4,
        "four-players",
        "Win a four-player Commander game against skill 4 or higher",
        Rule(format="commander", seats=4, skill_at_least=4),
    )
    add(
        4,
        "two-headed",
        "Win a Two-Headed Giant game against skill 4 or higher",
        Rule(format="two_headed_giant", skill_at_least=4),
    )
    add(4, "commander", "Win three Commander games", Rule(format="commander"), target=3)
    for color, word in COLOURS:
        add(
            4,
            f"colour-{word}",
            f"Beat a skill-4 or higher bot with a {word} deck",
            Rule(color=color, skill_at_least=4),
        )

    # Step 5: skill 6, or a long day of wins.
    add(5, "skill-6", "Beat a skill-6 bot", Rule(skill_at_least=6))
    add(5, "win", "Win five games", target=5)
    add(5, "skill-5", "Beat bots of skill 5 or higher in two games", Rule(skill_at_least=5), 2)
    add(
        5,
        "four-players",
        "Win a four-player Commander game against skill-6 bots",
        Rule(format="commander", seats=4, skill_at_least=6),
    )
    add(
        5,
        "kings-table",
        "Win a King's Table game against skill 5 or higher",
        Rule(format="kings_table", skill_at_least=5),
    )
    add(
        5,
        "legacy",
        "Beat a skill-6 bot in Legacy",
        Rule(format="legacy", skill_at_least=6),
    )
    add(5, "five-colours", "Win with a five-colour deck", Rule(colors_at_least=5))
    for color, word in COLOURS:
        add(
            5,
            f"colour-{word}",
            f"Beat a skill-6 bot with a {word} deck",
            Rule(color=color, skill_at_least=6),
        )
    return tuple(quests)


# The weekly pool.

TIERS: tuple[Tier, ...] = ("easy", "medium", "hard")
# The eras a goal may ask for a pack of: those whose packs cost a few hundred tokens, not the
# first years' tens of thousands to millions.
GOAL_ERAS = (
    ("play", "a Play Booster era set"),
    ("collector", "a Set or Collector Booster era set"),
    ("frame15", "an M15-frame set"),
    ("mythic", "a set from the Mythic rare era"),
)
CARD_TYPES = ("creature", "instant", "sorcery", "artifact", "enchantment", "land", "planeswalker")
# The card types whose plural is not the word with an s.
CARD_TYPE_PLURALS = {"sorcery": "sorceries"}


def weekly_pool() -> tuple[WeeklyGoal, ...]:
    goals: list[WeeklyGoal] = []

    def tiered(
        family: str,
        metric: Metric,
        targets: tuple[int, int, int],
        name: object,
        rule: Rule = Rule(),
        params: Params | None = None,
    ) -> None:
        for tier, target in zip(TIERS, targets, strict=True):
            if not target:
                continue
            goals.append(
                WeeklyGoal(
                    f"w-{family}-{target}",
                    name(target) if callable(name) else str(name),
                    tier,
                    family,
                    metric,
                    target,
                    rule,
                    params or Params(),
                )
            )

    # In the games.
    tiered("wins", "wins", (3, 7, 12), lambda n: f"Win {number(n, 'game')}")
    tiered("play", "games", (5, 10, 20), lambda n: f"Play {number(n, 'game')} to the end")
    tiered(
        "commander",
        "wins",
        (2, 4, 8),
        lambda n: f"Win {number(n, 'Commander game')}",
        Rule(format="commander"),
    )
    tiered(
        "legacy",
        "wins",
        (1, 3, 6),
        lambda n: f"Win {number(n, 'Legacy game')}",
        Rule(format="legacy"),
    )
    tiered(
        "four-players",
        "wins",
        (1, 3, 5),
        lambda n: f"Win {number(n, 'four-player Commander game')}",
        Rule(format="commander", seats=4),
    )
    tiered(
        "two-headed",
        "wins",
        (1, 2, 4),
        lambda n: f"Win {number(n, 'Two-Headed Giant game')}",
        Rule(format="two_headed_giant"),
    )
    tiered(
        "kings-table",
        "wins",
        (1, 2, 3),
        lambda n: f"Win {number(n, "King's Table game")}",
        Rule(format="kings_table"),
    )
    tiered(
        "skill-5",
        "wins",
        (1, 3, 6),
        lambda n: f"Beat bots of skill 5 or higher in {number(n, 'game')}",
        Rule(skill_at_least=5),
    )
    tiered(
        "skill-6",
        "wins",
        (1, 2, 4),
        lambda n: f"Beat skill-6 bots in {number(n, 'game')}",
        Rule(skill_at_least=6),
    )
    tiered(
        "mono",
        "wins",
        (1, 3, 5),
        lambda n: f"Win {number(n, 'game')} with a mono-coloured deck",
        Rule(mono=True),
    )
    tiered(
        "multicolour",
        "wins",
        (1, 3, 5),
        lambda n: f"Win {number(n, 'game')} with a deck of three or more colours",
        Rule(colors_at_least=3),
    )
    tiered("tables", "table_games", (1, 3, 5), lambda n: f"Finish {number(n, 'game')} at a table")
    for color, word in COLOURS:
        tiered(
            f"colour-{word}",
            "wins",
            (2, 4, 7),
            lambda n, word=word: f"Win {number(n, 'game')} with a {word} deck",
            Rule(color=color),
        )
        tiered(
            f"legacy-{word}",
            "wins",
            (1, 2, 4),
            lambda n, word=word: f"Win {number(n, 'Legacy game')} with a {word} deck",
            Rule(format="legacy", color=color),
        )
        tiered(
            f"commander-{word}",
            "wins",
            (1, 3, 5),
            lambda n, word=word: f"Win {number(n, 'Commander game')} with a {word} deck",
            Rule(format="commander", color=color),
        )

    # Leng's card shop.
    tiered("buy-packs", "packs_bought", (1, 3, 6), lambda n: f"Buy {number(n, 'pack')} at Leng's")
    tiered(
        "sale-packs",
        "packs_bought",
        (1, 2, 4),
        lambda n: f"Buy {number(n, 'pack')} on the weekly sale",
        params=Params(sale=True),
    )
    for era, words in GOAL_ERAS:
        tiered(
            f"era-{era}",
            "packs_bought",
            (1, 2, 4),
            lambda n, words=words: f"Buy {number(n, 'pack')} from {words}",
            params=Params(era=era),
        )
        tiered(
            f"open-{era}",
            "packs_opened",
            (1, 3, 5),
            lambda n, words=words: f"Open {number(n, 'pack')} from {words}",
            params=Params(era=era),
        )
    tiered(
        "land-packs",
        "packs_bought",
        (1, 2, 3),
        lambda n: f"Buy {number(n, 'basic land pack')}",
        params=Params(era="lands"),
    )
    tiered(
        "spend",
        "tokens_spent",
        (500, 2_000, 5_000),
        lambda n: f"Spend {n:,} tokens at Leng's card shop",
    )
    tiered("open", "packs_opened", (2, 5, 10), lambda n: f"Open {number(n, 'pack')}")
    tiered(
        "foils",
        "pulls",
        (1, 2, 4),
        lambda n: f"Pull {number(n, 'foil card')} from packs",
        params=Params(finish="foil"),
    )
    tiered(
        "rares",
        "pulls",
        (1, 3, 8),
        lambda n: f"Pull {number(n, 'rare or mythic rare', 'rares or mythic rares')} from packs",
        params=Params(rarities=("rare", "mythic")),
    )
    tiered(
        "mythics",
        "pulls",
        (0, 1, 2),
        lambda n: f"Pull {number(n, 'mythic rare')} from packs",
        params=Params(rarities=("mythic",)),
    )
    tiered(
        "new-cards",
        "pulls",
        (10, 30, 75),
        lambda n: f"Add {in_words(n)} cards new to your library from packs",
        params=Params(new=True),
    )
    for color, word in COLOURS:
        tiered(
            f"pull-{word}",
            "pulls",
            (5, 15, 30),
            lambda n, word=word: f"Pull {in_words(n)} {word} cards from packs",
            params=Params(color=color),
        )
    for card_type in CARD_TYPES:
        targets = (1, 2, 4) if card_type == "planeswalker" else (5, 12, 25)
        # "sorceries", not "sorcerys" (v0.9.7).
        many = CARD_TYPE_PLURALS.get(card_type)
        tiered(
            f"pull-{card_type}",
            "pulls",
            targets,
            lambda n,
            card_type=card_type,
            many=many: f"Pull {number(n, card_type, many)} from packs",
            params=Params(card_type=card_type),
        )

    # Tivit's Auction House.
    tiered(
        "list",
        "listings",
        (1, 3, 6),
        lambda n: f"List {number(n, 'card')} at Tivit's Auction House",
    )
    tiered(
        "list-rares",
        "listings",
        (1, 2, 4),
        lambda n: f"List {number(n, 'rare or mythic rare', 'rares or mythic rares')} at auction",
        params=Params(rarities=("rare", "mythic")),
    )
    tiered(
        "list-buy-now",
        "listings",
        (1, 2, 4),
        lambda n: f"List {number(n, 'card')} with a Buy Now price",
        params=Params(buy_now=True),
    )
    tiered(
        "win-auctions",
        "auctions_won",
        (1, 2, 4),
        lambda n: f"Win {number(n, 'auction')} from another player",
    )
    tiered(
        "bids", "bids", (1, 3, 6), lambda n: f"Bid on {number(n, 'auction')} of another player's"
    )

    # Decks.
    tiered("decks", "decks_built", (1, 2, 3), lambda n: f"Build {number(n, 'new legal deck')}")
    tiered(
        "commander-deck",
        "decks_built",
        (1, 2, 0),
        lambda n: f"Build {number(n, 'new legal Commander deck')}",
        params=Params(format="commander"),
    )
    tiered(
        "legacy-deck",
        "decks_built",
        (1, 2, 0),
        lambda n: f"Build {number(n, 'new legal Legacy deck')}",
        params=Params(format="legacy"),
    )
    tiered(
        "multicolour-deck",
        "decks_built",
        (0, 1, 2),
        lambda n: f"Build {number(n, 'new legal deck')} of three or more colours",
        params=Params(colors_at_least=3),
    )
    for color, word in COLOURS:
        goals.append(
            WeeklyGoal(
                f"w-deck-{word}-1",
                f"Build a new legal {word} deck",
                "medium",
                f"deck-{word}",
                "decks_built",
                1,
                params=Params(color=color),
            )
        )

    # Sleeves and the campaign.
    goals.append(
        WeeklyGoal("w-sleeve-1", "Upload a new card sleeve", "easy", "sleeve", "sleeves", 1)
    )
    tiered(
        "campaign",
        "campaign_wins",
        (1, 2, 4),
        lambda n: f"Win {number(n, 'campaign duel')}",
    )
    return tuple(goals)


DAILY = daily_pool()
WEEKLY = weekly_pool()
DAILY_BY_ID = {quest.id: quest for quest in DAILY}
WEEKLY_BY_ID = {goal.id: goal for goal in WEEKLY}
