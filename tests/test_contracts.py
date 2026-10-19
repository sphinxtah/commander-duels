import copy
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from jsonschema import Draft202012Validator, ValidationError
from referencing import Registry, Resource

from api.main import create_app


def validator_for(path: str) -> Draft202012Validator:
    schema = json.loads(Path(path).read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def test_generated_openapi_is_current():
    assert json.loads(Path("contracts/openapi.json").read_text()) == create_app().openapi()


def test_engine_contract_rejects_unsupported_versions_and_client_seats():
    validator = validator_for("contracts/engine-command.schema.json")
    command = {
        "v": 1,
        "game_id": str(uuid4()),
        "action_id": str(uuid4()),
        "expected_revision": 0,
        "prompt_id": str(uuid4()),
        "type": "submit_choice",
        "payload": {"option_id": "1"},
    }
    validator.validate(command)
    validator.validate(command | {"payload": {"amounts": [2, 0, 3]}})
    validator.validate(command | {"type": "concede", "payload": {}})
    for changes in [
        {"v": 2},
        {"seat": 1},
        {"game_id": "forged"},
        {"expected_revision": -1},
        {"payload": {}},
        {"payload": {"option_id": "1", "amounts": [1]}},
        {"payload": {"option_id": "1", "seat": 1}},
        {"payload": {"amounts": [-1]}},
        {"type": "concede", "payload": {"option_id": "1"}},
    ]:
        with pytest.raises(ValidationError):
            validator.validate(command | changes)
    without_prompt = {key: value for key, value in command.items() if key != "prompt_id"}
    with pytest.raises(ValidationError):
        validator.validate(without_prompt)


def card(object_id: str, name: str) -> dict[str, Any]:
    return {
        "id": object_id,
        "hidden": False,
        "name": name,
        "mana_cost": "{R}",
        "type_line": "Instant",
        "power": None,
        "toughness": None,
        "rules": ["Lightning Bolt deals 3 damage to any target."],
    }


def player(seat: int) -> dict[str, Any]:
    return {
        "seat": seat,
        "name": f"{['Human', 'Bot', 'Bot', 'Human'][seat]} {seat + 1}",
        "life": 40,
        "counters": {},
        "library_count": 92,
        "hand_count": 7,
        "graveyard": [],
        "exile": [],
        "mana_pool": {"white": 0, "blue": 0, "black": 0, "red": 0, "green": 0, "colorless": 0},
        "lost": False,
        "won": False,
        "color_identity": "WURG"[seat],
        "command_zone": [card(f"o{seat + 2:016x}", "Isamaru, Hound of Konda")],
        "commanders": [
            {
                "name": "Isamaru, Hound of Konda",
                "zone": "command",
                "object_id": f"o{seat + 2:016x}",
                "cast_count": 1,
                "tax": 2,
                "damage_dealt": [{"seat": (seat + 1) % 4, "damage": 2}],
            }
        ],
    }


def snapshot() -> dict[str, Any]:
    return {
        "game_id": str(uuid4()),
        "revision": 12,
        "status": "your_prompt",
        "seat": 0,
        "settings": {
            "format": "commander",
            "rules_profile": "commander_free_for_all",
            "seats": [
                {"seat": 0, "player": "human", "deck": "commander-mono-white-soldiers"},
                {"seat": 1, "player": "bot", "deck": None},
                {"seat": 2, "player": "bot", "deck": None},
                {"seat": 3, "player": "human", "deck": None},
            ],
            "skill": 4,
            "turn_cap": 60,
            "idle_timeout_seconds": 900,
            "spectator_delay_seconds": 0,
        },
        "prompt": {
            "id": str(uuid4()),
            "kind": "priority",
            "message": "Play spells and abilities",
            "detail": None,
            "options": [
                {
                    "id": "1",
                    "action": "pass",
                    "label": "Pass priority",
                    "object_id": None,
                    "seat": None,
                    "selected": False,
                },
                {
                    "id": "2",
                    "action": "cast",
                    "label": "Lightning Bolt",
                    "object_id": "o0123456789abcdef",
                    "seat": None,
                    "selected": False,
                },
            ],
            "amounts": None,
            "piles": None,
            "xmage_query": None,
        },
        "view": {
            "seat": 0,
            "turn": 1,
            "active_seat": 0,
            "priority_seat": 0,
            "phase": "precombat_main",
            "step": "precombat_main",
            "you": player(0),
            "opponents": [player(1), player(2), player(3)],
            "hand": [card("o0123456789abcdef", "Lightning Bolt")],
            "battlefield": [],
            "stack": [],
            "combat": [],
            "revealed": [],
            "looked_at": [],
            "messages": [],
        },
        "result": None,
        "log_count": 1,
        "log_from": 0,
        "log": [
            {"index": 0, "turn": 1, "active_seat": 0, "step": "UNTAP", "text": "Human 1 mulligans"}
        ],
    }


def opponent_commander(snapshot: dict[str, Any]) -> dict[str, Any]:
    commander: dict[str, Any] = snapshot["view"]["opponents"][0]["commanders"][0]
    return commander


def test_seat_view_contract_cannot_carry_concealed_information():
    validator = validator_for("contracts/engine-seat-view.schema.json")
    validator.validate(snapshot())

    secret = card("o1111111111111111", "Giant Growth")
    leaks: list[tuple[str, Any]] = [
        ("opponent hand", lambda view: view["view"]["opponents"][2].update(hand=[secret])),
        ("library contents", lambda view: view["view"]["you"].update(library=[])),
        ("shuffle seed", lambda view: view["settings"].update(seed=42)),
        ("XMage object id", lambda view: view["view"]["hand"][0].update(id=str(uuid4()))),
        ("named hidden card", lambda view: view["view"]["hand"][0].update(hidden=True)),
        ("unknown prompt kind", lambda view: view["prompt"].update(kind="reveal_hand")),
        ("seat chosen by option", lambda view: view["prompt"]["options"][0].update(seat=7)),
        ("a fifth seat", lambda view: view["view"]["opponents"].append(player(3) | {"seat": 4})),
        ("hidden commander's object", lambda view: opponent_commander(view).update(zone="hidden")),
        ("commander library", lambda view: opponent_commander(view).update(library=[])),
        ("odd commander tax", lambda view: view["view"]["you"]["commanders"][0].update(tax=3)),
        ("legacy deck field", lambda view: view["settings"].update(bot_deck="legacy-burn")),
    ]
    for description, mutate in leaks:
        leaked = copy.deepcopy(snapshot())
        mutate(leaked)
        with pytest.raises(ValidationError):
            validator.validate(leaked)
            pytest.fail(f"schema accepted {description}")


def spectator() -> dict[str, Any]:
    watched = snapshot()
    watched.update(seat=None, status="spectating", prompt=None)
    watched["view"].update(seat=None, you=None, hand=[])
    watched["view"]["opponents"] = [player(0), player(1), player(2), player(3)]
    for entry in watched["settings"]["seats"]:
        entry["deck"] = None
    return watched


def test_spectator_snapshots_carry_public_information_only():
    validator = validator_for("contracts/engine-seat-view.schema.json")
    validator.validate(spectator())
    piles = copy.deepcopy(snapshot())
    piles["prompt"].update(kind="choose_pile", piles=[["o0123456789abcdef"], []])
    validator.validate(piles)

    secret = card("o1111111111111111", "Giant Growth")
    leaks: list[tuple[str, Any]] = [
        ("a spectator's hand", lambda view: view["view"].update(hand=[secret])),
        ("a spectator's prompt", lambda view: view.update(prompt=snapshot()["prompt"])),
        ("a spectator's you", lambda view: view["view"].update(you=player(0))),
        ("looked-at cards", lambda v: v["view"].update(looked_at=[{"name": "x", "cards": []}])),
    ]
    for description, mutate in leaks:
        leaked = spectator()
        mutate(leaked)
        with pytest.raises(ValidationError):
            validator.validate(leaked)
            pytest.fail(f"schema accepted {description}")
    bad_pile = copy.deepcopy(piles)
    bad_pile["prompt"]["piles"] = [[str(uuid4())], []]
    with pytest.raises(ValidationError):
        validator.validate(bad_pile)


def test_scenario_vocabulary_is_constrained():
    schema = json.loads(Path("content/scenario.schema.json").read_text())
    validator = Draft202012Validator(schema)
    scenario = json.loads(Path("content/scenarios/framework-example.json").read_text())
    validator.validate(scenario)
    with pytest.raises(ValidationError):
        validator.validate(scenario | {"objectives": [{"type": "execute_script"}]})


def inspection_validator() -> Draft202012Validator:
    """The inspection contract reuses the seat-view contract's definitions."""
    seat_view = json.loads(Path("contracts/engine-seat-view.schema.json").read_text())
    schema = json.loads(Path("contracts/engine-inspection.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    registry: Registry[Any] = Registry().with_resource(
        seat_view["$id"], Resource.from_contents(seat_view)
    )
    return Draft202012Validator(
        schema, registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER
    )


def inspection() -> dict[str, Any]:
    watched = spectator()
    settings = watched["settings"]
    for entry, deck in zip(settings["seats"], ["a", "b", "c", "d"], strict=True):
        entry["deck"] = f"commander-mono-{deck}"
    return {
        "game_id": watched["game_id"],
        "version": 40,
        "status": "live",
        "settings": settings,
        "view": watched["view"],
        "players": [
            {
                "seat": seat,
                "name": f"Player {seat + 1}",
                "hand": [card(f"o{seat + 10:016x}", "Lightning Bolt")],
                "library": [card(f"o{seat + 20:016x}", "Mountain")],
            }
            for seat in range(4)
        ],
        "result": None,
    }


def test_inspection_shows_everything_and_only_as_itself():
    validator = inspection_validator()
    validator.validate(inspection())
    finished = inspection() | {"status": "finished"}
    finished["result"] = {
        "kind": "closed",
        "winner_seat": None,
        "draw": False,
        "conceded_seats": [],
        "turns": 3,
        "error": None,
    }
    validator.validate(finished)

    broken: list[tuple[str, Any]] = [
        ("a hidden card", lambda view: view["players"][1]["hand"][0].update(hidden=True)),
        ("an unnamed card", lambda view: view["players"][1]["library"][0].update(name=None)),
        ("a private deck", lambda view: view["settings"]["seats"][2].update(deck=None)),
        ("a seat's own view", lambda view: view["view"].update(you=player(0))),
        ("the seed", lambda view: view["settings"].update(seed=1)),
        ("XMage ids", lambda view: view["players"][0]["hand"][0].update(id=str(uuid4()))),
        ("a result while live", lambda view: view.update(result=finished["result"])),
        ("an extra field", lambda view: view["players"][0].update(sideboard=[])),
    ]
    for description, mutate in broken:
        changed = inspection()
        mutate(changed)
        with pytest.raises(ValidationError):
            validator.validate(changed)
            pytest.fail(f"schema accepted {description}")
