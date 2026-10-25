"""Basic land packs (v0.6.4, api/lands.py): shop products whose collation is built from the
catalog, not MTGJSON.

- ck_shop_products_origin also takes 'lands'.

The rows themselves are added by the API when the shop is first asked for (ensure_land_packs).
Downgrade keeps them, since packs and openings name them: they become 'mtgjson' products off
sale, which the older booster job marks missing; upgrading again puts them back.
"""

from alembic import op

revision = "0031_land_packs"
down_revision = "0030_auction_lengths"
branch_labels = None
depends_on = None

OLD_ORIGINS = "origin IN ('price_list', 'mtgjson')"
ORIGINS = "origin IN ('price_list', 'mtgjson', 'lands')"


def upgrade() -> None:
    with op.batch_alter_table("shop_products") as products:
        products.drop_constraint("ck_shop_products_origin", type_="check")
        products.create_check_constraint("ck_shop_products_origin", ORIGINS)
    # Land packs a downgrade turned into MTGJSON products are land packs again.
    op.execute(
        "UPDATE shop_products SET origin = 'lands', on_sale = true, sale_reason = NULL "
        "WHERE set_code = 'LANDS' AND sale_reason = 'Basic land packs need v0.6.4'"
    )
    op.execute("UPDATE shop_products SET origin = 'lands' WHERE set_code = 'LANDS'")


def downgrade() -> None:
    op.execute(
        "UPDATE shop_products SET origin = 'mtgjson', on_sale = false, "
        "sale_reason = 'Basic land packs need v0.6.4' WHERE origin = 'lands'"
    )
    with op.batch_alter_table("shop_products") as products:
        products.drop_constraint("ck_shop_products_origin", type_="check")
        products.create_check_constraint("ck_shop_products_origin", OLD_ORIGINS)
