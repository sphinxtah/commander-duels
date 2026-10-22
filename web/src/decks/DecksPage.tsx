import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { client, describe, type Me } from "../api";
import { formatLabels } from "../catalog/catalog";
import { GuidedDialog } from "./GuidedDialog";
import { ImportDialog } from "./ImportDialog";
import { LockIcon, NeedsTags } from "./ProblemList";
import {
  type DeckEntry,
  type DeckFormat,
  type DeckSummary,
  type StarterDeck,
} from "./decks";
import styles from "./decks.module.css";

type View = "active" | "archived" | "trash";
type DeckState = "playable" | "locked" | "legal" | "draft";

const stateWords: Record<DeckState, string> = {
  playable: "Ready to play",
  locked: "Needs cards you don't own",
  legal: "Legal, not playable yet",
  draft: "Draft",
};

/** A deck's state in the list, with a padlock when the player's library holds it back. */
function StateBadge({ state }: { state: DeckState }) {
  return (
    <span className={styles.badge} data-state={state}>
      {state === "locked" && <LockIcon />}
      {stateWords[state]}
    </span>
  );
}

export function IdentityPips({ identity }: { identity: string }) {
  if (!identity)
    return (
      <span className={styles.pips} aria-label="Colorless">
        ◇
      </span>
    );
  return (
    <span
      className={styles.pips}
      aria-label={`Colors ${identity.split("").join(" ")}`}
    >
      {identity.split("").map((color) => (
        <span key={color} data-color={color} aria-hidden="true">
          {color}
        </span>
      ))}
    </span>
  );
}

export function DecksPage({
  me,
  heading,
}: {
  me: Me | null | undefined;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  if (me === undefined) return null;
  if (!me || me.status !== "active" || !me.permissions.includes("decks.edit"))
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>
          A strategy to call your own.
        </h1>
        <p className={styles.lead}>
          {me
            ? "Your account is waiting for approval."
            : "Sign in to build and save decks."}
        </p>
        {!me && (
          <a className={styles.primary} href="#profile">
            Sign in
          </a>
        )}
      </>
    );
  return (
    <Decks
      heading={heading}
      library={!me.permissions.includes("library.unlimited")}
    />
  );
}

/** Creates a deck and opens it. */
export async function createDeck(body: {
  title: string;
  format: DeckFormat;
  entries?: DeckEntry[];
  source?: {
    kind: "empty" | "starter" | "duplicate" | "imported" | "guided";
    starter?: string;
    deck_id?: string;
  };
}): Promise<string | undefined> {
  const { data, error } = await client.POST("/api/v1/decks", {
    body: {
      entries: [],
      notes: "",
      source: { kind: "empty" },
      ...body,
    } as never,
  });
  if (data) {
    window.location.hash = `#deck/${data.id}`;
    return undefined;
  }
  return describe(error);
}

function Decks({
  heading,
  library,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  /** The account builds from a library of its own (v0.3.1), not the whole catalog. */
  library: boolean;
}) {
  const [view, setView] = useState<View>("active");
  const [decks, setDecks] = useState<DeckSummary[]>();
  const [starters, setStarters] = useState<StarterDeck[]>([]);
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState<DeckFormat>("commander");
  const create = useRef<HTMLDialogElement>(null);
  const [importing, setImporting] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const lists = useRef(0);

  const refresh = useCallback(async () => {
    // Only the newest list may show: an older answer landing last (the list asked for after
    // an archive, once the player has moved to another tab) would put the wrong decks under it.
    const ticket = ++lists.current;
    const { data } = await client.GET("/api/v1/decks", {
      params: { query: { view } },
    });
    if (ticket === lists.current) setDecks(data ?? []);
  }, [view]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // An action's answer may land after the player moved to another tab; the list it asks for
  // then must be that tab's, so it reaches the refresh of the render on screen, not its own.
  const latestRefresh = useRef(refresh);
  useLayoutEffect(() => {
    latestRefresh.current = refresh;
  });
  useEffect(() => {
    void client
      .GET("/api/v1/decks/starters")
      .then(({ data }) => data && setStarters(data));
  }, []);

  async function act(
    deck: DeckSummary,
    action: "archive" | "unarchive" | "restore" | "delete" | "duplicate",
  ) {
    setMessage("");
    const path = { params: { path: { deck_id: deck.id } } };
    if (action === "duplicate") {
      const failure = await createDeck({
        title: `${deck.title.slice(0, 73)} (copy)`,
        format: deck.format,
        source: { kind: "duplicate", deck_id: deck.id },
      });
      if (failure) setMessage(failure);
      return;
    }
    const result =
      action === "delete"
        ? await client.DELETE("/api/v1/decks/{deck_id}", path)
        : action === "archive"
          ? await client.POST("/api/v1/decks/{deck_id}/archive", path)
          : action === "unarchive"
            ? await client.POST("/api/v1/decks/{deck_id}/unarchive", path)
            : await client.POST("/api/v1/decks/{deck_id}/restore", path);
    if (result.error) setMessage(describe(result.error));
    else
      setMessage(
        {
          delete: `${deck.title} is in the trash. Restore it from there.`,
          archive: `${deck.title} is archived.`,
          unarchive: `${deck.title} is back with your decks.`,
          restore: `${deck.title} is restored.`,
        }[action],
      );
    void latestRefresh.current();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const failure = await createDeck({
      title: title.trim() || "New deck",
      format,
    });
    if (failure) setMessage(failure);
  }

  return (
    <>
      <span className={styles.eyebrow}>YOUR DECKS</span>
      <h1 ref={heading} tabIndex={-1}>
        A strategy to call your own.
      </h1>
      <p className={styles.lead}>
        {library ? (
          <>
            Build Commander and Legacy decks from your card library (see it
            under <a href="#cards">Cards</a>, My library), check them against
            the format's rules, and take them to the practice table.
          </>
        ) : (
          "Build Commander and Legacy decks from the whole card catalog, check them against the format's rules, and take them to the practice table."
        )}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={() => create.current?.showModal()}
        >
          New deck
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => setGuiding(true)}
        >
          Build one with help
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => setImporting(true)}
        >
          Import a list
        </button>
      </div>
      {message && (
        <p role="status" className={styles.message}>
          {message}
        </p>
      )}
      <div className={styles.tabs} role="tablist" aria-label="Which decks">
        {(["active", "archived", "trash"] as View[]).map((item) => (
          <button
            key={item}
            role="tab"
            type="button"
            aria-selected={view === item}
            onClick={() => setView(item)}
          >
            {
              { active: "Your decks", archived: "Archived", trash: "Trash" }[
                item
              ]
            }
          </button>
        ))}
      </div>
      {!decks ? (
        <p role="status">Loading your decks…</p>
      ) : decks.length === 0 ? (
        <p className={styles.hint}>
          {view === "active"
            ? "No decks yet. Start one, copy a starter deck below, or import a list."
            : view === "archived"
              ? "No archived decks."
              : "The trash is empty."}
        </p>
      ) : (
        <ul className={styles.deckList}>
          {decks.map((deck) => (
            <li key={deck.id}>
              <div>
                <a
                  href={view === "trash" ? undefined : `#deck/${deck.id}`}
                  className={styles.deckTitle}
                >
                  {deck.title}
                </a>
                <span className={styles.deckMeta}>
                  {formatLabels[deck.format]} ·{" "}
                  <IdentityPips identity={deck.identity} /> · {deck.card_count}{" "}
                  cards
                  {deck.commanders.length > 0 &&
                    ` · ${deck.commanders.join(" & ")}`}
                  {/* v0.4.5: the editor's note says which, and why. */}
                  {deck.removed_cards.length > 0 &&
                    ` · ${deck.removed_cards.length} ${deck.removed_cards.length === 1 ? "card" : "cards"} left the game`}
                </span>
                <NeedsTags needs={deck.needs} format={deck.format} />
              </div>
              <StateBadge
                state={
                  deck.playable
                    ? "playable"
                    : deck.collection_locked
                      ? "locked"
                      : deck.legal
                        ? "legal"
                        : "draft"
                }
              />
              <div className={styles.rowActions}>
                {view === "trash" ? (
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => void act(deck, "restore")}
                  >
                    Restore
                  </button>
                ) : (
                  <>
                    <a className={styles.secondary} href={`#deck/${deck.id}`}>
                      Open
                    </a>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => void act(deck, "duplicate")}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() =>
                        void act(
                          deck,
                          view === "archived" ? "unarchive" : "archive",
                        )
                      }
                    >
                      {view === "archived" ? "Unarchive" : "Archive"}
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => void act(deck, "delete")}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {starters.length > 0 && view === "active" && (
        <section className={styles.starters} aria-labelledby="starters-title">
          <h2 id="starters-title">Starter decks</h2>
          <p className={styles.hint}>
            {library
              ? "The ten Commander starter decks. The two you chose are among your decks already, and every copy of their cards is in your library for good. Any of them can be copied; a copy of one you did not choose holds cards you don't own, so it cannot start a game."
              : "The ten Commander starter decks. Copy one to make it yours, then change anything."}
          </p>
          <ul>
            {/* The player's own two first, then the rest in their order. */}
            {[...starters]
              .sort((a, b) => Number(b.chosen) - Number(a.chosen))
              .map((starter) => (
                <li key={starter.name}>
                  <div>
                    <strong className={styles.deckTitle}>
                      {starter.title}
                    </strong>
                    <span className={styles.deckMeta}>
                      {formatLabels[starter.format]} ·{" "}
                      <IdentityPips identity={starter.colors} /> {starter.guild}{" "}
                      ({starter.color_names}) · {starter.commanders.join(" & ")}{" "}
                      · {starter.card_count} cards
                    </span>
                    <p className={styles.starterAbout}>{starter.description}</p>
                    <details className={styles.starterMore}>
                      <summary>How to play it</summary>
                      <p>{starter.how_to_play}</p>
                      <p>
                        <strong>It teaches:</strong> {starter.teaches}
                      </p>
                    </details>
                  </div>
                  {starter.chosen && (
                    <span className={styles.badge} data-state="chosen">
                      One of your two
                    </span>
                  )}
                  {!starter.playable && (
                    <StateBadge state={starter.chosen ? "legal" : "locked"} />
                  )}
                  {/* Ten buttons that say Copy: each names its deck to a screen reader. */}
                  <button
                    type="button"
                    className={styles.secondary}
                    aria-label={`Copy ${starter.title}`}
                    onClick={() =>
                      void createDeck({
                        title: starter.title,
                        format: starter.format,
                        source: { kind: "starter", starter: starter.name },
                      }).then((failure) => failure && setMessage(failure))
                    }
                  >
                    Copy
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}
      <dialog
        ref={create}
        className={styles.dialog}
        aria-labelledby="new-deck-title"
      >
        <form onSubmit={submit} method="dialog">
          <h2 id="new-deck-title">A new deck</h2>
          <label className={styles.field}>
            <span>Name</span>
            <input
              value={title}
              maxLength={80}
              placeholder="New deck"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <fieldset className={styles.formats}>
            <legend>Format</legend>
            {(["commander", "legacy"] as DeckFormat[]).map((item) => (
              <label key={item}>
                <input
                  type="radio"
                  name="new-format"
                  checked={format === item}
                  onChange={() => setFormat(item)}
                />
                <span>
                  <strong>{formatLabels[item]}</strong>
                  <small>
                    {item === "commander"
                      ? "A commander and 99 cards, one of each"
                      : "60 cards or more, up to four of each"}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <div className={styles.actions}>
            <button type="submit" className={styles.primary}>
              Create
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => create.current?.close()}
            >
              Cancel
            </button>
          </div>
        </form>
      </dialog>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {guiding && <GuidedDialog onClose={() => setGuiding(false)} />}
    </>
  );
}
