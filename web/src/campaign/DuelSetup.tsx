import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { client } from "../api";
import { portraitUrl } from "../game/table/portrait";
import { selectSound } from "../shell/menuSound";
import { FriendPicker, useFriendList } from "../tables/InviteFriends";
import { LIFE_DETAIL, kingsAttackWords } from "../tables/kingsTable";
import { TURNS_PER_PLAYER } from "../tables/tables";
import {
  changeTutorial,
  COURT,
  openCourt,
  startEncounter,
  TIER_NAMES,
  type CampaignEncounter,
  type CampaignState,
  type StartChoice,
} from "./campaign";
import { STORY } from "./script";
import styles from "./campaign.module.css";

// Before a duel (v0.8.0): the handoff's first screen's controls. Learn Commander (the loaner, the
// training seed and the hints), the campaign's loaner deck, one of the player's own Commander
// decks, or for the first encounter "I know how to play" (the teaching skipped, the duel kept);
// Review my alliance leads to the profile. Kaya's advice for a duel lost before is the encounter's
// counterplay. Since v0.9.6 ward 15, the court, is a King's Table game: the player is King A, and
// their two Generals are bots, or one or two friends invited to a table the campaign opens.

type OwnDeck = { id: string; title: string; commanders: string[] };
type Court = NonNullable<CampaignEncounter["court"]>;

/** The court's rules in two sentences (v0.9.7), from its settings as the API gives them: whom a
 * King may attack, the starting life, and the turn limit, 40 turns for each of the six players.
 * Until v0.9.7 this said "Kings cannot attack", which the court's settings then were. */
/** What the player's bot Generals play (v0.9.8): the decks won from wardens already beaten.
 * Until v0.9.8 they played the engine's fixture decks against the court's power decks. */
function allyDecks(court: Court): string {
  const wardens = (court.ally_decks ?? []).map((deck) => deck.name);
  if (!wardens.length) return "";
  return `Your bot Generals play the decks you won from ${wardens.join(" and ")}.`;
}

function courtRules(court: Court): string {
  const { kings_table: rules, turn_cap: turns } = court;
  const life = LIFE_DETAIL[rules.life];
  return `${kingsAttackWords(rules)}; ${life.charAt(0).toLowerCase()}${life.slice(1)}. The court ends with no result after ${turns} turns, ${TURNS_PER_PLAYER} for each player.`;
}

export function DuelSetup({
  state,
  encounter,
  lostBefore,
  canUseOwnDecks,
  challenge = false,
  onClose,
  onState,
}: {
  state: CampaignState;
  encounter: CampaignEncounter;
  lostBefore: boolean;
  canUseOwnDecks: boolean;
  /** Apex Unbound (v0.9.3): the finale again, for its badge alone. */
  challenge?: boolean;
  onClose: () => void;
  onState: (state: CampaignState) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [decks, setDecks] = useState<OwnDeck[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = encounter.number === 1 && !challenge;
  const tutorial = state.progress.tutorial;
  const story = STORY.encounters[encounter.number];
  const court = encounter.number === COURT ? encounter.court : null;
  const [friends, setFriends] = useState<string[]>([]);
  const friendList = useFriendList(Boolean(court) && canUseOwnDecks);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
  }, []);
  useEffect(() => {
    if (!canUseOwnDecks) {
      setDecks([]);
      return;
    }
    let active = true;
    void client.GET("/api/v1/decks").then(({ data }) => {
      if (!active) return;
      const playable = (data ?? []).filter(
        (deck) =>
          deck.format === "commander" &&
          deck.playable &&
          !deck.archived &&
          !deck.deleted_at,
      );
      setDecks(
        playable.map((deck) => ({
          id: deck.id,
          title: deck.title,
          commanders: deck.commanders,
        })),
      );
      if (playable[0]) setChosen(playable[0].id);
    });
    return () => {
      active = false;
    };
  }, [canUseOwnDecks]);

  async function start(choice: StartChoice) {
    setBusy(true);
    setError("");
    selectSound();
    const started = await startEncounter(encounter.number, choice, challenge);
    if (started.gameId) {
      window.location.hash = `#game/${started.gameId}`;
      return;
    }
    setBusy(false);
    setError(started.error ?? "The duel could not start.");
  }

  async function bringFriends() {
    if (!chosen || friends.length === 0) return;
    setBusy(true);
    setError("");
    selectSound();
    const opened = await openCourt(
      encounter.number,
      chosen,
      friends,
      challenge,
    );
    if (opened.code) {
      window.location.hash = `#tables/${opened.code}`;
      return;
    }
    setBusy(false);
    setError(opened.error ?? "The court could not open.");
  }

  async function skipTeaching() {
    const next = await changeTutorial({ skip: true });
    if (next) onState(next);
  }

  const opponentPortrait =
    encounter.number === 14 ? null : portraitUrl(encounter.opponent, 256);
  const courtSpoils = encounter.spoils.decks
    .map((deck) => deck.title)
    .join(" and ");

  return (
    <dialog
      ref={dialog}
      className={styles.setup}
      aria-labelledby="duel-setup-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className={styles.setupHead}>
        {opponentPortrait ? (
          <img
            className={styles.setupPortrait}
            src={opponentPortrait}
            alt=""
            width={128}
            height={128}
          />
        ) : (
          <span className={styles.setupThrone} aria-hidden="true" />
        )}
        <div>
          <span className={styles.kicker}>
            {challenge
              ? "The post-campaign challenge"
              : court
                ? "The court · King's Table"
                : encounter.number === 14
                  ? "The final duel"
                  : `Encounter ${String(encounter.number).padStart(2, "0")} · ${TIER_NAMES[encounter.tier]}`}
          </span>
          <h2 id="duel-setup-title" className={styles.setupTitle}>
            {challenge ? state.challenge.name : encounter.title}
          </h2>
          <p className={styles.quiet}>
            {encounter.name}
            {court
              ? ", with Nicol Bolas and Liliana as his Generals"
              : encounter.commander
                ? `, commanding ${encounter.commander}`
                : ""}
            . {encounter.location}.
          </p>
          {court && !challenge ? (
            <p className={styles.spoilsLine}>
              {encounter.spoils.earned ? "Won: " : "Win it for "}
              <strong>{courtSpoils}</strong> and{" "}
              <strong>
                {encounter.spoils.tokens.toLocaleString("en-US")} tokens
              </strong>
              {encounter.spoils.earned
                ? "."
                : ", once, with the throne's own spoils if they still wait."}
            </p>
          ) : challenge ? (
            <p className={styles.spoilsLine}>
              {state.challenge.earned
                ? "Its badge is yours already; play it again for the challenge alone."
                : "Win it for the Apex Unbound badge, once. Kaya's aids stay off, and the ending you won stays yours."}
            </p>
          ) : (
            <p className={styles.spoilsLine}>
              {encounter.spoils.earned ? "Won: " : "Win it for "}
              <strong>{encounter.spoils.deck}</strong> (led by{" "}
              {encounter.spoils.commander}) and{" "}
              <strong>
                {encounter.spoils.tokens.toLocaleString("en-US")} tokens
              </strong>
              {encounter.spoils.earned ? "." : ", once."}
            </p>
          )}
        </div>
      </header>

      {lostBefore && !challenge && story?.counterplay && (
        <p className={styles.advice}>
          <strong>Kaya:</strong> {story.counterplay}
        </p>
      )}

      <div className={styles.choices}>
        {first && (
          <button
            type="button"
            className={styles.choice}
            disabled={busy}
            onClick={() => void start({ kind: "learn" })}
          >
            <strong>Learn Commander</strong>
            <span>
              The loaner deck, {state.loaner}, with {state.loaner_commander} in
              the command zone, the training shuffle and Kaya&rsquo;s hints.
            </span>
          </button>
        )}
        <button
          type="button"
          className={styles.choice}
          disabled={busy}
          onClick={() => void start({ kind: "loaner" })}
        >
          <strong>
            Use the loaner: {state.loaner}
            {court ? ", with bots as your Generals" : ""}
          </strong>
          <span>
            A mono-white deck led by {state.loaner_commander}. It stays the
            campaign&rsquo;s and never touches your collection.
          </span>
        </button>
        {canUseOwnDecks && (
          <div className={styles.choice}>
            <strong>Use my deck</strong>
            {decks === null ? (
              <span>Finding your Commander decks…</span>
            ) : decks.length === 0 ? (
              <span>
                None of your Commander decks is ready to play.{" "}
                <a href="#decks">Open your decks</a>.
              </span>
            ) : (
              <span className={styles.deckPick}>
                <label>
                  <span className={styles.visuallyHidden}>Your deck</span>
                  <select
                    value={chosen}
                    onChange={(event) => setChosen(event.target.value)}
                  >
                    {decks.map((deck) => (
                      <option key={deck.id} value={deck.id}>
                        {deck.title}
                        {deck.commanders.length
                          ? ` (${deck.commanders.join(" & ")})`
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={styles.gold}
                  disabled={busy || !chosen}
                  onClick={() => void start({ kind: "own", deckId: chosen })}
                >
                  {court ? "Play with bots as Generals" : "Duel with it"}
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {court && allyDecks(court) && (
        <p className={styles.quiet}>{allyDecks(court)}</p>
      )}

      {court && canUseOwnDecks && (
        <div className={styles.choice}>
          <strong>Bring friends as your Generals</strong>
          <span>
            One or two friends join you at a private table with their own
            Commander decks; a General&rsquo;s seat nobody takes is a
            bot&rsquo;s. Each friend who helps you win is paid{" "}
            {court.helper_tokens.toLocaleString("en-US")} tokens, once. Uses the
            deck chosen above.
          </span>
          <FriendPicker
            friends={friendList.friends}
            error={friendList.error}
            selected={friends}
            onChange={(next) => setFriends(next.slice(-2))}
          />
          <button
            type="button"
            className={styles.gold}
            disabled={busy || !chosen || friends.length === 0}
            onClick={() => void bringFriends()}
          >
            Open the court for {friends.length || "your"}{" "}
            {friends.length === 1 ? "friend" : "friends"}
          </button>
        </div>
      )}

      {first && !tutorial.skipped && (
        <p className={styles.quiet}>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void skipTeaching()}
          >
            I know how to play
          </button>{" "}
          skips Kaya&rsquo;s teaching; the duel and the story stay.
        </p>
      )}
      {encounter.number === 14 && (
        <p className={styles.warning}>
          The Sphinx plays without restraint: acceleration, tutors and
          combinations can end the duel from the first turns. At 15 life or less
          he crosses into the duel himself.
        </p>
      )}
      {court && (
        <p className={styles.warning}>
          The Sphinx is King B, with Nicol Bolas and Liliana as his Generals,
          all at full strength. His incarnation starts on the battlefield and
          returns at each of his upkeeps. {courtRules(court)} Lose the court,
          close it or leave it idle for an hour, and you return to the
          throne&rsquo;s ward.
        </p>
      )}

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className={styles.quiet}>
          Opening the ward…
        </p>
      )}

      <footer className={styles.setupFoot}>
        <a href="#profile" className={styles.linkButton}>
          Review my alliance
        </a>
        <button type="button" className={styles.secondary} onClick={onClose}>
          Back to the map
        </button>
      </footer>
    </dialog>
  );
}
