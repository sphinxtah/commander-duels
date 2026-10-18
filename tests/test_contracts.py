import json
from pathlib import Path
from uuid import uuid4

import pytest
from jsonschema import Draft202012Validator, ValidationError

from api.main import create_app


def test_generated_openapi_is_current():
    assert json.loads(Path("contracts/openapi.json").read_text()) == create_app().openapi()


def test_engine_contract_rejects_unsupported_versions_and_client_seats():
    schema = json.loads(Path("contracts/engine-command.schema.json").read_text())
    validator = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    command = {
        "v": 1,
        "game_id": str(uuid4()),
        "action_id": str(uuid4()),
        "expected_revision": 0,
        "type": "submit_choice",
        "payload": {},
    }
    validator.validate(command)
    for changes in [{"v": 2}, {"seat": 1}, {"game_id": "forged"}, {"expected_revision": -1}]:
        with pytest.raises(ValidationError):
            validator.validate(command | changes)


def test_scenario_vocabulary_is_constrained():
    schema = json.loads(Path("content/scenario.schema.json").read_text())
    validator = Draft202012Validator(schema)
    scenario = json.loads(Path("content/scenarios/framework-example.json").read_text())
    validator.validate(scenario)
    with pytest.raises(ValidationError):
        validator.validate(scenario | {"objectives": [{"type": "execute_script"}]})
