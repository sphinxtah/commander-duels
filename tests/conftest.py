import pytest

from api.config import Settings


@pytest.fixture(autouse=True)
def without_local_env_file(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests configure the API themselves; a developer's .env (a Google client ID, a service
    token) must not change what they see."""
    monkeypatch.setitem(Settings.model_config, "env_file", None)
