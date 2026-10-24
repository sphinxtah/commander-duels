import type { ReactNode } from "react";
import { foilGlow } from "../catalog/foilGlow";
import { useImageRetry } from "../game/RetryingImage";
import {
  amount,
  cardImage,
  editionLine,
  finishNames,
  itemName,
  rarityNames,
  shownPrice,
  standing,
  timeLeft,
  timeLeftWords,
  tokens,
  urgent,
  type Standing,
} from "./auctions";
import type { AuctionCard, AuctionItem, Finish } from "./types";
import styles from "./auctions.module.css";

// The auction house's pieces (v0.6.0), shared by its screens: an edition's picture in its finish,
// a price beside its coin, the countdown and the badge that says where the viewer stands. The
// market's tiles are Madden's item cards; the transfer list and targets show rows.

/** A token's coin, as the top bar draws it. */
export function Coin() {
  return <span className={styles.coin} aria-hidden="true" />;
}

/** A price with its coin; the words say "tokens" for screen readers. */
export function Price({
  value,
  className,
}: {
  value: number | null;
  className?: string;
}) {
  if (value === null) return <span className={className}>—</span>;
  return (
    <span className={[styles.price, className].filter(Boolean).join(" ")}>
      <Coin />
      <span aria-hidden="true">{amount(value)}</span>
      <span className={styles.hidden}>{tokens(value)}</span>
    </span>
  );
}

/** Time left, red under a minute. Only its words are read, not each second. */
export function TimeLeft({ endsAt, now }: { endsAt: string; now: number }) {
  return (
    <span
      className={styles.time}
      data-urgent={urgent(endsAt, now) || undefined}
      title={timeLeftWords(endsAt, now)}
    >
      {timeLeft(endsAt, now)}
    </span>
  );
}

export function StandingBadge({ shown }: { shown: Standing | null }) {
  if (!shown) return null;
  return (
    <span className={styles.badge} data-kind={shown.kind}>
      {shown.label}
    </span>
  );
}

/** An edition's picture in its finish: a foil shimmers, an etched foil is marked. */
export function CardArt({
  card,
  finish,
  size = "normal",
  className,
}: {
  card: AuctionCard;
  finish: Finish;
  size?: "normal" | "large";
  className?: string;
}) {
  const src = cardImage(card, size);
  const image = useImageRetry(src);
  return (
    <span
      className={[styles.art, foilGlow(finish), className]
        .filter(Boolean)
        .join(" ")}
      data-finish={finish}
      data-rarity={card.rarity}
      data-loaded={image.state === "loaded" || undefined}
    >
      {/* The name and edition, under the picture until it draws or if it never does. */}
      <span className={styles.artFrame} aria-hidden="true">
        <strong>{card.name}</strong>
        <small>{card.type_line}</small>
        <small>{editionLine(card)}</small>
      </span>
      {image.state !== "failed" && (
        <img
          key={image.attempt}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          ref={image.ref}
          onLoad={image.onLoad}
          onError={image.onError}
        />
      )}
      {finish !== "nonfoil" && (
        <span className={styles.foil} aria-hidden="true" />
      )}
      {finish === "etched" && (
        <span className={styles.etched} aria-hidden="true">
          Etched
        </span>
      )}
    </span>
  );
}

/** "Foil", "Etched foil": a chip beside the edition. Nonfoil says nothing. */
export function FinishChip({ finish }: { finish: Finish }) {
  return (
    <span className={styles.finish} data-finish={finish}>
      {finishNames[finish]}
    </span>
  );
}

/** The words a tile or a row is read by. */
export function itemLabel(item: AuctionItem, now: number, viewer?: string | null): string {
  const shown = standing(item, now, viewer);
  const price =
    item.status === "sold" && item.sold_price !== null
      ? `sold for ${tokens(item.sold_price)}`
      : item.current_bid !== null
        ? `current bid ${tokens(item.current_bid)}`
        : `starting bid ${tokens(item.starting_bid)}`;
  return [
    itemName(item),
    price,
    item.buy_now !== null && item.status === "active"
      ? `Buy Now ${tokens(item.buy_now)}`
      : "",
    item.status === "active" ? timeLeftWords(item.ends_at, now) : "",
    shown?.label ?? "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** A watch star: on, the auction is in the transfer targets. */
export function WatchStar({
  item,
  onWatch,
  className,
}: {
  item: AuctionItem;
  onWatch: (item: AuctionItem, on: boolean) => void;
  className?: string;
}) {
  if (item.mine) return null;
  return (
    <button
      type="button"
      className={[styles.star, className].filter(Boolean).join(" ")}
      aria-pressed={item.watching}
      aria-label={`Watch ${item.card.name}`}
      title={item.watching ? "Watching: in your transfer targets" : "Watch"}
      onClick={() => onWatch(item, !item.watching)}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L12 16.6l-5.3 2.9 1.1-5.9-4.4-4.1 6-.8z" />
      </svg>
    </button>
  );
}

/**
 * A market's item card, as Madden's: the edition's picture, a plate with its name and edition,
 * and the bid, Buy Now and time left; its badge says whether the viewer is winning or outbid.
 */
export function ItemTile({
  item,
  now,
  viewer,
  onOpen,
  onWatch,
}: {
  item: AuctionItem;
  now: number;
  viewer?: string | null;
  onOpen: (item: AuctionItem) => void;
  onWatch: (item: AuctionItem, on: boolean) => void;
}) {
  const shown = standing(item, now, viewer);
  return (
    <li className={styles.tile} data-standing={shown?.kind}>
      <button
        type="button"
        className={styles.tileOpen}
        aria-label={itemLabel(item, now, viewer)}
        onClick={() => onOpen(item)}
      >
        <span className={styles.tileArt}>
          <CardArt card={item.card} finish={item.finish} />
          <span className={styles.tileBadge}>
            <StandingBadge shown={shown} />
          </span>
        </span>
        <span className={styles.plate}>
          <span className={styles.plateName}>{item.card.name}</span>
          <span className={styles.plateEdition}>
            {item.card.set_name}{" "}
            <span className={styles.setCode}>
              {item.card.set_code.toUpperCase()} #{item.card.collector_number}
            </span>
          </span>
          <span className={styles.plateMeta}>
            <span className={styles.rarity} data-rarity={item.card.rarity}>
              {rarityNames[item.card.rarity] ?? item.card.rarity}
            </span>
            {item.finish !== "nonfoil" && <FinishChip finish={item.finish} />}
          </span>
          <span className={styles.prices}>
            <span className={styles.priceRow}>
              <span>{item.current_bid !== null ? "Bid" : "Start"}</span>
              <Price value={shownPrice(item)} />
            </span>
            <span className={styles.priceRow}>
              <span>Buy Now</span>
              <Price value={item.buy_now} className={styles.buyNow} />
            </span>
            <span className={styles.priceRow}>
              <span>Time</span>
              <TimeLeft endsAt={item.ends_at} now={now} />
            </span>
          </span>
        </span>
      </button>
      <WatchStar item={item} onWatch={onWatch} className={styles.tileStar} />
    </li>
  );
}

/** A row of the transfer list or targets: picture, name, where it stands, its price and time, and
 * the row's own actions. */
export function ItemRow({
  item,
  now,
  viewer,
  onOpen,
  children,
}: {
  item: AuctionItem;
  now: number;
  viewer?: string | null;
  onOpen: (item: AuctionItem) => void;
  children?: ReactNode;
}) {
  const shown = standing(item, now, viewer);
  const live = item.status === "active";
  return (
    <li className={styles.row} data-standing={shown?.kind}>
      <button
        type="button"
        className={styles.rowOpen}
        aria-label={itemLabel(item, now, viewer)}
        onClick={() => onOpen(item)}
      >
        <CardArt card={item.card} finish={item.finish} className={styles.rowArt} />
        <span className={styles.rowWords}>
          <span className={styles.rowName}>
            {item.card.name}
            {item.finish !== "nonfoil" && <FinishChip finish={item.finish} />}
          </span>
          <span className={styles.rowEdition}>{editionLine(item.card)}</span>
          <StandingBadge shown={shown} />
        </span>
        <span className={styles.rowNumbers}>
          {item.status === "sold" ? (
            <span className={styles.rowCell}>
              <small>{item.mine ? `Sold to ${item.buyer ?? "—"}` : "Sold for"}</small>
              <Price value={item.sold_price} />
            </span>
          ) : (
            <span className={styles.rowCell}>
              <small>
                {item.current_bid !== null
                  ? `Bid · ${item.bids} ${item.bids === 1 ? "bid" : "bids"}`
                  : "Starting bid"}
              </small>
              <Price value={shownPrice(item)} />
            </span>
          )}
          <span className={styles.rowCell}>
            <small>Buy Now</small>
            <Price value={item.buy_now} className={styles.buyNow} />
          </span>
          {live && (
            <span className={styles.rowCell}>
              <small>Time left</small>
              <TimeLeft endsAt={item.ends_at} now={now} />
            </span>
          )}
          {!item.mine && item.my_bid !== null && (
            <span className={styles.rowCell}>
              <small>Your bid</small>
              <Price value={item.my_bid} />
            </span>
          )}
        </span>
      </button>
      {children && <span className={styles.rowActions}>{children}</span>}
    </li>
  );
}
