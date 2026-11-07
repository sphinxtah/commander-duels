import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";
import { OFFICIAL_BACK, backUrl } from "../game/cardBack";
import styles from "./sleeves.module.css";

type Sleeves = components["schemas"]["Sleeves"];
type Sleeve = components["schemas"]["Sleeve"];

/** Five MB, as the server counts it. */
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = "image/png,image/jpeg,image/bmp";

/** The file as base64, without the data URL's prefix: what the API's JSON carries. */
function base64Of(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * The deck's card sleeve (v0.8.9, api/sleeves.py): the picture on the backs of its cards at a
 * table, which everyone there sees. The official back, a campaign back the account has earned,
 * or one of up to 20 sleeves the player uploads here.
 */
export function SleevePicker({
  deckId,
  current,
  onChange,
}: {
  deckId: string;
  current: string | null;
  onChange: (sleeve: string | null) => void;
}) {
  const id = useId();
  const [sleeves, setSleeves] = useState<Sleeves>();
  const [backNames, setBackNames] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [{ data }, { data: cosmetics }] = await Promise.all([
      client.GET("/api/v1/me/sleeves"),
      client.GET("/api/v1/me/cosmetics"),
    ]);
    if (data) setSleeves(data);
    if (cosmetics)
      setBackNames(
        Object.fromEntries(
          cosmetics.card_backs.map((back) => [back.id, back.name]),
        ),
      );
  }, []);

  useEffect(() => {
    void load().catch(() => setError(describe(undefined)));
  }, [load]);

  async function choose(sleeve: string | null) {
    setError("");
    setMessage("");
    const { data, error: refused } = await client.PUT(
      "/api/v1/decks/{deck_id}/sleeve",
      { params: { path: { deck_id: deckId } }, body: { sleeve } },
    );
    if (!data) return setError(describe(refused));
    onChange(data.sleeve ?? null);
    setMessage("Sleeve chosen. Games you start from now on show it.");
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (!file) return setError("Choose a picture first.");
    if (file.size > MAX_BYTES)
      return setError("The picture is larger than 5 MB. Choose a smaller one.");
    setBusy(true);
    try {
      const image = await base64Of(file);
      const { data, error: refused } = await client.POST("/api/v1/me/sleeves", {
        body: { name: name.trim() || file.name.slice(0, 40), image },
      });
      if (!data) return setError(describe(refused));
      setName("");
      setFile(null);
      (event.target as HTMLFormElement).reset();
      await load();
      await choose(`sleeve:${data.id}`);
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }

  async function remove(sleeve: Sleeve) {
    setError("");
    setMessage("");
    const { response } = await client.DELETE("/api/v1/me/sleeves/{sleeve_id}", {
      params: { path: { sleeve_id: sleeve.id } },
    });
    if (!response.ok) return setError(describe(undefined));
    if (current === `sleeve:${sleeve.id}`) onChange(null);
    setMessage(`${sleeve.name} deleted.`);
    await load();
  }

  const held = sleeves?.sleeves.filter((sleeve) => !sleeve.removed) ?? [];
  const removed = sleeves?.sleeves.filter((sleeve) => sleeve.removed) ?? [];
  const full = sleeves ? held.length >= sleeves.limit : false;

  const option = (
    value: string | null,
    picture: string,
    label: string,
    extra?: ReactNode,
  ) => (
    <li key={value ?? "official"} className={styles.choice}>
      <button
        type="button"
        className={styles.sleeveButton}
        aria-pressed={current === value}
        onClick={() => void choose(value)}
      >
        <img src={picture} alt="" width={63} height={88} loading="lazy" />
        <span>{label}</span>
      </button>
      {extra}
    </li>
  );

  return (
    <section className={styles.sleeves} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Card sleeve</h3>
      <p className={styles.fine}>
        The backs of this deck's cards at a table. Everyone at the table sees
        them, and may report a picture that does not belong there.
      </p>
      {!sleeves && !error && <p role="status">Opening your sleeves…</p>}
      {sleeves && (
        <ul className={styles.grid} aria-label="Sleeves">
          {option(null, OFFICIAL_BACK, "Official card back")}
          {sleeves.defaults.map((found) =>
            option(`default:${found.id}`, found.url, found.name),
          )}
          {sleeves.backs.map((slug) =>
            option(
              `back:${slug}`,
              backUrl(slug),
              backNames[slug] ?? slug.replace(/-/g, " "),
            ),
          )}
          {held.map((sleeve) =>
            option(
              `sleeve:${sleeve.id}`,
              sleeve.url,
              sleeve.name,
              <button
                type="button"
                className={styles.deleteSleeve}
                aria-label={`Delete ${sleeve.name}`}
                title="Delete this sleeve"
                onClick={() => void remove(sleeve)}
              >
                ×
              </button>,
            ),
          )}
        </ul>
      )}
      {removed.length > 0 && (
        <p className={styles.fine}>
          A moderator removed {removed.map((sleeve) => sleeve.name).join(", ")}{" "}
          after a report: {removed.length === 1 ? "it shows" : "they show"} on
          no table.
        </p>
      )}
      {sleeves && (
        <form
          className={styles.upload}
          onSubmit={(event) => void upload(event)}
        >
          <label>
            <span>Name</span>
            <input
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder="My sleeve"
            />
          </label>
          <label>
            <span>Picture (PNG, BMP or JPG, up to 5 MB)</span>
            <input
              type="file"
              accept={ACCEPTED}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="submit"
            className={styles.uploadButton}
            disabled={busy || full}
          >
            {busy ? "Uploading…" : "Upload and use"}
          </button>
          <p className={styles.fine}>
            {held.length} of {sleeves.limit} sleeves.{" "}
            {full
              ? "Delete one to upload another."
              : "The picture is cropped about its centre to a card's shape."}
          </p>
        </form>
      )}
      {message && (
        <p role="status" className={styles.fine}>
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  );
}
