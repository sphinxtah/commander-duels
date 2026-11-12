"""An account survives every migration (v0.9.10, the specification's §2 and §16: "existing accounts
and earned assets must survive both upgrades"; "migrations preserve representative account data").

A representative account is written at v0.9.9's schema, row by row, into tables reflected from the
database as that migration left it, so the account does not change when the models do. Every
migration after it is run, then every one is taken back to v0.9.9's and run again; the account's
totals (its tokens and wins, its library by edition and finish, its decks and their revisions, its
quests, achievements, campaign, auctions, packs, sleeves and records) must be the same at each step,
and at the newest schema the API's own readings must agree with them.

A migration that adds a table holding something of an account's adds a row of it to the account
below, or names it in TRANSIENT with the reason it holds nothing an account keeps: the last test
fails until it does.
"""

import os
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Engine,
    Float,
    Integer,
    LargeBinary,
    MetaData,
    Numeric,
    String,
    Table,
    Uuid,
    create_engine,
    make_url,
    text,
)
from sqlalchemy.orm import Session

# v0.9.9's head: the schema the account is written in. It stays, as the account's starting point,
# when later migrations are added.
BASELINE = "0043_deck_packs"

T0 = datetime(2026, 11, 1, 18, 0, tzinfo=UTC)

# Tables that refer to an account but hold nothing it keeps across an upgrade, each with why.
TRANSIENT = {
    "sessions": "sign-ins; an upgrade may end them",
    "notifications": "kept NOTIFICATION_DAYS, then swept",
    "audit_events": "the administrative record, append-only; not the account's assets",
    "problem_reports": "reports to the staff",
    "site_settings": "SysOp's settings, not an account's",
    "shop_products": "the shop's products (the account that last changed one)",
    "catalog_sync_runs": "the catalog's jobs",
    "booster_sync_runs": "the shop's jobs",
    "custom_cards": "SysOp's content",
    "conversations": "messages; kept as they are, no asset",
    "direct_messages": "messages; kept as they are, no asset",
    "table_messages": "a table's chat",
    "game_tables": "a table waiting for players",
    "table_seats": "a seat at a waiting table",
    "table_invites": "an invitation to a waiting table",
    "queue_entries": "a place in a queue, minutes long",
    "matches": "a match in play; its games' results are the record",
    "match_players": "a match in play",
    "rematches": "a rematch vote, minutes long",
    "rematch_players": "a rematch vote",
    "player_blocks": "a block; social, no asset",
    "auction_watches": "a watched auction; no asset",
}


def _uuid(column_type: object, value: UUID) -> object:
    # PostgreSQL reflects its uuid type; SQLite stores the 32 hex digits SQLAlchemy writes.
    return value if isinstance(column_type, Uuid) else value.hex


def _placeholder(table: Table, name: str) -> object:
    column = table.columns[name]
    kind = column.type
    if isinstance(kind, Uuid) or (
        isinstance(kind, String) and getattr(kind, "length", None) == 32 and name.endswith("id")
    ):
        return _uuid(kind, uuid4())
    if isinstance(kind, JSON):
        return {}
    if isinstance(kind, Boolean):
        return False
    if isinstance(kind, DateTime):
        return T0
    if isinstance(kind, Date):
        return T0.date()
    if isinstance(kind, Float | Numeric):
        return 0.0
    if isinstance(kind, Integer):
        return 0
    if isinstance(kind, LargeBinary):
        return b""
    return "x"


class Account:
    """Writes rows into the reflected tables, filling each required column the row leaves out."""

    def __init__(self, engine: Engine) -> None:
        self.metadata = MetaData()
        self.metadata.reflect(engine)
        self.rows: list[tuple[str, dict[str, object]]] = []

    def add(self, table_name: str, **values: object) -> dict[str, object]:
        table = self.metadata.tables[table_name]
        row: dict[str, object] = {}
        for column in table.columns:
            if column.name in values:
                value = values[column.name]
                row[column.name] = _uuid(column.type, value) if isinstance(value, UUID) else value
            elif not column.nullable and column.server_default is None:
                row[column.name] = _placeholder(table, column.name)
        unknown = set(values) - set(table.columns.keys())
        assert not unknown, f"{table_name} has no {unknown} at {BASELINE}"
        self.rows.append((table_name, row))
        return row

    def write(self, engine: Engine) -> None:
        with engine.begin() as connection:
            for table_name, row in self.rows:
                connection.execute(self.metadata.tables[table_name].insert().values(**row))


def representative_account(engine: Engine) -> tuple[UUID, UUID]:
    """A player of some weeks: welcome tokens, wins against bots and a friend, packs bought and
    opened, cards by edition and finish (foils among them), two decks with revisions (one built
    from a deck pack), a game played with a deck revision, quests and a weekly bonus, achievements,
    the campaign two wardens in with a warden's deck opened, an auction sold and one running, a
    sleeve, a friend, a moderator's role. Returns the player's and the friend's IDs."""
    account = Account(engine)
    player, friend = uuid4(), uuid4()
    account.add("catalog_revisions", id=1, created_at=T0, datasets={}, counts={}, changes={})

    concepts: dict[str, UUID] = {}
    printings: dict[tuple[str, str], UUID] = {}
    for name, sets in (
        ("Sol Ring", ("cmr", "c21")),
        ("Llanowar Elves", ("m19",)),
        ("Forest", ("m19", "unf")),
        ("Ezuri, Renegade Leader", ("c15",)),
    ):
        concepts[name] = uuid4()
        account.add(
            "card_concepts",
            id=concepts[name],
            oracle_id=uuid4(),
            name=name,
            normalized_name=name.lower(),
            construction_key=name.lower(),
            layout="normal",
            deck_card=True,
            mana_value=1.0,
            type_line="Artifact",
            oracle_text="",
            colors=[],
            color_identity=[],
            keywords=[],
            produced_mana=[],
            legalities={"commander": "legal", "legacy": "legal"},
            name_search=name.lower(),
            type_search="artifact",
            text_search="",
            gameplay_hash="g",
            legality_hash="l",
            extra={},
            status="implemented",
            review="none",
            capabilities={},
            first_revision=1,
            changed_revision=1,
        )
        for set_code in sets:
            printings[name, set_code] = uuid4()
            account.add(
                "card_printings",
                id=printings[name, set_code],
                scryfall_id=uuid4(),
                concept_id=concepts[name],
                set_code=set_code,
                set_name=set_code.upper(),
                set_type="expansion",
                collector_number="1",
                lang="en",
                rarity="uncommon",
                layout="normal",
                finishes=["nonfoil", "foil"],
                frame_effects=[],
                promo_types=[],
                games=["paper"],
                faces=[],
                extra={},
                cosmetic_hash="c",
                first_revision=1,
                changed_revision=1,
            )

    for user, name in ((player, "Ashling"), (friend, "Brigid")):
        account.add(
            "users",
            id=user,
            handle=name.lower(),
            normalized_handle=name.lower(),
            display_name=name,
            kind="player",
            status="active",
            onboarding="complete",
            avatar="sigil",
            locale="en",
            preferences={"music": {"volume": 0.4}, "theme": "dark"},
            privilege_version=1,
            created_at=T0,
            alliance="Gruul" if user == player else None,
            starter_decks=["green-red"] if user == player else None,
            presence_visibility="friends",
            tutorial="done",
            card_back="classic",
            title="Warden-breaker" if user == player else None,
        )
    account.add(
        "external_identities", user_id=player, issuer="https://accounts.google.com", subject="ash"
    )
    account.add("role_grants", user_id=player, role="moderator", granted_by=None, granted_at=T0)
    account.add(
        "friendships",
        user_low=min(player, friend, key=str),
        user_high=max(player, friend, key=str),
        requested_by=player,
        status="accepted",
        created_at=T0,
    )

    # A game against the friend, with the deck revision the player brought, and one against bots.
    deck, starter_deck = uuid4(), uuid4()
    revisions = {(deck, 1): uuid4(), (deck, 2): uuid4(), (starter_deck, 1): uuid4()}
    product, collation, pack, opening = uuid4(), uuid4(), uuid4(), uuid4()
    account.add(
        "shop_products",
        id=product,
        set_code="M19",
        booster="default",
        set_name="Core Set 2019",
        name="Core Set 2019 Booster",
        origin="price_list",
        on_sale=True,
        data_status="ready",
        unresolved_count=0,
        unresolved=[],
        created_at=T0,
        updated_at=T0,
    )
    account.add(
        "booster_collations",
        id=collation,
        product_id=product,
        revision=1,
        mtgjson_version="5",
        source_sha256="s",
        digest="d",
        layouts=[],
        sheets={},
        cards=2,
        created_at=T0,
    )
    account.add(
        "packs",
        id=pack,
        user_id=player,
        product_id=product,
        source="purchase",
        tokens=300,
        request_key="buy-1",
        created_at=T0,
    )
    account.add(
        "pack_openings",
        id=opening,
        pack_id=pack,
        user_id=player,
        product_id=product,
        collation_id=collation,
        layout=0,
        created_at=T0,
    )
    for position, (name, set_code, finish) in enumerate(
        (("Llanowar Elves", "m19", "foil"), ("Forest", "m19", "nonfoil"))
    ):
        account.add(
            "pack_cards",
            opening_id=opening,
            position=position,
            printing_id=printings[name, set_code],
            concept_id=concepts[name],
            finish=finish,
            sheet="common",
            new=True,
        )
    account.add(
        "packs",
        user_id=player,
        product_id=product,
        source="purchase",
        tokens=300,
        request_key="buy-2",
        created_at=T0,
    )

    for name, set_code, finish, quantity, source in (
        ("Sol Ring", "cmr", "nonfoil", 1, "starter"),
        ("Sol Ring", "c21", "foil", 2, "auction"),
        ("Llanowar Elves", "m19", "foil", 1, "pack"),
        ("Llanowar Elves", "m19", "nonfoil", 3, "starter"),
        ("Forest", "m19", "nonfoil", 30, "starter"),
        ("Forest", "unf", "foil", 4, "grant"),
        ("Ezuri, Renegade Leader", "c15", "etched", 1, "campaign"),
    ):
        account.add(
            "library_grants",
            user_id=player,
            concept_id=concepts[name],
            printing_id=printings[name, set_code],
            finish=finish,
            quantity=quantity,
            source=source,
            grant_key=f"{source}:{name}:{set_code}:{finish}",
            created_at=T0,
        )

    for deck_id, title, source, opening_id, latest in (
        (deck, "Elves of the Ring", "manual", None, 2),
        (starter_deck, "Core Set 2019 Starter Deck", "pack", opening, 1),
    ):
        account.add(
            "decks",
            id=deck_id,
            owner_id=player,
            title=title,
            format="commander",
            visibility="link" if deck_id == deck else "private",
            share_code="ELF123" if deck_id == deck else None,
            notes="Turn one Sol Ring.",
            draft={"commander": ["Ezuri, Renegade Leader"], "main": {"Sol Ring": 1}},
            draft_version=3,
            draft_hash=f"hash-{title}",
            card_count=34,
            legal=True,
            playable=True,
            identity="G",
            latest_revision=latest,
            source=source,
            created_at=T0,
            updated_at=T0,
            removed_cards=[],
            switched_editions=[],
            sleeve=None,
            opening_id=opening_id,
        )
    for (deck_id, number), revision in revisions.items():
        account.add(
            "deck_revisions",
            id=revision,
            deck_id=deck_id,
            number=number,
            format="commander",
            title="Elves of the Ring",
            notes="",
            content_hash=f"content-{number}",
            catalog_revision_id=1,
            legal=True,
            playable=True,
            created_at=T0 + timedelta(days=number),
        )
        cards = (
            ("Ezuri, Renegade Leader", "c15", 1, "commander"),
            ("Sol Ring", "c21", 1, "main"),
            ("Llanowar Elves", "m19", number, "main"),
            ("Forest", "m19", 30, "main"),
            ("Forest", "unf", 1, "maybeboard"),
        )
        for name, set_code, quantity, location in cards:
            account.add(
                "deck_entries",
                revision_id=revision,
                concept_id=concepts[name],
                printing_id=printings[name, set_code],
                quantity=quantity,
                location=location,
            )

    duel, practice = uuid4(), uuid4()
    for game, kind, opponents in ((duel, "table", (friend,)), (practice, "practice", (None,))):
        account.add(
            "games",
            id=game,
            kind=kind,
            format="commander",
            status="finished",
            created_by=player,
            created_at=T0,
            finished_at=T0 + timedelta(minutes=40),
            bot_skill=3,
            turn_cap=120,
            result={"winners": [0], "reason": "last_player_standing"},
            catalog_revision_id=1,
            settings={},
            bots_passive=False,
            passive_bots_used=False,
        )
        account.add(
            "game_seats",
            game_id=game,
            seat=0,
            player="human",
            user_id=player,
            deck="Elves of the Ring",
            deck_revision_id=revisions[deck, 2],
        )
        opponent = opponents[0]
        account.add(
            "game_seats",
            game_id=game,
            seat=1,
            player="human" if opponent else "bot",
            user_id=opponent,
            deck="starter",
        )
        for seat, user, outcome in ((0, player, "win"), (1, opponent, "loss")):
            if user is None:
                continue
            account.add(
                "player_results",
                game_id=game,
                seat=seat,
                user_id=user,
                outcome=outcome,
                format="commander",
                kind=kind,
                seats=2,
                players=2 if opponent else 1,
                bots=0 if opponent else 1,
                bot_skill=None if opponent else 3,
                colors="G",
                turns=11,
                started_at=T0,
                finished_at=T0 + timedelta(minutes=40),
                policy="v1",
            )
        account.add(
            "progress_ledger",
            user_id=player,
            kind="game_win",
            wins=1,
            key=f"win:{game}:0",
            game_id=game,
            policy="v1",
            created_at=T0,
        )
    account.add(
        "player_results",
        game_id=None,
        seat=0,
        user_id=player,
        outcome="win",
        format="legacy",
        kind="practice",
        seats=2,
        players=1,
        bots=1,
        colors="G",
        started_at=T0,
        finished_at=T0,
        policy="granted",
        granted_by=friend,
    )
    account.add(
        "progress_ledger",
        user_id=player,
        kind="wins_set",
        wins=4,
        key="wins_set:1",
        policy="v1",
        reason="test",
        actor_id=friend,
        created_at=T0,
    )

    for kind, amount, key, game in (
        ("welcome", 1000, "welcome:player", None),
        ("human_win", 150, f"tokens:{duel}:0:1", duel),
        ("bot_win", 50, f"tokens:{practice}:0:1", practice),
        ("pack", -300, "pack:1", None),
        ("pack", -300, "pack:2", None),
        ("quest", 250, "quest:player:2026-11-01:win", None),
        ("achievement", 500, "achievement:player:first", None),
        ("bid", -120, "bid:1", None),
        ("bid_return", 120, "bid_return:1", None),
        ("bid", -80, "bid:2", None),
        ("sale", 95, "sale:1", None),
        ("campaign", 1000, "campaign:player:campaign-v1:1:tokens:1", None),
        ("campaign", 2000, "campaign:player:campaign-v1:1:tokens:2", None),
        ("grant", -40, "grant:take-back", None),
    ):
        account.add(
            "token_ledger",
            user_id=player,
            kind=kind,
            amount=amount,
            key=key,
            game_id=game,
            opponent_seat=1 if game else None,
            policy="v1",
            created_at=T0,
        )

    for slot, quest, completed in ((0, "win_game", True), (1, "cast_creatures", False)):
        account.add(
            "daily_quests",
            user_id=player,
            day=date(2026, 11, 1),
            slot=slot,
            key=f"quest:{slot}",
            quest=quest,
            tokens=250,
            target=3,
            counts_from=T0,
            completed_at=T0 if completed else None,
            policy="v1",
            created_at=T0,
            board="daily",
        )
    account.add(
        "daily_quests",
        user_id=player,
        day=date(2026, 10, 26),
        slot=7,
        key="weekly:7",
        quest="open_packs",
        tokens=400,
        target=5,
        counts_from=T0,
        completed_at=T0,
        policy="v1",
        created_at=T0,
        board="weekly",
    )
    account.add(
        "quest_boards",
        user_id=player,
        board="daily",
        period=date(2026, 11, 1),
        key="board:daily:2026-11-01",
        streak=3,
        bonus=150,
        policy="v1",
        completed_at=T0,
    )
    for achievement, pin in (("first_win", 1), ("pack_opener", None)):
        account.add(
            "player_achievements",
            user_id=player,
            achievement=achievement,
            version=1,
            key=f"achievement:{achievement}",
            tokens=500,
            pin=pin,
            earned_at=T0,
        )

    account.add(
        "campaign_progress",
        user_id=player,
        campaign_id="campaign-v1",
        content_version=1,
        highest_unlocked=3,
        completed=[1, 2],
        scenes_seen=["intro", "ward-1", "ward-2"],
        hints=True,
        tutorial_skipped=False,
        lessons=["mana"],
        started_at=T0,
        updated_at=T0,
    )
    account.add(
        "campaign_games",
        game_id=practice,
        user_id=player,
        campaign_id="campaign-v1",
        encounter=2,
        opponent="liliana",
        opponent_name="Liliana",
        title="The Gravecaller",
        deck="liliana",
        hints=True,
        outcome="won",
        created_at=T0,
    )
    account.add(
        "campaign_rewards",
        user_id=player,
        campaign_id="campaign-v1",
        key="campaign:player:reward:2",
        reward="deck",
        game_id=practice,
        created_at=T0,
    )
    account.add(
        "warden_openings",
        user_id=player,
        campaign_id="campaign-v1",
        encounter=2,
        key="warden:player:2",
        opponent="liliana",
        opponent_name="Liliana",
        deck_title="Liliana's Gravecaller",
        cards=[{"name": "Forest", "count": 30}],
        game_id=practice,
        created_at=T0,
    )
    account.add(
        "custom_card_grants",
        user_id=player,
        custom_card_id=uuid4(),
        quantity=1,
        source="campaign",
        grant_key="campaign:high-priest",
        created_at=T0,
    )

    sold, running = uuid4(), uuid4()
    for auction, status, buyer, price, ends in (
        (sold, "sold", friend, 100, T0 + timedelta(days=1)),
        (running, "active", None, None, T0 + timedelta(days=3)),
    ):
        account.add(
            "auctions",
            id=auction,
            seller_id=player,
            concept_id=concepts["Sol Ring"],
            printing_id=printings["Sol Ring", "c21"],
            finish="foil",
            starting_bid=50,
            buy_now=200,
            duration="3d",
            status=status,
            current_bid=price,
            bid_count=1 if price else 0,
            buyer_id=buyer,
            sold_price=price,
            request_key=f"list-{status}",
            batch_index=0,
            created_at=T0,
            ends_at=ends,
        )
    account.add(
        "auction_bids",
        auction_id=sold,
        bidder_id=friend,
        amount=100,
        buy_now=False,
        status="won",
        request_key="bid-1",
        created_at=T0,
    )
    account.add(
        "card_sleeves",
        user_id=player,
        name="Elvish sleeve",
        image=b"RIFF0000WEBP",
        width=63,
        height=88,
        created_at=T0,
    )
    account.write(engine)
    return player, friend


def totals(engine: Engine, player: UUID) -> dict[str, Any]:
    """The account as a player would count it, read in SQL that holds at every schema since
    v0.9.9's."""
    key = player if engine.dialect.name == "postgresql" else player.hex
    queries = {
        "tokens": "SELECT SUM(amount) FROM token_ledger WHERE user_id = :u",
        "token_entries": "SELECT kind, COUNT(*), SUM(amount) FROM token_ledger WHERE user_id = :u "
        "GROUP BY kind ORDER BY kind",
        "wins": "SELECT SUM(wins) FROM progress_ledger WHERE user_id = :u",
        "library": "SELECT p.set_code, c.name, g.finish, SUM(g.quantity) FROM library_grants g "
        "JOIN card_printings p ON p.id = g.printing_id JOIN card_concepts c ON c.id = g.concept_id "
        "WHERE g.user_id = :u GROUP BY p.set_code, c.name, g.finish ORDER BY 1, 2, 3",
        "custom_cards": "SELECT grant_key, quantity FROM custom_card_grants WHERE user_id = :u",
        "decks": "SELECT title, format, visibility, share_code, draft_hash, draft_version, "
        "latest_revision, legal, playable, source, (opening_id IS NOT NULL) FROM decks "
        "WHERE owner_id = :u ORDER BY title",
        "revisions": "SELECT d.title, r.number, r.content_hash, e.location, c.name, p.set_code, "
        "e.quantity FROM deck_revisions r JOIN decks d ON d.id = r.deck_id "
        "JOIN deck_entries e ON e.revision_id = r.id JOIN card_concepts c ON c.id = e.concept_id "
        "JOIN card_printings p ON p.id = e.printing_id WHERE d.owner_id = :u "
        "ORDER BY 1, 2, 4, 5, 6",
        "results": "SELECT r.outcome, r.kind, r.format, r.policy, COUNT(*) FROM player_results r "
        "WHERE r.user_id = :u GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4",
        "games_played_with": "SELECT g.kind, g.status, r.number FROM game_seats s "
        "JOIN games g ON g.id = s.game_id JOIN deck_revisions r ON r.id = s.deck_revision_id "
        "WHERE s.user_id = :u ORDER BY 1",
        "quests": "SELECT board, quest, tokens, target, completed_at IS NOT NULL FROM daily_quests "
        "WHERE user_id = :u ORDER BY board, slot",
        "quest_boards": "SELECT board, streak, bonus FROM quest_boards WHERE user_id = :u",
        "achievements": "SELECT achievement, tokens, pin FROM player_achievements "
        "WHERE user_id = :u ORDER BY achievement",
        "campaign": "SELECT campaign_id, highest_unlocked, completed, scenes_seen, lessons, ending "
        "FROM campaign_progress WHERE user_id = :u",
        "campaign_games": "SELECT encounter, outcome FROM campaign_games WHERE user_id = :u",
        "campaign_rewards": "SELECT key, reward FROM campaign_rewards WHERE user_id = :u",
        "warden_decks": "SELECT encounter, deck_title, cards FROM warden_openings "
        "WHERE user_id = :u",
        "auctions": "SELECT status, finish, starting_bid, buy_now, sold_price, bid_count "
        "FROM auctions WHERE seller_id = :u ORDER BY status",
        "packs": "SELECT p.request_key, p.tokens, COUNT(c.id) FROM packs p "
        "LEFT JOIN pack_openings o ON o.pack_id = p.id LEFT JOIN pack_cards c "
        "ON c.opening_id = o.id WHERE p.user_id = :u GROUP BY p.request_key, p.tokens ORDER BY 1",
        "sleeves": "SELECT name, width, height, LENGTH(image) FROM card_sleeves WHERE user_id = :u",
        "account": "SELECT display_name, handle, status, kind, onboarding, alliance, title, "
        "card_back, tutorial, preferences, starter_decks FROM users WHERE id = :u",
        "sign_in": "SELECT issuer, subject FROM external_identities WHERE user_id = :u",
        "roles": "SELECT role FROM role_grants WHERE user_id = :u",
        "friends": "SELECT status FROM friendships WHERE user_low = :u OR user_high = :u",
    }
    with engine.connect() as connection:
        return {
            name: [tuple(row) for row in connection.execute(text(sql), {"u": key})]
            for name, sql in queries.items()
        }


def tables_referring_to_accounts(engine: Engine) -> set[str]:
    metadata = MetaData()
    metadata.reflect(engine)
    return {
        table.name
        for table in metadata.sorted_tables
        for key in table.foreign_keys
        if key.column.table.name == "users"
    }


@pytest.fixture(params=["sqlite", "postgresql"])
def database(request: pytest.FixtureRequest, tmp_path, monkeypatch) -> Iterator[str]:
    """A database URL for alembic and for the test: a file of SQLite's, or with
    CD_TEST_POSTGRES_URL a schema of PostgreSQL's of its own, dropped afterwards."""
    if request.param == "sqlite":
        url = f"sqlite:///{tmp_path}/accounts.db"
        monkeypatch.setenv("CD_DATABASE_URL", url)
        yield url
        return
    base = os.getenv("CD_TEST_POSTGRES_URL")
    if not base:
        pytest.skip("PostgreSQL URL not supplied")
    schema = f"test_{uuid4().hex}"
    admin = create_engine(base, connect_args={"connect_timeout": 3})
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    url = (
        make_url(base)
        .update_query_dict({"options": f"-csearch_path={schema}"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("CD_DATABASE_URL", url)
    try:
        yield url
    finally:
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def test_an_account_survives_every_migration_up_and_back(database):
    config = Config("alembic.ini")
    command.upgrade(config, BASELINE)
    engine = create_engine(database)
    try:
        player, _ = representative_account(engine)
        before = totals(engine, player)
        # The account is all there: nothing in the list above went unread.
        assert before["tokens"] == [(4325,)]
        assert before["wins"] == [(6,)]
        assert sum(row[3] for row in before["library"]) == 42
        assert len(before["revisions"]) == 15
        assert all(rows for name, rows in before.items() if name != "custom_cards")

        command.upgrade(config, "head")
        assert totals(engine, player) == before
        # The API reads the account as the ledgers do, at the newest schema.
        from api import economy, progression

        with Session(engine) as db:
            assert economy.balance_of(db, player) == 4325
            assert progression.total_wins(db, player) == 6

        command.downgrade(config, BASELINE)
        assert totals(engine, player) == before
        command.upgrade(config, "head")
        assert totals(engine, player) == before
    finally:
        engine.dispose()


def test_every_table_that_refers_to_an_account_is_in_the_account_or_said_to_hold_nothing(
    tmp_path, monkeypatch
):
    url = f"sqlite:///{tmp_path}/tables.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    config = Config("alembic.ini")
    command.upgrade(config, BASELINE)
    engine = create_engine(url)
    try:
        representative_account(engine)
        with engine.connect() as connection:
            written = {
                table
                for table in tables_referring_to_accounts(engine)
                if connection.execute(text(f'SELECT COUNT(*) FROM "{table}"')).scalar()
            }
        command.upgrade(config, "head")
        at_head = tables_referring_to_accounts(engine)
    finally:
        engine.dispose()
    unaccounted = at_head - written - set(TRANSIENT)
    assert not unaccounted, (
        f"{sorted(unaccounted)} refer to accounts: add rows of them to representative_account "
        "(at the schema that adds them) or name them in TRANSIENT with why they hold no asset"
    )
    assert not set(TRANSIENT) - at_head, "TRANSIENT names a table that no longer refers to accounts"
