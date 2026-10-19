"""Identity: profiles, sessions, role grants, audit events and Google sign-in challenges."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_identity"
down_revision = "0001_foundation"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TIMESTAMP = sa.DateTime(timezone=True)
SYSOP_ONLY = sa.text("kind = 'sysop'")


def upgrade() -> None:
    # Batch mode rebuilds the table on SQLite, which cannot alter a column in place.
    with op.batch_alter_table("users") as users:
        users.alter_column("normalized_handle", existing_type=sa.String(32), nullable=True)
        users.add_column(sa.Column("handle", sa.String(32)))
        users.add_column(
            sa.Column("display_name", sa.String(64), nullable=False, server_default="")
        )
        users.add_column(sa.Column("kind", sa.String(16), nullable=False, server_default="player"))
        users.add_column(
            sa.Column("status", sa.String(16), nullable=False, server_default="active")
        )
        users.add_column(
            sa.Column("onboarding", sa.String(16), nullable=False, server_default="handle")
        )
        users.add_column(sa.Column("avatar", sa.String(32), nullable=False, server_default="sigil"))
        users.add_column(sa.Column("locale", sa.String(16), nullable=False, server_default="en"))
        users.add_column(
            sa.Column("preferences", JSON, nullable=False, server_default=sa.text("'{}'"))
        )
        users.add_column(sa.Column("password_hash", sa.String(255)))
        users.add_column(
            sa.Column("privilege_version", sa.Integer(), nullable=False, server_default="0")
        )
        users.add_column(sa.Column("updated_at", TIMESTAMP))
        users.add_column(sa.Column("last_seen_at", TIMESTAMP))
        users.create_check_constraint("ck_users_kind", "kind IN ('player', 'sysop')")
        users.create_check_constraint(
            "ck_users_status", "status IN ('active', 'pending', 'denied', 'disabled')"
        )
        users.create_check_constraint("ck_users_onboarding", "onboarding IN ('handle', 'complete')")
        users.create_check_constraint("ck_users_privilege_version", "privilege_version >= 0")
    op.create_index(
        "uq_users_one_sysop",
        "users",
        ["kind"],
        unique=True,
        postgresql_where=SYSOP_ONLY,
        sqlite_where=SYSOP_ONLY,
    )

    with op.batch_alter_table("external_identities") as identities:
        identities.add_column(sa.Column("email", sa.String(320)))
        identities.add_column(
            sa.Column("email_verified", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        identities.add_column(sa.Column("created_at", TIMESTAMP))
        identities.add_column(sa.Column("last_login_at", TIMESTAMP))
    op.create_index("ix_external_identities_user_id", "external_identities", ["user_id"])

    op.create_table(
        "sessions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("csrf_token", sa.String(64), nullable=False),
        sa.Column("privilege_version", sa.Integer(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("authenticated_at", TIMESTAMP, nullable=False),
        sa.Column("last_seen_at", TIMESTAMP, nullable=False),
        sa.Column("idle_expires_at", TIMESTAMP, nullable=False),
        sa.Column("absolute_expires_at", TIMESTAMP, nullable=False),
        sa.Column("revoked_at", TIMESTAMP),
        sa.Column("revoked_reason", sa.String(32)),
        sa.Column("source_address", sa.String(64)),
        sa.Column("user_agent", sa.String(256)),
        sa.CheckConstraint("kind IN ('google', 'sysop')", name="ck_sessions_kind"),
        sa.CheckConstraint("privilege_version >= 0", name="ck_sessions_privilege_version"),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])

    op.create_table(
        "role_grants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("granted_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("granted_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("user_id", "role"),
        sa.CheckConstraint(
            "role IN ('moderator', 'content_editor', 'administrator')", name="ck_role_grants_role"
        ),
    )
    op.create_index("ix_role_grants_user_id", "role_grants", ["user_id"])

    op.create_table(
        "audit_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("occurred_at", TIMESTAMP, nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("target_user_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("source_address", sa.String(64)),
        sa.Column("request_id", sa.String(64)),
        sa.Column("details", JSON, nullable=False),
    )
    op.create_index("ix_audit_events_occurred_at", "audit_events", ["occurred_at"])
    op.create_index("ix_audit_events_actor_id", "audit_events", ["actor_id"])
    op.create_index("ix_audit_events_action", "audit_events", ["action"])
    if op.get_bind().dialect.name == "postgresql":
        # The audit trail is append-only: no role the application uses can rewrite history.
        op.execute(
            """
            CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'audit_events is append-only';
            END $$;
            CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
                FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
            """
        )

    op.create_table(
        "login_challenges",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("nonce", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("expires_at", TIMESTAMP, nullable=False),
        sa.Column("consumed_at", TIMESTAMP),
    )
    op.create_index("ix_login_challenges_expires_at", "login_challenges", ["expires_at"])


def downgrade() -> None:
    op.drop_table("login_challenges")
    if op.get_bind().dialect.name == "postgresql":
        op.execute("DROP TRIGGER audit_events_append_only ON audit_events")
        op.execute("DROP FUNCTION audit_events_append_only()")
    for table in ["audit_events", "role_grants", "sessions"]:
        op.drop_table(table)
    op.drop_index("ix_external_identities_user_id", "external_identities")
    with op.batch_alter_table("external_identities") as identities:
        for column in ["last_login_at", "created_at", "email_verified", "email"]:
            identities.drop_column(column)
    op.drop_index("uq_users_one_sysop", "users")
    # Downgrading forgets SysOp and handle-less accounts; 0001 cannot hold either.
    op.execute(
        "DELETE FROM external_identities WHERE user_id IN (SELECT id FROM users WHERE "
        "kind = 'sysop' OR normalized_handle IS NULL)"
    )
    op.execute("DELETE FROM users WHERE kind = 'sysop' OR normalized_handle IS NULL")
    with op.batch_alter_table("users") as users:
        for constraint in [
            "ck_users_privilege_version",
            "ck_users_onboarding",
            "ck_users_status",
            "ck_users_kind",
        ]:
            users.drop_constraint(constraint, type_="check")
        for column in [
            "last_seen_at",
            "updated_at",
            "privilege_version",
            "password_hash",
            "preferences",
            "locale",
            "avatar",
            "onboarding",
            "status",
            "kind",
            "display_name",
            "handle",
        ]:
            users.drop_column(column)
        users.alter_column("normalized_handle", existing_type=sa.String(32), nullable=False)
