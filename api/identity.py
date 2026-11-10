"""Sessions, roles, permissions and the audit trail (AUTH03, AUTH06, AUTH07, SEC05).

The browser holds one random session token in a Secure, HttpOnly cookie; the database holds
only its SHA-256 hash. Every state-changing request also carries the session's CSRF token in a
header. SysOp is the local root account: it holds every permission, including the ones no role
can be granted, and its sessions work only from the SysOp networks.
"""

import hashlib
import hmac
import secrets
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, cast, get_args
from uuid import UUID

from fastapi import Depends, Request, Response
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from starlette.requests import HTTPConnection

from api.config import Settings
from api.models import AuditEvent, ExternalIdentity, RoleGrant, User, UserSession
from api.network import client_address, within
from api.schemas import Me, Permission, Preferences, Role, SessionInfo, Tutorial

# The session cookie (v0.8.5): host-only, for the whole site, Secure. The __Host- prefix makes the
# browser refuse a cookie of this name from anywhere else, such as a sibling site setting one for
# the parent domain or for a narrower path to shadow it. Browsers take a Secure cookie on
# http://localhost too, so this is the name everywhere CD_COOKIE_SECURE is true (always in
# production).
SESSION_COOKIE = "__Host-cd_session"
# With CD_COOKIE_SECURE false (plain HTTP on a host other than localhost, for development only;
# production refuses it), no browser keeps a __Host- cookie: the cookie is this one, for the whole
# site, not Secure. Its own name, so it never meets the old cookie below.
INSECURE_SESSION_COOKIE = "cd_session_http"
# The cookie before v0.8.5, at path /api: expired on every sign-in and sign-out.
OLD_SESSION_COOKIE = "cd_session"
OLD_SESSION_PATH = "/api"
GOOGLE_COOKIE = "cd_google"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
TOUCH_INTERVAL = timedelta(minutes=1)
# How long a rotated session's old token still signs requests in, for those the browser sent
# before it read the new cookie.
ROTATION_GRACE = timedelta(seconds=60)
# Asked by the page on its own (Administration's counts every minute, v0.4.1; the presence
# check-in, v0.4.3): they are not activity, so a tab left open does not keep its session from
# reaching its idle limit.
BACKGROUND_PATHS = frozenset({"/api/v1/admin/counts", "/api/v1/presence"})
# Since v0.5.1 a read the page makes on its own, on a timer or after the chat's socket told it
# something (the chat bar's friends and conversations, the Friends page's refresh), carries this
# header, and is not activity either. Only a GET may: a change is always the person's doing.
BACKGROUND_HEADER = "x-background"

ALL_PERMISSIONS: frozenset[str] = frozenset(get_args(Permission))
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "player": frozenset({"profile.edit", "games.play", "decks.edit"}),
    # Since v0.9.4 moderators approve and deny new accounts too (the owner, 2026-11-10).
    "moderator": frozenset({"moderation.read", "admin.users.read", "admin.users.approve"}),
    "administrator": frozenset(
        {
            "moderation.read",
            "content.edit",
            "admin.users.read",
            "admin.users.approve",
            "admin.users.manage",
            "admin.roles.manage",
            "admin.audit.read",
            "catalog.manage",
            # Since v0.8.8 an administrator plays as any player does, from a library of its own:
            # only SysOp builds from the whole catalog (library.unlimited).
            # Leng's card shop: prices, sale and the booster data job (v0.4.0).
            "shop.manage",
            # Reading the players' problem reports and setting their status (v0.4.1).
            "reports.manage",
            # Every player's real presence, appearing offline or not (v0.4.3).
            "players.presence",
            # Tivit's Auction House's log of sales and live auctions (v0.6.0); cancelling one
            # is SysOp's (economy.manage).
            "auctions.manage",
            # Passive bots in their own game against bots, for testing (v0.8.7; SysOp's since
            # v0.8.6).
            "games.passive_bots",
            # Since v0.8.9 an administrator sees the app as SysOp does, but for the system-level
            # powers (the owner, 2026-11-06): concealed information in a game they do not play
            # against another person (api/games.py concealed_for), every chat, any player's
            # history, the testing grants and wins, and giving tokens and packs.
            "games.view_concealed",
            "chat.read_all",
            "players.history",
            "progress.manage",
            "economy.grant",
        }
    ),
}
# Held by SysOp alone and grantable to no role, the system-level powers: making or removing
# administrators, putting any card in the engine's database into its own library or a deck list,
# uploading the Godlike tier's custom cards, setting the economy's limits and cancelling auctions
# (economy.manage), and resetting an account to a new one's state (v0.4.5). Until v0.8.9 SysOp
# alone also saw concealed information in games, set wins, gave tokens and packs, read any chat
# and any player's history; administrators now do too.
SYSOP_ONLY = ALL_PERMISSIONS - frozenset().union(*ROLE_PERMISSIONS.values())


def utcnow() -> datetime:
    return datetime.now(UTC)


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
        names: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.headers = status, code, message, headers
        self.names = names


def not_found() -> ApiError:
    """Identical to the router's own 404, so a hidden resource looks like a missing one."""
    return ApiError(404, "http_404", "Not Found")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def settings_of(request: HTTPConnection) -> Settings:
    return cast(Settings, request.app.state.settings)


def get_db(request: Request) -> Iterator[Session]:
    with Session(request.app.state.database, expire_on_commit=False) as session:
        yield session


Db = Annotated[Session, Depends(get_db)]


def source_of(request: HTTPConnection) -> str | None:
    address = client_address(request, settings_of(request).trusted_proxy_list)
    return str(address) if address else None


def from_sysop_network(request: HTTPConnection) -> bool:
    settings = settings_of(request)
    address = client_address(request, settings.trusted_proxy_list)
    return within(address, settings.sysop_network_list)


def audit(
    db: Session,
    request: HTTPConnection,
    action: str,
    *,
    actor_id: UUID | None = None,
    target_user_id: UUID | None = None,
    details: dict[str, object] | None = None,
) -> None:
    db.add(
        AuditEvent(
            occurred_at=utcnow(),
            actor_id=actor_id,
            action=action,
            target_user_id=target_user_id,
            source_address=source_of(request),
            request_id=getattr(request.state, "request_id", None),
            details=details or {},
        )
    )


def roles_of(db: Session, user: User) -> list[str]:
    if user.kind == "sysop":
        return ["sysop"]
    if user.status != "active":
        return []
    granted = db.scalars(select(RoleGrant.role).where(RoleGrant.user_id == user.id)).all()
    order = list(ROLE_PERMISSIONS)
    return sorted({"player", *granted}, key=order.index)


def permissions_for(user: User, roles: list[str]) -> frozenset[str]:
    if user.kind == "sysop":
        return ALL_PERMISSIONS
    return frozenset().union(*(ROLE_PERMISSIONS[role] for role in roles))


@dataclass
class Principal:
    user: User
    session: UserSession
    roles: list[str]
    permissions: frozenset[str]

    def can(self, permission: str) -> bool:
        return permission in self.permissions


def _lifetimes(settings: Settings, kind: str) -> tuple[timedelta, timedelta]:
    if kind == "sysop":
        return (
            timedelta(minutes=settings.sysop_idle_minutes),
            timedelta(minutes=settings.sysop_absolute_minutes),
        )
    return (
        timedelta(minutes=settings.player_idle_minutes),
        timedelta(minutes=settings.player_absolute_minutes),
    )


def issue_session(
    db: Session,
    request: Request,
    user: User,
    kind: str,
    *,
    authenticated_at: datetime | None = None,
    absolute_expires_at: datetime | None = None,
    csrf_token: str | None = None,
) -> tuple[UserSession, str]:
    """A new session and its token. Rotation passes the old session's sign-in time, absolute
    expiry and CSRF token, so only the identifier changes."""
    now = utcnow()
    idle, absolute = _lifetimes(settings_of(request), kind)
    token = secrets.token_urlsafe(32)
    expires = absolute_expires_at or now + absolute
    session = UserSession(
        token_hash=hash_token(token),
        user_id=user.id,
        kind=kind,
        csrf_token=csrf_token or secrets.token_urlsafe(32),
        privilege_version=user.privilege_version,
        created_at=now,
        authenticated_at=authenticated_at or now,
        last_seen_at=now,
        idle_expires_at=min(now + idle, expires),
        absolute_expires_at=expires,
        source_address=source_of(request),
        user_agent=(request.headers.get("user-agent") or "")[:256] or None,
    )
    db.add(session)
    return session, token


def session_cookie_name(settings: Settings) -> str:
    """The session cookie's name under these settings (see SESSION_COOKIE)."""
    return SESSION_COOKIE if settings.cookie_secure else INSECURE_SESSION_COOKIE


def session_token(conn: HTTPConnection) -> str | None:
    """The session token the browser presents, from the session cookie alone: never from a
    cookie of the old name or path."""
    return conn.cookies.get(session_cookie_name(settings_of(conn)))


def expire_old_cookie(response: Response, request: Request) -> None:
    """Expires the session cookie of before v0.8.5 (cd_session at path /api)."""
    response.delete_cookie(
        OLD_SESSION_COOKIE,
        path=OLD_SESSION_PATH,
        secure=settings_of(request).cookie_secure,
        httponly=True,
        samesite="lax",
    )


def set_session_cookie(
    response: Response,
    request: Request,
    token: str,
    session: UserSession,
    *,
    expire_old: bool = True,
) -> None:
    """The session cookie, and on a sign-in (expire_old) the old one expired."""
    settings = settings_of(request)
    seconds = int((session.absolute_expires_at - utcnow()).total_seconds())
    response.set_cookie(
        session_cookie_name(settings),
        token,
        max_age=max(seconds, 0),
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="lax",
    )
    if expire_old:
        expire_old_cookie(response, request)


def clear_session_cookie(response: Response, request: Request, *, expire_old: bool = True) -> None:
    response.delete_cookie(
        session_cookie_name(settings_of(request)),
        path="/",
        secure=settings_of(request).cookie_secure,
        httponly=True,
        samesite="lax",
    )
    if expire_old:
        expire_old_cookie(response, request)


def clearing_headers(request: Request) -> dict[str, str]:
    response = Response()
    clear_session_cookie(response, request, expire_old=False)
    return {"set-cookie": response.headers["set-cookie"]}


def add_rotated_cookie(request: Request, response: Response) -> None:
    """Puts a session cookie rotated while signing the request in on its response, whatever made
    that response: a model, an error or a route's own Response. A response that sets or clears
    the session cookie itself (a sign-out, a new sign-in) keeps its own."""
    cookie: str | None = getattr(request.state, "rotated_cookie", None)
    if cookie is None:
        return
    own = f"{session_cookie_name(settings_of(request))}="
    if any(value.startswith(own) for value in response.headers.getlist("set-cookie")):
        return
    response.headers.append("set-cookie", cookie)


def revoke_sessions(
    db: Session, user_id: UUID, reason: str, *, except_id: UUID | None = None
) -> int:
    statement = (
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoked_reason=reason)
    )
    if except_id is not None:
        statement = statement.where(UserSession.id != except_id)
    return db.execute(statement).rowcount  # type: ignore[attr-defined, no-any-return]


def successor_of(db: Session, rotated: UserSession) -> UserSession | None:
    """The live session a rotated one was swapped for, during ROTATION_GRACE. Rotation copies the
    CSRF token, which sessions never otherwise share, so it links the two. Once the successor
    ends (sign-out, sign-out everywhere, a password change), the old token ends with it."""
    if rotated.revoked_at is None or utcnow() - rotated.revoked_at > ROTATION_GRACE:
        return None
    return db.scalar(
        select(UserSession)
        .where(
            UserSession.user_id == rotated.user_id,
            UserSession.csrf_token == rotated.csrf_token,
            UserSession.revoked_at.is_(None),
        )
        .order_by(UserSession.created_at.desc())
        .limit(1)
    )


def live_session(conn: HTTPConnection, db: Session) -> tuple[UserSession, User] | None:
    """The connection's session and account, or None. Expired, revoked and off-network SysOp
    sessions count as signed out, as do sessions of disabled and deleted accounts (a deletion
    removes them all; one in flight meanwhile still counts for nothing). A token rotated moments
    ago stands for its successor (see successor_of), and marks the connection via_grace."""
    token = session_token(conn)
    if not token:
        return None
    now = utcnow()
    session = db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(token)))
    if session is not None and session.revoked_reason == "rotated":
        session = successor_of(db, session)
        if session is None:
            # No clearing cookie: the browser may already hold the successor's, and a late
            # response with the old one would erase it.
            return None
        conn.state.via_grace = True
    user = db.get(User, session.user_id) if session else None
    if (
        session is None
        or user is None
        or session.revoked_at is not None
        or session.idle_expires_at <= now
        or session.absolute_expires_at <= now
        or user.status in ("disabled", "deleted")
        or (session.kind == "sysop" and not from_sysop_network(conn))
    ):
        conn.state.stale_session = True
        return None
    return session, user


def optional_principal(request: Request, db: Db) -> Principal | None:
    """The signed-in account, or None (see live_session). A session older than its account's last
    privilege change is rotated. Its new cookie waits on request.state for the correlation
    middleware, which adds it to whatever response the request ends with (add_rotated_cookie)."""
    found = live_session(request, db)
    if found is None:
        db.commit()
        return None
    session, user = found
    now = utcnow()
    # An old token in its grace is served as the session it stands for but never rotates it, or
    # whoever holds a stale token could take a fresh one. Only the successor's own cookie does.
    due = session.privilege_version != user.privilege_version
    if due and not getattr(request.state, "via_grace", False):
        # Only a session still live is rotated: a sign-out everywhere (or any revocation) that
        # committed since the session was read wins, and the request counts as signed out.
        ended = db.execute(
            update(UserSession)
            .where(UserSession.id == session.id, UserSession.revoked_at.is_(None))
            .values(revoked_at=now, revoked_reason="rotated")
            .execution_options(synchronize_session=False)
        )
        if ended.rowcount != 1:  # type: ignore[attr-defined]
            db.rollback()
            request.state.stale_session = True
            return None
        session, token = issue_session(
            db,
            request,
            user,
            session.kind,
            authenticated_at=session.authenticated_at,
            absolute_expires_at=session.absolute_expires_at,
            csrf_token=session.csrf_token,
        )
        db.commit()
        cookie = Response()
        set_session_cookie(cookie, request, token, session, expire_old=False)
        request.state.rotated_cookie = cookie.headers["set-cookie"]
    elif not asked_on_its_own(request):
        keep_alive(request, db, session, user)
    roles = roles_of(db, user)
    # End the read transaction: the pooled connection goes back now, not when the request ends,
    # so no route holds one while it awaits a lock, the engine or Scryfall. Nothing expires on
    # commit (get_db), so the principal's rows stay loaded and a route's changes still flush.
    db.commit()
    return Principal(user, session, roles, permissions_for(user, roles))


def asked_on_its_own(request: Request) -> bool:
    """Whether the page asked without the person: a background path, or a GET marked with
    BACKGROUND_HEADER. Neither extends the session's idle limit."""
    if request.url.path in BACKGROUND_PATHS:
        return True
    return request.method == "GET" and request.headers.get(BACKGROUND_HEADER) == "1"


def keep_alive(conn: HTTPConnection, db: Session, session: UserSession, user: User) -> None:
    """Activity extends the session's idle limit, at most once a minute."""
    now = utcnow()
    if now - session.last_seen_at >= TOUCH_INTERVAL:
        idle, _ = _lifetimes(settings_of(conn), session.kind)
        session.last_seen_at = now
        session.idle_expires_at = min(now + idle, session.absolute_expires_at)
        user.last_seen_at = now
        db.commit()


OptionalPrincipal = Annotated[Principal | None, Depends(optional_principal)]


def require_principal(request: Request, principal: OptionalPrincipal) -> Principal:
    if principal is None:
        headers = (
            clearing_headers(request) if getattr(request.state, "stale_session", False) else None
        )
        raise ApiError(401, "authentication_required", "Sign in to continue.", headers)
    if request.method not in SAFE_METHODS:
        sent = request.headers.get("x-csrf-token", "")
        if not hmac.compare_digest(sent.encode(), principal.session.csrf_token.encode()):
            raise ApiError(403, "csrf_failed", "The request is missing its CSRF token.")
    return principal


SignedIn = Annotated[Principal, Depends(require_principal)]


def require_active(principal: SignedIn) -> Principal:
    if principal.user.status == "pending":
        raise ApiError(403, "account_pending", "Your account is waiting for approval.")
    if principal.user.status != "active":
        raise ApiError(403, "account_denied", "Your account was not approved.")
    return principal


Active = Annotated[Principal, Depends(require_active)]


def require_permission(permission: Permission) -> Callable[[Principal], Principal]:
    def check(principal: Active) -> Principal:
        if not principal.can(permission):
            raise ApiError(403, "forbidden", "Your account does not have permission for this.")
        return principal

    return check


def refuse_deleted(user: User) -> None:
    """A deleted account (v0.4.1) stays as its deletion left it: nothing changes it afterwards."""
    if user.status == "deleted":
        raise ApiError(409, "account_deleted", "This account was deleted; it cannot be changed.")


def require_recent_sign_in(request: Request, principal: Principal) -> None:
    window = timedelta(minutes=settings_of(request).reauth_minutes)
    if utcnow() - principal.session.authenticated_at > window:
        raise ApiError(401, "reauthentication_required", "Sign in again to make this change.")


def email_of(db: Session, user: User) -> str | None:
    return verified_email_of(db, user)[0]


def verified_email_of(db: Session, user: User) -> tuple[str | None, bool]:
    """The account's email, from its latest Google sign-in, and whether Google verified it."""
    found = db.execute(
        select(ExternalIdentity.email, ExternalIdentity.email_verified)
        .where(ExternalIdentity.user_id == user.id)
        .order_by(ExternalIdentity.last_login_at.desc())
        .limit(1)
    ).first()
    if found is None or found.email is None:
        return None, False
    return found.email, bool(found.email_verified)


def me_of(db: Session, principal: Principal) -> Me:
    user, session = principal.user, principal.session
    return Me(
        id=user.id,
        kind=user.kind,  # type: ignore[arg-type]
        status=user.status,  # type: ignore[arg-type]
        handle=user.handle,
        display_name=user.display_name,
        avatar=user.avatar,  # type: ignore[arg-type]
        locale=user.locale,
        onboarding=user.onboarding,  # type: ignore[arg-type]
        alliance=user.alliance,
        tutorial=Tutorial(
            path=user.tutorial_path,  # type: ignore[arg-type]
            stage=user.tutorial,  # type: ignore[arg-type]
            skipped=user.tutorial_skipped,
        ),
        email=None if user.kind == "sysop" else email_of(db, user),
        roles=cast(list[Role], principal.roles),
        permissions=cast(list[Permission], sorted(principal.permissions)),
        preferences=Preferences.model_validate(user.preferences or {}),
        session=SessionInfo(
            id=session.id,
            kind=session.kind,  # type: ignore[arg-type]
            authenticated_at=session.authenticated_at,
            idle_expires_at=session.idle_expires_at,
            absolute_expires_at=session.absolute_expires_at,
        ),
        csrf_token=session.csrf_token,
    )
