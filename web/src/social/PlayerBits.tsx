import { avatars } from "../Account";
import { Portrait } from "../alliance/Portrait";
import { presenceWords, type PlayerRef, type Presence } from "./social";
import styles from "./social.module.css";

/** A player's picture: their alliance's portrait, or with none their avatar (v0.3.1). */
export function PlayerPicture({
  player,
  size = 36,
}: {
  player: PlayerRef;
  size?: number;
}) {
  if (player.alliance)
    return (
      <Portrait
        id={player.alliance}
        size={size}
        thumbnail={size <= 64}
        decorative
        className={styles.picture}
      />
    );
  return (
    <span
      className={styles.monogram}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {avatars[player.avatar]}
    </span>
  );
}

/** A coloured dot for the state, beside words that say it. */
export function PresenceDot({ presence }: { presence: Presence }) {
  return (
    <span
      className={styles.dot}
      data-state={presence.state}
      aria-hidden="true"
    />
  );
}

/** The dot and the words, or nothing when the player does not share their presence. */
export function PresenceLine({
  presence,
  className,
}: {
  presence: Presence | null | undefined;
  className?: string;
}) {
  if (!presence) return null;
  return (
    <span className={[styles.presence, className].filter(Boolean).join(" ")}>
      <PresenceDot presence={presence} />
      {presenceWords(presence)}
    </span>
  );
}
