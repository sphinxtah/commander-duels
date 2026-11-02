"""The tour's two last stages (v0.8.5, api/tutorial.py): tour_decks and tour_play.

After Tivit's Auction House the main menu's tour goes on to Decks (the starter decks, building one)
and the Play page (a practice game against a bot), so the stage reached may be either. Expand only:
every stored value stays valid, and v0.8.4, still serving while this migrates, never writes them.

Downgrade moves an account at either stage to done, which v0.8.4 knows.
"""

from alembic import op

revision = "0034_tour_decks_play"
down_revision = "0033_tutorial"
branch_labels = None
depends_on = None

BEFORE = "'choose', 'demo', 'overview', 'setup', 'tour_shop', 'tour_auctions', 'done'"


def upgrade() -> None:
    with op.batch_alter_table("users") as users:
        users.drop_constraint("ck_users_tutorial", type_="check")
        users.create_check_constraint(
            "ck_users_tutorial", f"tutorial IN ({BEFORE}, 'tour_decks', 'tour_play')"
        )


def downgrade() -> None:
    op.execute("UPDATE users SET tutorial = 'done' WHERE tutorial IN ('tour_decks', 'tour_play')")
    with op.batch_alter_table("users") as users:
        users.drop_constraint("ck_users_tutorial", type_="check")
        users.create_check_constraint("ck_users_tutorial", f"tutorial IN ({BEFORE})")
