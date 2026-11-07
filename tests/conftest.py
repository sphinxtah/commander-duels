import pytest

from api.config import Settings


@pytest.fixture(autouse=True)
def without_local_env_file(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests configure the API themselves; a developer's .env (a Google client ID, a service
    token) must not change what they see."""
    monkeypatch.setitem(Settings.model_config, "env_file", None)


@pytest.fixture(autouse=True)
def administrators_build_from_the_catalog(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Until v0.8.8 administrators built from the whole catalog, and most tests seat an
    administrator for exactly that: a deck of any card without granting each one. Since v0.8.8
    an administrator plays from a library of its own, as any player (only SysOp builds from the
    whole catalog); those tests keep the old shortcut, and a test marked real_roles sees the
    roles as they are."""
    if request.node.get_closest_marker("real_roles"):
        return
    from api import identity

    roles = dict(identity.ROLE_PERMISSIONS)
    roles["administrator"] = roles["administrator"] | {"library.unlimited"}
    monkeypatch.setattr(identity, "ROLE_PERMISSIONS", roles)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "real_roles: the roles' permissions as they are, administrators included"
    )
