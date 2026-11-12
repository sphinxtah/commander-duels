"""Game modes and reward eligibility (v0.9.10, the specification's §10; docs/modes.md).

Every game has a mode, set when it is made (``games.mode``), and every result the mode of its game
(``player_results.mode``). One function, ``eligibility``, decides what a game of a mode may earn
its players, reward by reward, with a reason code for each one withheld; ``api/games.py`` asks it
as a game ends, and records its answer with the game (``games.eligibility``), so it can always be
told why a game paid what it did. Settling a game twice settles nothing twice: every grant is keyed,
as before.

**Nothing changes by default.** The policies of the modes that exist (practice, table, campaign,
testing) are what the code did before v0.9.10, which ``tests/test_modes.py`` pins, mode by mode
and reward by reward. The modes that do not exist yet (sandbox, borrowed, the leagues') are
classified here so that their foundations have a policy to ask; their policies are proposals for
the owner, and no game is made in them until v1.0.0.
"""

from dataclasses import dataclass, field
from typing import Literal, get_args

Mode = Literal[
    "practice",  # against bots, alone or with the practice table (v0.1.0)
    "table",  # people at a table, a queue's or a match's (v0.4.0)
    "campaign",  # a campaign duel or the court (v0.8.0): the campaign pays its own spoils
    "sandbox",  # v1.0.0: any implemented card, owned or not
    "borrowed",  # v1.0.0: a seat plays a friend's lent deck
    "league_practice",  # v1.0.0: a league's pool, outside its standings
    "league",  # v1.0.0: a league's match, for its standings
    "testing",  # results SysOp grants for testing (v0.8.8); no game is played
]
MODES: tuple[str, ...] = get_args(Mode)

Reward = Literal["tokens", "wins", "quests", "achievements", "statistics", "competitive"]
REWARDS: tuple[str, ...] = get_args(Reward)

# Why a reward is withheld: stable codes, recorded with the game.
CAMPAIGN_PAYS_ITS_OWN = "campaign_pays_its_own"
NOT_COMPETITIVE = "not_competitive"
SANDBOX = "sandbox_cards_not_owned"
LEAGUE_PRACTICE = "league_practice"
LEAGUE_POLICY_PENDING = "league_rewards_not_approved"
GRANTED_FOR_TESTING = "granted_for_testing"
NO_RESULT = "no_result"


@dataclass(frozen=True)
class Eligibility:
    """What a game of a mode may earn its players: each reward earned or withheld, and why."""

    mode: str
    withheld: dict[str, str] = field(default_factory=dict)

    def earns(self, reward: Reward) -> bool:
        return reward not in self.withheld

    def record(self) -> dict[str, object]:
        """As the game keeps it (``games.eligibility``)."""
        return {
            "mode": self.mode,
            "earns": [reward for reward in REWARDS if reward not in self.withheld],
            "withheld": dict(self.withheld),
        }


# Each mode's rewards withheld, with why. The modes that exist are what the code did before
# v0.9.10; the others are proposals (docs/modes.md) until the owner approves a policy.
POLICIES: dict[str, dict[str, str]] = {
    "practice": {"competitive": NOT_COMPETITIVE},
    "table": {"competitive": NOT_COMPETITIVE},
    "campaign": {
        # The campaign's own rewards (spoils, chapter tokens, decks) are its business
        # (api/campaign.py); a campaign duel counts no win, pays no win's tokens, fills no quest,
        # earns no achievement and keeps no result (v0.8.0).
        "tokens": CAMPAIGN_PAYS_ITS_OWN,
        "wins": CAMPAIGN_PAYS_ITS_OWN,
        "quests": CAMPAIGN_PAYS_ITS_OWN,
        "achievements": CAMPAIGN_PAYS_ITS_OWN,
        "statistics": CAMPAIGN_PAYS_ITS_OWN,
        "competitive": NOT_COMPETITIVE,
    },
    "sandbox": {reward: SANDBOX for reward in REWARDS},
    "borrowed": {"competitive": NOT_COMPETITIVE},
    "league_practice": {
        "tokens": LEAGUE_PRACTICE,
        "wins": LEAGUE_PRACTICE,
        "quests": LEAGUE_PRACTICE,
        "achievements": LEAGUE_PRACTICE,
        "competitive": LEAGUE_PRACTICE,
    },
    "league": {
        "tokens": LEAGUE_POLICY_PENDING,
        "wins": LEAGUE_POLICY_PENDING,
        "quests": LEAGUE_POLICY_PENDING,
        "achievements": LEAGUE_POLICY_PENDING,
    },
    # A result granted for testing counts as a win and towards quests and achievements, and is
    # left out of the account's statistics and history (v0.8.8, api/stats.py played()). No win's
    # tokens are paid for it.
    "testing": {
        "tokens": GRANTED_FOR_TESTING,
        "statistics": GRANTED_FOR_TESTING,
        "competitive": GRANTED_FOR_TESTING,
    },
}

# Proposals: modes no game is made in yet. A mode here is refused for a game until approved.
PROPOSED = frozenset({"sandbox", "borrowed", "league_practice", "league"})


def eligibility(mode: str, *, result: bool = True) -> Eligibility:
    """What a game of ``mode`` may earn. ``result``: whether it ended with one (an interrupted or
    closed game without a winner earns nothing, whatever its mode; its results stay "no result").
    An unknown mode earns nothing: a game the code cannot classify pays out nothing rather than
    the wrong thing."""
    if mode not in POLICIES:
        return Eligibility(mode, {reward: "unknown_mode" for reward in REWARDS})
    withheld = dict(POLICIES[mode])
    if not result:
        # Its players' results are still kept, as "no result" (api/stats.py), as before.
        for reward in REWARDS:
            if reward != "statistics":
                withheld.setdefault(reward, NO_RESULT)
    return Eligibility(mode, withheld)


def mode_of(kind: str, campaign: bool) -> str:
    """The mode of a game made before v0.9.10, from what it is: its kind, and whether a campaign
    duel links it. Migration 0045 fills old games' mode with it, as games.mode is read."""
    if campaign:
        return "campaign"
    return "table" if kind == "table" else "practice"
