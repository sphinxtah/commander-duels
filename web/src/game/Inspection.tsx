import { CardButton, CardRow } from "./Board";
import type { Inspection } from "./types";
import styles from "./game.module.css";

/** SysOp's inspection view (games.view_concealed): every hand and library in order, top first,
 * refreshed with each revision. Opening it is recorded in the audit trail. */
export function InspectionPanel({
  inspection,
}: {
  inspection: Inspection | null;
}) {
  return (
    <section className={styles.inspection} aria-labelledby="inspection-title">
      <h2 id="inspection-title">
        Inspection <span>SysOp</span>
      </h2>
      <p className={styles.hint}>
        Every hand and library, top first. Opening this view is recorded in the
        audit trail.
      </p>
      {!inspection ? (
        <p role="status">Waiting for the next settled moment…</p>
      ) : (
        inspection.players.map((player) => {
          const deck = inspection.settings.seats.find(
            (s) => s.seat === player.seat,
          );
          return (
            <div key={player.seat} className={styles.inspected}>
              <h3>
                {player.name ?? `Seat ${player.seat + 1}`}
                <span>
                  {deck?.player === "bot" ? "Bot" : "Human"} ·{" "}
                  {deck?.deck ?? "custom"}
                </span>
              </h3>
              <h4>Hand ({player.hand.length})</h4>
              <CardRow label={`${player.name ?? "Player"}'s hand`}>
                {player.hand.map((card) => (
                  <CardButton key={card.id} card={card} small />
                ))}
              </CardRow>
              <details>
                <summary>Library ({player.library.length}), top first</summary>
                <ol className={styles.library}>
                  {player.library.map((card) => (
                    <li key={card.id}>{card.name}</li>
                  ))}
                </ol>
              </details>
            </div>
          );
        })
      )}
    </section>
  );
}
