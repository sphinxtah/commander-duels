"""King's Table (v0.8.7): two teams of three, after Magic's Emperor (CR 809). docs/kings-table.md
describes the mode; this module holds what the API needs of it.

- **Seats.** Six, in a fixed circle, the same in the engine and the API: 0 is team A's Left
  General, 1 team A's King, 2 team A's Right General, 3 team B's Right General, 4 team B's King,
  5 team B's Left General. A seat's team is seat // 3; the Kings sit in seats 1 and 4. The engine
  enforces range and who may attack whom.
- **Settings** (KingsTableSettings), chosen before anyone is ready and fixed once the game
  starts: the decks' format (Legacy or Commander, for all six decks, checked by that format's
  own legality and banned list), the starting life (20 or 40 for everyone, or 20 for the
  Generals and 40 for the Kings, whatever the deck format would give), and whether a King may
  attack anyone (a house rule the engine enforces). Kept with the table and with its game.
- **The result.** A King's elimination loses their team the game; both Kings at once is a draw. An
  eliminated General leaves and their team plays on, and the team's result is theirs too: the
  engine's winner_seats leaves such a General out, so the API takes the winning team from any
  winning seat (team_result) and counts, pays and records every seat of it.
"""

from typing import Any, Literal

from api.schemas import KingsTableSettings

FORMAT = "kings_table"
SEATS = 6
KINGS = (1, 4)
TEAMS = ((0, 1, 2), (3, 4, 5))
# The engine's fixture decks the bots play when a seat names none, by the decks' format.
DECK_FORMATS = ("legacy", "commander")
Role = Literal["king", "general"]


def team_of(seat: int) -> int:
    return seat // 3


def role_of(seat: int) -> Role:
    return "king" if seat in KINGS else "general"


def config_of(raw: object) -> KingsTableSettings:
    """The settings a table or a game keeps (JSON), or the defaults for a row without them."""
    if isinstance(raw, KingsTableSettings):
        return raw
    return KingsTableSettings.model_validate(raw if isinstance(raw, dict) else {})


def starting_life(settings: KingsTableSettings, seat: int) -> int:
    if settings.life == "all_20":
        return 20
    if settings.life == "all_40":
        return 40
    return 40 if seat in KINGS else 20


def engine_settings(settings: KingsTableSettings) -> dict[str, object]:
    """The engine's kings_table object: exactly the three settings."""
    return settings.model_dump(mode="json")


def team_result(result: dict[str, Any]) -> dict[str, Any]:
    """The engine's result with the winning team made whole: winner_seats every seat of the team
    of any seat the engine names a winner (an eliminated General is one of them), and winner_team
    that team. A draw, or a game with no winner, has none."""
    named = [seat for seat in result.get("winner_seats") or [] if isinstance(seat, int)]
    winner = result.get("winner_seat")
    if isinstance(winner, int):
        named.append(winner)
    if result.get("draw") is True or not named:
        return {**result, "winner_team": None}
    team = team_of(named[0])
    return {
        **result,
        "winner_seat": winner if isinstance(winner, int) else min(named),
        "winner_seats": list(TEAMS[team]),
        "winner_team": team,
    }
