import { PackArt } from "./PackArt";
import { priceToPay, tokens, type Product, type SaleInfo } from "./shop";
import styles from "./shop.module.css";

// Leng's weekly sale (v0.4.3, the owner's request), at the counter beside the balance: this
// week's five packs, chosen at random by the server, each 20% less from Sunday midnight to the
// next Sunday midnight, Arizona time. The shelves show the same prices; buying pays them.

/** "Sunday, Oct 25, 12:00 AM MST", in the viewer's own time zone. */
export function saleEnds(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function WeeklySale({
  sale,
  products,
  balance,
  onBuy,
}: {
  sale: SaleInfo | null | undefined;
  products: Product[];
  balance: number;
  onBuy: (product: Product) => void;
}) {
  if (!sale) return null;
  const chosen = new Set(sale.products);
  const shown = products.filter((product) => chosen.has(product.id));
  return (
    <section className={styles.sale} aria-labelledby="sale-title">
      <h2 id="sale-title">
        This week's sale{" "}
        <span className={styles.saleTag}>{sale.percent}% off</span>
      </h2>
      <p className={styles.saleWhen}>
        Until {saleEnds(sale.ends_at)}. Five other packs go on sale each week.
      </p>
      {shown.length === 0 ? (
        <p className={styles.note}>
          Nothing on sale this week. Come back on Sunday.
        </p>
      ) : (
        <ul className={styles.saleList} aria-label="On sale this week">
          {shown.map((product) => {
            const price = priceToPay(product);
            const short = price - balance;
            return (
              <li key={product.id} aria-label={product.name}>
                <PackArt product={product} height={4.2} />
                <span className={styles.saleName}>
                  <strong>{product.name}</strong>
                  <span>
                    <s aria-label={`was ${tokens(product.price)}`}>
                      {tokens(product.price)}
                    </s>{" "}
                    <b>{tokens(price)}</b>
                  </span>
                </span>
                <button
                  type="button"
                  className={styles.secondary}
                  aria-disabled={short > 0}
                  title={
                    short > 0 ? `You need ${tokens(short)} more.` : undefined
                  }
                  aria-label={`Buy ${product.name} for ${tokens(price)}`}
                  onClick={() => short <= 0 && onBuy(product)}
                >
                  Buy
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
