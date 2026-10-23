import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { client, describe } from "../api";
import game from "../game/game.module.css";
import { Face } from "../tables/TableParts";
import { usePolled } from "../tables/tables";
import {
  gameOutcome,
  matchVerdict,
  opponentOf,
  running,
  score,
  seatName,
  type MatchPlayer,
  type MatchView,
} from "./matches";
import { SideboardEditor } from "./SideboardEditor";
import styles from "./matches.module.css";

// A best-of-three match (v0.5.0, docs/matches.md), at #match/<id>: the score, its games, and
// between games the player's own sideboarding. The page asks again every few seconds and follows
// the match into each new game; the game's result leads back here.

type Loaded = { match?: MatchView; missing?: boolean };

export function MatchPage({
  matchId,
  heading,
}: {
  matchId: string;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const load = useCallback(async (): Promise<Loaded> => {
    const { data, response } = await client.GET("/api/v1/matches/{match_id}", {
      params: { path: { match_id: matchId } },
    });
    return data ? { match: data } : { missing: response.status === 404 };
  }, [matchId]);
  const [loaded, refresh] = usePolled(load);
  // The match as the latest answer has it: the page's own asking, or an action's reply.
  const [match, setMatch] = useState<MatchView>();
  const [error, setError] = useState("");
  const conceding = useRef<HTMLDialogElement>(null);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (loaded?.match) setMatch(loaded.match);
  }, [loaded]);
  useEffect(() => {
    document.title = "Commander Duels · Match";
    return () => {
      document.title = "Commander Duels";
    };
  }, []);

  const mine = match?.players.find((player) => player.you) ?? null;
  // Once a game of the match is in play, its players go to it.
  useEffect(() => {
    if (
      match?.status === "playing" &&
      match.game_id &&
      mine &&
      !mine.left &&
      opened.current !== match.game_id
    ) {
      opened.current = match.game_id;
      window.location.hash = `#game/${match.game_id}`;
    }
  }, [match, mine]);

  if (!match)
    return loaded?.missing ? (
      <div className={styles.page}>
        <h1 ref={heading} tabIndex={-1}>
          There is no such match.
        </h1>
        <p className={styles.lead}>
          It may not be yours. <a href="#play">Back to Play</a>
        </p>
      </div>
    ) : (
      <p role="status">Finding the match…</p>
    );

  const other = opponentOf(match, match.your_seat);
  const title =
    match.your_seat === null
      ? `${seatName(match, 0)} against ${seatName(match, 1)}`
      : `Your match against ${other?.player === "bot" ? "the bot" : (other?.handle ?? "a player")}`;
  const wins = match.players.map((player) => player.game_wins);
  const back =
    match.kind === "table"
      ? { href: "#tables", text: "Back to the lobby" }
      : { href: "#play", text: "Back to Play" };
  const out = mine?.left ?? null;

  async function concede() {
    setError("");
    const { data, error: failure } = await client
      .POST("/api/v1/matches/{match_id}/concede", {
        params: { path: { match_id: matchId } },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    if (data) setMatch(data);
    else setError(describe(failure));
    refresh();
  }

  return (
    <div className={styles.page}>
      <span className={game.eyebrow}>BEST OF THREE · LEGACY</span>
      <h1 ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p className={styles.lead}>
        The first to win two games takes the match. Every game won counts as a
        win and pays its tokens. Between games each player sideboards in
        private, and the loser of a game chooses who plays first in the next.{" "}
        <a href={back.href}>{back.text}</a>
      </p>

      <ul className={styles.score} aria-label="Score">
        {match.players.map((player) => (
          <Plate key={player.seat} match={match} player={player} />
        ))}
      </ul>

      {match.status === "playing" && (
        <p className={styles.notice} role="status">
          Game {match.game_number} is in play
          {mine && !out ? ": opening it…" : "."}
          {match.game_id && mine && !out && (
            <a href={`#game/${match.game_id}`}>Open the game</a>
          )}
        </p>
      )}
      {!running(match.status) && (
        <p className={styles.notice} role="status" data-verdict>
          {matchVerdict(match)}
        </p>
      )}
      {out && running(match.status) && (
        <p className={styles.notice} role="status">
          {out === "removed"
            ? "The other player removed you while you were away: the match is theirs."
            : "You conceded this match."}
        </p>
      )}

      <h2 className={styles.gamesTitle}>
        Games · {score(wins, match.your_seat)}
      </h2>
      <ol className={styles.games}>
        {match.games.map((entry) => (
          <li key={entry.id}>
            <strong>Game {entry.game}</strong>
            <span>{gameOutcome(match, entry)}</span>
            {entry.tokens ? (
              <small>{entry.tokens.toLocaleString()} tokens</small>
            ) : null}
          </li>
        ))}
      </ol>

      {match.status === "sideboarding" && mine && !out && (
        <SideboardEditor
          key={match.game_number}
          match={match}
          mine={mine}
          onMatch={(next) => {
            setMatch(next);
            refresh();
          }}
        />
      )}
      {match.status === "sideboarding" && !mine && (
        <p className={game.hint}>
          The players are sideboarding for game {match.game_number}.
        </p>
      )}

      {running(match.status) && mine && !out && (
        <div className={styles.actions}>
          <button
            type="button"
            className={game.dangerButton}
            onClick={() => conceding.current?.showModal()}
          >
            Concede the match
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className={game.refusal}>
          {error}
        </p>
      )}
      <dialog
        ref={conceding}
        className={game.confirm}
        aria-labelledby="concede-match-title"
      >
        <h2 id="concede-match-title">Concede the match?</h2>
        <p>
          {match.status === "playing"
            ? "You lose the game in play, and the match."
            : "You lose the match."}{" "}
          The games you won still count.
        </p>
        <form method="dialog" className={game.confirmButtons}>
          <button type="submit" className={game.secondaryButton} autoFocus>
            Keep playing
          </button>
          <button
            type="submit"
            className={game.dangerButton}
            onClick={() => void concede()}
          >
            Concede the match
          </button>
        </form>
      </dialog>
    </div>
  );
}

function Plate({ match, player }: { match: MatchView; player: MatchPlayer }) {
  const name = player.player === "bot" ? "Bot" : (player.handle ?? "A player");
  const sideboarding = match.status === "sideboarding";
  return (
    <li className={styles.plate} data-you={player.you}>
      {player.player === "bot" ? (
        <span className={styles.badge} aria-hidden="true">
          ⚙
        </span>
      ) : (
        <Face handle={player.handle} portrait={player.portrait} size={48} />
      )}
      <span>
        <strong>
          {name}
          {player.you ? " (you)" : ""}
        </strong>
        <span className={styles.badges}>
          {player.left ? (
            <span className={styles.badge} data-tone="out">
              {player.left === "removed" ? "Removed" : "Conceded"}
            </span>
          ) : sideboarding ? (
            <span
              className={styles.badge}
              data-tone={player.ready ? "good" : "wait"}
            >
              {player.ready ? "Ready" : "Sideboarding"}
            </span>
          ) : null}
          {match.winner_seat === player.seat && (
            <span className={styles.badge} data-tone="good">
              Match winner
            </span>
          )}
        </span>
      </span>
      <span
        className={styles.wins}
        aria-label={`${player.game_wins} game ${player.game_wins === 1 ? "win" : "wins"}`}
      >
        {player.game_wins}
      </span>
    </li>
  );
}
