"""The economy's foundations are gone (v0.9.13; docs/economy.md).

The owner adopted none of v0.9.12's economy proposals and had their foundations removed, the data
of migration 0047 included. Migration 0050 does that to a database v0.9.12 ran on, and refuses one
where a policy was ever switched on: these tests are both, on SQLite and on PostgreSQL. The code's
side (no route, no command, the settlement as v0.9.11 paid it) is the last tests'.
"""

from typing import Any
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, inspect, text
from test_account_data import (
    RECORDED,
    T0,
    Account,
    database,  # noqa: F401  (the fixture: SQLite, and PostgreSQL when its URL is given)
    play_on_v0_9_12,
    representative_account,
)

from api.main import create_app

V0_9_12 = "0049_table_profiles"


def eligibilities(engine: Engine) -> list[dict[str, Any]]:
    with engine.connect() as connection:
        games = Account(engine).metadata.tables["games"]
        return [
            row[0]
            for row in connection.execute(games.select().with_only_columns(games.c.eligibility))
        ]


def as_v0_9_12_left_it(engine: Engine) -> None:
    """A database v0.9.12 ran on with every policy off, one account in it."""
    config = Config("alembic.ini")
    command.upgrade(config, "0043_deck_packs")
    player, friend = representative_account(engine)
    command.upgrade(config, "0047_economy_foundations")
    play_on_v0_9_12(engine, player, friend)
    command.upgrade(config, V0_9_12)


def claimed_staple(engine: Engine) -> None:
    account = Account(engine)
    with engine.connect() as connection:
        user = connection.execute(text("SELECT id FROM users ORDER BY display_name")).scalar()
        card = connection.execute(text("SELECT id FROM card_concepts ORDER BY name")).scalar()
    account.add(
        "entitlements",
        id=uuid4(),
        user_id=user,
        kind="staple",
        card_id=card,
        copies=1,
        key=f"staple:{user}:{card}",
        policy="staples-v1",
        created_at=T0,
    )
    account.write(engine)


def drawn_alternative(engine: Engine) -> None:
    quests = Account(engine).metadata.tables["daily_quests"]
    with engine.begin() as connection:
        connection.execute(
            quests.update()
            .where(quests.c.slot == 0)
            .values(alternative={"quest": "cast_creatures", "target": 3})
        )


def withheld_reward(engine: Engine) -> None:
    games = Account(engine).metadata.tables["games"]
    with engine.begin() as connection:
        connection.execute(
            games.update().values(
                eligibility=RECORDED | {"seats": {"1": {"tokens": "farming_repeat_opponent"}}}
            )
        )


def as_it_was(engine: Engine) -> None:
    """Takes the three uses back out: the database is as v0.9.12 left it again."""
    games = Account(engine).metadata.tables["games"]
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM entitlements"))
        connection.execute(text("UPDATE daily_quests SET alternative = 'null'"))
        connection.execute(games.update().values(eligibility=RECORDED))


USED = [
    (claimed_staple, "1 rows in entitlements"),
    (drawn_alternative, "1 daily quests with an alternative"),
    (withheld_reward, "2 games with a reward the farming policy withheld"),
]


def test_the_migration_refuses_a_used_database_and_empties_one_v0_9_12_left(
    database: str,  # noqa: F811
) -> None:
    config = Config("alembic.ini")
    engine = create_engine(database)
    try:
        as_v0_9_12_left_it(engine)

        # A database where a policy was on, each of the three ways: refused, with what it found
        # named, and nothing changed (the same migration, the table, the column, the signals, the
        # setting).
        for used, named in USED:
            used(engine)
            before = eligibilities(engine)
            with pytest.raises(RuntimeError, match=named) as refused:
                command.upgrade(config, "head")
            assert "Nothing was changed" in str(refused.value)
            with engine.connect() as connection:
                revision = connection.execute(text("SELECT version_num FROM alembic_version"))
                assert revision.scalar() == V0_9_12
                assert connection.execute(
                    text("SELECT COUNT(*) FROM site_settings WHERE key = 'policy.farming'")
                ).scalar()
            assert "entitlements" in inspect(engine).get_table_names()
            columns = {column["name"] for column in inspect(engine).get_columns("daily_quests")}
            assert "alternative" in columns
            assert eligibilities(engine) == before
            as_it_was(engine)

        # The database as v0.9.12 left it with every policy off. A game that ended before
        # v0.9.10 has no record, and one SysOp's setting is not a policy's.
        with engine.begin() as connection:
            games = Account(engine).metadata.tables["games"]
            first = connection.execute(games.select().with_only_columns(games.c.id)).scalars()
            connection.execute(
                games.update().where(games.c.id == first.first()).values(eligibility=None)
            )
        assert sum("signals" in (kept or {}) for kept in eligibilities(engine)) == 1
        with engine.connect() as connection:
            settings = set(connection.execute(text("SELECT key FROM site_settings")).scalars())
        assert "policy.farming" in settings

        command.upgrade(config, "head")

        assert "entitlements" not in inspect(engine).get_table_names()
        assert "alternative" not in {c["name"] for c in inspect(engine).get_columns("daily_quests")}
        kept = {key: value for key, value in RECORDED.items() if key != "signals"}
        assert sorted(eligibilities(engine), key=repr) == sorted([kept, None], key=repr)
        with engine.connect() as connection:
            after = set(connection.execute(text("SELECT key FROM site_settings")).scalars())
            quests = connection.execute(text("SELECT COUNT(*) FROM daily_quests")).scalar()
        assert after == settings - {"policy.farming"}
        assert quests == 3

        # Going back makes the table and the column again, empty, for v0.9.12's code to read.
        command.downgrade(config, V0_9_12)
        with engine.connect() as connection:
            assert connection.execute(text("SELECT COUNT(*) FROM entitlements")).scalar() == 0
            assert (
                connection.execute(
                    text("SELECT COUNT(*) FROM daily_quests WHERE alternative IS NOT NULL")
                ).scalar()
                == 0
            )
        command.upgrade(config, "head")
    finally:
        engine.dispose()


def test_no_route_of_the_economys_foundations_is_left() -> None:
    paths = set(create_app().openapi()["paths"])
    for gone in ("polic", "entitlement", "staple", "economy/report", "farming"):
        assert not [path for path in paths if gone in path], gone
