import { landTally, type PulledCard } from "./shop";
import styles from "./shop.module.css";

// A basic land pack's summary by land and edition (v0.9.0, the owner's choice): a pack of 40 or
// 200 lands reads better as counts than as 200 pictures. Each land in WUBRG order with its count
// and foils, its editions newest first; then the oldest pulls, the rarest by the packs' scale.

function year(released: string | null | undefined) {
  return released ? released.slice(0, 4) : "";
}

export function LandTally({ cards }: { cards: PulledCard[] }) {
  const { lands, oldest } = landTally(cards);
  return (
    <div className={styles.landTally}>
      {oldest.length > 0 && (
        <section aria-labelledby="land-oldest">
          <h3 id="land-oldest">Oldest pulls</h3>
          <ol className={styles.landOldest}>
            {oldest.map((card) => (
              <li key={card.position}>
                <strong>{card.name}</strong> · {card.set_name || card.set_code}{" "}
                ({year(card.released_at)})
                {card.finish !== "nonfoil" && " · Foil"}
              </li>
            ))}
          </ol>
        </section>
      )}
      <ul className={styles.landList} aria-label="Lands by edition">
        {lands.map((land) => (
          <li key={land.name}>
            <h3>
              {land.name} · {land.count}
              {land.foils > 0 &&
                ` · ${land.foils} foil${land.foils === 1 ? "" : "s"}`}
            </h3>
            <table className={styles.landTable}>
              <caption className={styles.hidden}>
                {land.name} by edition, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Edition</th>
                  <th scope="col">Year</th>
                  <th scope="col">Cards</th>
                  <th scope="col">Foils</th>
                </tr>
              </thead>
              <tbody>
                {land.editions.map((edition) => (
                  <tr key={edition.set_code}>
                    <th scope="row">
                      {edition.set_name}{" "}
                      <small>{edition.set_code.toUpperCase()}</small>
                    </th>
                    <td>{year(edition.released_at)}</td>
                    <td>{edition.count}</td>
                    <td>{edition.foils || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        ))}
      </ul>
    </div>
  );
}
