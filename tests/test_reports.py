"""Problem reports (v0.4.1): sending one, with and without a screenshot; the screenshot decoded,
upright, shrunk and re-encoded as WebP without the original's metadata; what is refused (other
types, too many bytes or pixels, NUL characters, a 21st report in a day, pending and denied
accounts); Administration's list, detail, screenshot and status, audited, for administrators and
SysOp only; the counts of waiting accounts and unread reports; and removing an account's reports.

Every image is made here with Pillow; no test reaches the network."""

import base64
import io
import os
import struct
import zlib
from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from PIL import ExifTags, Image
from sqlalchemy import create_engine, make_url, select, text
from sqlalchemy.orm import Session
from test_games import SYSOP_ADDRESS
from test_progression import Account

from api import reports
from api.config import Settings
from api.identity import utcnow
from api.main import create_app
from api.models import AuditEvent, ProblemReport, RoleGrant, User, UserSession
from api.reports import delete_reports_of
from api.version import APP_VERSION

TABLES = ("problem_reports", "progress_ledger", "audit_events", "role_grants", "sessions", "users")
GAME = "8f14e45f-ceea-467f-a0e6-9d8b2c0e5f6a"


@pytest.fixture(scope="module")
def url(tmp_path_factory) -> str:
    folder = tmp_path_factory.mktemp("reports")
    url = f"sqlite:///{folder}/reports.db"
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CD_DATABASE_URL", url)
        command.upgrade(Config("alembic.ini"), "head")
    return url


def started(url: str):
    app = create_app(Settings(database_url=url, sysop_networks="10.20.0.0/24"))
    return TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS)


@pytest.fixture
def client(url: str):
    with started(url) as client:
        yield client
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            for table in TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def account(
    client: TestClient,
    handle: str,
    *,
    roles: tuple[str, ...] = (),
    status: str = "active",
    kind: str = "player",
) -> Account:
    found = Account(client, handle, kind=kind)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        user = db.get(User, found.id)
        assert user is not None
        user.status = status
        for role in roles:
            db.add(RoleGrant(user_id=user.id, role=role, granted_at=utcnow()))
        db.commit()
    return found


def picture(
    kind: str = "PNG", size: tuple[int, int] = (64, 48), mode: str = "RGB", **options: Any
) -> bytes:
    out = io.BytesIO()
    Image.new(mode, size, "red" if mode == "RGB" else 0).save(out, kind, **options)
    return out.getvalue()


def png_header(width: int, height: int) -> bytes:
    """A PNG whose header claims this size, with almost no pixel data behind it."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"\x00"))
        + chunk(b"IEND", b"")
    )


def context(**changed: Any) -> dict[str, Any]:
    return {
        "page": "#play",
        "app_version": "0.4.1",
        "viewport_width": 1366,
        "viewport_height": 768,
        "pixel_ratio": 2,
        "requests": [
            {
                "method": "GET",
                "path": "/api/v1/me",
                "status": 200,
                "request_id": "0f9c1e0a-1b2c-4d3e-8f90-123456789abc",
                "at": "2026-10-21T12:00:00Z",
            },
            # A request the network never answered.
            {
                "method": "POST",
                "path": "/api/v1/games",
                "status": 0,
                "request_id": None,
                "at": "2026-10-21T12:00:05.250Z",
            },
        ],
    } | changed


def report(who: Account, image: bytes | None = None, **changed: Any) -> httpx.Response:
    body: dict[str, Any] = {
        "summary": "The board froze",
        "description": "I passed priority and nothing happened. I expected the next step.",
        "context": context(),
    } | changed
    if image is not None:
        body["screenshot"] = base64.b64encode(image).decode()
    return who.http.post(
        "/api/v1/reports",
        json=body,
        headers=who.headers() | {"user-agent": "Mozilla/5.0 (test browser)"},
    )


def stored(client: TestClient, report_id: str) -> ProblemReport:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        found = db.get(ProblemReport, UUID(report_id))
        assert found is not None
        _ = found.screenshot  # loads the deferred column while the session is open
        return found


def test_a_report_without_a_screenshot_keeps_what_the_page_attached(client):
    ada = account(client, "ada")
    sent = report(
        ada,
        summary="  The board froze  ",
        context=context(page="#game/" + GAME, game_id=GAME, game_turn=7),
    )
    assert sent.status_code == 201, sent.text
    body = sent.json()
    assert body["screenshot"] is False
    row = stored(client, body["id"])
    assert row.summary == "The board froze"  # trimmed
    assert row.status == "new" and row.user_id == ada.id
    assert (row.page, row.game_id, row.game_turn) == ("#game/" + GAME, UUID(GAME), 7)
    assert row.app_version == "0.4.1" and row.api_version == APP_VERSION
    # The browser's own header, not anything the page says about itself.
    assert row.user_agent == "Mozilla/5.0 (test browser)"
    assert (row.viewport_width, row.viewport_height, row.pixel_ratio) == (1366, 768, 2)
    assert row.requests[0]["path"] == "/api/v1/me" and row.requests[0]["status"] == 200
    assert row.requests[1] == {
        "method": "POST",
        "path": "/api/v1/games",
        "status": 0,
        "request_id": None,
        "at": "2026-10-21T12:00:05.250000Z",
    }
    assert row.screenshot is None and row.screenshot_width is None


def test_a_screenshot_is_reencoded_as_webp(client):
    ada = account(client, "ada")
    for kind in ("PNG", "JPEG", "WEBP"):
        sent = report(ada, picture(kind))
        assert sent.status_code == 201, sent.text
        assert sent.json()["screenshot"] is True
        row = stored(client, sent.json()["id"])
        assert row.screenshot is not None
        assert row.screenshot[:4] == b"RIFF" and row.screenshot[8:12] == b"WEBP"
        assert (row.screenshot_width, row.screenshot_height) == (64, 48)
    # A transparent PNG keeps its transparency.
    sent = report(ada, picture("PNG", mode="RGBA"))
    with Image.open(io.BytesIO(stored(client, sent.json()["id"]).screenshot or b"")) as image:
        assert image.mode == "RGBA"
    # A large one is shrunk to 2560 px on its long edge, its aspect kept.
    sent = report(ada, picture("PNG", size=(4000, 1000)))
    row = stored(client, sent.json()["id"])
    assert (row.screenshot_width, row.screenshot_height) == (2560, 640)


def test_the_screenshot_loses_the_originals_metadata_and_stands_upright(client):
    ada = account(client, "ada")
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "TestMaker"
    exif[ExifTags.Base.Model] = "Pocket Camera 9"
    # Rotated 90 degrees: the photo is 64 x 48 as stored, 48 x 64 as seen.
    exif[ExifTags.Base.Orientation] = 6
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    gps[ExifTags.GPS.GPSLatitudeRef] = "N"
    gps[ExifTags.GPS.GPSLatitude] = (33.0, 29.0, 41.0)
    photo = picture(
        "JPEG",
        exif=exif,
        icc_profile=b"a stand-in colour profile",
        comment=b"Taken at home",
        xmp=b'<x:xmpmeta xmlns:x="adobe:ns:meta/">Secret place</x:xmpmeta>',
    )
    with Image.open(io.BytesIO(photo)) as original:
        assert original.getexif()[ExifTags.Base.Make] == "TestMaker"
        assert original.getexif().get_ifd(ExifTags.IFD.GPSInfo)
        assert "icc_profile" in original.info and "xmp" in original.info
    sent = report(ada, photo)
    assert sent.status_code == 201, sent.text
    row = stored(client, sent.json()["id"])
    image_bytes = row.screenshot or b""
    for leftover in (b"TestMaker", b"Pocket Camera", b"Secret place", b"stand-in colour", b"home"):
        assert leftover not in image_bytes
    # A WebP's metadata lives in chunks of its own; none is there.
    for chunk in (b"EXIF", b"XMP ", b"ICCP"):
        assert chunk not in image_bytes
    with Image.open(io.BytesIO(image_bytes)) as image:
        assert image.format == "WEBP"
        assert not image.getexif()
        assert not {"exif", "xmp", "icc_profile"} & set(image.info)
        assert image.size == (48, 64)
    assert (row.screenshot_width, row.screenshot_height) == (48, 64)


def test_what_is_not_an_allowed_image_is_refused(client):
    ada = account(client, "ada")
    for image in (
        picture("GIF"),
        picture("BMP"),
        b"plain text, not an image",
        # A PNG's signature with nothing of a PNG behind it, and a truncated PNG.
        b"\x89PNG\r\n\x1a\n" + bytes(range(64)),
        picture("PNG", size=(200, 200))[:120],
    ):
        refused = report(ada, image)
        assert refused.status_code == 422, refused.text
        assert refused.json()["code"] == "invalid_image"
    refused = ada.http.post(
        "/api/v1/reports",
        json={"summary": "x", "description": "y", "context": context(), "screenshot": "*not*"},
        headers=ada.headers(),
    )
    assert refused.status_code == 422 and refused.json()["code"] == "invalid_image"
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        assert db.scalar(select(ProblemReport.id)) is None


def test_too_many_bytes_or_pixels_are_refused(client):
    ada = account(client, "ada")
    # One byte over 5 MB still fits the field, so the API itself says why.
    over = report(ada, b"\x89PNG" + bytes(reports.MAX_SCREENSHOT_BYTES - 3))
    assert over.status_code == 422 and over.json()["code"] == "image_too_large"
    assert "5 MB" in over.json()["message"]
    # Far more is past the contract's own limit on the field.
    far = report(ada, bytes(reports.MAX_SCREENSHOT_BYTES + 4096))
    assert far.status_code == 422 and far.json()["code"] == "invalid_request"
    # A few bytes that would unpack to 50 million pixels, or to 400 million (past Pillow's own
    # limit), are refused before any pixel is unpacked.
    for width, height in ((10_000, 5_000), (20_000, 20_000)):
        bomb = report(ada, png_header(width, height))
        assert bomb.status_code == 422, bomb.text
        assert bomb.json()["code"] == "image_too_large"
    # Just inside the limit is taken, and shrunk.
    taken = report(ada, picture("PNG", size=(8000, 5000), mode="1"))
    assert taken.status_code == 201, taken.text
    row = stored(client, taken.json()["id"])
    assert (row.screenshot_width, row.screenshot_height) == (2560, 1600)


def test_text_is_checked(client):
    ada = account(client, "ada")
    sent = context()["requests"][0]
    for changed in (
        {"summary": "   "},
        {"summary": "x" * 121},
        {"summary": "Froze\x00"},
        {"description": ""},
        {"description": "x" * 4001},
        {"description": "nul \x00 here"},
        {"context": context(page="#play\x00")},
        {"context": context(page="")},
        {"context": context(app_version="v" * 33)},
        {"context": context(viewport_width=0)},
        {"context": context(game_turn=-1)},
        {"context": context(game_id="not-a-game")},
        {"context": context(requests=[sent] * 21)},
        {"context": context(requests=[sent | {"path": "/api/v1/cards?q=x"}])},
        {"context": context(requests=[sent | {"path": "/api/v1/\x00"}])},
        {"context": context(requests=[sent | {"method": "TRACE"}])},
        {"context": context(requests=[sent | {"request_id": "a b"}])},
        {"context": context(requests=[sent | {"body": "{}"}])},
        # Every field is named, the request ID too (null when no answer came).
        {"context": context(requests=[{k: v for k, v in sent.items() if k != "request_id"}])},
        {"context": context(user_agent="the page's own")},
        {"extra": True},
    ):
        refused = report(ada, **changed)
        assert refused.status_code == 422, changed
        assert refused.json()["code"] == "invalid_request"


def test_twenty_reports_a_day_and_sysop_unlimited(client):
    ada = account(client, "ada")
    root = account(client, "sysop", kind="sysop")
    now = utcnow()
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        for who in (ada, root):
            for index in range(reports.DAILY_LIMIT):
                db.add(
                    ProblemReport(
                        user_id=who.id,
                        created_at=now - timedelta(hours=23, minutes=index),
                        summary="Earlier",
                        description="Earlier",
                        status="new",
                        page="#play",
                        app_version="0.4.1",
                        api_version=APP_VERSION,
                        viewport_width=1,
                        viewport_height=1,
                        pixel_ratio=1,
                        requests=[],
                    )
                )
        db.commit()
    refused = report(ada)
    assert refused.status_code == 429
    assert refused.json()["code"] == "too_many_reports"
    # The oldest of the day's reports leaves the window in about 41 minutes.
    assert 40 * 60 <= int(refused.headers["retry-after"]) <= 41 * 60
    assert report(root).status_code == 201
    # A day later the old reports no longer count.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        for row in db.scalars(select(ProblemReport).where(ProblemReport.user_id == ada.id)):
            row.created_at -= timedelta(hours=2)
        db.commit()
    assert report(ada).status_code == 201


def test_only_active_accounts_send_reports(client):
    assert client.post("/api/v1/reports", json={}).status_code == 401
    waiting = account(client, "waiting", status="pending")
    refused = report(waiting)
    assert refused.status_code == 403 and refused.json()["code"] == "account_pending"
    denied = account(client, "denied", status="denied")
    refused = report(denied)
    assert refused.status_code == 403 and refused.json()["code"] == "account_denied"
    # The CSRF token is needed as on every change.
    ada = account(client, "ada")
    unsigned = client.post(
        "/api/v1/reports",
        json={"summary": "x", "description": "y", "context": context()},
        headers={"cookie": f"cd_session={ada.token}"},
    )
    assert unsigned.status_code == 403 and unsigned.json()["code"] == "csrf_failed"


def test_administrators_and_sysop_read_reports_and_others_cannot(client):
    ada = account(client, "ada")
    sent = report(ada, picture("PNG"))
    report_id = sent.json()["id"]
    for handle, roles in (
        ("player", ()),
        ("moderator", ("moderator",)),
        ("editor", ("content_editor",)),
    ):
        other = account(client, handle, roles=roles)
        for path in ("/api/v1/admin/reports", f"/api/v1/admin/reports/{report_id}"):
            assert other.get(path).status_code == 403
        status = f"/api/v1/admin/reports/{report_id}/status"
        changed = other.send("POST", status, {"status": "seen"})
        assert changed.status_code == 403 and changed.json()["code"] == "forbidden"
        # The image answers as a missing one would.
        image = other.get(f"/api/v1/admin/reports/{report_id}/screenshot")
        assert image.status_code == 404 and image.json()["code"] == "http_404"
    root = account(client, "sysop", kind="sysop")
    admin = account(client, "admin", roles=("administrator",))
    for reader in (admin, root):
        listed = reader.get("/api/v1/admin/reports")
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["items"]] == [report_id]
        image = reader.get(f"/api/v1/admin/reports/{report_id}/screenshot")
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/webp"
        assert image.headers["cache-control"] == "private, no-store"
        assert image.headers["x-content-type-options"] == "nosniff"
        assert image.content == stored(client, report_id).screenshot
    # No screenshot, or no such report: 404.
    plain = report(ada).json()["id"]
    assert admin.get(f"/api/v1/admin/reports/{plain}/screenshot").status_code == 404
    assert admin.get(f"/api/v1/admin/reports/{uuid4()}/screenshot").status_code == 404
    assert admin.get(f"/api/v1/admin/reports/{uuid4()}").status_code == 404
    assert admin.get("/api/v1/admin/reports/not-an-id").status_code == 422


def test_the_list_newest_first_with_its_reporter_and_the_detail(client):
    ada = account(client, "ada")
    root = account(client, "sysop", kind="sysop")
    admin = account(client, "admin", roles=("administrator",))
    first = report(ada, summary="First").json()["id"]
    second = report(root, summary="Second").json()["id"]
    third = report(
        ada, picture("PNG"), summary="Third", context=context(game_id=GAME, game_turn=3)
    ).json()["id"]
    page = admin.get("/api/v1/admin/reports", limit=2).json()
    assert [item["id"] for item in page["items"]] == [third, second]
    rest = admin.get("/api/v1/admin/reports", limit=2, cursor=page["next_cursor"]).json()
    assert [item["id"] for item in rest["items"]] == [first] and rest["next_cursor"] is None
    newest = page["items"][0]
    assert newest["reporter"] == {"id": str(ada.id), "handle": "ada", "display_name": "Ada"}
    assert (newest["game_id"], newest["game_turn"], newest["screenshot"]) == (GAME, 3, True)
    assert newest["status"] == "new" and newest["page"] == "#play"
    # SysOp is the site administrator to everyone else, and itself to itself.
    assert page["items"][1]["reporter"] == {
        "id": None,
        "handle": None,
        "display_name": "Site administrator",
    }
    own = root.get("/api/v1/admin/reports", limit=2).json()["items"][1]["reporter"]
    assert own["handle"] == "sysop" and own["id"] == str(root.id)
    detail = admin.get(f"/api/v1/admin/reports/{third}").json()
    assert detail["description"].startswith("I passed priority")
    assert detail["user_agent"] == "Mozilla/5.0 (test browser)"
    assert detail["api_version"] == APP_VERSION and detail["app_version"] == "0.4.1"
    assert (detail["viewport_width"], detail["pixel_ratio"]) == (1366, 2)
    assert detail["requests"][0]["request_id"] == "0f9c1e0a-1b2c-4d3e-8f90-123456789abc"
    assert (detail["screenshot_width"], detail["screenshot_height"]) == (64, 48)
    assert detail["status_changed_by"] is None
    assert admin.get("/api/v1/admin/reports", cursor="nonsense").status_code == 422


def test_status_changes_are_audited_and_filter_the_list(client):
    ada = account(client, "ada")
    admin = account(client, "admin", roles=("administrator",))
    first = report(ada, summary="First").json()["id"]
    second = report(ada, summary="Second").json()["id"]
    changed = admin.send("POST", f"/api/v1/admin/reports/{first}/status", {"status": "seen"})
    assert changed.status_code == 200, changed.text
    assert changed.json()["status"] == "seen"
    assert changed.json()["status_changed_by"]["label"] == "admin"
    # The same status again changes nothing and records nothing.
    assert (
        admin.send("POST", f"/api/v1/admin/reports/{first}/status", {"status": "seen"}).json()[
            "status_changed_at"
        ]
        == changed.json()["status_changed_at"]
    )
    admin.send("POST", f"/api/v1/admin/reports/{second}/status", {"status": "fixed"})
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        events = db.scalars(
            select(AuditEvent)
            .where(AuditEvent.action == "admin.report_status_changed")
            .order_by(AuditEvent.occurred_at)
        ).all()
    assert [event.details for event in events] == [
        {"report": first, "from": "new", "to": "seen"},
        {"report": second, "from": "new", "to": "fixed"},
    ]
    assert {(event.actor_id, event.target_user_id) for event in events} == {(admin.id, ada.id)}
    # The audit log shows it to administrators.
    logged = admin.get("/api/v1/admin/audit", action="admin.report").json()["items"]
    assert len(logged) == 2 and logged[0]["target"]["label"] == "ada"

    def shown(*statuses: str) -> list[str]:
        query = "&".join(f"status={status}" for status in statuses)
        listed = admin.http.get(f"/api/v1/admin/reports?{query}", headers=admin.headers())
        return [item["summary"] for item in listed.json()["items"]]

    assert shown("new", "seen") == ["First"]
    assert shown("fixed") == ["Second"]
    assert shown("closed") == []
    assert shown() == ["Second", "First"]
    unknown = admin.send("POST", f"/api/v1/admin/reports/{first}/status", {"status": "lost"})
    assert unknown.status_code == 422
    assert (
        admin.http.get("/api/v1/admin/reports?status=lost", headers=admin.headers()).status_code
        == 422
    )
    # Back to new is allowed: an administrator may mark a report unread again.
    again = admin.send("POST", f"/api/v1/admin/reports/{first}/status", {"status": "new"})
    assert again.json()["status"] == "new"


def test_counts_per_role(client):
    ada = account(client, "ada")
    account(client, "waiting", status="pending")
    account(client, "waiting2", status="pending")
    account(client, "denied", status="denied")
    root = account(client, "sysop", kind="sysop")
    admin = account(client, "admin", roles=("administrator",))
    moderator = account(client, "moderator", roles=("moderator",))
    editor = account(client, "editor", roles=("content_editor",))
    first = report(ada).json()["id"]
    report(ada)
    nothing = {"pending_accounts": None, "unread_reports": None}
    for viewer in (ada, moderator, editor):
        assert viewer.get("/api/v1/admin/counts").json() == nothing
    for viewer in (admin, root):
        assert viewer.get("/api/v1/admin/counts").json() == {
            "pending_accounts": 2,
            "unread_reports": 2,
        }
    admin.send("POST", f"/api/v1/admin/reports/{first}/status", {"status": "seen"})
    assert root.get("/api/v1/admin/counts").json()["unread_reports"] == 1
    assert client.get("/api/v1/admin/counts").status_code == 401
    waiting = account(client, "waiting3", status="pending")
    assert waiting.get("/api/v1/admin/counts").status_code == 403


def test_asking_for_the_counts_is_not_activity(client):
    admin = account(client, "admin", roles=("administrator",))
    earlier = utcnow() - timedelta(minutes=5)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        session = db.scalar(select(UserSession).where(UserSession.user_id == admin.id))
        assert session is not None
        session.last_seen_at = earlier
        db.commit()

    def last_seen() -> Any:
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            return db.scalar(
                select(UserSession.last_seen_at).where(UserSession.user_id == admin.id)
            )

    assert admin.get("/api/v1/admin/counts").status_code == 200
    assert last_seen() == earlier
    assert admin.get("/api/v1/me").status_code == 200
    assert last_seen() > earlier


def test_removing_an_accounts_reports(client):
    ada = account(client, "ada")
    bob = account(client, "bob")
    report(ada, picture("PNG"))
    report(ada)
    kept = report(bob).json()["id"]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        assert delete_reports_of(db, ada.id) == 2
        db.commit()
        assert [str(found) for found in db.scalars(select(ProblemReport.id))] == [kept]


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_reports_on_postgresql(monkeypatch):
    """The screenshot as bytea, the requests as jsonb and the status filter on PostgreSQL."""
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
            ada = account(client, "ada")
            admin = account(client, "admin", roles=("administrator",))
            sent = report(ada, picture("JPEG", size=(3000, 2000)))
            assert sent.status_code == 201, sent.text
            report_id = sent.json()["id"]
            listed = admin.http.get(
                "/api/v1/admin/reports?status=new&status=seen", headers=admin.headers()
            ).json()["items"]
            assert [item["id"] for item in listed] == [report_id]
            detail = admin.get(f"/api/v1/admin/reports/{report_id}").json()
            assert detail["requests"][0]["path"] == "/api/v1/me"
            assert (detail["screenshot_width"], detail["screenshot_height"]) == (2560, 1707)
            image = admin.get(f"/api/v1/admin/reports/{report_id}/screenshot")
            assert image.content[8:12] == b"WEBP"
            assert admin.get("/api/v1/admin/counts").json()["unread_reports"] == 1
            with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
                assert delete_reports_of(db, ada.id) == 1
                db.commit()
        command.downgrade(Config("alembic.ini"), "0011_custom_play")
        command.upgrade(Config("alembic.ini"), "head")
    finally:
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin_engine.dispose()
