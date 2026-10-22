"""Finding other players, friends, presence and notifications (v0.4.3): the search by handle in
part and by email in full, never showing an email, and its limits; profiles; mutual friend
requests, withdrawing, declining and ending them; blocks; presence from the app's check-ins and
the running games, for friends or everyone, and appearing offline to all but administrators and
SysOp; the bell's notifications, a friend come online, the history's pages and marking read, and
their pruning; the privacy settings; and deleting an account removing it all."""

import os
from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, make_url, select, text, update
from sqlalchemy.orm import Session
from test_games import SYSOP_ADDRESS
from test_progression import Account

from api import social
from api.accounts import delete_account
from api.config import Settings
from api.identity import utcnow
from api.main import create_app
from api.models import (
    ExternalIdentity,
    Friendship,
    Game,
    GameSeat,
    Notification,
    PlayerBlock,
    RoleGrant,
    User,
    UserSession,
)
from api.social import SearchLimits

TABLES = (
    "notifications",
    "player_blocks",
    "friendships",
    "game_seats",
    "games",
    "progress_ledger",
    "external_identities",
    "audit_events",
    "role_grants",
    "sessions",
    "users",
)


@pytest.fixture(scope="module")
def url(tmp_path_factory) -> str:
    folder = tmp_path_factory.mktemp("social")
    url = f"sqlite:///{folder}/social.db"
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CD_DATABASE_URL", url)
        command.upgrade(Config("alembic.ini"), "head")
    return url


def started(url: str) -> TestClient:
    app = create_app(Settings(database_url=url, sysop_networks="10.20.0.0/24"))
    return TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS)


@pytest.fixture
def client(url: str) -> Iterator[TestClient]:
    with started(url) as client:
        yield client
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            for table in TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def database(client: TestClient) -> Session:
    return Session(client.app.state.database, expire_on_commit=False)  # type: ignore[attr-defined]


def player(
    client: TestClient,
    name: str,
    *,
    email: str | None = None,
    kind: str = "player",
    admin: bool = False,
    **changes: Any,
) -> Account:
    found = Account(client, name, kind=kind, admin=admin)
    with database(client) as db:
        user = db.get(User, found.id)
        assert user is not None
        for name, value in changes.items():
            setattr(user, name, value)
        if email:
            db.add(
                ExternalIdentity(
                    user_id=user.id,
                    issuer="https://accounts.google.com",
                    subject=uuid4().hex,
                    email=email,
                    email_verified=True,
                    created_at=utcnow(),
                    last_login_at=utcnow(),
                )
            )
        db.commit()
    return found


def search(who: Account, q: str) -> list[str]:
    answer = who.get("/api/v1/players", q=q)
    assert answer.status_code == 200, answer.text
    return [found["handle"] for found in answer.json()["players"]]


def befriend(one: Account, other: Account) -> None:
    assert one.send("PUT", f"/api/v1/friends/{other.id}").status_code == 200
    assert other.send("PUT", f"/api/v1/friends/{one.id}").json()["friendship"] == "friends"


def check_in(who: Account, **body: Any) -> dict[str, Any]:
    answer = who.send("POST", "/api/v1/presence", body)
    assert answer.status_code == 200, answer.text
    return answer.json()  # type: ignore[no-any-return]


def presence_of(viewer: Account, subject: Account) -> dict[str, Any] | None:
    answer = viewer.get(f"/api/v1/players/{subject.id}")
    assert answer.status_code == 200, answer.text
    return answer.json()["presence"]  # type: ignore[no-any-return]


def age(client: TestClient, who: Account, **seconds: int) -> None:
    """Moves the account's presence back in time."""
    with database(client) as db:
        user = db.get(User, who.id)
        assert user is not None
        for name, value in seconds.items():
            setattr(user, name, utcnow() - timedelta(seconds=value))
        db.commit()


def notifications(who: Account, **params: Any) -> dict[str, Any]:
    answer = who.get("/api/v1/notifications", **params)
    assert answer.status_code == 200, answer.text
    return answer.json()  # type: ignore[no-any-return]


# The search.


def test_search_by_handle_matches_in_part_with_the_closest_first(client):
    me = player(client, "seeker")
    for handle in ("Ada", "adamant", "Nomad_ada", "badass", "Bob"):
        player(client, handle)
    player(client, "pending_ada", status="pending")
    player(client, "deleted_ada", status="deleted")
    player(client, "newcomer_ada", handle=None, normalized_handle=None, onboarding="handle")
    player(client, "sysop_ada", kind="sysop")
    assert search(me, "ADA") == ["Ada", "adamant", "badass", "Nomad_ada"]
    assert search(me, "ada")[0] == "Ada"
    # A wildcard character is only itself: "_" never stands for any letter.
    assert search(me, "d_a") == ["Nomad_ada"]
    assert search(me, "%") == []
    assert search(me, "seek") == []  # never the account searching
    answer = me.get("/api/v1/players", q="ada").json()
    assert answer["by_email"] is False
    first = answer["players"][0]
    assert set(first) == {"id", "handle", "avatar", "alliance", "tier", "presence", "friendship"}
    assert first["tier"]["id"] == "bronze" and first["friendship"] == "none"
    assert me.get("/api/v1/players", q="   ").status_code == 422


def test_search_by_email_matches_only_in_full_and_never_shows_one(client):
    me = player(client, "seeker")
    player(client, "ada", email="Ada.Lovelace@Example.com")
    player(client, "hidden", email="hidden@example.com", email_searchable=False)
    assert search(me, "ada.lovelace@example.com") == ["ada"]
    assert search(me, "  ADA.LOVELACE@EXAMPLE.COM ") == ["ada"]
    for partial in ("ada.lovelace@", "lovelace@example.com", "@example.com", "ada.lovelace@ex"):
        assert search(me, partial) == []
    assert search(me, "hidden@example.com") == []
    answer = me.get("/api/v1/players", q="ada.lovelace@example.com")
    assert answer.json()["by_email"] is True
    assert "example.com" not in answer.text.lower()
    profile = me.get(f"/api/v1/players/{answer.json()['players'][0]['id']}")
    assert "example.com" not in profile.text.lower()


def test_search_limits(client):
    limits = SearchLimits()
    someone = uuid4()
    for second in range(social.EMAIL_SEARCHES_PER_DAY):
        limits.take(someone, email=True, now=second * 61.0)
    with pytest.raises(social.ApiError) as refused:
        limits.take(someone, email=True, now=social.EMAIL_SEARCHES_PER_DAY * 61.0)
    assert refused.value.status == 429
    limits.take(someone, email=False, now=social.EMAIL_SEARCHES_PER_DAY * 61.0)
    # A day later, email searches are open again.
    limits.take(someone, email=True, now=86400 + 61.0)
    for _ in range(social.SEARCHES_PER_MINUTE):
        limits.take(someone, email=False, now=90000.0)
    with pytest.raises(social.ApiError):
        limits.take(someone, email=False, now=90000.5)
    limits.take(someone, email=False, now=90061.0)

    me = player(client, "seeker")
    sysop = player(client, "sysop", kind="sysop")
    for _ in range(social.SEARCHES_PER_MINUTE):
        assert me.get("/api/v1/players", q="ada").status_code == 200
    refused_answer = me.get("/api/v1/players", q="ada")
    assert refused_answer.status_code == 429
    assert refused_answer.json()["code"] == "search_limited"
    for _ in range(social.SEARCHES_PER_MINUTE + 5):
        assert sysop.get("/api/v1/players", q="ada").status_code == 200


def test_only_active_accounts_search(client):
    waiting = player(client, "waiting", status="pending")
    assert waiting.get("/api/v1/players", q="ada").status_code == 403
    assert waiting.send("POST", "/api/v1/presence", {}).status_code == 403


# Profiles.


def test_profiles(client):
    me = player(client, "seeker")
    ada = player(client, "ada", alliance="the-sphinx")
    sysop = player(client, "sysop", kind="sysop")
    gone = player(client, "gone", status="deleted")
    waiting = player(client, "waiting", status="pending")
    profile = me.get(f"/api/v1/players/{ada.id}").json()
    assert profile["handle"] == "ada" and profile["alliance"] == "the-sphinx"
    assert profile["wins"] == 0 and profile["blocked"] is False and profile["you"] is False
    assert profile["friendship"] == "none" and profile["presence"] is None
    assert me.get(f"/api/v1/players/{me.id}").json()["you"] is True
    # SysOp is never listed, but its profile opens from its notifications.
    assert me.get(f"/api/v1/players/{sysop.id}").json()["wins"] == 100_000
    for hidden in (gone.id, waiting.id, uuid4()):
        answer = me.get(f"/api/v1/players/{hidden}")
        assert answer.status_code == 404 and answer.json()["code"] == "http_404"


# Friends.


def test_friend_requests_are_mutual(client):
    ada, bob = player(client, "ada"), player(client, "bob")
    asked = ada.send("PUT", f"/api/v1/friends/{bob.id}")
    assert asked.status_code == 200 and asked.json()["friendship"] == "requested"
    # Asking again changes nothing.
    assert ada.send("PUT", f"/api/v1/friends/{bob.id}").json()["friendship"] == "requested"
    assert bob.get(f"/api/v1/players/{ada.id}").json()["friendship"] == "requested_you"
    lists = bob.get("/api/v1/friends").json()
    assert [found["handle"] for found in lists["incoming"]] == ["ada"]
    assert lists["friends"] == [] and lists["outgoing"] == []
    assert [found["handle"] for found in ada.get("/api/v1/friends").json()["outgoing"]] == ["bob"]
    bell = notifications(bob)
    assert bell["unread"] == 1
    request = bell["items"][0]
    assert request["kind"] == "friend_request" and request["request_pending"] is True
    assert request["actor"]["handle"] == "ada" and request["read"] is False
    # Bob adds Ada back: the two are friends, his notification is read, and she hears of it.
    assert bob.send("PUT", f"/api/v1/friends/{ada.id}").json()["friendship"] == "friends"
    bell = notifications(bob)
    assert bell["unread"] == 0 and bell["items"][0]["request_pending"] is False
    told = notifications(ada)["items"]
    assert [(item["kind"], item["actor"]["handle"]) for item in told] == [
        ("friend_accepted", "bob")
    ]
    assert [found["handle"] for found in ada.get("/api/v1/friends").json()["friends"]] == ["bob"]
    # Either ends it.
    ended = ada.send("DELETE", f"/api/v1/friends/{bob.id}")
    assert ended.status_code == 200 and ended.json()["friendship"] == "none"
    assert bob.get("/api/v1/friends").json()["friends"] == []


def test_withdrawing_and_declining_a_request(client):
    ada, bob = player(client, "ada"), player(client, "bob")
    ada.send("PUT", f"/api/v1/friends/{bob.id}")
    assert ada.send("DELETE", f"/api/v1/friends/{bob.id}").json()["friendship"] == "none"
    # Withdrawn: Bob's notification stays, no longer waiting for him.
    [told] = notifications(bob)["items"]
    assert told["kind"] == "friend_request" and told["request_pending"] is False
    # Asked again within a day: the request waits, and Bob is not told twice.
    ada.send("PUT", f"/api/v1/friends/{bob.id}")
    [told] = notifications(bob)["items"]
    assert told["request_pending"] is True and told["read"] is False
    # Declined: answered, so read.
    assert bob.send("DELETE", f"/api/v1/friends/{ada.id}").json()["friendship"] == "none"
    assert notifications(bob)["unread"] == 0
    assert ada.get(f"/api/v1/players/{bob.id}").json()["friendship"] == "none"
    assert notifications(ada)["items"] == []


def test_friend_requests_need_a_handle_and_another_player(client, monkeypatch):
    ada = player(client, "ada")
    newcomer = player(client, "newcomer", handle=None, normalized_handle=None, onboarding="handle")
    answer = newcomer.send("PUT", f"/api/v1/friends/{ada.id}")
    assert answer.status_code == 409 and answer.json()["code"] == "handle_required"
    assert ada.send("PUT", f"/api/v1/friends/{ada.id}").json()["code"] == "own_account"
    assert ada.send("PUT", f"/api/v1/friends/{newcomer.id}").status_code == 404
    assert ada.send("PUT", f"/api/v1/friends/{uuid4()}").status_code == 404
    monkeypatch.setattr(social, "PENDING_LIMIT", 2)
    others = [player(client, f"other{index}") for index in range(3)]
    for other in others[:2]:
        assert ada.send("PUT", f"/api/v1/friends/{other.id}").status_code == 200
    refused = ada.send("PUT", f"/api/v1/friends/{others[2].id}")
    assert refused.status_code == 429 and refused.json()["code"] == "too_many_requests"
    # Answering a request is never limited.
    others[2].send("PUT", f"/api/v1/friends/{ada.id}")
    assert ada.send("PUT", f"/api/v1/friends/{others[2].id}").json()["friendship"] == "friends"


# Blocks.


def test_blocking_a_player(client):
    ada, bob = player(client, "ada"), player(client, "bob")
    befriend(ada, bob)
    blocked = ada.send("PUT", f"/api/v1/blocks/{bob.id}")
    assert blocked.status_code == 200
    assert blocked.json()["blocked"] is True and blocked.json()["friendship"] == "none"
    assert ada.get("/api/v1/friends").json()["friends"] == []
    assert notifications(ada)["items"] == []  # Bob's acceptance went
    assert [entry["player"]["handle"] for entry in ada.get("/api/v1/me/blocks").json()] == ["bob"]
    # Bob no longer finds Ada; she still finds him, to unblock.
    assert search(bob, "ada") == []
    assert search(ada, "bob") == ["bob"]
    refused = ada.send("PUT", f"/api/v1/friends/{bob.id}")
    assert refused.status_code == 409 and refused.json()["code"] == "player_blocked"
    # Bob's request waits unseen: Ada hears nothing and lists nothing.
    assert bob.send("PUT", f"/api/v1/friends/{ada.id}").json()["friendship"] == "requested"
    assert notifications(ada)["items"] == []
    assert ada.get("/api/v1/friends").json()["incoming"] == []
    assert ada.get(f"/api/v1/players/{bob.id}").json()["friendship"] == "none"
    # Unblocking drops it, so nothing old surfaces.
    unblocked = ada.send("DELETE", f"/api/v1/blocks/{bob.id}")
    assert unblocked.json()["blocked"] is False and unblocked.json()["friendship"] == "none"
    assert bob.get(f"/api/v1/players/{ada.id}").json()["friendship"] == "none"
    assert ada.get("/api/v1/me/blocks").json() == []


# Presence.


def test_presence_from_check_ins_and_games(client):
    ada, bob = player(client, "ada"), player(client, "bob")
    befriend(ada, bob)
    assert presence_of(bob, ada) == {
        "state": "offline",
        "game_kind": None,
        "game_format": None,
        "appears_offline": False,
    }
    check_in(ada)
    assert presence_of(bob, ada)["state"] == "online"
    # A tab its player left says so; with none in use for a while, idle.
    check_in(ada, idle=True)
    assert presence_of(bob, ada)["state"] == "online"
    age(client, ada, active_at=91)
    assert presence_of(bob, ada)["state"] == "idle"
    check_in(ada)
    assert presence_of(bob, ada)["state"] == "online"
    with database(client) as db:
        game = Game(
            id=uuid4(),
            kind="table",
            format="commander",
            status="active",
            created_by=ada.id,
            created_at=utcnow(),
            bot_skill=3,
            turn_cap=40,
        )
        db.add(game)
        db.flush()
        db.add(GameSeat(game_id=game.id, seat=0, player="human", user_id=ada.id, deck="custom"))
        db.commit()
    assert presence_of(bob, ada) | {"appears_offline": False} == {
        "state": "in_game",
        "game_kind": "table",
        "game_format": "commander",
        "appears_offline": False,
    }
    age(client, ada, presence_at=91)
    assert presence_of(bob, ada)["state"] == "offline"


def test_who_sees_presence(client):
    ada, friend = player(client, "ada"), player(client, "friend")
    stranger, admin = player(client, "stranger"), player(client, "admin", admin=True)
    sysop = player(client, "sysop", kind="sysop")
    befriend(ada, friend)
    check_in(ada)
    assert presence_of(friend, ada)["state"] == "online"
    assert presence_of(stranger, ada) is None
    assert presence_of(admin, ada)["state"] == "online"
    privacy = ada.send("PATCH", "/api/v1/me/privacy", {"presence_visibility": "everyone"})
    assert privacy.json() == {
        "presence_visibility": "everyone",
        "appear_offline": False,
        "email_searchable": True,
    }
    assert presence_of(stranger, ada)["state"] == "online"
    # Appearing offline: offline to everyone, the real state to staff and to herself.
    ada.send("PATCH", "/api/v1/me/privacy", {"appear_offline": True})
    for viewer in (friend, stranger):
        assert presence_of(viewer, ada) == {
            "state": "offline",
            "game_kind": None,
            "game_format": None,
            "appears_offline": False,
        }
    for viewer in (admin, sysop, ada):
        seen = presence_of(viewer, ada)
        assert seen["state"] == "online" and seen["appears_offline"] is True
    # A blocked player sees nothing, whatever the setting.
    ada.send("PATCH", "/api/v1/me/privacy", {"appear_offline": False})
    ada.send("PUT", f"/api/v1/blocks/{stranger.id}")
    assert presence_of(stranger, ada) is None
    assert ada.get("/api/v1/me/privacy").json()["presence_visibility"] == "everyone"
    assert (
        ada.send("PATCH", "/api/v1/me/privacy", {"presence_visibility": "all"}).status_code == 422
    )


def test_a_check_in_is_not_activity(client):
    ada = player(client, "ada")
    with database(client) as db:
        session = db.scalar(select(UserSession).where(UserSession.user_id == ada.id))
        assert session is not None
        session.last_seen_at = utcnow() - timedelta(minutes=5)
        before = session.idle_expires_at
        db.commit()
    check_in(ada)
    with database(client) as db:
        session = db.scalar(select(UserSession).where(UserSession.user_id == ada.id))
        assert session is not None and session.idle_expires_at == before


# Notifications.


def test_a_friend_coming_online_is_told_to_friends_online(client):
    ada, bob, carol = player(client, "ada"), player(client, "bob"), player(client, "carol")
    befriend(ada, bob)
    befriend(ada, carol)
    for who in (ada, bob, carol):
        who.send("POST", "/api/v1/notifications/read", {})
    first = check_in(bob)
    check_in(ada)
    # Bob was online and hears of it; Carol was not, and does not.
    answer = check_in(bob, since=first["newest"])
    assert [(item["kind"], item["actor"]["handle"]) for item in answer["fresh"]] == [
        ("friend_online", "ada")
    ]
    assert answer["unread"] == 1
    assert check_in(bob, since=answer["newest"])["fresh"] == []
    assert notifications(carol)["unread"] == 0
    # Still online: no more. Back after a short absence: not again within the gap.
    check_in(ada)
    age(client, ada, presence_at=120)
    check_in(ada)
    assert notifications(bob)["unread"] == 1
    # After the gap, again; and never while appearing offline.
    with database(client) as db:
        db.execute(update(Notification).values(created_at=utcnow() - timedelta(minutes=31)))
        db.commit()
    age(client, ada, presence_at=120)
    check_in(ada)
    assert notifications(bob)["unread"] == 2
    ada.send("PATCH", "/api/v1/me/privacy", {"appear_offline": True})
    with database(client) as db:
        db.execute(text("DELETE FROM notifications"))
        db.commit()
    age(client, ada, presence_at=120)
    check_in(ada)
    assert notifications(bob)["unread"] == 0


def test_the_history_and_marking_read(client):
    ada = player(client, "ada")
    friends = [player(client, f"friend{index}") for index in range(5)]
    for index, friend in enumerate(friends):
        friend.send("PUT", f"/api/v1/friends/{ada.id}")
        with database(client) as db:
            at = utcnow() - timedelta(minutes=10 - index)
            db.execute(
                update(Notification).where(Notification.created_at > at).values(created_at=at)
            )
            db.commit()
    first = notifications(ada, limit=2)
    assert [item["actor"]["handle"] for item in first["items"]] == ["friend4", "friend3"]
    assert first["unread"] == 5 and first["next"]
    second = notifications(ada, limit=2, cursor=first["next"])
    assert [item["actor"]["handle"] for item in second["items"]] == ["friend2", "friend1"]
    third = notifications(ada, limit=2, cursor=second["next"])
    assert [item["actor"]["handle"] for item in third["items"]] == ["friend0"]
    assert third["next"] is None
    assert ada.get("/api/v1/notifications", cursor="nope").status_code == 422
    up_to = second["items"][0]["created_at"]
    marked = ada.send("POST", "/api/v1/notifications/read", {"up_to": up_to})
    assert marked.json() == {"unread": 2}
    assert ada.send("POST", "/api/v1/notifications/read", {}).json() == {"unread": 0}


def test_notifications_are_pruned(client, monkeypatch):
    monkeypatch.setattr(social, "NOTIFICATION_LIMIT", 3)
    ada = player(client, "ada")
    others = [player(client, f"other{index}") for index in range(5)]
    with database(client) as db:
        old = Notification(
            user_id=ada.id,
            kind="friend_online",
            actor_id=others[0].id,
            created_at=utcnow() - timedelta(days=social.NOTIFICATION_DAYS + 1),
        )
        db.add(old)
        db.commit()
    for other in others[1:]:
        other.send("PUT", f"/api/v1/friends/{ada.id}")
    items = notifications(ada)["items"]
    assert [item["actor"]["handle"] for item in items] == ["other4", "other3", "other2"]


def test_deleting_an_account_removes_its_friends_blocks_and_notifications(client):
    ada, bob, carol = player(client, "ada"), player(client, "bob"), player(client, "carol")
    befriend(ada, bob)
    ada.send("PUT", f"/api/v1/blocks/{carol.id}")
    carol.send("PUT", f"/api/v1/friends/{bob.id}")
    check_in(bob)
    with database(client) as db:
        user = db.get(User, ada.id)
        assert user is not None
        delete_account(db, user, utcnow())
        db.commit()
        # Carol's request to Bob is theirs, and stays.
        assert db.scalar(select(func.count()).select_from(Friendship)) == 1
        assert db.scalar(select(func.count()).select_from(PlayerBlock)) == 0
        left = db.scalar(
            select(func.count())
            .select_from(Notification)
            .where((Notification.user_id == ada.id) | (Notification.actor_id == ada.id))
        )
        assert left == 0
    assert bob.get(f"/api/v1/players/{ada.id}").status_code == 404
    assert [item["kind"] for item in notifications(bob)["items"]] == ["friend_request"]


def test_administrators_see_presence_through_their_permission(client):
    admin = player(client, "admin", admin=True)
    with database(client) as db:
        assert (
            db.scalar(select(RoleGrant.role).where(RoleGrant.user_id == admin.id))
            == "administrator"
        )
    assert "players.presence" in admin.get("/api/v1/me").json()["permissions"]
    assert "players.presence" not in player(client, "ada").get("/api/v1/me").json()["permissions"]


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_social_on_postgresql(monkeypatch):
    """The search's escaped LIKE and email join, the check-in's row lock and the friendships'
    pair on PostgreSQL."""
    url = os.environ["CD_TEST_POSTGRES_URL"]
    schema = f"test_{uuid4().hex}"
    admin_engine = create_engine(url, connect_args={"connect_timeout": 3})
    with admin_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = (
        make_url(url)
        .update_query_dict({"options": f"-csearch_path={schema}"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("CD_DATABASE_URL", scoped)
    try:
        command.upgrade(Config("alembic.ini"), "head")
        with started(scoped) as client:
            me = player(client, "seeker")
            ada = player(client, "Nomad_ada", email="Ada@Example.com")
            player(client, "nomadxada")
            assert search(me, "d_a") == ["Nomad_ada"]
            assert search(me, "ada@example.com") == ["Nomad_ada"]
            befriend(me, ada)
            before = check_in(me)
            # Seeker's request, which she answered, is read.
            assert check_in(ada)["unread"] == 0
            assert presence_of(me, ada)["state"] == "online"
            with database(client) as db:
                row = db.scalar(select(Friendship))
                assert row is not None and row.user_low < row.user_high
                assert isinstance(row.user_low, UUID)
            fresh = check_in(me, since=before["newest"])["fresh"]
            assert [item["kind"] for item in fresh] == ["friend_online"]
    finally:
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin_engine.dispose()
