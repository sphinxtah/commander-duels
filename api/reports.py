"""Problem reports (v0.4.1): "Report a problem" for the beta testers, and Administration's
Reports tab. docs/reports.md describes both.

Any active account sends a report: a summary, what happened, and what the page attached on its
own: its address, the web app's version, the window's size, at a table the game and its turn, and
its latest API requests (method, path without the query, status, request ID and time; never a
body). The API adds its own version and the browser's User-Agent header. None of it is checked
against the account or decides anything: it is context for whoever reads the report.

An optional screenshot comes base64 in the JSON: PNG, JPEG or WebP, at most 5 MB. Pillow decodes
it, and anything that is not really one of those is refused, as is an image that would unpack to
more than 40 million pixels, before any of it is unpacked. The image is turned upright by its EXIF
orientation, shrunk to at most 2560 px on its long edge and encoded again as WebP from its pixels
alone, so no EXIF, GPS, XMP, ICC profile or text of the file sent survives. It is kept in the
database, so the nightly backups hold it with its report.

SysOp and administrators (reports.manage) read the reports newest first, see the screenshots and
set a status: new (unread), seen, fixed or closed. Each change is audited. An account sends at most
20 reports a day; SysOp has no limit.

Since v0.4.4 a report may be about a chat message (message): a friend's message the account
received, or a line of a table's chat it saw. The report keeps a copy of it and of the messages
before it that the reporter saw (api/chat.py, api/table_chat.py), and who sent it. Administrators
read chat messages only so, when a player reports them.
"""

import base64
import binascii
import io
import math
import threading
import warnings
from datetime import datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from PIL import Image, ImageOps
from pydantic import AfterValidator, Field, StringConstraints
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.orm import Session

from api.admin import SITE_ADMINISTRATOR, actor_label, decode_cursor, encode_cursor
from api.auth import INPUT_ERRORS
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    require_permission,
    utcnow,
)
from api.models import ProblemReport, User
from api.schemas import (
    AuditActor,
    ChatPerson,
    Contract,
    ReportedChat,
    ReportedMessageRef,
    StoredText,
    without_nul,
)
from api.version import APP_VERSION

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
CanManageReports = Annotated[Principal, Depends(require_permission("reports.manage"))]

# 5 MB as a computer shows file sizes, so a file it calls "5 MB" is taken.
MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024
# 8000 x 5000. A phone's largest photos are past it, but past 5 MB too, and the page shrinks
# those before it sends them; this bounds what a request made by hand can make the API unpack.
MAX_PIXELS = 40_000_000
LONG_EDGE = 2560
WEBP_QUALITY = 85
FORMATS = ("PNG", "JPEG", "WEBP")
DAILY_LIMIT = 20
MAX_REQUESTS = 20
# An image being decoded may hold a few hundred MB of pixels for a moment: two at most at once.
DECODING = threading.BoundedSemaphore(2)

ReportStatus = Literal["new", "seen", "fixed", "closed"]
# Text a person writes: trimmed, never empty, without NUL characters.
Summary = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=120),
    AfterValidator(without_nul),
]
Description = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=4000),
    AfterValidator(without_nul),
]


class RecentRequest(Contract):
    """One of the page's latest API requests, as the page recorded it."""

    method: Literal["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
    # A plain string, so the request's schema is also the answer's; the pattern refuses NUL.
    path: str = Field(
        min_length=1,
        max_length=200,
        pattern=r"^/[^?#\s\x00]*$",
        description="The request's path, without its query.",
    )
    status: int = Field(ge=0, le=599, description="0 when no answer came.")
    # Required, null when no answer or no ID came, so the request's schema is also the answer's.
    request_id: Annotated[str, Field(max_length=64, pattern=r"^[A-Za-z0-9-]+$")] | None = Field(
        description="The answer's X-Request-ID."
    )
    at: datetime


class ReportContext(Contract):
    """What the page attaches on its own. Context only: nothing in it is checked against the
    account or decides anything."""

    page: Annotated[
        StoredText,
        Field(
            min_length=1,
            max_length=200,
            description="The page's address: its hash route, without a query.",
        ),
    ]
    app_version: Annotated[
        StoredText,
        Field(
            min_length=1,
            max_length=32,
            description="The web app's version, which may be older than the API's.",
        ),
    ]
    viewport_width: int = Field(ge=1, le=100_000)
    viewport_height: int = Field(ge=1, le=100_000)
    pixel_ratio: float = Field(gt=0, le=16)
    game_id: UUID | None = Field(default=None, description="The game, when sent from its table.")
    game_turn: int | None = Field(default=None, ge=0, le=100_000)
    requests: list[RecentRequest] = Field(default_factory=list, max_length=MAX_REQUESTS)


class ReportCreate(Contract):
    summary: Summary
    description: Description
    context: ReportContext
    screenshot: str | None = Field(
        default=None,
        min_length=1,
        max_length=4 * math.ceil(MAX_SCREENSHOT_BYTES / 3),
        description="An image, base64: PNG, JPEG or WebP, at most 5 MB decoded.",
    )
    message: ReportedMessageRef | None = Field(
        default=None, description="The chat message the report is about (v0.4.4)."
    )


class ReportReceipt(Contract):
    id: UUID
    created_at: datetime
    screenshot: bool = Field(description="Whether a screenshot was kept with the report.")


class Reporter(Contract):
    id: UUID | None = Field(description="Null for SysOp's own reports, to anyone but SysOp.")
    handle: str | None
    display_name: str


class ReportSummary(Contract):
    id: UUID
    created_at: datetime
    status: ReportStatus = Field(description="new (unread), seen, fixed or closed.")
    summary: str
    reporter: Reporter
    page: str
    app_version: str
    game_id: UUID | None
    game_turn: int | None
    screenshot: bool
    reported_user: ChatPerson | None = Field(
        default=None, description="Who sent the reported chat message, if the report is of one."
    )


class ReportDetail(ReportSummary):
    description: str
    api_version: str = Field(description="The API's version when the report came.")
    user_agent: str | None
    viewport_width: int
    viewport_height: int
    pixel_ratio: float
    requests: list[RecentRequest]
    screenshot_width: int | None
    screenshot_height: int | None
    status_changed_at: datetime | None
    status_changed_by: AuditActor | None
    chat: ReportedChat | None = Field(
        default=None,
        description="The reported message and the messages before it the reporter saw.",
    )


class ReportPage(Contract):
    items: list[ReportSummary]
    next_cursor: str | None


class ReportStatusChange(Contract):
    status: ReportStatus


class AdminCounts(Contract):
    pending_accounts: int | None = Field(
        description="Accounts waiting for approval; null without admin.users.manage."
    )
    unread_reports: int | None = Field(
        description="Reports nobody has opened (status new); null without reports.manage."
    )


def delete_reports_of(db: Session, user_id: UUID) -> int:
    """Removes every report an account sent, screenshots included, as deleting the account does.
    The caller commits. Audit entries of their status changes stay, naming only their IDs."""
    return db.execute(  # type: ignore[no-any-return]
        delete(ProblemReport).where(ProblemReport.user_id == user_id)
    ).rowcount  # type: ignore[attr-defined]


def limit_reports(db: Session, user_id: UUID, now: datetime) -> None:
    """DAILY_LIMIT reports in any 24 hours. Past it the answer says when the next one may go."""
    window = timedelta(days=1)
    sent = list(
        db.scalars(
            select(ProblemReport.created_at)
            .where(ProblemReport.user_id == user_id, ProblemReport.created_at > now - window)
            .order_by(ProblemReport.created_at)
            .limit(DAILY_LIMIT)
        )
    )
    if len(sent) >= DAILY_LIMIT:
        wait = max(1, math.ceil((sent[0] + window - now).total_seconds()))
        raise ApiError(
            429,
            "too_many_reports",
            f"You have sent {DAILY_LIMIT} reports in the last 24 hours. Try again later.",
            {"Retry-After": str(wait)},
        )


def too_many_pixels() -> ApiError:
    return ApiError(
        422,
        "image_too_large",
        "The screenshot has more than 40 million pixels. Send a smaller one.",
    )


def unreadable() -> ApiError:
    return ApiError(422, "invalid_image", "The screenshot is not a PNG, JPEG or WebP image.")


def reencoded(data: bytes) -> tuple[bytes, int, int]:
    """The image as a new WebP of its pixels alone, upright, at most LONG_EDGE on its long edge.
    The size is read from the header and checked before any pixel is unpacked."""
    try:
        with warnings.catch_warnings():
            # Pillow warns from 89 million pixels on its own; anything that large is refused here.
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data), formats=FORMATS) as image:
                if image.width * image.height > MAX_PIXELS:
                    raise too_many_pixels()
                # Unpacks the first frame only, a JPEG at a reduced scale where it can.
                image.thumbnail((LONG_EDGE, LONG_EDGE), Image.Resampling.LANCZOS)
                image.load()
                upright = ImageOps.exif_transpose(image)
                mode = "RGBA" if upright.has_transparency_data else "RGB"
                pixels = upright.convert(mode)
    except ApiError:
        raise
    except Image.DecompressionBombError as error:
        raise too_many_pixels() from error
    except Exception as error:
        # Not one of the three formats (UnidentifiedImageError), or a decoder's failure on a
        # damaged or crafted file, whatever its kind: refused, never a 500.
        raise unreadable() from error
    # A new image from the bytes of its pixels carries nothing else of the original.
    clean = Image.frombytes(mode, pixels.size, pixels.tobytes())
    out = io.BytesIO()
    clean.save(out, "WEBP", quality=WEBP_QUALITY, method=4)
    return out.getvalue(), clean.width, clean.height


def screenshot_of(encoded: str) -> tuple[bytes, int, int]:
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ApiError(422, "invalid_image", "The screenshot is not valid base64.") from error
    if len(data) > MAX_SCREENSHOT_BYTES:
        raise ApiError(422, "image_too_large", "The screenshot is larger than 5 MB.")
    with DECODING:
        return reencoded(data)


@router.post("/reports", response_model=ReportReceipt, status_code=201)
def send_report(body: ReportCreate, request: Request, principal: Active, db: Db) -> ReportReceipt:
    """Sends a problem report to the site's administrators, with an optional screenshot."""
    now = utcnow()
    if principal.user.kind != "sysop":
        limit_reports(db, principal.user.id, now)
    reported: tuple[UUID, ReportedChat] | None = None
    if body.message is not None:
        # Imported here: the chat modules import far.
        from api.chat import reported_direct
        from api.table_chat import reported_table

        found = reported_direct if body.message.kind == "direct" else reported_table
        reported = found(db, principal, body.message.id)
    shot = screenshot_of(body.screenshot) if body.screenshot else None
    context = body.context
    report = ProblemReport(
        user_id=principal.user.id,
        created_at=now,
        summary=body.summary,
        description=body.description,
        status="new",
        page=context.page,
        app_version=context.app_version,
        api_version=APP_VERSION,
        user_agent=(request.headers.get("user-agent") or "")[:512] or None,
        viewport_width=context.viewport_width,
        viewport_height=context.viewport_height,
        pixel_ratio=context.pixel_ratio,
        game_id=context.game_id,
        game_turn=context.game_turn,
        requests=[entry.model_dump(mode="json") for entry in context.requests],
        screenshot=shot[0] if shot else None,
        screenshot_width=shot[1] if shot else None,
        screenshot_height=shot[2] if shot else None,
        reported_user_id=reported[0] if reported else None,
        chat=reported[1].model_dump(mode="json") if reported else None,
    )
    db.add(report)
    db.commit()
    return ReportReceipt(id=report.id, created_at=report.created_at, screenshot=shot is not None)


def reporter_of(user: User | None, viewer: Principal) -> Reporter:
    if user is None:
        return Reporter(id=None, handle=None, display_name="Unknown account")
    # SysOp is a ghost to everyone else, here as in the audit trail.
    if user.kind == "sysop" and viewer.user.kind != "sysop":
        return Reporter(id=None, handle=None, display_name=SITE_ADMINISTRATOR)
    return Reporter(id=user.id, handle=user.handle, display_name=user.display_name)


def users_of(db: Session, ids: set[UUID | None]) -> dict[UUID, User]:
    wanted = {found for found in ids if found is not None}
    if not wanted:
        return {}
    return {user.id: user for user in db.scalars(select(User).where(User.id.in_(wanted)))}


def summary_of(report: ProblemReport, users: dict[UUID, User], viewer: Principal) -> ReportSummary:
    return ReportSummary(
        id=report.id,
        created_at=report.created_at,
        status=report.status,  # type: ignore[arg-type]
        summary=report.summary,
        reporter=reporter_of(users.get(report.user_id), viewer),
        page=report.page,
        app_version=report.app_version,
        game_id=report.game_id,
        game_turn=report.game_turn,
        # The width says whether there is one, without loading the image itself.
        screenshot=report.screenshot_width is not None,
        reported_user=(
            ReportedChat.model_validate(report.chat).reported_user if report.chat else None
        ),
    )


def detail_of(db: Session, report: ProblemReport, viewer: Principal) -> ReportDetail:
    users = users_of(db, {report.user_id, report.status_changed_by})
    changer = users.get(report.status_changed_by) if report.status_changed_by else None
    return ReportDetail(
        **summary_of(report, users, viewer).model_dump(),
        description=report.description,
        api_version=report.api_version,
        user_agent=report.user_agent,
        viewport_width=report.viewport_width,
        viewport_height=report.viewport_height,
        pixel_ratio=report.pixel_ratio,
        requests=[RecentRequest.model_validate(entry) for entry in report.requests or []],
        screenshot_width=report.screenshot_width,
        screenshot_height=report.screenshot_height,
        status_changed_at=report.status_changed_at,
        status_changed_by=actor_label(changer, viewer),
        chat=ReportedChat.model_validate(report.chat) if report.chat else None,
    )


@router.get("/admin/reports", response_model=ReportPage)
def list_reports(
    principal: CanManageReports,
    db: Db,
    status: Annotated[list[ReportStatus] | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
) -> ReportPage:
    """The reports, newest first: all of them, or those of the statuses named."""
    query = select(ProblemReport)
    if status:
        query = query.where(ProblemReport.status.in_(status))
    if cursor:
        moment, row_id = decode_cursor(cursor)
        query = query.where(
            or_(
                ProblemReport.created_at < moment,
                and_(ProblemReport.created_at == moment, ProblemReport.id < row_id),
            )
        )
    reports = list(
        db.scalars(
            query.order_by(ProblemReport.created_at.desc(), ProblemReport.id.desc()).limit(
                limit + 1
            )
        )
    )
    more = len(reports) > limit
    reports = reports[:limit]
    users = users_of(db, {report.user_id for report in reports})
    last = reports[-1] if reports else None
    return ReportPage(
        items=[summary_of(report, users, principal) for report in reports],
        next_cursor=encode_cursor(last.created_at, last.id) if more and last else None,
    )


@router.get("/admin/reports/{report_id}", response_model=ReportDetail)
def report_detail(report_id: UUID, principal: CanManageReports, db: Db) -> ReportDetail:
    report = db.get(ProblemReport, report_id)
    if report is None:
        raise not_found()
    return detail_of(db, report, principal)


@router.get(
    "/admin/reports/{report_id}/screenshot",
    response_class=Response,
    responses={200: {"content": {"image/webp": {}}}},
)
def report_screenshot(report_id: UUID, principal: Active, db: Db) -> Response:
    """The report's screenshot, WebP. Without reports.manage, or without a screenshot, the same
    404 as a missing route's."""
    if not principal.can("reports.manage"):
        raise not_found()
    image = db.scalar(select(ProblemReport.screenshot).where(ProblemReport.id == report_id))
    if image is None:
        raise not_found()
    # Kept out of every shared cache and of the installed app's offline copies.
    return Response(
        content=image,
        media_type="image/webp",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f'inline; filename="report-{report_id}.webp"',
        },
    )


@router.post("/admin/reports/{report_id}/status", response_model=ReportDetail)
def change_report_status(
    report_id: UUID,
    body: ReportStatusChange,
    request: Request,
    principal: CanManageReports,
    db: Db,
) -> ReportDetail:
    """Sets the report's status; opening a new report in Administration marks it seen."""
    report = db.get(ProblemReport, report_id)
    if report is None:
        raise not_found()
    before = report.status
    if before != body.status:
        report.status = body.status
        report.status_changed_by = principal.user.id
        report.status_changed_at = utcnow()
        audit(
            db,
            request,
            "admin.report_status_changed",
            actor_id=principal.user.id,
            target_user_id=report.user_id,
            details={"report": str(report.id), "from": before, "to": body.status},
        )
        db.commit()
    return detail_of(db, report, principal)


@router.get("/admin/counts", response_model=AdminCounts)
def admin_counts(principal: Active, db: Db) -> AdminCounts:
    """What waits for Administration: accounts to approve and unread reports, each null for an
    account that may not see it. The page asks every minute; that is not activity, so it does
    not hold off the session's idle limit (identity.BACKGROUND_PATHS)."""
    pending = (
        db.scalar(
            select(func.count())
            .select_from(User)
            .where(User.kind == "player", User.status == "pending")
        )
        if principal.can("admin.users.manage")
        else None
    )
    unread = (
        db.scalar(
            select(func.count()).select_from(ProblemReport).where(ProblemReport.status == "new")
        )
        if principal.can("reports.manage")
        else None
    )
    return AdminCounts(pending_accounts=pending, unread_reports=unread)
