import { useCallback, useEffect, useState, type FormEvent } from "react";
import { client, type Me } from "../api";
import game from "../game/game.module.css";
import { getSoundEngine } from "../game/sound/engine";
import { DeckChoices } from "../tables/TableParts";
import {
  casualRules,
  deckFormat,
  formatNames,
  unfit,
  useOwnDecks,
  usePolled,
} from "../tables/tables";
import {
  TEAM_QUEUE,
  acceptInvite,
  declineInvite,
  joinQueue,
  leaveQueue,
  ordinal,
  players,
  useQueue,
  waited,
  type QueueFormat,
  type QueueInfo,
  type QueueStatus,
  type TeamInvite,
} from "./queue";
import styles from "./queues.module.css";

// "Find a game" (v0.5.0) on the Play page: the public queues, Legacy for two and Commander for
// two, three or four, each size its own; a deck the casual rules take; and whether to wait for
// players only. While the account waits it shows how long, its place, and when bots may come,
// with a way out. The game the queue finds opens by itself (queue.ts), on any page of the app.
// Since v0.5.1 Two-Headed Giant's queue too, whose teams form alone or with a friend: a player
// invites a friend, who accepts here with a deck of their own, and the two wait as one team.

const SIZES: Record<QueueFormat, number[]> = {
  legacy: [2],
  commander: [2, 3, 4],
  two_headed_giant: [4],
};
const FORMATS: QueueFormat[] = ["legacy", "commander", TEAM_QUEUE];
const FORMAT_WORDS: Record<QueueFormat, string> = {
  legacy: "Two players",
  commander: "Two to four players",
  two_headed_giant: "Two teams of two, Legacy decks",
};

type Friend = { id: string; handle: string };

/** The account's friends, to invite to the Two-Headed Giant queue, asked for once wanted; null
 * until they arrive. */
function useFriends(wanted: boolean): Friend[] | null {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const asked = friends !== null;
  useEffect(() => {
    if (!wanted || asked) return;
    let active = true;
    void client
      .GET("/api/v1/friends")
      .then((answer) => {
        if (active)
          setFriends(
            (answer?.data?.friends ?? []).map(({ id, handle }) => ({
              id,
              handle,
            })),
          );
      })
      .catch(() => {
        if (active) setFriends([]);
      });
    return () => {
      active = false;
    };
  }, [wanted, asked]);
  return friends;
}

export function FindGame({ me }: { me: Me }) {
  if (
    !me.permissions.includes("games.play") ||
    !me.permissions.includes("decks.edit")
  )
    return null;
  return <Finder />;
}

function Finder() {
  const { status, answeredAt } = useQueue();
  const load = useCallback(
    async () => (await client.GET("/api/v1/queues")).data,
    [],
  );
  const [queues] = usePolled(load);
  if (!status)
    return (
      <section className={game.table} aria-labelledby="find-title">
        <span className={game.eyebrow}>PUBLIC QUEUE</span>
        <h2 id="find-title">Find a game</h2>
        <p role="status">Looking for your place…</p>
      </section>
    );
  return (
    <section className={game.table} aria-labelledby="find-title">
      <span className={game.eyebrow}>PUBLIC QUEUE</span>
      <h2 id="find-title">Find a game</h2>
      {status.status === "waiting" ? (
        <Waiting status={status} answeredAt={answeredAt} />
      ) : status.status === "inviting" ? (
        <Inviting status={status} />
      ) : (
        <>
          {status.invites?.length ? (
            <Invitations invites={status.invites} />
          ) : null}
          <JoinForm status={status} queues={queues ?? []} />
        </>
      )}
    </section>
  );
}

/** Why the account's last wait ended without a game, in its own words. */
function lastWait(status: QueueStatus): string | null {
  if (status.status === "refused")
    return status.reason === "partner_refused"
      ? status.message
      : `You left the queue as your game started: ${status.message ?? "your deck or account could not play."}`;
  // Gone, or since v0.5.1 a friend who declined, left or could no longer join.
  if (status.status === "left" && status.reason !== "left")
    return status.message;
  return null;
}

/** Friends' invitations to the Two-Headed Giant queue (v0.5.1), each with Accept and Decline:
 * accepting takes the deck chosen here, which the two decks' check may refuse. */
function Invitations({ invites }: { invites: TeamInvite[] }) {
  const decks = useOwnDecks();
  const [deck, setDeck] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const here = (decks ?? []).filter((d) => d.format === "legacy");
  const fitting = here.filter((d) => unfit(d, casualRules) === null);
  const chosen =
    (fitting.some((d) => d.id === deck) ? deck : fitting[0]?.id) ?? "";

  async function answer(invite: TeamInvite, accept: boolean) {
    if (accept) getSoundEngine().unlock();
    setError("");
    setBusy(true);
    const refused = accept
      ? await acceptInvite(invite.player.id, chosen)
      : await declineInvite(invite.player.id);
    setBusy(false);
    if (refused) setError(refused);
  }

  return (
    <section className={styles.invites} aria-labelledby="invites-title">
      <h3 id="invites-title">Invitations</h3>
      {decks !== null && fitting.length === 0 ? (
        <p className={styles.note}>
          You have no playable Legacy deck yet to play beside a friend. Build
          one in <a href="#decks">Decks</a>.
        </p>
      ) : (
        <label className={game.field}>
          <span>Your deck for your friend's team</span>
          <select
            value={chosen}
            onChange={(event) => setDeck(event.target.value)}
          >
            <DeckChoices decks={here} rules={casualRules} />
          </select>
        </label>
      )}
      <ul>
        {invites.map((invite) => (
          <li key={invite.player.id} data-invite={invite.player.id}>
            <span>
              <strong>{invite.player.handle}</strong> invites you to play
              Two-Headed Giant as their teammate
              {invite.humans_only ? ", against players only" : ""}.
            </span>
            <span className={styles.inviteActions}>
              <button
                type="button"
                className={game.primaryButton}
                disabled={busy || !chosen}
                onClick={() => void answer(invite, true)}
              >
                {/* The space stays outside the hidden words, so the name reads whole. */}
                Accept{" "}
                <span className={game.visuallyHidden}>
                  {invite.player.handle}'s invitation
                </span>
              </button>
              <button
                type="button"
                className={game.secondaryButton}
                disabled={busy}
                onClick={() => void answer(invite, false)}
              >
                Decline{" "}
                <span className={game.visuallyHidden}>
                  {invite.player.handle}'s invitation
                </span>
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className={game.refusal}>
          {error}
        </p>
      )}
    </section>
  );
}

/** Waiting for the friend invited to the Two-Headed Giant queue to accept (v0.5.1). */
function Inviting({ status }: { status: QueueStatus }) {
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const friend = status.partner?.handle ?? "your friend";

  async function withdraw() {
    setError("");
    setLeaving(true);
    const refused = await leaveQueue();
    setLeaving(false);
    if (refused) setError(refused);
  }

  return (
    <div className={styles.waiting}>
      <span className={styles.ring} aria-hidden="true" />
      <div className={styles.words} role="status">
        <strong>Waiting for {friend} to join your team…</strong>
        <span>
          {friend} was told through the bell. Once they accept with a deck of
          their own, the two of you wait for a Two-Headed Giant game together.
        </span>
        <small>Playing {status.deck ?? "your deck"}.</small>
      </div>
      <button
        type="button"
        className={game.secondaryButton}
        disabled={leaving}
        onClick={() => void withdraw()}
      >
        {leaving ? "Withdrawing…" : "Withdraw the invitation"}
      </button>
      {error && (
        <p role="alert" className={game.refusal}>
          {error}
        </p>
      )}
    </div>
  );
}

function JoinForm({
  status,
  queues,
}: {
  status: QueueStatus;
  queues: QueueInfo[];
}) {
  const decks = useOwnDecks();
  const [format, setFormat] = useState<QueueFormat>(status.format ?? "legacy");
  const [seats, setSeats] = useState(status.seats ?? 2);
  const [deck, setDeck] = useState(status.deck_id ?? "");
  const [humansOnly, setHumansOnly] = useState(status.humans_only);
  // Legacy's best-of-three queue (v0.5.0) is a queue of its own.
  const [bestOf, setBestOf] = useState<1 | 3>(status.best_of === 3 ? 3 : 1);
  // Two-Headed Giant (v0.5.1): paired with another player, or a friend invited as a teammate.
  const [friend, setFriend] = useState("");
  const [withFriend, setWithFriend] = useState(false);
  const teams = format === TEAM_QUEUE;
  const friends = useFriends(teams && withFriend);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);

  const invited =
    teams && withFriend
      ? ((friends ?? []).find((f) => f.id === friend) ?? friends?.[0] ?? null)
      : null;
  const here = (decks ?? []).filter((d) => d.format === deckFormat(format));
  const fitting = here.filter((d) => unfit(d, casualRules) === null);
  const chosen =
    (fitting.some((d) => d.id === deck) ? deck : fitting[0]?.id) ?? "";
  const count = (fmt: QueueFormat, size: number, best = 1) =>
    queues.find(
      (q) => q.format === fmt && q.seats === size && (q.best_of ?? 1) === best,
    )?.waiting ?? 0;
  const waitingIn = (fmt: QueueFormat) =>
    SIZES[fmt].reduce(
      (sum, size) => sum + count(fmt, size) + count(fmt, size, 3),
      0,
    );
  const note = lastWait(status);

  function chooseFormat(next: QueueFormat) {
    setFormat(next);
    setDeck("");
    setSeats(next === "legacy" ? 2 : 4);
  }

  async function join(event: FormEvent) {
    event.preventDefault();
    // Sound starts only from a click: this may be the last one before the game opens.
    getSoundEngine().unlock();
    setError("");
    setJoining(true);
    const refused = await joinQueue({
      format,
      seats,
      deck_id: chosen,
      humans_only: humansOnly,
      best_of: format === "legacy" ? bestOf : 1,
      partner_id: invited?.id ?? null,
    });
    setJoining(false);
    if (refused) setError(refused);
  }

  return (
    <>
      <p className={styles.lead}>
        Play other players without an invite. The queue seats players in the
        order they joined; after a minute with too few players, bots take the
        empty seats, unless you wait for players only. Casual rules: banned
        cards and cards not legal in the format may play. In Two-Headed Giant
        you are paired with another player, or invite a friend as your teammate.
      </p>
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
      <form className={game.startForm} onSubmit={join}>
        <fieldset>
          <legend>Format</legend>
          {FORMATS.map((id) => (
            <label key={id} className={game.choice}>
              <input
                type="radio"
                name="queue-format"
                value={id}
                checked={format === id}
                onChange={() => chooseFormat(id)}
              />
              <span>
                <strong>{formatNames[id]}</strong>
                <small>
                  {FORMAT_WORDS[id]} · {waitingIn(id)} waiting
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        {teams && (
          <fieldset>
            <legend>Your teammate</legend>
            <label className={game.choice}>
              <input
                type="radio"
                name="queue-teammate"
                checked={!withFriend}
                onChange={() => setWithFriend(false)}
              />
              <span>
                <strong>Another player</strong>
                <small>
                  The queue pairs you with a player whose deck shares no card
                  with yours
                </small>
              </span>
            </label>
            <label className={game.choice}>
              <input
                type="radio"
                name="queue-teammate"
                checked={withFriend}
                onChange={() => setWithFriend(true)}
              />
              <span>
                <strong>A friend</strong>
                <small>
                  They accept with a deck of their own, then you wait together
                </small>
              </span>
            </label>
          </fieldset>
        )}
        {teams && withFriend && (
          <label className={game.field}>
            <span>Your friend</span>
            {friends !== null && friends.length === 0 ? (
              <span data-no-friend>
                You have no friends to invite yet: add them from their profiles.
              </span>
            ) : (
              <select
                value={invited?.id ?? ""}
                onChange={(event) => setFriend(event.target.value)}
              >
                {(friends ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.handle}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
        {format === "commander" && (
          <label className={game.field}>
            <span>Players</span>
            <select
              value={seats}
              onChange={(event) => setSeats(Number(event.target.value))}
            >
              {SIZES.commander.map((size) => (
                <option key={size} value={size}>
                  {players(size)} ({count("commander", size)} waiting)
                </option>
              ))}
            </select>
          </label>
        )}
        {format === "legacy" && (
          <fieldset>
            <legend>Games</legend>
            <label className={game.choice}>
              <input
                type="radio"
                name="queue-best-of"
                checked={bestOf === 1}
                onChange={() => setBestOf(1)}
              />
              <span>
                <strong>One game</strong>
                <small>{count("legacy", 2)} waiting</small>
              </span>
            </label>
            <label className={game.choice}>
              <input
                type="radio"
                name="queue-best-of"
                checked={bestOf === 3}
                onChange={() => setBestOf(3)}
              />
              <span>
                <strong>Best of three</strong>
                <small>
                  Sideboard between games · {count("legacy", 2, 3)} waiting
                </small>
              </span>
            </label>
          </fieldset>
        )}
        {decks !== null && fitting.length === 0 ? (
          <div className={game.field} data-no-deck>
            <span>Your deck</span>
            <span>
              You have no playable {formatNames[deckFormat(format)]} deck yet.
              Build one in <a href="#decks">Decks</a>.
            </span>
          </div>
        ) : (
          <label className={game.field}>
            <span>Your deck</span>
            <select
              value={chosen}
              onChange={(event) => setDeck(event.target.value)}
            >
              <DeckChoices decks={here} rules={casualRules} />
            </select>
          </label>
        )}
        <label className={game.choice}>
          <input
            type="checkbox"
            checked={humansOnly}
            onChange={(event) => setHumansOnly(event.target.checked)}
          />
          <span>
            <strong>Players only</strong>
            <small>Wait for other players, however long: no bots</small>
          </span>
        </label>
        <div className={game.startRow}>
          <button
            type="submit"
            className={game.primaryButton}
            disabled={joining || !chosen || (teams && withFriend && !invited)}
          >
            {joining
              ? "Joining…"
              : invited
                ? `Invite ${invited.handle}`
                : "Find a game"}
          </button>
          {error && (
            <p role="alert" className={game.refusal}>
              {error}
            </p>
          )}
        </div>
      </form>
    </>
  );
}

/** The time waited, counted on in the page from the server's last answer. */
function useWaited(status: QueueStatus, answeredAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return status.waited_seconds + Math.max(0, (now - answeredAt) / 1000);
}

function Waiting({
  status,
  answeredAt,
}: {
  status: QueueStatus;
  answeredAt: number;
}) {
  const seconds = useWaited(status, answeredAt);
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const fmt = status.format ?? "legacy";
  const name =
    fmt === "commander"
      ? `${formatNames[fmt]} game for ${players(status.seats ?? 4)}`
      : status.best_of === 3
        ? `${formatNames[fmt]} best-of-three match`
        : status.partner
          ? `${formatNames[fmt]} game with ${status.partner.handle}`
          : `${formatNames[fmt]} game`;
  const others = Math.max(0, status.waiting - 1);
  // Counted down to the whole second, as the wait is counted up.
  const botsIn =
    status.bots_in_seconds === null
      ? null
      : Math.max(
          0,
          Math.ceil(
            status.bots_in_seconds -
              Math.max(0, (Date.now() - answeredAt) / 1000),
          ),
        );

  async function leave() {
    setError("");
    setLeaving(true);
    const refused = await leaveQueue();
    setLeaving(false);
    if (refused) setError(refused);
  }

  return (
    <div className={styles.waiting}>
      <span className={styles.ring} aria-hidden="true" />
      <div className={styles.words} role="status">
        <strong>Looking for a {name}…</strong>
        <span className={styles.clock}>
          Waited <time>{waited(seconds)}</time>
        </span>
        <span>
          {others === 0
            ? "Nobody else is waiting yet."
            : `${others} other ${others === 1 ? "player is" : "players are"} waiting.`}{" "}
          {status.position !== null &&
            `You are ${ordinal(status.position)} in line.`}
        </span>
        <span>
          {status.humans_only
            ? "You wait for players only: no bots."
            : botsIn !== null && botsIn > 0
              ? `If too few players come, bots take the empty seats in ${waited(botsIn)}.`
              : "Bots take the empty seats if no more players come."}
        </span>
        {/* Why a game found waits to start: every slot busy, or the engine silent. */}
        {status.message && <span>{status.message}</span>}
        <small>Playing {status.deck ?? "your deck"}.</small>
      </div>
      <button
        type="button"
        className={game.secondaryButton}
        disabled={leaving}
        onClick={() => void leave()}
      >
        {leaving ? "Leaving…" : "Leave the queue"}
      </button>
      {error && (
        <p role="alert" className={game.refusal}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Keeps the account's place followed on every page of the app's shell, so the game the queue
 * finds opens wherever the player is. Draws nothing. */
export function QueueFollower() {
  useQueue();
  return null;
}
