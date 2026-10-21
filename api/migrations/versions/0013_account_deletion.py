"""Deleting an account (v0.4.1): the status deleted, when it happened, and the one change a deck
revision allows.

A deleted account keeps its row as "Deleted player" (api/accounts.py). A revision that a game
played stays, with its cards; on PostgreSQL its trigger now lets a deleted account's revision lose
its title and notes, to the fixed title "Deleted deck" and no notes, and refuses every other
update as before. Its entries stay immutable. Expand only: the previous version never writes the
new status and ignores the new column.

Downgrade marks deleted accounts disabled, which the previous version refuses at sign-in.
"""

import sqlalchemy as sa
from alembic import op

revision = "0013_account_deletion"
down_revision = "0011_custom_play"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
STATUSES = "'active', 'pending', 'denied', 'disabled'"


def upgrade() -> None:
    with op.batch_alter_table("users") as users:
        users.add_column(sa.Column("deleted_at", TIMESTAMP))
        users.drop_constraint("ck_users_status", type_="check")
        users.create_check_constraint("ck_users_status", f"status IN ({STATUSES}, 'deleted')")
    if op.get_bind().dialect.name == "postgresql":
        # Every column but the title and the notes must stay as it was, so a column added later
        # is covered too; and only a deleted account's revision may change, to the fixed words.
        op.execute(
            """
            CREATE FUNCTION deck_revisions_redactable() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.title = 'Deleted deck' AND NEW.notes = ''
                    AND to_jsonb(NEW) - 'title' - 'notes' = to_jsonb(OLD) - 'title' - 'notes'
                    AND EXISTS (
                        SELECT 1 FROM decks JOIN users ON users.id = decks.owner_id
                        WHERE decks.id = NEW.deck_id AND users.status = 'deleted'
                    )
                THEN
                    RETURN NEW;
                END IF;
                RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
            END $$;
            DROP TRIGGER deck_revisions_immutable ON deck_revisions;
            CREATE TRIGGER deck_revisions_immutable BEFORE UPDATE ON deck_revisions
                FOR EACH ROW EXECUTE FUNCTION deck_revisions_redactable();
            """
        )


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            """
            DROP TRIGGER deck_revisions_immutable ON deck_revisions;
            CREATE TRIGGER deck_revisions_immutable BEFORE UPDATE ON deck_revisions
                FOR EACH ROW EXECUTE FUNCTION deck_revisions_immutable();
            DROP FUNCTION deck_revisions_redactable();
            """
        )
    op.execute("UPDATE users SET status = 'disabled' WHERE status = 'deleted'")
    with op.batch_alter_table("users") as users:
        users.drop_constraint("ck_users_status", type_="check")
        users.create_check_constraint("ck_users_status", f"status IN ({STATUSES})")
        users.drop_column("deleted_at")
