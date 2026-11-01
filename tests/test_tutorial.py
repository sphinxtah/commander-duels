"""The first-time tutorial (v0.8.4, api/tutorial.py): its path and stage on the account."""

import test_progression
from sqlalchemy import update
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
    for stage in ("setup", "tour_shop", "tour_auctions", "done"):
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
    # Settings may start the tour again for anyone.
    assert put(cal, {"stage": "tour_shop"}).json()["tutorial"]["path"] == "advanced"
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


def test_only_an_active_account_moves_its_tutorial(client):
    eve = Account(client, "eve", onboarding="handle")
    with Session(client.app.state.database) as db:
        db.execute(update(User).where(User.id == eve.id).values(status="pending"))
        db.commit()
    refused = put(eve, {"stage": "setup", "path": "advanced"})
    assert (refused.status_code, refused.json()["code"]) == (403, "account_inactive")
    unknown = put(eve, {"stage": "lost"})
    assert unknown.status_code == 422
