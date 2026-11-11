import { useEffect, useRef, useState, type CSSProperties } from "react";
import { portraitUrl } from "../game/table/portrait";
import type { GameView, LogLine, Prompt } from "../game/types";
import {
  FRESH_MEMORY,
  fires,
  incarnation,
  lesson,
  observe,
  remember,
  type Memory,
  type Observation,
} from "./barks";
import { changeTutorial, rememberArrival, type CampaignRef } from "./campaign";
import { speakerName, speakerPortrait } from "./cast";
import { STORY, type Line, type Speaker } from "./script";
import { useCampaignSettings } from "./settings";
import styles from "./layer.module.css";

// A campaign duel's voices at the table (v0.8.0). The opponent's barks and Kaya's, as speech
// bubbles by their portraits that never pause the game, cover the stack or take a click; in the
// finale, The Sphinx's crossing into the duel (a fracture of gold over the table, his lines, and
// the handoff's tooltip) and his returns; and in the first duel with hints on, Kaya's lessons as
// cards that follow the board, each with Got it and Turn off hints. What fires when is barks.ts.

interface Spoken {
  line: Line;
  key: number;
}

/** How long a bark stays, by its length. */
function holdMs(text: string): number {
  return Math.min(9000, 3200 + text.length * 45);
}

export function CampaignLayer({
  gameId,
  campaign,
  view,
  prompt,
  log,
  over,
}: {
  gameId: string;
  campaign: CampaignRef;
  view: GameView | null;
  prompt: Prompt | null;
  log: LogLine[];
  /** The game has ended: barks stop, the queue empties. */
  over: boolean;
}) {
  const [settings] = useCampaignSettings();
  const [spoken, setSpoken] = useState<Spoken | null>(null);
  const [queue, setQueue] = useState<Line[]>([]);
  const [hint, setHint] = useState<{ id: string; text: string } | null>(null);
  const [hints, setHints] = useState(campaign.hints);
  const [arrival, setArrival] = useState(0);
  const [tip, setTip] = useState<string | null>(null);
  const before = useRef<Observation | null>(null);
  /** The board at the lessons' last look (v0.9.1). */
  const lessonBefore = useRef<Observation | null>(null);
  const memory = useRef<Memory>(FRESH_MEMORY);
  const said = useRef(new Set<string>());
  const taught = useRef(new Set<string>());
  const seenLog = useRef(0);
  const counter = useRef(0);
  const finale = campaign.encounter === 14;
  // Ward 15, the court (v0.9.6): The Sphinx is King B, his incarnation there from the start.
  const court = campaign.encounter === 15;
  const story = STORY.encounters[campaign.encounter];

  // Each new view: what it fires.
  useEffect(() => {
    if (!view || over) return;
    const now = observe(view, log, seenLog.current, story?.bossSeat);
    seenLog.current = (log[log.length - 1]?.index ?? -1) + 1;
    const was = before.current;
    const mind = memory.current;
    const lines: Line[] = [];
    const say = (line: Line | undefined, once = true) => {
      if (!line || (once && said.current.has(line.id))) return;
      said.current.add(line.id);
      lines.push(line);
    };
    if (settings.barks) {
      for (const bark of story?.barks ?? [])
        if (!said.current.has(bark.id) && fires(bark.trigger, was, now, mind))
          say(bark);
      if (finale) {
        for (const bark of STORY.finale.escalation)
          if (!said.current.has(bark.id) && fires(bark.trigger, was, now, mind))
            say(bark);
        // The finale's first phase: the boss's commander cast, then your commander's return.
        const phase1 = STORY.finale.phase1;
        if (was && now.boss.commanderCasts > was.boss.commanderCasts)
          say(phase1[0]);
        if (
          was &&
          was.you.commanderZone !== "command" &&
          now.you.commanderZone === "command" &&
          now.you.commanderCasts > 0
        )
          for (const line of phase1.slice(1)) say(line);
      }
      if (campaign.encounter === 1 && hints) {
        const help = STORY.tutorialHelp;
        if (prompt?.kind === "priority" && (prompt.options.length ?? 0) > 2)
          say(help[0]);
        if (
          was &&
          now.boss.creatures > was.boss.creatures &&
          was.boss.creatures === 0
        )
          say(help[1]);
        if (was && now.you.creatures < was.you.creatures && !now.bossAttack)
          say(help[3]);
      }
    }
    if ((finale || court) && campaign.finale === "private") {
      const voices = court
        ? {
            arrival: STORY.court.arrival,
            removed: STORY.court.removed,
            recast: STORY.court.returned,
            tip: STORY.court.arrivalTip,
          }
        : {
            arrival: STORY.finale.arrival,
            removed: STORY.finale.removed,
            recast: STORY.finale.recast,
            tip: STORY.finale.arrivalTip,
          };
      const step = incarnation(was, now, mind, court);
      if (step === "arrived") {
        memory.current = { ...memory.current, arrived: true };
        rememberArrival(gameId);
        setArrival((value) => value + 1);
        setTip(voices.tip);
        for (const line of voices.arrival) say(line);
      } else if (step === "removed") {
        const first = !memory.current.removed;
        memory.current = { ...memory.current, removed: true };
        if (first) for (const line of voices.removed) say(line);
      } else if (step === "returned") {
        const returns = memory.current.returns + 1;
        const quiet = now.turn - memory.current.lastReturnTurn < 2;
        memory.current = {
          ...memory.current,
          returns,
          lastReturnTurn: now.turn,
        };
        if (returns === 1) for (const line of voices.recast) say(line);
        else if (!quiet) say(voices.recast[0], false);
        setArrival((value) => value + 1);
      }
    }
    memory.current = remember(memory.current, was, now);
    before.current = now;
    if (lines.length > 0)
      setQueue((current) => [...current, ...lines].slice(-6));
  }, [view, prompt, log, over]);

  // Lessons: one at a time, each once. Looked at again when a lesson closes (v0.9.1), so a
  // moment that came while another lesson showed (the mulligan, behind the welcome) isn't lost;
  // the board they compare with is the one of the last look, so a creature that entered meanwhile
  // still counts.
  useEffect(() => {
    if (campaign.encounter !== 1 || !hints || hint || over || !view) return;
    const now = before.current;
    if (!now) return;
    const was = lessonBefore.current;
    lessonBefore.current = now;
    for (const entry of STORY.tutorial) {
      if (entry.id === "T12" || taught.current.has(entry.id)) continue;
      if (lesson(entry.id, was, now, prompt, view)) {
        taught.current.add(entry.id);
        setHint({ id: entry.id, text: entry.text });
        void changeTutorial({ lessons: [entry.id] });
        break;
      }
    }
  }, [view, prompt, hint, hints, over, campaign.encounter]);

  // The queue speaks one line at a time.
  useEffect(() => {
    if (spoken || queue.length === 0) return;
    const [line, ...rest] = queue;
    if (!line) return;
    counter.current += 1;
    setSpoken({ line, key: counter.current });
    setQueue(rest);
  }, [spoken, queue]);
  useEffect(() => {
    if (!spoken) return;
    const timer = window.setTimeout(
      () => setSpoken(null),
      holdMs(spoken.line.text),
    );
    return () => window.clearTimeout(timer);
  }, [spoken]);
  useEffect(() => {
    if (!over) return;
    setQueue([]);
    setSpoken(null);
    setHint(null);
  }, [over]);
  useEffect(() => {
    if (!tip) return;
    const timer = window.setTimeout(() => setTip(null), 12000);
    return () => window.clearTimeout(timer);
  }, [tip]);

  return (
    <div className={styles.layer} aria-live="polite">
      {arrival > 0 && (
        <div key={arrival} className={styles.crossing} aria-hidden="true" />
      )}
      {spoken && (
        <Bubble
          key={spoken.key}
          line={spoken.line}
          finale={finale || court}
          lilianaAlly={finale}
        />
      )}
      {tip && (
        <div className={styles.tip} role="status">
          <strong>{court ? "The Sphinx's court" : "The Sphinx crosses"}</strong>
          <span>{tip}</span>
          <button type="button" onClick={() => setTip(null)}>
            Got it
          </button>
        </div>
      )}
      {hint && !over && (
        <section className={styles.hint} aria-label="Kaya's lesson">
          <img src={portraitUrl("kaya", 128)} alt="" width={56} height={56} />
          <div>
            <span className={styles.hintKicker}>
              Kaya&rsquo;s lesson · {hint.id}
            </span>
            <p>{hint.text}</p>
            <div className={styles.hintButtons}>
              <button type="button" onClick={() => setHint(null)}>
                Got it
              </button>
              <button
                type="button"
                className={styles.hintQuiet}
                onClick={() => {
                  setHint(null);
                  setHints(false);
                  void changeTutorial({ hints: false });
                }}
              >
                Turn off hints
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function Bubble({
  line,
  finale,
  lilianaAlly,
}: {
  line: Line;
  /** The Sphinx is seen at last: the finale's duel and since v0.9.6 the court. */
  finale: boolean;
  /** Liliana speaks for the player (the finale's duel), not for his court. */
  lilianaAlly: boolean;
}) {
  const speaker = line.speaker as Speaker;
  const ally =
    speaker === "KAYA" ||
    speaker === "PLAYER" ||
    (lilianaAlly && speaker === "LILIANA");
  const portrait = speakerPortrait(speaker);
  return (
    <div
      className={[styles.bark, ally ? styles.ally : styles.foe].join(" ")}
      style={{ "--hold": `${holdMs(line.text)}ms` } as CSSProperties}
    >
      {portrait && (
        <img
          className={[
            styles.barkPortrait,
            speaker === "SPHINX" && !finale ? styles.veiled : "",
          ].join(" ")}
          src={portraitUrl(portrait, 128)}
          alt=""
          width={64}
          height={64}
        />
      )}
      <p>
        <strong>
          {speaker === "PLAYER" ? "You" : speakerName(speaker, finale)}
        </strong>
        {line.text}
      </p>
    </div>
  );
}
