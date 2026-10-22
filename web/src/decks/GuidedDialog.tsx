import { useEffect, useRef, useState } from "react";
import { client, describe } from "../api";
import {
  colorWords,
  emptySearch,
  formatLabels,
  type CardSummary,
} from "../catalog/catalog";
import { useCardSearch } from "../catalog/SearchControls";
import { createDeck } from "./DecksPage";
import { ProblemList } from "./ProblemList";
import type { DeckFormat, GuidedRequest, GuidedResult } from "./decks";
import styles from "./decks.module.css";

const themes: { id: GuidedRequest["theme"]; name: string; about: string }[] = [
  { id: "aggro", name: "Aggro", about: "Cheap creatures that attack early" },
  { id: "midrange", name: "Midrange", about: "Solid creatures and answers" },
  {
    id: "control",
    name: "Control",
    about: "Counterspells, removal and card draw",
  },
  { id: "tokens", name: "Tokens", about: "Cards that make creature tokens" },
  { id: "counters", name: "+1/+1 counters", about: "Growing your creatures" },
  {
    id: "graveyard",
    name: "Graveyard",
    about: "Using cards from the graveyard",
  },
  { id: "spells", name: "Spells", about: "Instants and sorceries" },
  { id: "ramp", name: "Ramp", about: "Extra mana, then big spells" },
  { id: "tribal", name: "Tribal", about: "One creature type" },
  {
    id: "artifacts",
    name: "Artifacts",
    about: "Artifacts and what rewards them",
  },
  {
    id: "enchantments",
    name: "Enchantments",
    about: "Enchantments and what rewards them",
  },
  {
    id: "lifegain",
    name: "Life gain",
    about: "Gaining life, and what rewards it",
  },
];

/** DECK06: a starting deck from a few choices, every card explained, nothing saved until asked. */
export function GuidedDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<DeckFormat>("commander");
  const [name, setName] = useState("");
  const [leader, setLeader] = useState<CardSummary>();
  const [partner, setPartner] = useState<CardSummary>();
  const [colors, setColors] = useState("");
  const [theme, setTheme] = useState<GuidedRequest["theme"]>("midrange");
  const [tribe, setTribe] = useState("");
  const [experience, setExperience] =
    useState<GuidedRequest["experience"]>("new");
  const [result, setResult] = useState<GuidedResult>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);
  // Commanders from the player's library, as the proposal's cards are (v0.3.1); an account that
  // builds from the whole catalog searches all of it, the server setting `owned` aside.
  const leaders = useCardSearch(
    {
      ...emptySearch,
      q: name.trim() ? name.trim() : "",
      sort: "popularity",
      owned: true,
    },
    1,
    8,
    {
      q: leader ? "is:partner" : "is:commander",
      legal: "commander",
    },
  );

  async function propose() {
    setError("");
    setBusy(true);
    const body: GuidedRequest = {
      format,
      theme,
      experience,
      tribe: theme === "tribal" ? tribe.trim() || null : null,
      commander_id: format === "commander" ? (leader?.id ?? null) : null,
      partner_id: format === "commander" ? (partner?.id ?? null) : null,
      colors: format === "legacy" ? colors || null : null,
    };
    const { data, error: failure } = await client.POST("/api/v1/decks/guided", {
      body,
    });
    setBusy(false);
    if (data) setResult(data);
    else setError(describe(failure));
  }

  async function keep() {
    if (!result) return;
    const failure = await createDeck({
      title: result.title,
      format: result.format,
      entries: result.entries,
      source: { kind: "guided" },
    });
    if (failure) setError(failure);
  }

  const groups = new Map<string, { names: string[]; count: number }>();
  for (const item of result?.suggestions ?? []) {
    const group = groups.get(item.reason) ?? { names: [], count: 0 };
    group.names.push(
      item.quantity > 1 ? `${item.quantity} ${item.name}` : item.name,
    );
    group.count += item.quantity;
    groups.set(item.reason, group);
  }
  const ready = format === "legacy" ? true : Boolean(leader);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="guided-title"
      onClose={onClose}
    >
      <h2 id="guided-title">Build a deck with help</h2>
      <p className={styles.hint}>
        Choose a direction and get a starting deck of playable cards from your
        library, each with the reason it was picked. The rules are simple and
        written down; they make a start, not a promise of a strong deck.
      </p>
      <fieldset className={styles.formats}>
        <legend>Format</legend>
        {(["commander", "legacy"] as DeckFormat[]).map((item) => (
          <label key={item}>
            <input
              type="radio"
              name="guided-format"
              checked={format === item}
              onChange={() => setFormat(item)}
            />
            <span>
              <strong>{formatLabels[item]}</strong>
            </span>
          </label>
        ))}
      </fieldset>
      {format === "commander" ? (
        <div className={styles.step}>
          <label className={styles.field}>
            <span>{leader ? "A partner (optional)" : "Your commander"}</span>
            <input
              type="search"
              value={name}
              placeholder={
                leader
                  ? "Search for a partner"
                  : "Search for a legendary creature"
              }
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {leader && (
            <p>
              Commander: <strong>{leader.name}</strong> (
              {colorWords(leader.color_identity)})
              {partner && (
                <>
                  {" "}
                  and <strong>{partner.name}</strong>
                </>
              )}{" "}
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  setLeader(undefined);
                  setPartner(undefined);
                }}
              >
                Change
              </button>
            </p>
          )}
          {(!leader || (leader.partner && !partner)) && (
            <ul className={styles.picks}>
              {(leaders.results?.items ?? []).map((card) => (
                <li key={card.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!leader) setLeader(card);
                      else setPartner(card);
                      setName("");
                    }}
                  >
                    {card.name} <small>{colorWords(card.color_identity)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <fieldset className={styles.step}>
          <legend>Colors</legend>
          {["W", "U", "B", "R", "G"].map((color) => (
            <label key={color} className={styles.pip} data-color={color}>
              <input
                type="checkbox"
                checked={colors.includes(color)}
                onChange={() =>
                  setColors((value) =>
                    value.includes(color)
                      ? value.replace(color, "")
                      : value + color,
                  )
                }
              />
              <span title={colorWords(color)}>{color}</span>
              <span className={styles.visuallyHidden}>{colorWords(color)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className={styles.themes}>
        <legend>Theme</legend>
        {themes.map((item) => (
          <label key={item.id}>
            <input
              type="radio"
              name="guided-theme"
              checked={theme === item.id}
              onChange={() => setTheme(item.id)}
            />
            <span>
              <strong>{item.name}</strong>
              <small>{item.about}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {theme === "tribal" && (
        <label className={styles.field}>
          <span>Creature type</span>
          <input
            value={tribe}
            maxLength={40}
            placeholder="Elf, Goblin, Dragon"
            onChange={(event) => setTribe(event.target.value)}
          />
        </label>
      )}
      <fieldset className={styles.formats}>
        <legend>Experience</legend>
        <label>
          <input
            type="radio"
            name="guided-experience"
            checked={experience === "new"}
            onChange={() => setExperience("new")}
          />
          <span>
            <strong>New to the game</strong>
            <small>Simpler cards first</small>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="guided-experience"
            checked={experience === "experienced"}
            onChange={() => setExperience("experienced")}
          />
          <span>
            <strong>Experienced</strong>
            <small>The most popular cards first</small>
          </span>
        </label>
      </fieldset>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || !ready}
          onClick={() => void propose()}
        >
          {busy
            ? "Choosing cards…"
            : result
              ? "Choose again"
              : "Suggest a deck"}
        </button>
      </div>
      {error && (
        <p role="alert" className={styles.refusal}>
          {error}
        </p>
      )}
      {result && (
        <section aria-labelledby="proposal-title" className={styles.preview}>
          <h3 id="proposal-title">{result.title}</h3>
          <p className={styles.hint}>{result.note}</p>
          <ProblemList validation={result.validation} cards={result.cards} />
          <ul className={styles.reasons}>
            {[...groups.entries()].map(([reason, group]) => (
              <li key={reason}>
                <strong>
                  {group.count} · {reason}
                </strong>
                <span>{group.names.join(", ")}</span>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void keep()}
            >
              Keep it as a new deck
            </button>
          </div>
        </section>
      )}
      <button
        type="button"
        className={styles.close}
        aria-label="Close"
        onClick={() => dialog.current?.close()}
      >
        ×
      </button>
    </dialog>
  );
}
