"""Sign-in, sign-out, the signed-in profile and SysOp's entrance.

Google sign-in (AUTH01-AUTH05) uses Google Identity Services' ID-token flow with a JavaScript
callback. The page asks for a challenge first: the server keeps the nonce, the browser keeps the
secret that hashes to it in an HttpOnly cookie, and Google signs the nonce into the ID token. A
sign-in must present the token and the matching cookie, and consumes the challenge, so a stolen
or replayed token cannot open a session and a cross-site page cannot sign a visitor in.
"""

import hashlib
import re
import secrets
import threading
from datetime import datetime, timedelta
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.google import ISSUER, GoogleVerifier, InvalidToken, ProviderUnavailable
from api.identity import (
    GOOGLE_COOKIE,
    SESSION_COOKIE,
    Active,
    ApiError,
    Db,
    Principal,
    SignedIn,
    audit,
    clear_session_cookie,
    from_sysop_network,
    hash_token,
    issue_session,
    me_of,
    not_found,
    permissions_for,
    revoke_sessions,
    roles_of,
    set_session_cookie,
    settings_of,
    source_of,
    utcnow,
)
from api.models import AuditEvent, ExternalIdentity, LoginChallenge, User, UserSession
from api.passwords import hash_password, needs_rehash, verify_password
from api.schemas import (
    Error,
    GoogleChallenge,
    GoogleCredential,
    Me,
    ProfileUpdate,
    SessionSummary,
    SysopLogin,
    SysopPasswordChange,
)

router = APIRouter(prefix="/api/v1")
CHALLENGE_LIFETIME = timedelta(minutes=10)
# Refused Google sign-ins one address may leave in the audit trail per window. Counted per exact
# address, which suits the IPv4-only site; if it ever serves IPv6, count by /64, or one client
# could rotate through its own prefix.
GOOGLE_FAILURE_LIMIT = 10
GOOGLE_FAILURE_WINDOW = timedelta(minutes=15)
SYSOP_FAILURE_LIMIT = 5
SYSOP_FAILURE_WINDOW = timedelta(minutes=15)
# SysOp's password checks run one at a time, so a burst of guesses cannot all pass the lockout
# check before the first failure is recorded. The API is one process with one SysOp; this also
# bounds the 64 MiB Argon2 checks running at once.
SYSOP_ATTEMPTS = threading.Lock()
HANDLE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$")
RESERVED_HANDLES = {
    "admin",
    "administrator",
    "anonymous",
    "bot",
    "commander",
    "commanderduels",
    "computer",
    "google",
    "guest",
    "mod",
    "moderator",
    "null",
    "official",
    "root",
    "site-administrator",
    "site_administrator",
    "siteadministrator",
    "spectator",
    "staff",
    "support",
    "sysop",
    "system",
    "undefined",
}
ERRORS: dict[int | str, dict[str, object]] = {
    status: {"model": Error} for status in (400, 401, 403, 404, 409, 429, 503)
}
# With 422 for input the contract does not allow. FastAPI would describe it with Python's phrase
# for the status, which Python 3.13 renamed; naming it keeps the contract the same on any Python.
INPUT_ERRORS: dict[int | str, dict[str, object]] = ERRORS | {
    422: {"model": Error, "description": "Unprocessable Entity"}
}


def google_verifier(request: Request) -> GoogleVerifier:
    verifier: GoogleVerifier | None = getattr(request.app.state, "google_verifier", None)
    if verifier is None:
        raise ApiError(503, "sign_in_unavailable", "Google sign-in is not configured.")
    return verifier


Verifier = Annotated[GoogleVerifier, Depends(google_verifier)]


@router.post("/auth/google/start", response_model=GoogleChallenge, responses=ERRORS)
def google_start(
    request: Request, response: Response, verifier: Verifier, db: Db
) -> GoogleChallenge:
    now = utcnow()
    secret = secrets.token_urlsafe(32)
    nonce = hashlib.sha256(secret.encode()).hexdigest()
    db.execute(delete(LoginChallenge).where(LoginChallenge.expires_at < now - timedelta(days=1)))
    db.add(LoginChallenge(nonce=nonce, created_at=now, expires_at=now + CHALLENGE_LIFETIME))
    db.commit()
    response.set_cookie(
        GOOGLE_COOKIE,
        secret,
        max_age=int(CHALLENGE_LIFETIME.total_seconds()),
        path="/api/v1/auth/google",
        secure=settings_of(request).cookie_secure,
        httponly=True,
        samesite="strict",
    )
    return GoogleChallenge(nonce=nonce, client_id=verifier.client_id)


def invalid_sign_in() -> ApiError:
    return ApiError(401, "invalid_sign_in", "Google sign-in could not be verified. Try again.")


def recent_google_failures(db: Session, address: str | None) -> int:
    """Refused Google sign-ins from this address in the window."""
    return (
        db.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(
                AuditEvent.action == "auth.google_login_failed",
                AuditEvent.source_address == address,
                AuditEvent.occurred_at > utcnow() - GOOGLE_FAILURE_WINDOW,
            )
        )
        or 0
    )


def refuse_google(db: Session, request: Request, reason: str) -> ApiError:
    """A refused sign-in, audited unless its address has failed too often lately: past the limit
    it is refused unrecorded, so nobody can fill the append-only trail."""
    if recent_google_failures(db, source_of(request)) >= GOOGLE_FAILURE_LIMIT:
        db.commit()  # the attempt still spends its challenge
        return ApiError(
            429,
            "too_many_attempts",
            "Too many failed sign-ins from this address. Wait 15 minutes, then try again.",
        )
    audit(db, request, "auth.google_login_failed", details={"reason": reason})
    db.commit()
    return invalid_sign_in()


@router.post("/auth/google", response_model=Me, responses=ERRORS)
def google_sign_in(
    body: GoogleCredential, request: Request, response: Response, verifier: Verifier, db: Db
) -> Me:
    secret = request.cookies.get(GOOGLE_COOKIE)
    if not secret:
        # Not audited: without a challenge this is not a sign-in attempt from our page.
        raise invalid_sign_in()
    claims: dict[str, Any] | None
    try:
        claims = verifier.verify(body.credential)
    except ProviderUnavailable as error:
        # The challenge is left unspent, for a retry.
        raise ApiError(
            503, "provider_unavailable", "Google is not responding. Try again shortly."
        ) from error
    except InvalidToken:
        claims = None
    nonce = hashlib.sha256(secret.encode()).hexdigest()
    now = utcnow()
    # Every attempt spends its challenge, so each audited failure costs the client a new one.
    consumed = db.execute(
        update(LoginChallenge)
        .where(
            LoginChallenge.nonce == nonce,
            LoginChallenge.consumed_at.is_(None),
            LoginChallenge.expires_at > now,
        )
        .values(consumed_at=now)
    ).rowcount  # type: ignore[attr-defined]
    genuine = claims is not None and claims.get("nonce") == nonce
    if consumed != 1:
        known = db.scalar(select(LoginChallenge.id).where(LoginChallenge.nonce == nonce))
        if known is None or not genuine:
            # Not audited either: a made-up cookie is no challenge, and a spent one buys no
            # further entries, so a bot cannot fill the trail.
            raise invalid_sign_in()
        # A token signed for this very challenge, after it was spent or expired: a replay, or a
        # sign-in left open too long.
        raise refuse_google(db, request, "challenge_used_or_expired")
    if claims is None:
        raise refuse_google(db, request, "invalid_token")
    if not genuine:
        raise refuse_google(db, request, "nonce_mismatch")

    subject = str(claims["sub"])
    identity = db.scalar(
        select(ExternalIdentity).where(
            ExternalIdentity.issuer == ISSUER, ExternalIdentity.subject == subject
        )
    )
    email = claims.get("email") if isinstance(claims.get("email"), str) else None
    created = identity is None
    if identity is None:
        user, identity = new_account(db, request, subject, claims, now)
    else:
        user = db.get_one(User, identity.user_id)
    # The subject is the identity; a changed email address only updates the private record.
    identity.email = email[:320] if email else None
    identity.email_verified = claims.get("email_verified") is True
    identity.last_login_at = now
    if user.status == "disabled":
        audit(
            db,
            request,
            "auth.google_login_refused",
            target_user_id=user.id,
            details={"reason": "account_disabled"},
        )
        db.commit()
        raise ApiError(403, "account_disabled", "This account is disabled.")
    end_presented_session(db, request, "replaced")
    session, token = issue_session(db, request, user, "google")
    if created:
        audit(
            db,
            request,
            "auth.google_signup",
            actor_id=user.id,
            target_user_id=user.id,
            details={"status": user.status},
        )
    audit(db, request, "auth.google_login", actor_id=user.id, target_user_id=user.id)
    db.commit()
    set_session_cookie(response, request, token, session)
    response.delete_cookie(GOOGLE_COOKIE, path="/api/v1/auth/google")
    roles = roles_of(db, user)
    return me_of(db, Principal(user, session, roles, permissions_for(user, roles)))


def new_account(
    db: Session, request: Request, subject: str, claims: dict[str, Any], now: datetime
) -> tuple[User, ExternalIdentity]:
    """A first sign-in's account. Two first sign-ins of one Google account can race; the one that
    finds the identity taken when it writes is asked to try again."""
    policy = settings_of(request).signup_policy
    user = User(
        display_name=(str(claims.get("name") or claims.get("given_name") or "Player"))[:64],
        status="active" if policy == "open" else "pending",
        created_at=now,
    )
    db.add(user)
    db.flush()
    identity = ExternalIdentity(user_id=user.id, issuer=ISSUER, subject=subject, created_at=now)
    db.add(identity)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise ApiError(
            409, "sign_in_conflict", "This account is signing in elsewhere. Try again."
        ) from None
    # Every new account starts with the welcome grant (v0.4.0). Imported here: the economy's
    # routes use this module's error responses.
    from api.economy import welcome

    welcome(db, user)
    return user, identity


def end_presented_session(db: Session, request: Request, reason: str) -> None:
    """A sign-in always starts a new session; one the browser already holds ends (AUTH03)."""
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db.execute(
            update(UserSession)
            .where(UserSession.token_hash == hash_token(token), UserSession.revoked_at.is_(None))
            .values(revoked_at=utcnow(), revoked_reason=reason)
        )


@router.post("/auth/logout", status_code=204, responses=ERRORS)
def logout(request: Request, principal: SignedIn, db: Db) -> Response:
    principal.session.revoked_at, principal.session.revoked_reason = utcnow(), "logout"
    action = "auth.sysop_logout" if principal.user.kind == "sysop" else "auth.logout"
    audit(db, request, action, actor_id=principal.user.id, target_user_id=principal.user.id)
    db.commit()
    response = Response(status_code=204)
    clear_session_cookie(response, request)
    return response


@router.post("/auth/logout-all", status_code=204, responses=ERRORS)
def logout_all(request: Request, principal: SignedIn, db: Db) -> Response:
    count = revoke_sessions(db, principal.user.id, "logout_all")
    audit(
        db,
        request,
        "auth.logout_all",
        actor_id=principal.user.id,
        target_user_id=principal.user.id,
        details={"sessions": count},
    )
    db.commit()
    response = Response(status_code=204)
    clear_session_cookie(response, request)
    return response


@router.get("/me", response_model=Me, responses=ERRORS)
def me(principal: SignedIn, db: Db) -> Me:
    return me_of(db, principal)


def normalized_handle(value: str) -> str:
    if not HANDLE.fullmatch(value):
        raise ApiError(
            422,
            "invalid_handle",
            "Handles are 3-20 letters, digits, hyphens or underscores, starting with a letter "
            "or digit.",
        )
    normalized = value.casefold()
    if normalized in RESERVED_HANDLES:
        raise ApiError(409, "handle_unavailable", "That handle is not available.")
    return normalized


@router.patch("/me", response_model=Me, responses=INPUT_ERRORS)
def update_profile(body: ProfileUpdate, request: Request, principal: SignedIn, db: Db) -> Me:
    user = principal.user
    if user.status == "denied":
        raise ApiError(403, "account_denied", "Your account was not approved.")
    changes = body.model_dump(exclude_unset=True)
    if user.kind == "sysop" and "handle" in changes:
        raise ApiError(409, "handle_fixed", "SysOp's handle cannot change.")
    changed: list[str] = []
    if body.handle is not None and body.handle != user.handle:
        normalized = normalized_handle(body.handle)
        taken = db.scalar(
            select(User.id).where(User.normalized_handle == normalized, User.id != user.id)
        )
        if taken:
            raise ApiError(409, "handle_taken", "That handle is already taken.")
        user.handle, user.normalized_handle = body.handle, normalized
        # A player chooses two starter decks next (v0.3.1), unless they already have.
        if user.onboarding == "handle":
            user.onboarding = "starters" if user.starter_decks is None else "complete"
        changed.append("handle")
    if body.display_name is not None and body.display_name.strip() != user.display_name:
        user.display_name = body.display_name.strip() or user.display_name
        changed.append("display_name")
    for field in ("avatar", "locale"):
        value = getattr(body, field)
        if value is not None and value != getattr(user, field):
            setattr(user, field, value)
            changed.append(field)
    if body.preferences is not None:
        user.preferences = body.preferences.model_dump()
        changed.append("preferences")
    if changed:
        user.updated_at = utcnow()
        audit(
            db,
            request,
            "profile.updated",
            actor_id=user.id,
            target_user_id=user.id,
            details={"fields": changed},
        )
        try:
            db.commit()
        except IntegrityError:
            # Another account claimed the handle between the check above and this write.
            db.rollback()
            if "handle" not in changed:
                raise
            raise ApiError(409, "handle_taken", "That handle is already taken.") from None
    return me_of(db, principal)


def session_summary(session: UserSession, current: UUID) -> SessionSummary:
    return SessionSummary(
        id=session.id,
        kind=session.kind,  # type: ignore[arg-type]
        current=session.id == current,
        created_at=session.created_at,
        last_seen_at=session.last_seen_at,
        idle_expires_at=session.idle_expires_at,
        absolute_expires_at=session.absolute_expires_at,
        source_address=session.source_address,
        user_agent=session.user_agent,
    )


@router.get("/me/sessions", response_model=list[SessionSummary], responses=ERRORS)
def my_sessions(principal: SignedIn, db: Db) -> list[SessionSummary]:
    now = utcnow()
    sessions = db.scalars(
        select(UserSession)
        .where(
            UserSession.user_id == principal.user.id,
            UserSession.revoked_at.is_(None),
            UserSession.idle_expires_at > now,
            UserSession.absolute_expires_at > now,
        )
        .order_by(UserSession.last_seen_at.desc())
    ).all()
    return [session_summary(session, principal.session.id) for session in sessions]


@router.delete("/me/sessions/{session_id}", status_code=204, responses=ERRORS)
def end_session(session_id: UUID, request: Request, principal: SignedIn, db: Db) -> Response:
    session = db.get(UserSession, session_id)
    if session is None or session.user_id != principal.user.id or session.revoked_at:
        raise not_found()
    session.revoked_at, session.revoked_reason = utcnow(), "revoked"
    audit(
        db,
        request,
        "auth.session_revoked",
        actor_id=principal.user.id,
        target_user_id=principal.user.id,
        details={"session": str(session.id)},
    )
    db.commit()
    response = Response(status_code=204)
    if session.id == principal.session.id:
        clear_session_cookie(response, request)
    return response


# SysOp, the local root account. Its entrance exists only for the SysOp networks; everywhere
# else it answers exactly like a path that does not exist.


def sysop_network_only(request: Request) -> None:
    if not from_sysop_network(request):
        raise not_found()


SysopNetwork = Depends(sysop_network_only)


@router.get(
    "/sysop/entrance", status_code=204, dependencies=[SysopNetwork], include_in_schema=False
)
def sysop_entrance() -> Response:
    return Response(status_code=204)


def recent_sysop_failures(db: Session, address: str | None) -> int:
    """Failed sign-ins from this address in the window, since its last success there (a sign-in
    or a password change) or the last password set from the server console, which lifts every
    address's lockout."""
    now = utcnow()
    last_success = (
        select(func.max(AuditEvent.occurred_at))
        .where(
            or_(
                and_(
                    AuditEvent.action.in_(("auth.sysop_login", "account.sysop_password_changed")),
                    AuditEvent.source_address == address,
                ),
                AuditEvent.action == "account.sysop_password_set",
            )
        )
        .scalar_subquery()
    )
    return (
        db.scalar(
            select(func.count())
            .select_from(AuditEvent)
            .where(
                AuditEvent.action == "auth.sysop_login_failed",
                AuditEvent.source_address == address,
                AuditEvent.occurred_at > now - SYSOP_FAILURE_WINDOW,
                or_(last_success.is_(None), AuditEvent.occurred_at > last_success),
            )
        )
        or 0
    )


def refuse_locked_out(db: Session, request: Request) -> None:
    """Call holding SYSOP_ATTEMPTS, and record a failure before releasing it."""
    if recent_sysop_failures(db, source_of(request)) >= SYSOP_FAILURE_LIMIT:
        raise ApiError(
            429,
            "too_many_attempts",
            "Too many failed sign-in attempts from this address. Wait 15 minutes, or set a new "
            "password from the server console.",
        )


@router.post(
    "/sysop/login",
    response_model=Me,
    dependencies=[SysopNetwork],
    responses=ERRORS,
    include_in_schema=False,
)
def sysop_login(body: SysopLogin, request: Request, response: Response, db: Db) -> Me:
    with SYSOP_ATTEMPTS:
        refuse_locked_out(db, request)
        sysop = db.scalar(select(User).where(User.kind == "sysop"))
        password_ok = verify_password(sysop.password_hash if sysop else None, body.password)
        if not (sysop and password_ok and body.username.strip().casefold() == "sysop"):
            audit(db, request, "auth.sysop_login_failed")
            db.commit()
            raise ApiError(401, "invalid_credentials", "Unable to sign in with those credentials.")
        if sysop.password_hash and needs_rehash(sysop.password_hash):
            sysop.password_hash = hash_password(body.password)
        end_presented_session(db, request, "replaced")
        session, token = issue_session(db, request, sysop, "sysop")
        audit(db, request, "auth.sysop_login", actor_id=sysop.id, target_user_id=sysop.id)
        db.commit()
    set_session_cookie(response, request, token, session)
    return me_of(db, Principal(sysop, session, ["sysop"], permissions_for(sysop, ["sysop"])))


@router.post(
    "/sysop/password",
    response_model=Me,
    dependencies=[SysopNetwork],
    responses=ERRORS,
    include_in_schema=False,
)
def sysop_password(
    body: SysopPasswordChange, request: Request, response: Response, principal: Active, db: Db
) -> Me:
    user = principal.user
    if user.kind != "sysop":
        raise not_found()
    with SYSOP_ATTEMPTS:
        # The current password is a guess like any other, under the same lockout: a session left
        # open is no way to try passwords without limit.
        refuse_locked_out(db, request)
        if not verify_password(user.password_hash, body.current_password):
            audit(db, request, "auth.sysop_login_failed", details={"step": "password_change"})
            db.commit()
            raise ApiError(401, "invalid_credentials", "The current password is not correct.")
        user.password_hash = hash_password(body.new_password)
        user.updated_at = utcnow()
        revoke_sessions(db, user.id, "password_changed")
        session, token = issue_session(db, request, user, "sysop")
        audit(
            db, request, "account.sysop_password_changed", actor_id=user.id, target_user_id=user.id
        )
        db.commit()
    set_session_cookie(response, request, token, session)
    return me_of(db, Principal(user, session, ["sysop"], permissions_for(user, ["sysop"])))
