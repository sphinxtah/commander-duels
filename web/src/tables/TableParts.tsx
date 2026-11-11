import { Portrait } from "../alliance/Portrait";
import game from "../game/game.module.css";
import {
  DECK_FORMAT_DETAIL,
  DECK_FORMAT_WORDS,
  GUARD_RULE,
  GUARD_RULE_DETAIL,
  HOUSE_RULE,
  HOUSE_RULE_DETAIL,
  kingsGuarded,
  KINGS_TABLE,
  LIFE_DETAIL,
  LIFE_WORDS,
  listWords,
  settingsSentence,
  settingsTags,
  type KingsLife,
  type KingsTableSettings,
} from "./kingsTable";
import {
  TEAM_FORMAT,
  casualRules,
  deckFormat,
  formatNames,
  isTournament,
  rulesSentence,
  rulesTag,
  teamName,
  tournamentRules,
  unfit,
  type OwnDeck,
  type TableFormat,
  type TablePlayer,
  type TableRules,
  type TableView,
} from "./tables";
import styles from "./tables.module.css";

/** A table's seats and rules as tags (v0.4.5), so a player sees before joining which decks it
 * takes. The rules tag spells them out to a screen reader. A King's Table table (v0.8.7) tags its
 * settings too: the decks, the starting life and the house rule. */
export function TableTags({ table }: { table: TableView }) {
  const kings = table.format === KINGS_TABLE ? table.kings_table : null;
  return (
    <span className={styles.tags}>
      <span className={styles.badge}>
        {table.format === TEAM_FORMAT
          ? "Two teams of two"
          : table.format === KINGS_TABLE
            ? "Two teams of three"
            : `${table.seats} seats`}
      </span>
      {table.best_of === 3 && (
        <span className={styles.badge} data-tone="gold">
          Best of three
        </span>
      )}
      {kings && (
        <span className={styles.visuallyHidden}>
          King&apos;s Table settings:{" "}
        </span>
      )}
      {kings &&
        settingsTags(kings).map((tag) => (
          <span key={tag} className={styles.badge} data-tone="kings">
            {tag}
          </span>
        ))}
      <span className={styles.badge} data-tone="rules">
        {rulesTag(table.rules, table.format, kings)}
        <span className={styles.visuallyHidden}>
          {" "}
          ({rulesSentence(table.rules, table.format, kings)})
        </span>
      </span>
    </span>
  );
}

/** A team table's seats by team: Two-Headed Giant's (v0.5.1) seats 0 and 1, then 2 and 3; King's
 * Table's (v0.8.7) 0 to 2, then 3 to 5. */
export function teamsOf(table: TableView): TablePlayer[][] {
  return [0, 1].map((team) =>
    table.players.filter((player) => player.team === team),
  );
}

/** Who sits in a team, in words: "ada and a bot", "bob, a bot and an open seat". */
export function teamWords(players: TablePlayer[]): string {
  return listWords(
    players.map((player) =>
      player.player === "bot"
        ? "a bot"
        : player.taken
          ? (player.handle ?? "a player")
          : "an open seat",
    ),
  );
}

/** The lobby's line for a team table's teams. */
export function TeamsLine({ table }: { table: TableView }) {
  return (
    <span className={styles.teams} aria-label="Teams">
      {teamsOf(table).map((players, team) => (
        <span key={team} data-team={team}>
          <strong>{teamName(team, table.format)}:</strong> {teamWords(players)}
        </span>
      ))}
    </span>
  );
}

/** King's Table's settings in sentences (v0.8.7): what a table shows before anyone readies. */
export function KingsRules({ settings }: { settings: KingsTableSettings }) {
  return <p className={styles.kingsRules}>{settingsSentence(settings)}</p>;
}

/** King's Table's settings as the host or the practice player chooses them (v0.8.7): the decks'
 * format, the starting life (each preset says what it gives) and the house rule. `name` keeps
 * two forms' radio groups apart. */
export function KingsSettingsFields({
  settings,
  onChange,
  name,
  disabled = false,
}: {
  settings: KingsTableSettings;
  onChange: (change: Partial<KingsTableSettings>) => void;
  name: string;
  disabled?: boolean;
}) {
  return (
    <>
      <fieldset disabled={disabled}>
        <legend>Decks, for all six players</legend>
        {(["commander", "legacy"] as const).map((format) => (
          <label key={format} className={game.choice}>
            <input
              type="radio"
              name={`${name}-deck-format`}
              checked={settings.deck_format === format}
              onChange={() => onChange({ deck_format: format })}
            />
            <span>
              <strong>{DECK_FORMAT_WORDS[format]}</strong>
              <small>{DECK_FORMAT_DETAIL[format]}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Starting life</legend>
        {(Object.keys(LIFE_WORDS) as KingsLife[]).map((life) => (
          <label key={life} className={game.choice}>
            <input
              type="radio"
              name={`${name}-life`}
              checked={settings.life === life}
              onChange={() => onChange({ life })}
            />
            <span>
              <strong>{LIFE_WORDS[life]}</strong>
              <small>{LIFE_DETAIL[life]}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>House rule</legend>
        <label className={game.choice}>
          <input
            type="checkbox"
            checked={settings.king_attacks_anyone}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? { king_attacks_anyone: true }
                  : { king_attacks_anyone: false, guarded_kings: false },
              )
            }
          />
          <span>
            <strong>{HOUSE_RULE}</strong>
            <small>{HOUSE_RULE_DETAIL}</small>
          </span>
        </label>
        {/* The rule's guard (v0.9.7): it belongs to the house rule, so it is chosen only with
            it, and turning the house rule off turns it off too. */}
        <label className={game.choice}>
          <input
            type="checkbox"
            checked={kingsGuarded(settings)}
            disabled={!settings.king_attacks_anyone}
            onChange={(event) =>
              onChange({ guarded_kings: event.target.checked })
            }
          />
          <span>
            <strong>{GUARD_RULE}</strong>
            <small>{GUARD_RULE_DETAIL}</small>
          </span>
        </label>
      </fieldset>
    </>
  );
}

/** A player's face at a table: their alliance's portrait, or their handle's first letter. */
export function Face({
  handle,
  portrait,
  size = 28,
}: {
  handle: string | null;
  portrait: string | null;
  size?: number;
}) {
  if (portrait)
    return <Portrait id={portrait} size={size} thumbnail decorative />;
  return (
    <span
      className={styles.sigil}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {(handle ?? "?").charAt(0).toUpperCase()}
    </span>
  );
}

/** The deck choices of one format: the decks the table's rules take, and the others greyed with
 * the reason. */
export function DeckChoices({
  decks,
  rules,
}: {
  decks: OwnDeck[];
  rules: TableRules;
}) {
  return (
    <>
      {decks.map((deck) => {
        const reason = unfit(deck, rules);
        return (
          <option key={deck.id} value={deck.id} disabled={reason !== null}>
            {deck.title}
            {reason ? ` (${reason})` : ""}
          </option>
        );
      })}
    </>
  );
}

/** The host's choice of which cards the decks may hold by their legality (v0.4.5): two boxes, and
 * Tournament rules, which clears both. Unticking it goes back to casual. */
export function RulesFields({
  rules,
  format,
  kings,
  onChange,
}: {
  rules: TableRules;
  format: TableFormat;
  /** King's Table's settings (v0.8.7), whose deck format the rules follow. */
  kings?: KingsTableSettings | null;
  onChange: (rules: TableRules) => void;
}) {
  const name = formatNames[deckFormat(format, kings)];
  const tournament = isTournament(rules);
  return (
    <fieldset>
      <legend>Cards the decks may hold</legend>
      <label className={game.choice}>
        <input
          type="checkbox"
          checked={rules.banned}
          onChange={(event) =>
            onChange({ ...rules, banned: event.target.checked })
          }
        />
        <span>
          <strong>Banned cards</strong>
          <small>Cards banned in {name}</small>
        </span>
      </label>
      <label className={game.choice}>
        <input
          type="checkbox"
          checked={rules.not_legal}
          onChange={(event) =>
            onChange({ ...rules, not_legal: event.target.checked })
          }
        />
        <span>
          <strong>Cards not legal in {name}</strong>
          <small>Un-cards, playtest and digital-only cards</small>
        </span>
      </label>
      <label className={game.choice}>
        <input
          type="checkbox"
          checked={rules.stand_in}
          onChange={(event) =>
            onChange({ ...rules, stand_in: event.target.checked })
          }
        />
        <span>
          <strong>Stand-ins</strong>
          <small>
            Cards the game has no rules for yet, played with their cost, types,
            power and toughness
          </small>
        </span>
      </label>
      <label className={game.choice}>
        <input
          type="checkbox"
          checked={tournament}
          onChange={(event) =>
            onChange(event.target.checked ? tournamentRules : casualRules)
          }
        />
        <span>
          <strong>Tournament rules</strong>
          <small>None of these: every card legal in {name}, with its rules</small>
        </span>
      </label>
    </fieldset>
  );
}
