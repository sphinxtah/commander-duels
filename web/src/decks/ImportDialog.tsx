import { useEffect, useRef, useState } from "react";
import { client, describe } from "../api";
import { formatLabels } from "../catalog/catalog";
import { createDeck } from "./DecksPage";
import { ProblemList } from "./ProblemList";
import {
  merge,
  type DeckEntry,
  type DeckFormat,
  type ImportLine,
  type ImportPreview,
} from "./decks";
import styles from "./decks.module.css";

const MAX_FILE = 256 * 1024;

/** Paste or open a deck list, see how each line resolves, then save it as a new deck. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<DeckFormat>("commander");
  const [text, setText] = useState("");
  const [file, setFile] = useState<{
    name: string;
    json: boolean;
    content: string;
  }>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);

  async function read(chosen: File | undefined) {
    setError("");
    if (!chosen) return;
    if (chosen.size > MAX_FILE) {
      setError("A deck file is at most 256 KB.");
      return;
    }
    const content = await chosen.text();
    const json =
      chosen.name.toLowerCase().endsWith(".json") ||
      content.trimStart().startsWith("{");
    setFile({ name: chosen.name, json, content });
  }

  async function check() {
    setError("");
    setBusy(true);
    const body = file?.json
      ? { format, json_text: file.content, text: "" }
      : { format, text: file?.content ?? text, json_text: "" };
    const { data, error: failure } = await client.POST(
      "/api/v1/decks/import/preview",
      { body },
    );
    setBusy(false);
    if (!data) {
      setError(describe(failure));
      return;
    }
    setPreview(data);
    setChoices({});
    if (data.title && !title) setTitle(data.title);
    if (data.format !== format) setFormat(data.format);
  }

  function chosenEntries(): DeckEntry[] {
    if (!preview) return [];
    const extra: DeckEntry[] = [];
    for (const line of preview.lines) {
      const chosen = choices[line.line];
      if (line.status !== "resolved" && chosen)
        extra.push({
          card_id: chosen,
          printing_id: null,
          quantity: line.quantity,
          location: line.location,
        });
    }
    return merge([...preview.entries, ...extra]);
  }

  async function save() {
    setBusy(true);
    const failure = await createDeck({
      title: title.trim() || "Imported deck",
      format,
      entries: chosenEntries(),
      source: { kind: "imported" },
    });
    setBusy(false);
    if (failure) setError(failure);
  }

  const open =
    preview?.lines.filter((line) => line.status !== "resolved") ?? [];
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="import-title"
      onClose={onClose}
    >
      <h2 id="import-title">Import a deck list</h2>
      <p className={styles.hint}>
        One card per line ("4 Lightning Bolt"), with Commander, Deck, Sideboard,
        Companion and Maybeboard headings if you like, or a Commander Duels deck
        file. Nothing is saved until you create the deck.
      </p>
      <fieldset className={styles.formats}>
        <legend>Format</legend>
        {(["commander", "legacy"] as DeckFormat[]).map((item) => (
          <label key={item}>
            <input
              type="radio"
              name="import-format"
              checked={format === item}
              onChange={() => setFormat(item)}
            />
            <span>
              <strong>{formatLabels[item]}</strong>
            </span>
          </label>
        ))}
      </fieldset>
      <label className={styles.field}>
        <span>Deck list</span>
        <textarea
          rows={10}
          value={file ? "" : text}
          disabled={Boolean(file)}
          placeholder={
            "Commander\n1 Kenrith, the Returned King\n\nDeck\n1 Sol Ring\n98 Wastes"
          }
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className={styles.actions}>
        <label className={styles.secondary}>
          {file ? `File: ${file.name}` : "Open a file…"}
          <input
            type="file"
            accept=".txt,.dec,.dek,.json,text/plain,application/json"
            className={styles.visuallyHidden}
            onChange={(event) => void read(event.target.files?.[0])}
          />
        </label>
        {file && (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setFile(undefined)}
          >
            Use the text box instead
          </button>
        )}
        <button
          type="button"
          className={styles.primary}
          disabled={busy || (!file && !text.trim())}
          onClick={() => void check()}
        >
          {busy ? "Reading…" : "Preview"}
        </button>
      </div>
      {error && (
        <p role="alert" className={styles.refusal}>
          {error}
        </p>
      )}
      {preview && (
        <section aria-labelledby="preview-title" className={styles.preview}>
          <h3 id="preview-title">
            {preview.lines.length} lines · {preview.unresolved} not found ·{" "}
            {preview.ambiguous} with several matches
          </h3>
          {open.length > 0 && (
            <ul className={styles.resolutions}>
              {open.map((line: ImportLine) => (
                <li key={line.line}>
                  <span>
                    Line {line.line}: <code>{line.text}</code>{" "}
                    {line.status === "ambiguous"
                      ? "matches several cards."
                      : "matches no card."}
                  </span>
                  <select
                    aria-label={`Card for line ${line.line}`}
                    value={choices[line.line] ?? ""}
                    onChange={(event) =>
                      setChoices((current) => ({
                        ...current,
                        [line.line]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Leave it out</option>
                    {(line.candidates ?? []).map((card) => (
                      <option key={card.id} value={card.id}>
                        {card.name} — {card.type_line}
                        {card.playable ? "" : " (not playable yet)"}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
          <ProblemList validation={preview.validation} cards={preview.cards} />
          <label className={styles.field}>
            <span>Deck name</span>
            <input
              value={title}
              maxLength={80}
              placeholder="Imported deck"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => void save()}
            >
              Create the deck
            </button>
          </div>
        </section>
      )}
      <button
        type="button"
        className={styles.close}
        aria-label="Close the import"
        onClick={() => dialog.current?.close()}
      >
        ×
      </button>
    </dialog>
  );
}
