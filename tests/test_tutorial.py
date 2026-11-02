"""The first-time tutorial (v0.8.4, api/tutorial.py): its path and stage on the account."""

import pytest
import test_progression
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from test_progression import Account

from api.models import User

# The progression tests' database, content and app, for this module's own accounts.
url = test_progression.url
content = test_progression.content
engine = test_progression.engine
client = test_progression.client


def tutorial(account: Account) -> dict:
    return account.get("/api/v1/me").json()["tutorial"]


def put(account: Account, body: dict):
    return account.send("PUT", "/api/v1/me/tutorial", body)


def test_a_new_account_chooses_a_path_and_moves_along_it(client):
    ada = Account(client, "ada", onboarding="handle")
    assert tutorial(ada) == {"path": None, "stage": "choose", "skipped": False}
    # No stage before a path.
    early = put(ada, {"stage": "setup"})
    assert (early.status_code, early.json()["code"]) == (422, "tutorial_path")
    chosen = put(ada, {"stage": "demo", "path": "beginner"})
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["tutorial"] == {"path": "beginner", "stage": "demo", "skipped": False}
    # The path is kept from then on.
    # The tour's stages, Decks and the Play page since v0.8.5.
    for stage in ("setup", "tour_shop", "tour_auctions", "tour_decks", "tour_play", "done"):
        moved = put(ada, {"stage": stage})
        assert moved.status_code == 200, moved.text
        assert moved.json()["tutorial"]["path"] == "beginner"
    assert tutorial(ada) == {"path": "beginner", "stage": "done", "skipped": False}
    # Settings starts the tour again.
    assert put(ada, {"stage": "tour_shop"}).json()["tutorial"]["stage"] == "tour_shop"


def test_each_path_has_its_own_stages(client):
    bea = Account(client, "bea", onboarding="handle")
    wrong = put(bea, {"stage": "demo", "path": "novice"})
    assert (wrong.status_code, wrong.json()["code"]) == (422, "tutorial_stage")
    assert put(bea, {"stage": "overview", "path": "novice"}).status_code == 200
    overview = put(bea, {"stage": "demo"})
    assert (overview.status_code, overview.json()["code"]) == (422, "tutorial_stage")
    cal = Account(client, "cal", onboarding="handle")
    assert put(cal, {"stage": "setup", "path": "advanced"}).status_code == 200
    for stage in ("demo", "overview"):
        refused = put(cal, {"stage": stage})
        assert (refused.status_code, refused.json()["code"]) == (422, "tutorial_stage")
    # Settings may start the tour again for anyone, from the shop or from Decks (v0.8.5).
    assert put(cal, {"stage": "tour_shop"}).json()["tutorial"]["path"] == "advanced"
    for stage in ("tour_decks", "tour_play"):
        moved = put(cal, {"stage": stage})
        assert moved.json()["tutorial"] == {"path": "advanced", "stage": stage, "skipped": False}
    # Choosing again starts over.
    again = put(cal, {"stage": "choose"})
    assert again.json()["tutorial"] == {"path": None, "stage": "choose", "skipped": False}


def test_a_skip_is_kept_until_the_tutorial_moves_again(client):
    dee = Account(client, "dee", onboarding="handle")
    put(dee, {"stage": "overview", "path": "novice"})
    skipped = put(dee, {"stage": "done", "skipped": True})
    assert skipped.json()["tutorial"] == {"path": "novice", "stage": "done", "skipped": True}
    assert put(dee, {"stage": "tour_shop"}).json()["tutorial"]["skipped"] is False
    # A skip says nothing short of done.
    half = put(dee, {"stage": "tour_auctions", "skipped": True})
    assert half.json()["tutorial"]["skipped"] is False
    # Skipped from the tour's last bubble, on the Play page (v0.8.5).
    put(dee, {"stage": "tour_play"})
    late = put(dee, {"stage": "done", "skipped": True})
    assert late.json()["tutorial"] == {"path": "novice", "stage": "done", "skipped": True}


def test_only_an_active_account_moves_its_tutorial(client):
    eve = Account(client, "eve", onboarding="handle")
    with Session(client.app.state.database) as db:
        db.execute(update(User).where(User.id == eve.id).values(status="pending"))
        db.commit()
    refused = put(eve, {"stage": "setup", "path": "advanced"})
    assert (refused.status_code, refused.json()["code"]) == (403, "account_inactive")
    unknown = put(eve, {"stage": "lost"})
    assert unknown.status_code == 422


def test_the_database_refuses_a_stage_it_does_not_know(client):
    fay = Account(client, "fay", onboarding="handle")
    with Session(client.app.state.database) as db:
        db.execute(update(User).where(User.id == fay.id).values(tutorial="tour_play"))
        db.commit()
        with pytest.raises(IntegrityError):
            db.execute(update(User).where(User.id == fay.id).values(tutorial="tour_cards"))
            db.commit()


def test_migration_0034_keeps_every_stored_stage_and_goes_back_to_done(tmp_path, monkeypatch):
    """The tour's last two stages (v0.8.5) widen the check; v0.8.4's values all stay valid, and
    going back moves an account at either new stage to done, which v0.8.4 knows."""
    url = f"sqlite:///{tmp_path}/tour.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    config = Config("alembic.ini")
    command.upgrade(config, "0033_tutorial")
    engine = create_engine(url)
    old = ("choose", "demo", "overview", "setup", "tour_shop", "tour_auctions", "done")
    insert = text(
        "INSERT INTO users (id, display_name, kind, status, onboarding, avatar, locale, "
        "preferences, privilege_version, created_at, tutorial, tutorial_path, tutorial_skipped) "
        "VALUES (:id, 'Player', 'player', 'active', 'complete', 'sigil', 'en', '{}', 0, "
        "'2026-11-01', :stage, 'beginner', 0)"
    )
    with engine.begin() as connection:
        for n, stage in enumerate(old):
            connection.execute(insert, {"id": f"{n:032x}", "stage": stage})
    command.upgrade(config, "0034_tour_decks_play")
    stages = text("SELECT tutorial FROM users ORDER BY id")
    with engine.begin() as connection:
        assert tuple(connection.execute(stages).scalars()) == old
        for n, stage in enumerate(("tour_decks", "tour_play"), start=len(old)):
            connection.execute(insert, {"id": f"{n:032x}", "stage": stage})
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(insert, {"id": f"{99:032x}", "stage": "tour_cards"})
    command.downgrade(config, "0033_tutorial")
    with engine.connect() as connection:
        assert tuple(connection.execute(stages).scalars()) == (*old, "done", "done")
    command.upgrade(config, "head")
    engine.dispose()
