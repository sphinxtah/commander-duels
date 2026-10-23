import { formatName, winRate, type Stats, type Totals } from "./records";
import styles from "./records.module.css";

function count(value: number, one: string, many: string) {
  return (
    <li>
      <strong>{value.toLocaleString("en-US")}</strong>
      {value === 1 ? one : many}
    </li>
  );
}

/**
 * A player's record (v0.5.0): wins, losses and the share won, then every game by format and by
 * opponent, from the server's own results.
 */
export function RecordTable({ stats, label }: { stats: Stats; label: string }) {
  const totals = stats.totals;
  if (totals.games === 0)
    return <p className={styles.fine}>No games finished yet.</p>;
  const rows: [string, Totals][] = [
    ["All games", totals],
    ...stats.formats.map(
      (row): [string, Totals] => [formatName(row.format), row],
    ),
    ["Against bots", stats.against_bots],
    ["Against players", stats.against_players],
  ];
  return (
    <>
      <ul className={styles.headline} aria-label={`${label} in short`}>
        {count(totals.wins, "win", "wins")}
        {count(totals.losses, "loss", "losses")}
        <li>
          <strong>{winRate(totals)}</strong>
          won
        </li>
      </ul>
      <div className={styles.tableWrap}>
        <table className={styles.record}>
          <caption className={styles.visuallyHidden}>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Games</th>
              <th scope="col">Played</th>
              <th scope="col">Won</th>
              <th scope="col">Lost</th>
              <th scope="col">Drawn</th>
              <th scope="col">No result</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .filter(([, row], index) => index === 0 || row.games > 0)
              .map(([name, row]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{row.games.toLocaleString("en-US")}</td>
                  <td>{row.wins.toLocaleString("en-US")}</td>
                  <td>{row.losses.toLocaleString("en-US")}</td>
                  <td>{row.draws.toLocaleString("en-US")}</td>
                  <td>{row.no_result.toLocaleString("en-US")}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
