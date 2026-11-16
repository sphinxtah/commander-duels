import { useId, useState } from "react";
import game from "../game/game.module.css";
import {
  BLANK_PROFILE,
  DURATIONS,
  GAME_CHANGER_LIMITS,
  INTENTS,
  INTENT_NAMES,
  INTENT_WORDS,
  NOTE_LIMIT,
  PACES,
  PACE_WORDS,
  describedWords,
  durationWords,
  findPreset,
  plain,
  presetKey,
  profileChanges,
  sameProfile,
  usePresets,
  type Duration,
  type Intent,
  type Pace,
  type Presets,
  type Profile,
  type ProfileView,
} from "./profile";
import styles from "./tables.module.css";

// Rule Zero at the table (v1.0.0, docs/tables.md): how a table's profile is shown and written.
// Everywhere a profile appears its two parts stand apart, each under its own words and its own
// mark, never told by colour alone: what the host **describes** (nothing checks it; the players
// agree to it by getting ready) and what the server **checks on every deck**.

const DESCRIBED = "Described by the host";
const DESCRIBED_NOTE =
  "Nothing checks this. Players agree to it by getting ready.";
const ENFORCED = "Checked on every deck";
const ENFORCED_NOTE =
  "The server refuses a deck that breaks one of these: as it sits down, as its player gets ready, and at the start.";
const NOTHING_ENFORCED = "Nothing: any deck the format takes may sit down.";

/** A table's profile on the table's own page: the two parts side by side, each under its name. */
export function ProfilePanel({ profile }: { profile: ProfileView }) {
  return (
    <section className={styles.profile} aria-labelledby="profile-title">
      <h2 id="profile-title">What this table is for</h2>
      <div className={styles.profileParts}>
        <div className={styles.profilePart} data-part="described">
          <h3>
            <span aria-hidden="true">✎</span> {DESCRIBED}
          </h3>
          <p className={styles.partNote}>{DESCRIBED_NOTE}</p>
          <dl>
            <div>
              <dt>Kind of game</dt>
              <dd>{profile.intent_name}</dd>
            </div>
            <div>
              <dt>Pace</dt>
              <dd>{profile.pace_name ?? "Not said"}</dd>
            </div>
            <div>
              <dt>Expected length</dt>
              <dd>
                {profile.duration
                  ? durationWords(profile.duration)
                  : "Not said"}
              </dd>
            </div>
            {profile.note && (
              <div>
                <dt>The host&apos;s note</dt>
                <dd>“{profile.note}”</dd>
              </div>
            )}
          </dl>
        </div>
        <div className={styles.profilePart} data-part="enforced">
          <h3>
            <span aria-hidden="true">✓</span> {ENFORCED}
          </h3>
          <p className={styles.partNote}>{ENFORCED_NOTE}</p>
          {profile.enforced_rules.length > 0 ? (
            <ul aria-label={ENFORCED}>
              {profile.enforced_rules.map((rule) => (
                <li key={rule.code}>{rule.text}</li>
              ))}
            </ul>
          ) : (
            <p>{NOTHING_ENFORCED}</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** A table's profile on its card in the lobby: one line a part, each saying which it is. */
export function ProfileSummary({ profile }: { profile: ProfileView }) {
  return (
    <div className={styles.cardProfile}>
      <p data-part="described">
        <strong>
          <span aria-hidden="true">✎</span> Host describes:
        </strong>{" "}
        {describedWords(profile).join(" · ")}
        {profile.note && <q>{profile.note}</q>}
      </p>
      <p data-part="enforced">
        <strong>
          <span aria-hidden="true">✓</span> {ENFORCED}:
        </strong>{" "}
        {profile.enforced_rules.length > 0
          ? profile.enforced_rules.map((rule) => rule.text).join("; ")
          : "nothing beyond the format"}
      </p>
    </div>
  );
}

/** Where a host starts a profile from: none, one of the six built in, or a table they saved. */
export function PresetSelect({
  presets,
  value,
  onChange,
  none = "No description: any deck the table's rules take",
}: {
  presets: Presets | null;
  /** "" for no profile, else a preset's key. */
  value: string;
  onChange: (key: string) => void;
  /** What choosing no profile is called. */
  none?: string;
}) {
  return (
    <label className={game.field}>
      <span>Start from</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{none}</option>
        <optgroup label="Built in">
          {(presets?.built_in ?? []).map((preset) => (
            <option key={presetKey(preset)} value={presetKey(preset)}>
              {preset.name}
            </option>
          ))}
        </optgroup>
        {presets && presets.saved.length > 0 && (
          <optgroup label="Your saved tables">
            {presets.saved.map((preset) => (
              <option key={presetKey(preset)} value={presetKey(preset)}>
                {preset.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** The profile's editor: the described part, then the enforced one, each a group of its own
 * that says who holds the players to it. */
export function ProfileFields({
  profile,
  onChange,
  disabled = false,
}: {
  profile: Profile;
  onChange: (profile: Profile) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const enforced = plain(profile).enforced!;
  const set = (change: Partial<Profile>) => onChange({ ...profile, ...change });
  const enforce = (change: Partial<typeof enforced>) =>
    set({ enforced: { ...enforced, ...change } });
  return (
    <>
      <fieldset
        className={styles.profileEditor}
        data-part="described"
        disabled={disabled}
      >
        <legend>
          <span aria-hidden="true">✎</span> Described: what you tell the players
        </legend>
        <p className={styles.partNote}>{DESCRIBED_NOTE}</p>
        {/* What a choice means stands beside its field as its description, not in its name. */}
        <div className={game.field}>
          <label htmlFor={`${id}-intent`}>Kind of game</label>
          <select
            id={`${id}-intent`}
            value={profile.intent}
            aria-describedby={`${id}-intent-words`}
            onChange={(event) => set({ intent: event.target.value as Intent })}
          >
            {INTENTS.map((intent) => (
              <option key={intent} value={intent}>
                {INTENT_NAMES[intent]}
              </option>
            ))}
          </select>
          <small id={`${id}-intent-words`}>
            {INTENT_WORDS[profile.intent]}
          </small>
        </div>
        <label className={game.field}>
          <span>Pace</span>
          <select
            value={profile.pace ?? ""}
            onChange={(event) =>
              set({ pace: (event.target.value || null) as Pace | null })
            }
          >
            <option value="">Not said</option>
            {PACES.map((pace) => (
              <option key={pace} value={pace}>
                {PACE_WORDS[pace]}
              </option>
            ))}
          </select>
        </label>
        <label className={game.field}>
          <span>Expected length</span>
          <select
            value={profile.duration ?? ""}
            onChange={(event) =>
              set({
                duration: event.target.value
                  ? (Number(event.target.value) as Duration)
                  : null,
              })
            }
          >
            <option value="">Not said</option>
            {DURATIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {durationWords(minutes).replace(/^a/, "A")}
              </option>
            ))}
          </select>
        </label>
        <div className={`${game.field} ${styles.profileNote}`}>
          <label htmlFor={`${id}-note`}>A note in your own words</label>
          <textarea
            id={`${id}-note`}
            rows={2}
            maxLength={NOTE_LIMIT}
            value={profile.note ?? ""}
            aria-describedby={`${id}-note-count`}
            placeholder="What players should know before they sit down"
            onChange={(event) => set({ note: event.target.value })}
          />
          <small id={`${id}-note-count`}>
            {(profile.note ?? "").length} of {NOTE_LIMIT} characters
          </small>
        </div>
      </fieldset>
      <fieldset
        className={styles.profileEditor}
        data-part="enforced"
        disabled={disabled}
      >
        <legend>
          <span aria-hidden="true">✓</span> Enforced: cards the server lets a
          deck hold
        </legend>
        <p className={styles.partNote}>
          Checked on every deck, yours too, beside the table&apos;s own rules. A
          deck that breaks one cannot sit down, get ready or start.
        </p>
        <label className={game.choice}>
          <input
            type="checkbox"
            checked={enforced.custom_cards}
            onChange={(event) =>
              enforce({ custom_cards: event.target.checked })
            }
          />
          <span>
            <strong>Custom cards</strong>
            <small>The game&apos;s own cards of the Godlike tier</small>
          </span>
        </label>
        <label className={game.choice}>
          <input
            type="checkbox"
            checked={enforced.reserved_list}
            onChange={(event) =>
              enforce({ reserved_list: event.target.checked })
            }
          />
          <span>
            <strong>Reserved List cards</strong>
            <small>The old cards that are never printed again</small>
          </span>
        </label>
        <div className={game.field}>
          <label htmlFor={`${id}-changers`}>
            Game Changers a deck may hold
          </label>
          <select
            id={`${id}-changers`}
            value={enforced.game_changers ?? ""}
            aria-describedby={`${id}-changers-words`}
            onChange={(event) =>
              enforce({
                game_changers:
                  event.target.value === "" ? null : Number(event.target.value),
              })
            }
          >
            <option value="">Any number</option>
            {GAME_CHANGER_LIMITS.map((most) => (
              <option key={most} value={most}>
                {most === 0 ? "None" : `At most ${most}`}
              </option>
            ))}
          </select>
          <small id={`${id}-changers-words`}>
            Commander&apos;s list of its strongest cards, counted by the copy
          </small>
        </div>
      </fieldset>
    </>
  );
}

/**
 * What a seated player must read before getting ready again: the host changed what the table is
 * for (the specification's "explicit acknowledgment of changed rules"). It says what differs
 * from the profile this browser last showed as read, by part; without one, that the profile
 * below is the table's now. Its button is the acknowledgement: it gets the player ready and says
 * they have read it.
 */
export function ProfileChanged({
  before,
  after,
  busy,
  onReady,
}: {
  /** The profile last read here; undefined when this browser kept none. */
  before: ProfileView | null | undefined;
  after: ProfileView | null;
  busy: boolean;
  onReady: () => void;
}) {
  const changes =
    before === undefined ? null : profileChanges(before, after ?? null);
  const parts = (["described", "enforced"] as const).map((part) => ({
    part,
    lines: (changes ?? []).filter((change) => change.part === part),
  }));
  return (
    <section
      className={styles.changed}
      aria-labelledby="changed-title"
      role="status"
    >
      <h2 id="changed-title">The host changed what this table is for</h2>
      {after === null ? (
        <p>
          The host took the table&apos;s description away. Only the table&apos;s
          own rules are checked on a deck now.
        </p>
      ) : changes && changes.length > 0 ? (
        <p>You were ready for the table as it was. This is what differs:</p>
      ) : (
        <p>
          You were ready for the table as it was. Read what it is for now,
          above: what the host describes, and what is checked on every deck.
        </p>
      )}
      {parts.map(
        ({ part, lines }) =>
          lines.length > 0 && (
            <div key={part} className={styles.changedPart} data-part={part}>
              <h3>
                <span aria-hidden="true">
                  {part === "described" ? "✎" : "✓"}
                </span>{" "}
                {part === "described" ? DESCRIBED : ENFORCED}
              </h3>
              <ul>
                {lines.map((line) => (
                  <li key={line.text}>{line.text}</li>
                ))}
              </ul>
            </div>
          ),
      )}
      <button
        type="button"
        className={game.primaryButton}
        disabled={busy}
        onClick={onReady}
      >
        I have read it: ready
      </button>
      <small>
        Your deck is checked again as you get ready. If it no longer fits,
        choose another first.
      </small>
    </section>
  );
}

/**
 * The host's own change to an open table's profile: describing a table that had none, changing
 * it, or taking it away. Any change makes every player not ready again, and each of them reads
 * it before getting ready.
 */
export function HostProfile({
  current,
  busy,
  onSave,
}: {
  current: ProfileView | null;
  busy: boolean;
  /** Sends the profile from now on (null takes it away); true when the table took it. */
  onSave: (profile: Profile | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const title = current
    ? "Change what the table is for"
    : "Describe this table";
  return (
    <section className={styles.hostPanel} aria-labelledby="host-profile">
      <h2 id="host-profile">{title}</h2>
      {open ? (
        <HostProfileForm
          current={current}
          busy={busy}
          onSave={onSave}
          onClose={() => setOpen(false)}
        />
      ) : (
        <>
          <p className={game.hint}>
            {current
              ? "Any change, the note included, makes every player not ready again, and each of them reads it before getting ready."
              : "Say what kind of game this is, and which cards the server lets a deck hold. Players see both before they sit down."}
          </p>
          <button
            type="button"
            className={game.secondaryButton}
            disabled={busy}
            onClick={() => setOpen(true)}
          >
            {current ? "Change it" : "Describe it"}
          </button>
        </>
      )}
    </section>
  );
}

/** The host's form, drawn only while it is open: it asks for the presets then. */
function HostProfileForm({
  current,
  busy,
  onSave,
  onClose,
}: {
  current: ProfileView | null;
  busy: boolean;
  onSave: (profile: Profile | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const { presets } = usePresets();
  const kept = current ? plain(current) : null;
  const [draft, setDraft] = useState<Profile>(kept ?? BLANK_PROFILE);
  const [start, setStart] = useState("");
  const send = (profile: Profile | null) =>
    void onSave(profile).then((taken) => {
      if (taken) onClose();
    });
  return (
    <form
      className={game.startForm}
      onSubmit={(event) => {
        event.preventDefault();
        send(draft);
      }}
    >
      <PresetSelect
        presets={presets}
        value={start}
        none={current ? "The table as it stands" : "A description of your own"}
        onChange={(key) => {
          setStart(key);
          const preset = findPreset(presets, key);
          setDraft(preset ? plain(preset.profile) : (kept ?? BLANK_PROFILE));
        }}
      />
      <ProfileFields profile={draft} onChange={setDraft} disabled={busy} />
      <div className={game.startRow}>
        <button
          type="submit"
          className={game.primaryButton}
          disabled={busy || sameProfile(draft, kept)}
        >
          {current ? "Change the table" : "Describe the table"}
        </button>
        {current && (
          <button
            type="button"
            className={game.dangerButton}
            disabled={busy}
            onClick={() => send(null)}
          >
            Take the description away
          </button>
        )}
        <button
          type="button"
          className={game.secondaryButton}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
