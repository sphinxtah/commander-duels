import { useEffect, useMemo, useRef, useState } from "react";
import { describe } from "../api";
import shell from "../App.module.css";
import { auctionApi } from "./api";
import {
  DURATIONS,
  durationNames,
  editionLine,
  finishNames,
  priceProblem,
  requestKey,
} from "./auctions";
import { CardArt, FinishChip, Price } from "./ItemViews";
import type { AuctionItem, Duration, SellableItem } from "./types";
import styles from "./auctions.module.css";

// The Sell dialog (v0.6.0), Madden's "List on transfer market": a card in one edition and finish
// from what the viewer may list, how many copies (each its own auction), the starting bid, an
// optional Buy Now and the length. Relisting an unsold card uses the same form, prefilled, for the
// same copy. The server checks everything again; the form only keeps it from asking for what it
// will refuse.

export type SellRequest =
  | {
      mode: "sell";
      /** From My library: the edition chosen, its finishes offered. */
      preset?: { printingId: string; name: string };
    }
  | { mode: "relist"; item: AuctionItem };

const MAX_QUANTITY = 20;

function sameItem(a: SellableItem, b: SellableItem): boolean {
  return a.card.printing_id === b.card.printing_id && a.finish === b.finish;
}

export function SellDialog({
  request,
  onClose,
  onListed,
}: {
  request: SellRequest | null;
  onClose: () => void;
  /** The auctions listed (or the one relisted), with the words to say so. */
  onListed: (items: AuctionItem[], said: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<SellableItem[]>();
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<SellableItem | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [startingBid, setStartingBid] = useState("");
  const [useBuyNow, setUseBuyNow] = useState(false);
  const [buyNow, setBuyNow] = useState("");
  const [duration, setDuration] = useState<Duration>("24h");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per listing until it succeeds, so a retry lists once.
  const key = useRef("");
  const relist = request?.mode === "relist" ? request.item : null;
  const preset = request?.mode === "sell" ? request.preset : undefined;

  useEffect(() => {
    if (request && !dialog.current?.open) dialog.current?.showModal?.();
    if (!request && dialog.current?.open) dialog.current.close();
    if (!request) return;
    key.current = requestKey();
    setError("");
    setChosen(null);
    setFound(undefined);
    setQuantity("1");
    if (request.mode === "relist") {
      const item = request.item;
      setStartingBid(String(item.starting_bid));
      setUseBuyNow(item.buy_now !== null);
      setBuyNow(item.buy_now !== null ? String(item.buy_now) : "");
      setDuration(item.duration);
    } else {
      setStartingBid("");
      setUseBuyNow(false);
      setBuyNow("");
      setDuration("24h");
      setQ(request.preset?.name ?? "");
    }
  }, [request]);

  // The picker's search, a moment after typing stops.
  useEffect(() => {
    if (!request || request.mode !== "sell") return;
    let active = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void auctionApi.sellable(q).then(({ data, error: refused }) => {
        if (!active) return;
        setSearching(false);
        if (!data) return setError(describe(refused));
        let items = data.items;
        // From My library, only that edition's finishes.
        if (preset)
          items = items.filter(
            (item) => item.card.printing_id === preset.printingId,
          );
        setFound(items);
        // One choice, from the library: it is chosen.
        if (preset && items.length === 1) setChosen(items[0]!);
      });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [q, request, preset]);

  const most = chosen ? Math.min(chosen.sellable, MAX_QUANTITY) : 1;
  const count = Math.floor(Number(quantity));
  const quantityProblem =
    relist || !chosen
      ? ""
      : !Number.isInteger(Number(quantity)) || count < 1 || count > most
        ? `List 1 to ${most} ${most === 1 ? "copy" : "copies"}.`
        : "";
  const problem = useMemo(
    () => priceProblem(startingBid, useBuyNow ? buyNow : ""),
    [startingBid, buyNow, useBuyNow],
  );
  const ready = (relist || chosen) && !problem && !quantityProblem;

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    const start = Number(startingBid);
    const buy = useBuyNow && buyNow.trim() ? Number(buyNow) : null;
    try {
      if (relist) {
        const { data, error: refused } = await auctionApi.relist(relist.id, {
          starting_bid: start,
          buy_now: buy,
          duration,
          key: key.current,
        });
        if (!data) return setError(describe(refused));
        onListed(
          [data],
          `${relist.card.name} is back on the market for ${durationNames[duration]}.`,
        );
      } else if (chosen) {
        const { data, error: refused } = await auctionApi.create({
          printing_id: chosen.card.printing_id,
          finish: chosen.finish,
          starting_bid: start,
          buy_now: buy,
          duration,
          quantity: count,
          key: key.current,
        });
        if (!data) return setError(describe(refused));
        const listed = data.items.length;
        onListed(
          data.items,
          listed === 1
            ? `${chosen.card.name} is on the market for ${durationNames[duration]}.`
            : `${listed} copies of ${chosen.card.name} are on the market for ${durationNames[duration]}.`,
        );
      }
      dialog.current?.close();
    } finally {
      setBusy(false);
    }
  }

  const card = relist ? relist.card : chosen?.card;
  const finish = relist ? relist.finish : chosen?.finish;
  const start = Number(startingBid) || 0;
  const buy = useBuyNow ? Number(buyNow) || 0 : 0;
  const copies = relist ? 1 : count || 1;
  return (
    <dialog
      ref={dialog}
      className={styles.sell}
      aria-labelledby="sell-title"
      onClose={onClose}
    >
      {request && (
        <form
          className={styles.sellForm}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <header className={styles.sellHead}>
            <h2 id="sell-title">
              {relist ? "Relist on the market" : "List on the market"}
            </h2>
            <button
              type="button"
              className={styles.drawerClose}
              aria-label="Close"
              onClick={() => dialog.current?.close()}
            >
              ×
            </button>
          </header>

          {!relist && (
            <fieldset className={styles.picker}>
              <legend>The card</legend>
              {!preset && (
                <label className={styles.field}>
                  <span>Find a card you may sell</span>
                  <input
                    type="search"
                    value={q}
                    maxLength={80}
                    placeholder="A card's name"
                    onChange={(event) => setQ(event.target.value)}
                  />
                </label>
              )}
              {found === undefined || searching ? (
                <p className={styles.note} role="status">
                  Looking through your library…
                </p>
              ) : found.length === 0 ? (
                <p className={styles.note} role="status">
                  {preset
                    ? "No copy of this edition can be listed: it is in a live auction already, or it is an alliance's card, the one of a kind, a basic land or a custom card."
                    : "Nothing you hold by that name can be listed. Alliance cards, the one of a kind, basic lands and custom cards are never sold."}
                </p>
              ) : (
                <ul
                  className={styles.pickList}
                  role="radiogroup"
                  aria-label="Edition and finish"
                >
                  {found.map((item) => {
                    const on = chosen !== null && sameItem(chosen, item);
                    return (
                      <li key={`${item.card.printing_id}-${item.finish}`}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={on}
                          disabled={item.sellable < 1}
                          onClick={() => {
                            setChosen(item);
                            setQuantity("1");
                          }}
                          className={styles.pick}
                        >
                          <CardArt
                            card={item.card}
                            finish={item.finish}
                            className={styles.pickArt}
                          />
                          <span className={styles.pickWords}>
                            <strong>{item.card.name}</strong>
                            <small>{editionLine(item.card)}</small>
                            <span>
                              <FinishChip finish={item.finish} />{" "}
                              <small>
                                {item.sellable} of {item.copies} free to sell
                              </small>
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </fieldset>
          )}

          {card && finish && (
            <div className={styles.sellChosen}>
              <CardArt card={card} finish={finish} className={styles.sellArt} />
              <div>
                <strong>{card.name}</strong>
                <small>{editionLine(card)}</small>
                <FinishChip finish={finish} />
              </div>
            </div>
          )}

          <fieldset className={styles.pricing} disabled={!card}>
            <legend>The auction</legend>
            {!relist && (
              <label className={styles.field}>
                <span>
                  Copies to list{chosen ? ` (up to ${most})` : ""}
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={most}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
              </label>
            )}
            <label className={styles.field}>
              <span>Starting bid (tokens)</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                required
                value={startingBid}
                onChange={(event) => setStartingBid(event.target.value)}
              />
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={useBuyNow}
                onChange={(event) => setUseBuyNow(event.target.checked)}
              />
              <span>Set a Buy Now price</span>
            </label>
            {useBuyNow && (
              <label className={styles.field}>
                <span>Buy Now (tokens)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={Math.max(2, start + 1)}
                  value={buyNow}
                  onChange={(event) => setBuyNow(event.target.value)}
                />
              </label>
            )}
            <div
              className={styles.durations}
              role="radiogroup"
              aria-label="Length of the auction"
            >
              {DURATIONS.map((item) => (
                <label key={item} data-on={duration === item || undefined}>
                  <input
                    type="radio"
                    name="duration"
                    value={item}
                    checked={duration === item}
                    onChange={() => setDuration(item)}
                  />
                  <span>{durationNames[item]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className={styles.summary} aria-live="polite">
            <p className={styles.noFee}>You receive 100% — no fee</p>
            {card && !problem && (
              <p>
                {copies > 1 ? `${copies} auctions, each ` : ""}from{" "}
                <Price value={start} />
                {useBuyNow && buy > 0 && (
                  <>
                    {" "}
                    up to <Price value={buy} /> at Buy Now
                  </>
                )}
                , for {durationNames[duration]}. The card leaves your library
                while it is listed; unsold, it comes back.
              </p>
            )}
            {(problem || quantityProblem) && startingBid !== "" && (
              <p className={styles.error}>{quantityProblem || problem}</p>
            )}
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.bidActions}>
            <button
              type="submit"
              className={shell.primary}
              disabled={!ready || busy}
            >
              {error
                ? "Try again"
                : relist
                  ? "Relist"
                  : copies > 1
                    ? `List ${copies} copies`
                    : "List it"}
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
          </div>
          {finish && finish !== "nonfoil" && (
            <p className={styles.note}>
              Listed as {finishNames[finish].toLowerCase()}: buyers see and
              search the finish.
            </p>
          )}
        </form>
      )}
    </dialog>
  );
}
