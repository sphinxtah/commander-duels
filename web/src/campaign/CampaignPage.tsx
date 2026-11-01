import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { TierBadge } from "../alliance/TierBadge";
import { client, type Me } from "../api";
import { portraitUrl } from "../game/table/portrait";
import { hoverSound, selectSound } from "../shell/menuSound";
import {
  arrived,
  changeTutorial,
  loadCampaign,
  markSeen,
  scenesBefore,
  stepsAfterWin,
  TIER_NAMES,
  type CampaignEncounter,
  type CampaignState,
} from "./campaign";
import type { PlayerFace } from "./cast";
import { Cutscene } from "./Cutscene";
import { DuelSetup } from "./DuelSetup";
import { Journal } from "./Journal";
import { MAP_LINE, STORY, type Scene } from "./script";
import { useCampaignSettings } from "./settings";
import type { Step } from "./stage";
import styles from "./campaign.module.css";

// The Campaign page (v0.8.0): The Final Concordance's map, the refuge between battles, and the
// cut scenes. The first visit plays the opening cinematic and the refuge's introduction; an
// encounter plays its scene before the duel, then the deck choice; coming back from a duel
// (#campaign/game/<id>) plays its victory scene with the seal claimed and a chapter's rewards, or
// the defeat's line and the retreat. The story's words are web/src/campaign/script.ts; the
// progress and the duels are the API's (api/campaign.py). docs/campaign.md.

interface Playing {
  scenes: Scene[];
  /** Extra steps after the last scene's lines. */
  extra?: Step[];
  then?: () => void;
  key: number;
}

interface Aftermath {
  gameId: string;
  encounter: number;
  outcome: "lost" | "draw" | "unfinished";
}

export function CampaignPage({
  me,
  heading,
  returning,
}: {
  me: Me;
  heading: RefObject<HTMLHeadingElement | null>;
  /** The campaign duel this visit comes back from (#campaign/game/<id>). */
  returning?: string;
}) {
  const [state, setState] = useState<CampaignState | null>();
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [setup, setSetup] = useState<number | null>(null);
  const [journal, setJournal] = useState(false);
  const [aftermath, setAftermath] = useState<Aftermath | null>(null);
  const [notice, setNotice] = useState("");
  const [lost, setLost] = useState<Set<number>>(new Set());
  const [settings, updateSettings] = useCampaignSettings();
  const started = useRef(false);
  const counter = useRef(0);
  const player = useMemo<PlayerFace>(
    () => ({
      name: me.handle ?? me.display_name,
      alliance: me.alliance ?? null,
    }),
    [me.handle, me.display_name, me.alliance],
  );

  const play = useCallback((next: Omit<Playing, "key">) => {
    counter.current += 1;
    setPlaying({ ...next, key: counter.current });
  }, []);

  useEffect(() => {
    let active = true;
    void loadCampaign().then((data) => {
      if (active) setState(data);
    });
    return () => {
      active = false;
    };
  }, []);

  // What the visit opens on, once: the story of the duel it comes back from, else the opening
  // cinematic on a first visit, else the replay's framing once the campaign is complete.
  useEffect(() => {
    if (!state || started.current) return;
    started.current = true;
    if (returning) {
      void tellDuel(returning);
      return;
    }
    const seen = new Set(state.progress.scenes_seen);
    if (!seen.has(STORY.opening.id)) {
      const scenes = [STORY.opening, STORY.refugeIntro];
      if (me.alliance === "kaya") scenes.push(STORY.allianceKaya);
      play({ scenes });
    } else if (state.progress.ending && !seen.has(STORY.replay.id)) {
      play({ scenes: [STORY.replay] });
    }
    // Once, as the page has the campaign.
  }, [state]);

  async function tellDuel(gameId: string) {
    // The address becomes the map's, so a reload does not tell the story again.
    history.replaceState(history.state, "", "#campaign");
    let summary = await gameOf(gameId);
    for (let tries = 0; tries < 15 && summary?.status === "active"; tries++) {
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      summary = await gameOf(gameId);
    }
    const ref = summary?.campaign;
    if (!summary || !ref) return;
    if (summary.status === "active") {
      setNotice("Your duel is still going.");
      return;
    }
    const fresh = (await loadCampaign()) ?? state ?? null;
    if (fresh) setState(fresh);
    const number = ref.encounter;
    const story = STORY.encounters[number];
    const encounter = fresh?.encounters.find((e) => e.number === number);
    if (!story || !encounter || !fresh) return;
    if (ref.outcome === "won") {
      if (number === 14) {
        const early = arrived(gameId) === false;
        const ending = early ? STORY.endings.early : STORY.endings.win;
        play({
          scenes: [ending],
          extra: [
            ...stepsAfterWin(fresh, encounter),
            {
              kind: "card",
              kicker: fresh.title,
              title: "The Concordance is revoked",
              text: "Every seal answered to you, and you gave them back. Replay any duel from the map; the Archive kept their shape.",
            },
          ],
        });
        return;
      }
      const post = story.post;
      if (!post) return;
      const first = !fresh.progress.scenes_seen.includes(post.id);
      play({
        scenes: [post],
        extra: first ? stepsAfterWin(fresh, encounter) : [],
      });
      return;
    }
    if (ref.outcome === "lost" || ref.outcome === "draw") {
      setLost((current) => new Set(current).add(number));
      const loss = number === 14 ? STORY.finale.loss : story.loss;
      play({
        scenes: loss ? [loss] : [],
        then: () =>
          setAftermath({
            gameId,
            encounter: number,
            outcome: ref.outcome as "lost" | "draw",
          }),
      });
      return;
    }
    setAftermath({ gameId, encounter: number, outcome: "unfinished" });
  }

  async function seen(scene: string) {
    const next = await markSeen(scene);
    if (next) setState(next);
  }

  function begin(encounter: CampaignEncounter) {
    if (encounter.status === "locked" || !state) return;
    selectSound();
    setAftermath(null);
    const scenes = scenesBefore(state, encounter, me.alliance ?? null);
    play({
      scenes,
      then: () => setSetup(encounter.number),
    });
  }

  if (state === undefined)
    return (
      <section className={styles.page} aria-labelledby="campaign-title">
        <h1
          id="campaign-title"
          ref={heading}
          tabIndex={-1}
          className={styles.visuallyHidden}
        >
          Campaign
        </h1>
        <p role="status" className={styles.quiet}>
          Opening the Archive…
        </p>
      </section>
    );
  if (state === null)
    return (
      <section className={styles.page} aria-labelledby="campaign-title">
        <h1 id="campaign-title" ref={heading} tabIndex={-1}>
          Campaign
        </h1>
        <p role="alert" className={styles.error}>
          The campaign could not be opened. Check your connection, or try again
          later.
        </p>
      </section>
    );

  const won = new Set(state.progress.completed);
  const next = state.encounters.find((e) => e.status === "open");
  const current = playing?.scenes[0];
  const setupEncounter = state.encounters.find((e) => e.number === setup);
  const rewards = state.chapters.flatMap((chapter) =>
    chapter.rewards.filter((reward) => reward.earned),
  );

  return (
    <section className={styles.page} aria-labelledby="campaign-title">
      <header className={styles.hero}>
        <div className={styles.heroArt} aria-hidden="true">
          <span className={styles.heroThrone} />
        </div>
        <div className={styles.heroWords}>
          <span className={styles.kicker}>Campaign</span>
          <h1
            id="campaign-title"
            ref={heading}
            tabIndex={-1}
            className={styles.heroTitle}
          >
            {state.title}
          </h1>
          <p className={styles.heroLine}>{MAP_LINE}.</p>
          <div className={styles.seals} aria-label="Seals">
            {state.encounters
              .filter((e) => e.number < 14)
              .map((e) => (
                <span
                  key={e.number}
                  className={[
                    styles.sealIcon,
                    won.has(e.number) ? styles.sealWon : "",
                  ].join(" ")}
                  title={
                    won.has(e.number)
                      ? `Seal ${String(e.number).padStart(2, "0")} · ${e.seal}`
                      : `Seal ${String(e.number).padStart(2, "0")} · not yet claimed`
                  }
                  data-tier={e.tier}
                >
                  {String(e.number).padStart(2, "0")}
                </span>
              ))}
            <span
              className={[
                styles.sealThrone,
                won.has(14) ? styles.sealWon : "",
              ].join(" ")}
              title={won.has(14) ? "The throne: revoked" : "The throne"}
              aria-hidden="true"
            />
            <span className={styles.visuallyHidden}>
              {won.size >= 14 ? 13 : won.size} of 13 seals claimed
              {won.has(14) ? ", and the throne's claim revoked" : ""}
            </span>
          </div>
          <div className={styles.heroActions}>
            {state.running ? (
              <a className={styles.gold} href={`#game/${state.running}`}>
                Return to your duel <span aria-hidden="true">▶</span>
              </a>
            ) : next ? (
              <button
                type="button"
                className={styles.gold}
                onClick={() => begin(next)}
                onPointerEnter={() => hoverSound()}
              >
                {next.number === 1 && won.size === 0 ? "Begin" : "Continue"}:{" "}
                {next.title} <span aria-hidden="true">▶</span>
              </button>
            ) : null}
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setJournal(true)}
            >
              Journal
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => play({ scenes: [STORY.opening] })}
            >
              Replay the opening
            </button>
          </div>
          {notice && (
            <p role="status" className={styles.quiet}>
              {notice}
            </p>
          )}
        </div>
      </header>

      {aftermath && (
        <Retreat
          aftermath={aftermath}
          state={state}
          onRetry={() => {
            const encounter = state.encounters.find(
              (e) => e.number === aftermath.encounter,
            );
            setAftermath(null);
            if (encounter) setSetup(encounter.number);
          }}
          onClose={() => setAftermath(null)}
        />
      )}

      <div className={styles.layout}>
        <ol className={styles.map} aria-label="The wards">
          {state.chapters.map((chapter) => (
            <li
              key={chapter.tier}
              className={styles.chapter}
              data-tier={chapter.tier}
              data-complete={chapter.complete}
            >
              <div className={styles.chapterHead}>
                <TierBadge tier={chapter.tier} size={44} decorative />
                <h2>
                  {TIER_NAMES[chapter.tier]}
                  <span className={styles.chapterCount}>
                    {chapter.encounters.length === 1
                      ? chapter.tier === "godlike"
                        ? "The final duel"
                        : "1 ward"
                      : `${chapter.encounters.length} wards`}
                  </span>
                </h2>
                {chapter.complete && (
                  <span className={styles.chip}>Complete</span>
                )}
              </div>
              <ol className={styles.nodes}>
                {chapter.encounters.map((number) => {
                  const encounter = state.encounters.find(
                    (e) => e.number === number,
                  );
                  return encounter ? (
                    <Node
                      key={number}
                      encounter={encounter}
                      onBegin={() => begin(encounter)}
                    />
                  ) : null;
                })}
              </ol>
            </li>
          ))}
        </ol>

        <aside className={styles.refuge} aria-labelledby="refuge-title">
          <img
            className={styles.refugeKaya}
            src={portraitUrl("kaya", 256)}
            alt=""
            width={160}
            height={160}
          />
          <h2 id="refuge-title">The refuge</h2>
          <p className={styles.refugeLine}>
            &ldquo;{STORY.refugeIntro.lines[0]?.text}&rdquo;
            <span className={styles.quiet}> — Kaya</span>
          </p>
          <ul className={styles.refugeLinks}>
            <li>
              <a href="#decks">Rebuild your decks</a>
            </li>
            <li>
              <a href="#profile">Review your alliance</a>
            </li>
            <li>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setJournal(true)}
              >
                Read the journal
              </button>
            </li>
          </ul>

          <h3>Story settings</h3>
          <label className={styles.setting}>
            <span>Text speed</span>
            <select
              value={settings.textSpeed}
              onChange={(event) =>
                updateSettings({
                  textSpeed: event.target.value as typeof settings.textSpeed,
                })
              }
            >
              <option value="slow">Slow</option>
              <option value="normal">Normal</option>
              <option value="fast">Fast</option>
              <option value="instant">Instant</option>
            </select>
          </label>
          <label className={styles.setting}>
            <input
              type="checkbox"
              checked={settings.auto}
              onChange={(event) =>
                updateSettings({ auto: event.target.checked })
              }
            />
            <span>Read on by itself (Auto)</span>
          </label>
          <label className={styles.setting}>
            <input
              type="checkbox"
              checked={settings.barks}
              onChange={(event) =>
                updateSettings({ barks: event.target.checked })
              }
            />
            <span>Opponents speak during duels</span>
          </label>
          <label className={styles.setting}>
            <input
              type="checkbox"
              checked={settings.music}
              onChange={(event) =>
                updateSettings({ music: event.target.checked })
              }
            />
            <span>Music in the cut scenes</span>
          </label>
          <label className={styles.setting}>
            <input
              type="checkbox"
              checked={state.progress.tutorial.hints}
              onChange={(event) =>
                void changeTutorial({ hints: event.target.checked }).then(
                  (next) => next && setState(next),
                )
              }
            />
            <span>Kaya&rsquo;s hints in the first duel</span>
          </label>

          {rewards.length > 0 && (
            <>
              <h3>Rewards</h3>
              <ul className={styles.rewardList}>
                {rewards.map((reward) => (
                  <li key={reward.id}>{reward.name}</li>
                ))}
              </ul>
            </>
          )}

          <h3>The campaign&rsquo;s rules</h3>
          <ul className={styles.rules}>
            <li>
              Win a duel to claim its seal and open the next ward. A lost duel
              is a retreat: nothing won is lost, and you try again from its
              start.
            </li>
            <li>
              Beating a warden the first time wins their deck, every card of it
              yours, and tokens: 1,000 for the first warden, doubling with each
              (8,192,000 for The Sphinx).
            </li>
            <li>
              Campaign duels count no wins towards your tier and advance no
              quests; the campaign&rsquo;s other rewards are its seals, card
              backs and titles.
            </li>
            <li>
              Your alliance keeps all its bonuses whoever you face, your
              ally&rsquo;s incarnation included.
            </li>
            <li>
              Duels won can be played again for the story; they earn nothing
              twice.
            </li>
          </ul>
        </aside>
      </div>

      {setupEncounter && (
        <DuelSetup
          state={state}
          encounter={setupEncounter}
          lostBefore={lost.has(setupEncounter.number)}
          canUseOwnDecks={me.permissions.includes("decks.edit")}
          onClose={() => setSetup(null)}
          onState={setState}
        />
      )}
      {journal && <Journal state={state} onClose={() => setJournal(false)} />}
      {playing && current && (
        <Cutscene
          key={`${playing.key}-${current.id}`}
          scene={current}
          extra={playing.scenes.length === 1 ? playing.extra : undefined}
          player={player}
          onDone={() => {
            const rest = playing.scenes.slice(1);
            void seen(current.id);
            if (rest.length > 0) {
              setPlaying({ ...playing, scenes: rest });
              return;
            }
            setPlaying(null);
            playing.then?.();
          }}
        />
      )}
    </section>
  );
}

async function gameOf(gameId: string) {
  const { data } = await client.GET("/api/v1/games/{game_id}", {
    params: { path: { game_id: gameId } },
  });
  return data?.game;
}

function Node({
  encounter,
  onBegin,
}: {
  encounter: CampaignEncounter;
  onBegin: () => void;
}) {
  const locked = encounter.status === "locked";
  const finale = encounter.number === 14;
  const number = String(encounter.number).padStart(2, "0");
  return (
    <li
      className={styles.node}
      data-status={encounter.status}
      data-finale={finale || undefined}
      style={{ "--i": encounter.number } as CSSProperties}
    >
      <button
        type="button"
        className={styles.nodeButton}
        disabled={locked}
        onClick={onBegin}
        onPointerEnter={() => !locked && hoverSound()}
        aria-label={
          locked
            ? `Encounter ${number}: locked`
            : `Encounter ${number}: ${encounter.title}, against ${encounter.name}${
                encounter.status === "won" ? ", won" : ""
              }`
        }
      >
        <span className={styles.medallion} aria-hidden="true">
          {finale ? (
            <span className={styles.throneIcon} />
          ) : (
            <img
              src={portraitUrl(encounter.opponent, 256)}
              alt=""
              loading="lazy"
            />
          )}
          {encounter.status === "won" && (
            <span className={styles.wonSeal}>{number}</span>
          )}
        </span>
        <span className={styles.nodeWords}>
          <span className={styles.nodeNumber}>{finale ? "Final" : number}</span>
          <span className={styles.nodeTitle}>
            {locked ? "Sealed ward" : encounter.title}
          </span>
          <span className={styles.nodeName}>
            {locked
              ? "Win the ward before it"
              : finale
                ? "The throne"
                : encounter.name}
          </span>
          {encounter.status === "won" && (
            <span className={styles.nodeSeal}>Seal · {encounter.seal}</span>
          )}
          {!locked && (
            <span
              className={styles.nodeSpoils}
              data-earned={encounter.spoils.earned || undefined}
            >
              {encounter.spoils.earned ? "Won · " : ""}
              {encounter.spoils.deck} ·{" "}
              {encounter.spoils.tokens.toLocaleString("en-US")} tokens
            </span>
          )}
          {encounter.status === "open" && (
            <span className={styles.nodeAction}>
              Begin <span aria-hidden="true">▶</span>
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function Retreat({
  aftermath,
  state,
  onRetry,
  onClose,
}: {
  aftermath: Aftermath;
  state: CampaignState;
  onRetry: () => void;
  onClose: () => void;
}) {
  const encounter = state.encounters.find(
    (e) => e.number === aftermath.encounter,
  );
  const story = STORY.encounters[aftermath.encounter];
  return (
    <section className={styles.retreat} aria-labelledby="retreat-title">
      <h2 id="retreat-title">
        {aftermath.outcome === "unfinished"
          ? "The duel ended without a result"
          : aftermath.outcome === "draw"
            ? "A draw: the ward holds"
            : "Retreat through the silver light"}
      </h2>
      <p>
        {aftermath.outcome === "unfinished"
          ? "The table closed, timed out or reached its turn limit. Nothing changed: the seals you hold are yours."
          : "Kaya's tether caught you. The seals you hold are still yours, and the ward waits for another try."}
      </p>
      {story?.counterplay && aftermath.outcome !== "unfinished" && (
        <p className={styles.advice}>
          <strong>Review the defeat:</strong> {story.counterplay}{" "}
          <a href={`#game/${aftermath.gameId}`}>
            See the game&rsquo;s board and log
          </a>
          .
        </p>
      )}
      <div className={styles.heroActions}>
        <button type="button" className={styles.gold} onClick={onRetry}>
          Retry {encounter ? encounter.title : "the duel"}
        </button>
        <a className={styles.secondary} href="#decks">
          Edit a deck
        </a>
        <button type="button" className={styles.secondary} onClick={onClose}>
          Return to the campaign
        </button>
      </div>
    </section>
  );
}
