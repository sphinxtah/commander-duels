import { Portrait } from "../alliance/Portrait";
import game from "../game/game.module.css";
import {
  TEAM_FORMAT,
  casualRules,
  deckFormat,
  formatNames,
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
 * takes. The rules tag spells them out to a screen reader. */
export function TableTags({ table }: { table: TableView }) {
  return (
    <span className={styles.tags}>
      <span className={styles.badge}>
        {table.format === TEAM_FORMAT
          ? "Two teams of two"
          : `${table.seats} seats`}
      </span>
      {table.best_of === 3 && (
        <span className={styles.badge} data-tone="gold">
          Best of three
        </span>
      )}
      <span className={styles.badge} data-tone="rules">
        {rulesTag(table.rules, table.format)}
        <span className={styles.visuallyHidden}>
          {" "}
          ({rulesSentence(table.rules, table.format)})
        </span>
      </span>
    </span>
  );
}

/** A Two-Headed Giant table's seats by team (v0.5.1): seats 0 and 1, then 2 and 3. */
export function teamsOf(table: TableView): TablePlayer[][] {
  return [0, 1].map((team) =>
    table.players.filter((player) => player.team === team),
  );
}

/** Who sits in a team, in words: "ada and a bot", "bob and an open seat". */
export function teamWords(players: TablePlayer[]): string {
  return players
    .map((player) =>
      player.player === "bot"
        ? "a bot"
        : player.taken
          ? (player.handle ?? "a player")
          : "an open seat",
    )
    .join(" and ");
}

/** The lobby's line for a Two-Headed Giant table's teams. */
export function TeamsLine({ table }: { table: TableView }) {
  return (
    <span className={styles.teams} aria-label="Teams">
      {teamsOf(table).map((players, team) => (
        <span key={team} data-team={team}>
          <strong>{teamName(team)}:</strong> {teamWords(players)}
        </span>
      ))}
    </span>
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
  onChange,
}: {
  rules: TableRules;
  format: TableFormat;
  onChange: (rules: TableRules) => void;
}) {
  const name = formatNames[deckFormat(format)];
  const tournament = !rules.banned && !rules.not_legal;
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
          checked={tournament}
          onChange={(event) =>
            onChange(event.target.checked ? tournamentRules : casualRules)
          }
        />
        <span>
          <strong>Tournament rules</strong>
          <small>Neither: every card legal in {name}</small>
        </span>
      </label>
    </fieldset>
  );
}
