import { useEffect, useState } from "react";
import { client, describe } from "../api";
import { backUrl, setCardBack } from "../game/cardBack";
import type { components } from "../generated/api";
import styles from "./campaign.module.css";

type Cosmetics = components["schemas"]["Cosmetics"];

/**
 * The campaign's cosmetics in use (v0.8.8, api/cosmetics.py), on the Campaign page beside the
 * rewards: the card back your table draws, and the title under your name on your profile. Each
 * card back earned is shown as a small card to choose; one not earned yet is shown locked.
 */
export function CosmeticsPicker() {
  const [cosmetics, setCosmetics] = useState<Cosmetics>();
  const [error, setError] = useState("");
  const [said, setSaid] = useState("");
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/me/cosmetics")
      .then(({ data, error: failure }) => {
        if (!active) return;
        if (data) setCosmetics(data);
        else setError(describe(failure));
      })
      .catch(() => active && setError(describe(undefined)));
    return () => {
      active = false;
    };
  }, []);
  if (!cosmetics) return error ? <p role="alert">{error}</p> : null;
  const earnedBacks = cosmetics.card_backs.filter((back) => back.earned);
  const earnedTitles = cosmetics.titles.filter((title) => title.earned);
  if (earnedBacks.length === 0 && earnedTitles.length === 0) return null;

  async function choose(change: {
    card_back: string | null;
    title: string | null;
  }) {
    setError("");
    setSaid("");
    const { data, error: refused } = await client
      .PUT("/api/v1/me/cosmetics", { body: change })
      .catch(() => ({ data: undefined, error: undefined }));
    if (!data) return setError(describe(refused));
    setCosmetics(data);
    setCardBack(data.card_back ?? null);
    setSaid(
      change.card_back !== cosmetics?.card_back
        ? data.card_back
          ? `Your table now uses the ${cosmetics?.card_backs.find((b) => b.id === data.card_back)?.name ?? ""} card back.`
          : "Your table uses the official card back again."
        : data.title_name
          ? `Your profile now shows the title ${data.title_name}.`
          : "Your profile shows no title.",
    );
  }

  const current = {
    card_back: cosmetics.card_back ?? null,
    title: cosmetics.title ?? null,
  };
  return (
    <section className={styles.cosmetics} aria-labelledby="cosmetics-title">
      <h3 id="cosmetics-title">Your rewards in use</h3>
      {earnedBacks.length > 0 && (
        <fieldset className={styles.backChoices}>
          <legend>Card back on your table</legend>
          <label data-chosen={current.card_back === null || undefined}>
            <input
              type="radio"
              name="card-back"
              checked={current.card_back === null}
              onChange={() => void choose({ ...current, card_back: null })}
            />
            <img src={backUrl(null)} alt="" />
            <span>Official</span>
          </label>
          {earnedBacks.map((back) => (
            <label
              key={back.id}
              data-chosen={current.card_back === back.id || undefined}
            >
              <input
                type="radio"
                name="card-back"
                checked={current.card_back === back.id}
                onChange={() => void choose({ ...current, card_back: back.id })}
              />
              <img src={backUrl(back.id)} alt="" />
              <span>{back.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      {earnedTitles.length > 0 && (
        <label className={styles.titleChoice}>
          <span>Title on your profile</span>
          <select
            value={current.title ?? ""}
            onChange={(event) =>
              void choose({ ...current, title: event.target.value || null })
            }
          >
            <option value="">None</option>
            {earnedTitles.map((title) => (
              <option key={title.id} value={title.id}>
                {title.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p role="status" className={styles.cosmeticsSaid}>
        {said}
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
