import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  client,
  describe,
  type CustomCard,
  type CustomCardUpload,
  type Planeswalker,
} from "../api";
import {
  CardImageError,
  fitCardImage,
  toBase64,
  toDataUrl,
  type FittedImage,
} from "./cardImage";
import account from "../Account.module.css";
import shell from "../App.module.css";
import styles from "./admin.module.css";

type Rarity = CustomCardUpload["rarity"];
const rarities: { id: Rarity; name: string }[] = [
  { id: "common", name: "Common" },
  { id: "uncommon", name: "Uncommon" },
  { id: "rare", name: "Rare" },
  { id: "mythic", name: "Mythic" },
  { id: "special", name: "Special" },
];
type Fields = {
  name: string;
  planeswalker: string;
  mana_cost: string;
  type_line: string;
  oracle_text: string;
  flavor_text: string;
  power: string;
  toughness: string;
  loyalty: string;
  rarity: Rarity;
  set_code: string;
  collector_number: string;
  artist: string;
};
const blank: Fields = {
  name: "",
  planeswalker: "",
  mana_cost: "",
  type_line: "",
  oracle_text: "",
  flavor_text: "",
  power: "",
  toughness: "",
  loyalty: "",
  rarity: "mythic",
  set_code: "",
  collector_number: "",
  artist: "",
};
// The short fields, with the API's limits (api/custom_cards.py).
const short: { key: keyof Fields; label: string; max: number }[] = [
  { key: "mana_cost", label: "Mana cost, such as {2}{U}{U}", max: 64 },
  { key: "power", label: "Power", max: 8 },
  { key: "toughness", label: "Toughness", max: 8 },
  { key: "loyalty", label: "Loyalty", max: 8 },
  { key: "set_code", label: "Set code", max: 16 },
  { key: "collector_number", label: "Collector number", max: 16 },
  { key: "artist", label: "Artist", max: 128 },
];

function kilobytes(bytes: number) {
  return `${Math.round(bytes / 1000).toLocaleString("en-US")} KB`;
}

/**
 * The Godlike tier's custom cards (v0.3.1), for SysOp alone: upload a card's definition with its
 * image, and see or remove the ones uploaded. The image is fitted to the card's size and encoded
 * here, in the browser, so the request stays under the proxies' limit. Nothing about the cards is
 * in the page's code: they come from the API, to SysOp, and to Godlike accounts only.
 */
export function CustomCards() {
  const [cards, setCards] = useState<CustomCard[]>();
  const [roster, setRoster] = useState<Planeswalker[]>([]);
  const [fields, setFields] = useState<Fields>(blank);
  const [image, setImage] = useState<FittedImage & { preview?: string }>();
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const file = useRef<HTMLInputElement>(null);
  // Only roster entries marked custom take custom cards: the Godlike tier's Planeswalker.
  const owners = roster.filter((found) => found.custom);
  const owner = fields.planeswalker || owners[0]?.id || "";

  async function load() {
    try {
      const [uploaded, all] = await Promise.all([
        client.GET("/api/v1/admin/custom-cards"),
        client.GET("/api/v1/planeswalkers"),
      ]);
      if (uploaded.data) setCards(uploaded.data);
      else setError(describe(uploaded.error));
      if (all.data) setRoster(all.data);
    } catch {
      setError(describe(undefined));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function set<K extends keyof Fields>(key: K, value: Fields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
  }
  async function choose(chosen: File | undefined) {
    setImage(undefined);
    setError("");
    if (!chosen) return;
    setPreparing(true);
    try {
      const fitted = await fitCardImage(chosen);
      setImage({ ...fitted, preview: await toDataUrl(fitted.blob) });
    } catch (caught) {
      setError(
        caught instanceof CardImageError
          ? caught.message
          : "The image could not be prepared.",
      );
    } finally {
      setPreparing(false);
    }
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (busy || preparing) return;
    if (!image) return setError("Choose the card's image first.");
    if (!owner) return setError("The roster has no custom Planeswalker.");
    setBusy(true);
    setError("");
    setMessage("");
    const text = (value: string) => value.trim() || null;
    try {
      const body: CustomCardUpload = {
        name: fields.name.trim(),
        planeswalker: owner,
        mana_cost: text(fields.mana_cost),
        type_line: fields.type_line.trim(),
        oracle_text: fields.oracle_text.trim(),
        flavor_text: text(fields.flavor_text),
        power: text(fields.power),
        toughness: text(fields.toughness),
        loyalty: text(fields.loyalty),
        rarity: fields.rarity,
        set_code: text(fields.set_code),
        collector_number: text(fields.collector_number),
        artist: text(fields.artist),
        image: await toBase64(image.blob),
        image_type: "image/webp",
      };
      const { data, error: refused } = await client.POST(
        "/api/v1/admin/custom-cards",
        { body },
      );
      if (!data) return setError(describe(refused));
      setMessage(`${data.name} is saved.`);
      setFields(blank);
      setImage(undefined);
      if (file.current) file.current.value = "";
      await load();
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }
  async function remove(card: CustomCard) {
    setError("");
    setMessage("");
    try {
      const { response, error: refused } = await client.DELETE(
        "/api/v1/admin/custom-cards/{card_id}",
        { params: { path: { card_id: card.id } } },
      );
      if (!response.ok) return setError(describe(refused));
      setRemoving(undefined);
      setMessage(`${card.name} is removed.`);
      await load();
    } catch {
      setError(describe(undefined));
    }
  }

  return (
    <section className={account.panel} aria-labelledby="custom-title">
      <h2 id="custom-title">Custom cards</h2>
      <p className={account.fine}>
        The Godlike tier's own cards. Only SysOp and accounts at Godlike
        (100,000 wins) can see them; an alliance with their Planeswalker puts
        them in the library. None can be played yet. A card with the name of one
        already here replaces it.
      </p>
      <p role="status" className={account.fine}>
        {message}
      </p>
      {error && (
        <p role="alert" className={account.error}>
          {error}
        </p>
      )}
      <form
        className={styles.customForm}
        onSubmit={upload}
        aria-label="Upload a custom card"
      >
        <label className={account.field}>
          <span>Name</span>
          <input
            value={fields.name}
            maxLength={160}
            required
            onChange={(event) => set("name", event.target.value)}
          />
        </label>
        <label className={account.field}>
          <span>Planeswalker</span>
          <select
            value={owner}
            required
            onChange={(event) => set("planeswalker", event.target.value)}
          >
            {owners.map((found) => (
              <option key={found.id} value={found.id}>
                {found.name}
              </option>
            ))}
          </select>
        </label>
        <label className={account.field}>
          <span>Type line</span>
          <input
            value={fields.type_line}
            maxLength={160}
            required
            onChange={(event) => set("type_line", event.target.value)}
          />
        </label>
        <label className={account.field}>
          <span>Rules text</span>
          <textarea
            value={fields.oracle_text}
            maxLength={4000}
            rows={5}
            onChange={(event) => set("oracle_text", event.target.value)}
          />
        </label>
        <label className={account.field}>
          <span>Flavour text</span>
          <textarea
            value={fields.flavor_text}
            maxLength={1000}
            rows={2}
            onChange={(event) => set("flavor_text", event.target.value)}
          />
        </label>
        <div className={styles.customShort}>
          {short.map(({ key, label, max }) => (
            <label key={key} className={account.field}>
              <span>{label}</span>
              <input
                value={fields[key]}
                maxLength={max}
                onChange={(event) => set(key, event.target.value)}
              />
            </label>
          ))}
          <label className={account.field}>
            <span>Rarity</span>
            <select
              value={fields.rarity}
              onChange={(event) => set("rarity", event.target.value as Rarity)}
            >
              {rarities.map((rarity) => (
                <option key={rarity.id} value={rarity.id}>
                  {rarity.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={account.field}>
          <span>Image (PNG, JPEG or WebP)</span>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
        <p className={account.fine} role="status">
          {preparing
            ? "Preparing the image…"
            : image
              ? `Ready: ${image.width} × ${image.height} WebP, ${kilobytes(image.blob.size)}.`
              : ""}
        </p>
        {image?.preview && (
          <img
            className={styles.customPreview}
            src={image.preview}
            alt="The image as it will be uploaded"
            width={image.width}
            height={image.height}
          />
        )}
        <div className={account.actions}>
          <button
            type="submit"
            className={shell.primary}
            aria-disabled={busy || preparing}
          >
            Upload the card
          </button>
        </div>
      </form>
      <h3 className={styles.customHeading}>Uploaded</h3>
      {cards === undefined ? null : cards.length === 0 ? (
        <p className={account.fine}>No custom cards yet.</p>
      ) : (
        <ul className={styles.customList}>
          {cards.map((card) => (
            <li key={card.id} aria-label={card.name}>
              {hidden.has(card.id) ? (
                // The image route answers only at Godlike: SysOp below it sees words instead.
                <span className={styles.customHidden}>
                  The image shows at the Godlike tier.
                </span>
              ) : (
                <img
                  src={card.image_url}
                  alt={card.name}
                  width={149}
                  height={208}
                  loading="lazy"
                  onError={() =>
                    setHidden((current) => new Set(current).add(card.id))
                  }
                />
              )}
              <div>
                <strong>{card.name}</strong>
                <small>
                  {[card.mana_cost, card.type_line, card.rarity, card.set_code]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                {removing === card.id ? (
                  <div className={account.actions}>
                    <button
                      type="button"
                      className={account.danger}
                      onClick={() => void remove(card)}
                    >
                      Remove {card.name} for good
                    </button>
                    <button
                      type="button"
                      className={account.secondary}
                      onClick={() => setRemoving(undefined)}
                    >
                      Keep it
                    </button>
                  </div>
                ) : (
                  <div className={account.actions}>
                    <button
                      type="button"
                      className={account.secondary}
                      onClick={() => setRemoving(card.id)}
                    >
                      Remove {card.name}
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
