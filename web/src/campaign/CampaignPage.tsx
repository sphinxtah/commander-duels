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
  COURT,
  FLIGHT,
  loadCampaign,
  markSeen,
  scenesBefore,
  stepsAfterWin,
  TIER_NAMES,
  type CampaignEncounter,
  type CampaignState,
} from "./campaign";
import type { PlayerFace } from "./cast";
import { CosmeticsPicker } from "./CosmeticsPicker";
import { Cutscene } from "./Cutscene";
import { DuelSetup } from "./DuelSetup";
import { Journal } from "./Journal";
import {
  loadOpenings,
  WardenOpening,
  type WardenOpeningSummary,
} from "./WardenOpening";
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
  // Apex Unbound's setup (v0.9.3): the finale's, for the challenge.
  const [challenging, setChallenging] = useState(false);
  const [journal, setJournal] = useState(false);
  const [aftermath, setAftermath] = useState<Aftermath | null>(null);
  // A warden's deck to open (v0.9.5), and what follows it; the decks won, opened or waiting.
  const [opening, setOpening] = useState<{
    id: string;
    then?: () => void;
  } | null>(null);
  const [openings, setOpenings] = useState<WardenOpeningSummary[]>([]);
  const [notice, setNotice] = useState("");
  const [lost, setLost] = useState<Set<number>>(new Set());
  // The Sphinx's flight from ward 14 (v0.9.6), played on the map once after its scene.
  const [fleeing, setFleeing] = useState(false);
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
    void loadOpenings().then((found) => {
      if (active) setOpenings(found);
    });
    return () => {
      active = false;
    };
  }, []);

  /** Opens a warden's deck, then runs what follows (the spoils card after a duel). */
  function unseal(id: string, then?: () => void) {
    setOpening({ id, then });
  }

  /** The win's steps, split: the seal with the scene, the rest after the deck is opened when
   * one waits (v0.9.5: the duel's end, the cut scene, the opening, then the spoils card). */
  function afterWin(
    scenes: Scene | Scene[],
    steps: Step[],
    waiting: WardenOpeningSummary[],
  ) {
    const all = Array.isArray(scenes) ? scenes : [scenes];
    const scene = all[all.length - 1] as Scene;
    if (waiting.length === 0) return play({ scenes: all, extra: steps });
    const seal = steps.filter((step) => step.kind === "seal");
    const rest = steps.filter((step) => step.kind !== "seal");
    // The rest plays over the scene's own scenery, without its lines.
    const after: Scene = {
      ...scene,
      caption: undefined,
      intro: undefined,
      outro: undefined,
      lines: [],
    };
    // Each deck waiting is opened in turn (since v0.9.6 the court gives three).
    const open = (left: WardenOpeningSummary[]) => {
      const [next, ...others] = left;
      if (!next) {
        if (rest.length > 0) play({ scenes: [after], extra: rest });
        return;
      }
      unseal(next.id, () => open(others));
    };
    play({ scenes: all, extra: seal, then: () => open(waiting) });
  }

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
    if (ref.challenge && number === FLIGHT && ref.outcome === "won") {
      // Apex Unbound's Sphinx flees too (v0.9.6): the challenge goes on at his court.
      setFleeing(true);
      setNotice(
        "The Sphinx fled again. Apex Unbound goes on at The Unbound Court: take the challenge from the map.",
      );
      return;
    }
    if (ref.challenge) {
      // Apex Unbound tells no story: the ending stays the one already won.
      setNotice(
        ref.outcome === "won"
          ? `${fresh?.challenge.name ?? "Apex Unbound"} is beaten. Its badge is on your profile.`
          : ref.outcome === "lost" || ref.outcome === "draw"
            ? "The throne held. Take the challenge again from the map."
            : "The challenge did not finish. Take it again from the map.",
      );
      return;
    }
    const story = STORY.encounters[number];
    const encounter = fresh?.encounters.find((e) => e.number === number);
    if (!story || !encounter || !fresh) return;
    if (ref.outcome === "won") {
      const found = await loadOpenings();
      setOpenings(found);
      const waiting = found.filter(
        (item) =>
          !item.opened_at &&
          (item.encounter === number ||
            (number === COURT && item.encounter === FLIGHT)),
      );
      if (number === FLIGHT && encounter.status === "fled") {
        // The Sphinx flees (v0.9.6): his recall and flight, then the map shows the empty throne.
        play({
          scenes: [STORY.flight],
          then: () => {
            setFleeing(true);
            setNotice(
              "The Sphinx fled to his court. The Unbound Court is open: win it to claim both wards.",
            );
          },
        });
        return;
      }
      // A later win that gives spoils an earlier one left owing (v0.9.7: a first win with
      // passive bots pays nothing) still shows them: a deck of the ward's waits to be opened.
      const owed = (ward: CampaignEncounter): Step[] =>
        waiting.some((item) => item.encounter === ward.number)
          ? stepsAfterWin(fresh, ward).filter((step) => step.kind === "spoils")
          : [];
      if (number === COURT) {
        const flight = fresh.encounters.find((e) => e.number === FLIGHT);
        const first = !fresh.progress.scenes_seen.includes(STORY.court.post.id);
        afterWin(
          [STORY.court.post, STORY.endings.win],
          [
            ...(flight
              ? first
                ? stepsAfterWin(fresh, flight)
                : owed(flight)
              : []),
            ...(first ? stepsAfterWin(fresh, encounter) : owed(encounter)),
            {
              kind: "card",
              kicker: fresh.title,
              title: "The Concordance is revoked",
              text: "The throne and its court are empty, and every seal answered to you. Replay any ward from the map; the Archive kept their shape.",
            },
          ],
          waiting,
        );
        return;
      }
      if (number === 14) {
        const early = arrived(gameId) === false;
        const ending = early ? STORY.endings.early : STORY.endings.win;
        afterWin(
          ending,
          [
            ...stepsAfterWin(fresh, encounter),
            {
              kind: "card",
              kicker: fresh.title,
              title: "The Concordance is revoked",
              text: "Every seal answered to you, and you gave them back. Replay any duel from the map; the Archive kept their shape.",
            },
          ],
          waiting,
        );
        return;
      }
      const post = story.post;
      if (!post) return;
      const first = !fresh.progress.scenes_seen.includes(post.id);
      afterWin(
        post,
        first ? stepsAfterWin(fresh, encounter) : owed(encounter),
        waiting,
      );
      return;
    }
    if (ref.outcome === "lost" || ref.outcome === "draw") {
      setLost((current) => new Set(current).add(number));
      const loss = number === 14 ? STORY.finale.loss : story.loss;
      if (number === COURT && encounter.status !== "open")
        setNotice(
          "The court held. You are back at the throne: win ward 14 again to reach it.",
        );
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
  const rewards = [
    ...state.chapters.flatMap((chapter) =>
      chapter.rewards.filter((reward) => reward.earned),
    ),
    ...(state.challenge.earned
      ? [{ id: "badge:apex-unbound", name: `${state.challenge.name} badge` }]
      : []),
  ];
  const finale = state.encounters.find((e) => e.number === 14);
  // Apex Unbound (since v0.9.6 wards 14 and 15 as one run): the ward its run stands at.
  const challengeAt =
    state.encounters.find((e) => e.number === state.challenge.at) ?? finale;

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
            {state.encounters.some((e) => e.number === COURT) && (
              <span
                className={[
                  styles.sealCourt,
                  won.has(COURT) ? styles.sealWon : "",
                ].join(" ")}
                title={
                  won.has(COURT)
                    ? "The court: emptied · Sovereignty"
                    : "The court"
                }
                aria-hidden="true"
              />
            )}
            <span className={styles.visuallyHidden}>
              {[...won].filter((n) => n < 14).length} of 13 seals claimed
              {won.has(14) ? ", and the throne's claim revoked" : ""}
              {won.has(COURT) ? ", and the court emptied" : ""}
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

      {openings.length > 0 && (
        <section className={styles.openings} aria-label="Warden decks">
          <span className={styles.openingsTitle}>Warden decks</span>
          <ul>
            {openings.map((item) => (
              <li key={item.id} data-waiting={!item.opened_at || undefined}>
                <button
                  type="button"
                  className={item.opened_at ? styles.secondary : styles.gold}
                  onClick={() =>
                    unseal(item.id, () =>
                      setOpenings((current) =>
                        current.map((found) =>
                          found.id === item.id
                            ? {
                                ...found,
                                opened_at:
                                  found.opened_at ?? new Date().toISOString(),
                              }
                            : found,
                        ),
                      ),
                    )
                  }
                >
                  {item.opened_at
                    ? `Open ${item.deck_title} again`
                    : `Open ${item.deck_title}`}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {aftermath && (
        <Retreat
          aftermath={aftermath}
          state={state}
          onRetry={() => {
            const encounter = state.encounters.find(
              (e) => e.number === aftermath.encounter,
            );
            setAftermath(null);
            // A lost court (v0.9.6) is retried from the throne, unless it stays open.
            if (encounter?.status === "locked" && encounter.number === COURT)
              setSetup(FLIGHT);
            else if (encounter) setSetup(encounter.number);
          }}
          onClose={() => setAftermath(null)}
        />
      )}

      <div className={styles.layout}>
        <ol className={styles.map} aria-label="The wards">
          {state.chapters.map((chapter) => (
            <li
              key={chapter.name}
              className={styles.chapter}
              data-tier={chapter.tier}
              data-complete={chapter.complete}
            >
              <div className={styles.chapterHead}>
                <TierBadge tier={chapter.tier} size={44} decorative />
                <h2>
                  {chapter.encounters.includes(COURT)
                    ? chapter.name
                    : TIER_NAMES[chapter.tier]}
                  <span className={styles.chapterCount}>
                    {chapter.encounters.includes(COURT)
                      ? "King's Table"
                      : chapter.encounters.length === 1
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
                      fleeing={fleeing && number === FLIGHT}
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

          {state.challenge.open && challengeAt && (
            <div className={styles.challenge}>
              <h3>{state.challenge.name}</h3>
              <p>
                The throne and its court again, as one run, as the Archive kept
                them, with Kaya&rsquo;s aids off. Win both for a badge of its
                own; the ending you won stays yours, and nothing else is won
                twice.
                {state.challenge.at === COURT
                  ? " The Sphinx has fled: the challenge stands at his court."
                  : ""}
              </p>
              <button
                type="button"
                className={styles.gold}
                onClick={() => {
                  selectSound();
                  setAftermath(null);
                  setChallenging(true);
                }}
              >
                {state.challenge.earned
                  ? "Take the challenge again"
                  : "Take the challenge"}
              </button>
            </div>
          )}

          {rewards.length > 0 && (
            <>
              <h3>Rewards</h3>
              <ul className={styles.rewardList}>
                {rewards.map((reward) => (
                  <li key={reward.id}>{reward.name}</li>
                ))}
              </ul>
              <CosmeticsPicker />
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
              (8,192,000 for The Sphinx, 16,384,000 for his court).
            </li>
            <li>
              The throne and the court are one run: The Sphinx flees the throne
              to his court, and both pay when the court is won. Losing the court
              sends you back to the throne.
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
      {challenging && challengeAt && (
        <DuelSetup
          state={state}
          encounter={challengeAt}
          lostBefore={false}
          canUseOwnDecks={me.permissions.includes("decks.edit")}
          challenge
          onClose={() => setChallenging(false)}
          onState={setState}
        />
      )}
      {journal && <Journal state={state} onClose={() => setJournal(false)} />}
      {opening && (
        <WardenOpening
          key={opening.id}
          id={opening.id}
          onDone={() => {
            const then = opening.then;
            setOpening(null);
            setOpenings((current) =>
              current.map((found) =>
                found.id === opening.id
                  ? {
                      ...found,
                      opened_at: found.opened_at ?? new Date().toISOString(),
                    }
                  : found,
              ),
            );
            then?.();
          }}
        />
      )}
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
  fleeing = false,
  onBegin,
}: {
  encounter: CampaignEncounter;
  /** The Sphinx's flight, played once (v0.9.6): he shakes with fury, then flees the throne. */
  fleeing?: boolean;
  onBegin: () => void;
}) {
  const locked = encounter.status === "locked";
  const finale = encounter.number === 14;
  const court = encounter.number === COURT;
  const fled = encounter.status === "fled";
  const number = String(encounter.number).padStart(2, "0");
  return (
    <li
      className={styles.node}
      data-status={encounter.status}
      data-finale={finale || undefined}
      data-court={court || undefined}
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
                encounter.status === "won"
                  ? ", won"
                  : fled
                    ? ", fled: he waits at his court"
                    : ""
              }`
        }
      >
        <span className={styles.medallion} aria-hidden="true">
          {finale && fled ? (
            <>
              {fleeing && (
                <img
                  className={styles.fleeing}
                  src={portraitUrl(encounter.opponent, 256)}
                  alt=""
                />
              )}
              <span
                className={styles.fledMarker}
                data-after={fleeing || undefined}
              >
                Fled
              </span>
            </>
          ) : finale ? (
            <span className={styles.throneIcon} />
          ) : court ? (
            <>
              <img
                src={portraitUrl(encounter.opponent, 256)}
                alt=""
                loading="lazy"
              />
              <span className={styles.courtCrown} />
            </>
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
          <span className={styles.nodeNumber}>
            {finale ? "Final" : court ? "Court" : number}
          </span>
          <span className={styles.nodeTitle}>
            {locked ? "Sealed ward" : encounter.title}
          </span>
          <span className={styles.nodeName}>
            {locked
              ? "Win the ward before it"
              : finale
                ? fled
                  ? "The throne stands empty"
                  : "The throne"
                : court
                  ? "The Sphinx, Nicol Bolas and Liliana"
                  : encounter.name}
          </span>
          {encounter.status === "won" && (
            <span className={styles.nodeSeal}>Seal · {encounter.seal}</span>
          )}
          {fled && (
            <span className={styles.nodeSeal}>
              Fled · its spoils wait with the court&rsquo;s
            </span>
          )}
          {!locked && (
            <span
              className={styles.nodeSpoils}
              data-earned={encounter.spoils.earned || undefined}
            >
              {encounter.spoils.earned ? "Won · " : ""}
              {encounter.spoils.decks
                .map((deck) => deck.title)
                .join(" & ")} ·{" "}
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
