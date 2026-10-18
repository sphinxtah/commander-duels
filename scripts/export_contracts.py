"""Run from the repository root after installing the Python environment."""

import json
from pathlib import Path

from api.main import create_app

Path("contracts/openapi.json").write_text(
    json.dumps(create_app().openapi(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
