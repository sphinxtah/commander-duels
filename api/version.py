"""Application version. The repository's VERSION file is the single source of truth."""

from importlib.metadata import version
from pathlib import Path

_VERSION_FILE = Path(__file__).resolve().parents[1] / "VERSION"

APP_VERSION = (
    _VERSION_FILE.read_text(encoding="utf-8").strip()
    if _VERSION_FILE.is_file()
    else version("commander-duels")
)
