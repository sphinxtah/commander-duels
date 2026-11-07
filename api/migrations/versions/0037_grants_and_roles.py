"""v0.8.8: SysOp's grants for testing (api/testing.py), the campaign's cosmetics in use
(api/cosmetics.py), and the content editor role removed.

- player_results: a result may be granted instead of played: game_id is then null and granted_by
  names SysOp, who granted it. Granted results count towards quests and achievements; the
  profile's statistics and the match history leave them out (api/stats.py).
- library_grants: a grant's source may be "grant", SysOp's own cards for testing.
- users: card_back and title, the campaign's cosmetics in use (api/cosmetics.py), null for none.
- role_grants: the content editor role is gone (the owner's decision); its grants are deleted and
  their accounts' privileges change, so their sessions take the change at once.

Expand only: the previous version never reads a granted result's missing game (its totals would
count granted wins, nothing more), and reads a "grant" source as any other.

Downgrade deletes the granted results and the granted cards, with the append-only triggers set
aside on PostgreSQL, and restores the checks; the content editor grants deleted stay deleted.
"""

import sqlalchemy as sa
from alembic import op

revision = "0037_grants_and_roles"
down_revision = "0036_kings_table"
branch_labels = None
depends_on = None

SOURCES_BEFORE = "source IN ('starter', 'grandfathered', 'pack', 'unique', 'auction', 'campaign')"
SOURCES = "source IN ('starter', 'grandfathered', 'pack', 'unique', 'auction', 'campaign', 'grant')"
GRANTED = "(game_id IS NULL) = (granted_by IS NOT NULL)"
ROLES_BEFORE = "role IN ('moderator', 'content_editor', 'administrator')"
ROLES = "role IN ('moderator', 'administrator')"


def upgrade() -> None:
    with op.batch_alter_table("users") as users:
        users.add_column(sa.Column("card_back", sa.String(48), nullable=True))
        users.add_column(sa.Column("title", sa.String(48), nullable=True))
    with op.batch_alter_table("player_results") as results:
        results.add_column(sa.Column("granted_by", sa.Uuid(), nullable=True))
        results.create_foreign_key(
            "fk_player_results_granted_by_users", "users", ["granted_by"], ["id"]
        )
        results.alter_column("game_id", existing_type=sa.Uuid(), nullable=True)
        results.create_check_constraint("ck_player_results_granted", GRANTED)
    with op.batch_alter_table("library_grants") as grants:
        grants.drop_constraint("ck_library_grants_source", type_="check")
        grants.create_check_constraint("ck_library_grants_source", SOURCES)
    op.execute(
        "UPDATE users SET privilege_version = privilege_version + 1 WHERE id IN "
        "(SELECT user_id FROM role_grants WHERE role = 'content_editor')"
    )
    op.execute("DELETE FROM role_grants WHERE role = 'content_editor'")
    with op.batch_alter_table("role_grants") as roles:
        roles.drop_constraint("ck_role_grants_role", type_="check")
        roles.create_check_constraint("ck_role_grants_role", ROLES)


def downgrade() -> None:
    with op.batch_alter_table("role_grants") as roles:
        roles.drop_constraint("ck_role_grants_role", type_="check")
        roles.create_check_constraint("ck_role_grants_role", ROLES_BEFORE)
    postgres = op.get_bind().dialect.name == "postgresql"
    if postgres:
        op.execute("ALTER TABLE player_results DISABLE TRIGGER player_results_append_only")
        op.execute("ALTER TABLE library_grants DISABLE TRIGGER library_grants_append_only")
    op.execute("DELETE FROM player_results WHERE granted_by IS NOT NULL")
    op.execute("DELETE FROM library_grants WHERE source = 'grant'")
    if postgres:
        op.execute("ALTER TABLE player_results ENABLE TRIGGER player_results_append_only")
        op.execute("ALTER TABLE library_grants ENABLE TRIGGER library_grants_append_only")
    with op.batch_alter_table("library_grants") as grants:
        grants.drop_constraint("ck_library_grants_source", type_="check")
        grants.create_check_constraint("ck_library_grants_source", SOURCES_BEFORE)
    with op.batch_alter_table("player_results") as results:
        results.drop_constraint("ck_player_results_granted", type_="check")
        results.alter_column("game_id", existing_type=sa.Uuid(), nullable=False)
        results.drop_constraint("fk_player_results_granted_by_users", type_="foreignkey")
        results.drop_column("granted_by")
    with op.batch_alter_table("users") as users:
        users.drop_column("title")
        users.drop_column("card_back")
