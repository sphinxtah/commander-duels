"""Administration: accounts, roles and the audit trail (AUTH06, SEC05).

Administrators approve, deny, disable, restore and delete accounts and grant the moderator and
content-editor roles. Only SysOp makes or removes administrators, and resets an account to a new
one's state (v0.4.5, api/resets.py). SysOp itself never appears here: it cannot be listed,
changed, demoted or disabled through the interface, and other viewers see its audit events as the
site administrator's. A deleted account (v0.4.1, api/accounts.py) is listed only when asked for,
as "Deleted player", and nothing changes it afterwards.
"""

import base64
import binascii
from datetime import datetime
from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import Select, and_, delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.accounts import DELETED_NAME, delete_account
from api.auth import ERRORS
from api.economy import balance_of
from api.games import hub_of
from api.identity import (
    ROLE_PERMISSIONS,
    ApiError,
    Db,
    Principal,
    audit,
    email_of,
    not_found,
    refuse_deleted,
    require_permission,
    require_recent_sign_in,
    revoke_sessions,
    roles_of,
    utcnow,
)
from api.models import AuditEvent, ExternalIdentity, RoleGrant, User
from api.progression import admin_progress
from api.resets import reset_account
from api.roster import roster_of
from api.schemas import (
    AccountDeletion,
    AccountReset,
    AccountStatus,
    AdminUser,
    AuditActor,
    AuditEntry,
    AuditPage,
    GrantableRole,
    Role,
    StatusChange,
    StoredText,
    UserPage,
)

router = APIRouter(prefix="/api/v1/admin", responses=ERRORS)
CanReadUsers = Annotated[Principal, Depends(require_permission("admin.users.read"))]
CanManageUsers = Annotated[Principal, Depends(require_permission("admin.users.manage"))]
CanManageRoles = Annotated[Principal, Depends(require_permission("admin.roles.manage"))]
CanReadAudit = Annotated[Principal, Depends(require_permission("admin.audit.read"))]
CanResetUsers = Annotated[Principal, Depends(require_permission("admin.users.reset"))]
SITE_ADMINISTRATOR = "Site administrator"


def encode_cursor(moment: datetime, row_id: UUID) -> str:
    return base64.urlsafe_b64encode(f"{moment.isoformat()}|{row_id}".encode()).decode()


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    try:
        moment, row_id = base64.urlsafe_b64decode(cursor.encode()).decode().split("|")
        return datetime.fromisoformat(moment), UUID(row_id)
    except (ValueError, binascii.Error, UnicodeDecodeError) as error:
        raise ApiError(422, "invalid_cursor", "The page cursor is not valid.") from error


def granted_roles(db: Session, user: User) -> list[str]:
    """The account's role grants, whatever its status. roles_of counts them only while the account
    is active, but they stay through a disable and apply again on restore."""
    granted = db.scalars(select(RoleGrant.role).where(RoleGrant.user_id == user.id)).all()
    order = list(ROLE_PERMISSIONS)
    return sorted(granted, key=order.index)


def admin_user(db: Session, user: User, viewer: Principal) -> AdminUser:
    wins, tier = admin_progress(db, user)
    return AdminUser(
        id=user.id,
        handle=user.handle,
        display_name=user.display_name,
        # Email identifies the accounts administrators approve; moderators approve none.
        email=email_of(db, user) if viewer.can("admin.users.manage") else None,
        status=cast(AccountStatus, user.status),
        # An inactive account shows the grants it would get back, so an administrator's row
        # stays locked to those who may not change administrators.
        roles=cast(
            list[Role], roles_of(db, user) if user.status == "active" else granted_roles(db, user)
        ),
        created_at=user.created_at,
        last_seen_at=user.last_seen_at,
        wins=wins,
        tier=tier,
        alliance=user.alliance,
        tokens=balance_of(db, user.id),
        deleted_at=user.deleted_at,
    )


@router.get("/users", response_model=UserPage)
def list_users(
    principal: CanReadUsers,
    db: Db,
    status: AccountStatus | None = None,
    q: Annotated[StoredText | None, Query(max_length=64)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
) -> UserPage:
    query: Select[User] = select(User).where(User.kind == "player")
    # Deleted accounts only when asked for: there is nothing left to do with them.
    query = query.where(User.status == status if status else User.status != "deleted")
    if q and (term := q.strip()):
        # The text is matched as written: autoescape makes % _ and \ literal, and names and
        # email compare through the database's own lower(), as they are stored.
        matches = [
            User.normalized_handle.contains(term.casefold(), autoescape=True),
            User.display_name.icontains(term, autoescape=True),
        ]
        if principal.can("admin.users.manage"):
            matches.append(
                User.id.in_(
                    select(ExternalIdentity.user_id).where(
                        ExternalIdentity.email.icontains(term, autoescape=True)
                    )
                )
            )
        query = query.where(or_(*matches))
    if cursor:
        moment, row_id = decode_cursor(cursor)
        query = query.where(
            or_(User.created_at < moment, and_(User.created_at == moment, User.id < row_id))
        )
    users = db.scalars(query.order_by(User.created_at.desc(), User.id.desc()).limit(limit + 1))
    page = list(users)
    more = len(page) > limit
    page = page[:limit]
    return UserPage(
        items=[admin_user(db, user, principal) for user in page],
        next_cursor=encode_cursor(page[-1].created_at, page[-1].id) if more and page else None,
    )


def managed_user(db: Session, principal: Principal, user_id: UUID) -> User:
    """The target of an account change: never SysOp, never yourself, never a deleted account."""
    user = db.get(User, user_id)
    if user is None or user.kind != "player":
        raise not_found()
    if user.id == principal.user.id:
        raise ApiError(409, "self_change", "You cannot change your own account here.")
    refuse_deleted(user)
    # The grant, not the account's current roles: a disabled administrator restored by anyone
    # but SysOp would be an administrator again.
    if "administrator" in granted_roles(db, user) and not principal.can(
        "admin.roles.administrator"
    ):
        raise ApiError(403, "forbidden", "Only the site administrator can change administrators.")
    return user


@router.post("/users/{user_id}/status", response_model=AdminUser)
def change_status(
    user_id: UUID, body: StatusChange, request: Request, principal: CanManageUsers, db: Db
) -> AdminUser:
    require_recent_sign_in(request, principal)
    user = managed_user(db, principal, user_id)
    before = user.status
    if before != body.status:
        if body.status == "denied" and before != "pending":
            raise ApiError(409, "invalid_transition", "Only a pending account can be denied.")
        user.status = body.status
        user.privilege_version += 1
        user.updated_at = utcnow()
        if body.status == "disabled":
            revoke_sessions(db, user.id, "disabled")
        audit(
            db,
            request,
            "admin.user_status_changed",
            actor_id=principal.user.id,
            target_user_id=user.id,
            details={"from": before, "to": body.status, "reason": body.reason},
        )
        db.commit()
    return admin_user(db, user, principal)


def role_change(request: Request, principal: Principal, role: str) -> None:
    require_recent_sign_in(request, principal)
    if role == "administrator" and not principal.can("admin.roles.administrator"):
        raise ApiError(403, "forbidden", "Only the site administrator can change administrators.")


@router.put("/users/{user_id}/roles/{role}", response_model=AdminUser)
def grant_role(
    user_id: UUID, role: GrantableRole, request: Request, principal: CanManageRoles, db: Db
) -> AdminUser:
    role_change(request, principal, role)
    user = managed_user(db, principal, user_id)
    if user.status != "active":
        raise ApiError(409, "not_active", "Roles can be granted to active accounts only.")
    if role not in roles_of(db, user):
        db.add(
            RoleGrant(user_id=user.id, role=role, granted_by=principal.user.id, granted_at=utcnow())
        )
        user.privilege_version += 1
        audit(
            db,
            request,
            "admin.role_granted",
            actor_id=principal.user.id,
            target_user_id=user.id,
            details={"role": role},
        )
        try:
            db.commit()
        except IntegrityError:
            # A simultaneous grant of the same role got there first: it is granted either way.
            db.rollback()
    return admin_user(db, user, principal)


@router.delete("/users/{user_id}/roles/{role}", response_model=AdminUser)
def revoke_role(
    user_id: UUID, role: GrantableRole, request: Request, principal: CanManageRoles, db: Db
) -> AdminUser:
    role_change(request, principal, role)
    user = managed_user(db, principal, user_id)
    removed = db.execute(
        delete(RoleGrant).where(RoleGrant.user_id == user.id, RoleGrant.role == role)
    ).rowcount  # type: ignore[attr-defined]
    if removed:
        user.privilege_version += 1
        audit(
            db,
            request,
            "admin.role_revoked",
            actor_id=principal.user.id,
            target_user_id=user.id,
            details={"role": role},
        )
        db.commit()
    return admin_user(db, user, principal)


@router.post("/users/{user_id}/sign-out", response_model=AdminUser)
def sign_out_user(user_id: UUID, request: Request, principal: CanManageUsers, db: Db) -> AdminUser:
    user = managed_user(db, principal, user_id)
    count = revoke_sessions(db, user.id, "admin_sign_out")
    audit(
        db,
        request,
        "admin.sessions_revoked",
        actor_id=principal.user.id,
        target_user_id=user.id,
        details={"sessions": count},
    )
    db.commit()
    return admin_user(db, user, principal)


@router.post("/users/{user_id}/delete", response_model=AdminUser)
async def delete_user(
    user_id: UUID, body: AccountDeletion, request: Request, principal: CanManageUsers, db: Db
) -> AdminUser:
    """Deletes an account for good (v0.4.1, api/accounts.py): its sign-in, profile, sessions,
    roles and decks go; its game results, wins and tokens stay, as "Deleted player". Refused 409
    while it plays a game. The account's game lock is held meanwhile, so no game of it starts."""
    require_recent_sign_in(request, principal)
    user = await run_in_threadpool(managed_user, db, principal, user_id)
    async with hub_of(request).locks[user.id]:
        return await run_in_threadpool(deleted_by, db, request, principal, user, body.reason)


def deleted_by(
    db: Session, request: Request, principal: Principal, user: User, reason: str
) -> AdminUser:
    removed = delete_account(db, user, utcnow(), roster_of(request))
    audit(
        db,
        request,
        "admin.user_deleted",
        actor_id=principal.user.id,
        target_user_id=user.id,
        details={"from": removed.status, "reason": reason},
    )
    db.commit()
    return admin_user(db, user, principal)


@router.post("/users/{user_id}/reset", response_model=AccountReset)
async def reset_user(
    user_id: UUID, request: Request, principal: CanResetUsers, db: Db
) -> AccountReset:
    """SysOp resets an account to a new one's state (v0.4.5, api/resets.py), so the setup wizard
    runs again: its handle, alliance, library and packs are cleared, its decks go to the trash,
    and its wins and tokens go back to 0 and 1,000; its friends, messages and reports stay.
    Refused 409 while it plays a game or sits at an open table. The account's game lock is held
    meanwhile, as for a deletion, so no game of it starts."""
    require_recent_sign_in(request, principal)
    user = await run_in_threadpool(managed_user, db, principal, user_id)
    async with hub_of(request).locks[user.id]:
        return await run_in_threadpool(reset_by, db, request, principal, user)


def reset_by(db: Session, request: Request, principal: Principal, user: User) -> AccountReset:
    cleared = reset_account(db, user, principal.user, roster_of(request))
    audit(
        db,
        request,
        "admin.user_reset",
        actor_id=principal.user.id,
        target_user_id=user.id,
        details=cleared.details(),
    )
    db.commit()
    return AccountReset(
        account=admin_user(db, user, principal),
        decks=cleared.decks,
        cards=cleared.cards,
        packs=cleared.packs,
        wins=cleared.wins,
        tokens=cleared.tokens,
    )


def actor_label(user: User | None, viewer: Principal) -> AuditActor | None:
    if user is None:
        return None
    if user.kind == "sysop":
        label = "SysOp" if viewer.user.kind == "sysop" else SITE_ADMINISTRATOR
        return AuditActor(id=user.id if viewer.user.kind == "sysop" else None, label=label)
    if user.status == "deleted":
        # Told apart by the start of the ID, which names nobody; no player's label has this form.
        return AuditActor(id=user.id, label=f"{DELETED_NAME} ({str(user.id)[:8]})")
    # A display name is free text: alone it could read "Site administrator" or another player's
    # handle. A handle has no spaces or brackets, so this label can be neither.
    label = user.handle or f"{user.display_name} (no handle, {str(user.id)[:8]})"
    return AuditActor(id=user.id, label=label)


def flat(details: dict[str, object]) -> dict[str, str | int | bool | None | list[str]]:
    result: dict[str, str | int | bool | None | list[str]] = {}
    for key, value in details.items():
        if value is None or isinstance(value, (str, int, bool)):
            result[key] = value
        elif isinstance(value, list):
            result[key] = [str(item) for item in value]
        else:
            result[key] = str(value)
    return result


@router.get("/audit", response_model=AuditPage)
def audit_log(
    principal: CanReadAudit,
    db: Db,
    action: Annotated[StoredText | None, Query(max_length=64)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    cursor: str | None = None,
) -> AuditPage:
    query = select(AuditEvent)
    sysop_viewer = principal.user.kind == "sysop"
    if not sysop_viewer:
        # SysOp's own sign-in trail is SysOp's alone; it would name the account to others.
        query = query.where(
            AuditEvent.action.not_like("auth.sysop%"), AuditEvent.action.not_like("account.sysop%")
        )
    if action:
        # Actions are lower-case names; PostgreSQL's LIKE, unlike SQLite's, minds case.
        query = query.where(AuditEvent.action.startswith(action.lower(), autoescape=True))
    if cursor:
        moment, row_id = decode_cursor(cursor)
        query = query.where(
            or_(
                AuditEvent.occurred_at < moment,
                and_(AuditEvent.occurred_at == moment, AuditEvent.id < row_id),
            )
        )
    events = list(
        db.scalars(
            query.order_by(AuditEvent.occurred_at.desc(), AuditEvent.id.desc()).limit(limit + 1)
        )
    )
    more = len(events) > limit
    events = events[:limit]
    ids = {event.actor_id for event in events} | {event.target_user_id for event in events}
    users = {user.id: user for user in db.scalars(select(User).where(User.id.in_(ids - {None})))}
    items = []
    for event in events:
        actor = users.get(event.actor_id) if event.actor_id else None
        hidden = actor is not None and actor.kind == "sysop" and not sysop_viewer
        items.append(
            AuditEntry(
                id=event.id,
                occurred_at=event.occurred_at,
                action=event.action,
                actor=actor_label(actor, principal),
                target=actor_label(users.get(event.target_user_id), principal)
                if event.target_user_id
                else None,
                # SysOp's addresses describe the production network; only SysOp sees them.
                source_address=None if hidden else event.source_address,
                details=flat(event.details or {}),
            )
        )
    last = events[-1] if events else None
    return AuditPage(
        items=items,
        next_cursor=encode_cursor(last.occurred_at, last.id) if more and last else None,
    )
