import copy
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from jsonschema import Draft202012Validator, ValidationError

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
        "name": ["Human", "Bot"][seat],
        "life": 20,
        "counters": {},
        "library_count": 53,
        "hand_count": 7,
        "graveyard": [],
        "exile": [],
        "mana_pool": {"white": 0, "blue": 0, "black": 0, "red": 0, "green": 0, "colorless": 0},
        "lost": False,
        "won": False,
    }


def snapshot() -> dict[str, Any]:
    return {
        "game_id": str(uuid4()),
        "revision": 12,
        "status": "your_prompt",
        "seat": 0,
        "settings": {
            "human_deck": "legacy-mono-red-burn",
            "bot_deck": "legacy-mono-green-creatures",
            "skill": 4,
            "turn_cap": 60,
            "idle_timeout_seconds": 900,
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
            "opponent": player(1),
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
            {"index": 0, "turn": 1, "active_seat": 0, "step": "UNTAP", "text": "Human mulligans"}
        ],
    }


def test_seat_view_contract_cannot_carry_concealed_information():
    validator = validator_for("contracts/engine-seat-view.schema.json")
    validator.validate(snapshot())

    secret = card("o1111111111111111", "Giant Growth")
    leaks: list[tuple[str, Any]] = [
        ("opponent hand", lambda view: view["view"]["opponent"].update(hand=[secret])),
        ("library contents", lambda view: view["view"]["you"].update(library=[])),
        ("shuffle seed", lambda view: view["settings"].update(seed=42)),
        ("XMage object id", lambda view: view["view"]["hand"][0].update(id=str(uuid4()))),
        ("named hidden card", lambda view: view["view"]["hand"][0].update(hidden=True)),
        ("unknown prompt kind", lambda view: view["prompt"].update(kind="reveal_hand")),
        ("seat chosen by option", lambda view: view["prompt"]["options"][0].update(seat=7)),
    ]
    for description, mutate in leaks:
        leaked = copy.deepcopy(snapshot())
        mutate(leaked)
        with pytest.raises(ValidationError):
            validator.validate(leaked)
            pytest.fail(f"schema accepted {description}")


def test_scenario_vocabulary_is_constrained():
    schema = json.loads(Path("content/scenario.schema.json").read_text())
    validator = Draft202012Validator(schema)
    scenario = json.loads(Path("content/scenarios/framework-example.json").read_text())
    validator.validate(scenario)
    with pytest.raises(ValidationError):
        validator.validate(scenario | {"objectives": [{"type": "execute_script"}]})
