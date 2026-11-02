import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import shell from "../App.module.css";
import {
  GUIDE,
  guideHref,
  ruleHref,
  searchGuide,
  topicById,
  TOPICS,
  type Block,
  type Topic,
} from "./guide";
import { Anatomy, CardRow, GuideCard } from "./GuideCards";
import { useOfficialRules, type OfficialRules } from "./officialRules";
import { RichText } from "./RichText";
import {
  chapterOf,
  RULE_NUMBER,
  searchRules,
  WIZARDS_RULES_PAGE,
  type Chapter,
  type ComprehensiveRules,
  type Rule,
} from "./rules";
import { Shot } from "./Shot";
import styles from "./HowToPlay.module.css";

// How to play (v0.8.6, docs/how-to-play.md): the guide in plain words, and the official
// Comprehensive Rules when the build has them. Its addresses:
//   #how-to-play                  the guide's contents
//   #how-to-play/<topic>          one topic of the guide
//   #how-to-play/rules            the official rules' contents
//   #how-to-play/rules/<number>   a chapter of the official rules, at a rule ("702.19b") or whole ("702")
//   #how-to-play/glossary         the official glossary
// It opens from the account's menu, and signed out from the landing page's links; the game's
// prompts link to their topics ("What's this?"), and so does the tutorial.

export const HOW_TO_PLAY_ROUTE = /^#how-to-play(?:\/(.*))?$/i;

export type HowToPlayView =
  | { kind: "contents" }
  | { kind: "topic"; topic: Topic }
  | { kind: "rules" }
  | { kind: "rule"; number: string }
  | { kind: "glossary" }
  | { kind: "unknown" };

/** What an address inside How to play shows. */
export function viewOf(rest: string | undefined): HowToPlayView {
  const path = (rest ?? "").replace(/\/+$/, "");
  if (path === "") return { kind: "contents" };
  if (path === "rules") return { kind: "rules" };
  if (path === "glossary") return { kind: "glossary" };
  if (path.startsWith("rules/")) {
    const number = path.slice("rules/".length).toLowerCase();
    return RULE_NUMBER.test(number)
      ? { kind: "rule", number }
      : { kind: "unknown" };
  }
  const topic = topicById(path.toLowerCase());
  return topic ? { kind: "topic", topic } : { kind: "unknown" };
}

export function HowToPlay({
  rest,
  heading,
}: {
  /** The address after "#how-to-play/". */
  rest: string | undefined;
  heading?: RefObject<HTMLHeadingElement | null>;
}) {
  const view = viewOf(rest);
  const official = useOfficialRules();
  const own = useRef<HTMLHeadingElement>(null);
  const title = heading ?? own;
  const key = rest ?? "";
  // A new view takes focus to its heading, as the app's pages do, and starts at its top, unless
  // it is a rule, which scrolls to itself once drawn.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (view.kind !== "rule") {
      title.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }
  }, [key, title, view.kind]);

  return (
    <div className={styles.page}>
      <aside className={styles.side} aria-label="How to play contents">
        <Search official={official} />
        {/* On a phone the contents fold away: the guide's own contents page lists every topic. */}
        <a className={styles.phoneContents} href={guideHref()}>
          All topics
        </a>
        <nav aria-label="The guide">
          <ol className={styles.toc}>
            {GUIDE.map((chapter) => (
              <li key={chapter.id}>
                <span className={styles.tocChapter}>{chapter.title}</span>
                <ol>
                  {chapter.topics.map((topic) => (
                    <li key={topic.id}>
                      <a
                        href={guideHref(topic.id)}
                        aria-current={
                          view.kind === "topic" && view.topic.id === topic.id
                            ? "page"
                            : undefined
                        }
                      >
                        {topic.title}
                      </a>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
            <li>
              <span className={styles.tocChapter}>The official rules</span>
              <ol>
                <li>
                  <a
                    href="#how-to-play/rules"
                    aria-current={
                      view.kind === "rules" || view.kind === "rule"
                        ? "page"
                        : undefined
                    }
                  >
                    Comprehensive Rules
                  </a>
                </li>
                <li>
                  <a
                    href="#how-to-play/glossary"
                    aria-current={view.kind === "glossary" ? "page" : undefined}
                  >
                    Glossary
                  </a>
                </li>
              </ol>
            </li>
          </ol>
        </nav>
      </aside>
      <article className={styles.body} key={key}>
        {view.kind === "contents" ? (
          <Contents title={title} official={official} />
        ) : view.kind === "topic" ? (
          <TopicView topic={view.topic} title={title} />
        ) : view.kind === "rules" ? (
          <RulesContents title={title} official={official} />
        ) : view.kind === "rule" ? (
          <RuleView number={view.number} title={title} official={official} />
        ) : view.kind === "glossary" ? (
          <Glossary title={title} official={official} />
        ) : (
          <>
            <h2 ref={title} tabIndex={-1}>
              Not in the guide
            </h2>
            <p>
              Nothing in How to play has that address.{" "}
              <a href={guideHref()}>Go to the contents</a>.
            </p>
          </>
        )}
      </article>
    </div>
  );
}

function Contents({
  title,
  official,
}: {
  title: RefObject<HTMLHeadingElement | null>;
  official: OfficialRules;
}) {
  return (
    <>
      <span className={shell.eyebrow}>How to play</span>
      <h2 ref={title} tabIndex={-1}>
        Learn to play Magic
      </h2>
      <p className={styles.lead}>
        Everything you need to play Magic: The Gathering at Commander Duels,
        explained in plain words with real cards and the real table. Start at
        the top if you have never played; jump to any topic if you have. Each
        topic links to the official rule it explains.
      </p>
      <div className={styles.heroCards} aria-hidden="true">
        <GuideCard card="sigarda" />
        <GuideCard card="lightningBolt" />
        <GuideCard card="serraAngel" />
      </div>
      {GUIDE.map((chapter, index) => (
        <section key={chapter.id} className={styles.contentsChapter}>
          <h3>
            <span aria-hidden="true">{index + 1}</span> {chapter.title}
          </h3>
          <ul>
            {chapter.topics.map((topic) => (
              <li key={topic.id}>
                <a href={guideHref(topic.id)}>{topic.title}</a>
                <span>
                  <RichText text={topic.summary} rules={false} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section className={styles.contentsChapter}>
        <h3>The official rules</h3>
        <OfficialNote official={official} />
        {official.state === "ready" && (
          <ul>
            <li>
              <a href="#how-to-play/rules">Comprehensive Rules</a>
              <span>Every rule of the game, searchable and linkable.</span>
            </li>
            <li>
              <a href="#how-to-play/glossary">Glossary</a>
              <span>
                {official.rules.glossary.length.toLocaleString("en-US")} game
                terms defined.
              </span>
            </li>
          </ul>
        )}
      </section>
    </>
  );
}

/** Where the official text stands in this build, and whose it is. */
function OfficialNote({ official }: { official: OfficialRules }) {
  if (official.state === "loading")
    return <p role="status">Loading the official rules…</p>;
  if (official.state === "ready")
    return (
      <p className={styles.attribution}>
        Magic: The Gathering Comprehensive Rules, effective{" "}
        {official.rules.effective ?? "as published"}, by Wizards of the Coast.
        Magic: The Gathering is © Wizards of the Coast LLC.{" "}
        <a href={WIZARDS_RULES_PAGE} target="_blank" rel="noreferrer">
          Wizards’ rules page
        </a>
        .
      </p>
    );
  return (
    <p className={styles.notIncluded} data-official={official.state}>
      {official.state === "missing"
        ? "Official rules not included in this build."
        : "The official rules could not be loaded just now."}{" "}
      Read them on{" "}
      <a href={WIZARDS_RULES_PAGE} target="_blank" rel="noreferrer">
        Wizards of the Coast’s rules page
      </a>
      .
    </p>
  );
}

function TopicView({
  topic,
  title,
}: {
  topic: Topic;
  title: RefObject<HTMLHeadingElement | null>;
}) {
  const at = TOPICS.indexOf(topic);
  const previous = TOPICS[at - 1];
  const next = TOPICS[at + 1];
  const chapter = GUIDE.find((item) => item.topics.includes(topic))!;
  return (
    <>
      <span className={shell.eyebrow}>{chapter.title}</span>
      <h2 ref={title} tabIndex={-1}>
        {topic.title}
      </h2>
      <p className={styles.lead}>
        <RichText text={topic.summary} rules={false} />
      </p>
      {topic.blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
      {topic.rules.length > 0 && (
        <aside className={styles.officialRefs} aria-label="Official rules">
          <span>Official rules</span>
          <ul>
            {topic.rules.map((number) => (
              <li key={number}>
                <a href={ruleHref(number)}>{number}</a>
              </li>
            ))}
          </ul>
        </aside>
      )}
      <nav className={styles.pager} aria-label="Topics">
        {previous ? (
          <a href={guideHref(previous.id)} rel="prev">
            <span aria-hidden="true">◂</span> {previous.title}
          </a>
        ) : (
          <a href={guideHref()}>
            <span aria-hidden="true">◂</span> Contents
          </a>
        )}
        {next && (
          <a href={guideHref(next.id)} rel="next">
            {next.title} <span aria-hidden="true">▸</span>
          </a>
        )}
      </nav>
    </>
  );
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case "p":
      return (
        <p>
          <RichText text={block.text} />
        </p>
      );
    case "tip":
      return (
        <p className={styles.tip}>
          <strong>At the table</strong> <RichText text={block.text} />
        </p>
      );
    case "list":
      return (
        <ul className={styles.list}>
          {block.items.map((item) => (
            <li key={item}>
              <RichText text={item} />
            </li>
          ))}
        </ul>
      );
    case "steps":
      return (
        <section className={styles.steps}>
          <h3>{block.title.replace(/ \(rule [\d.a-z]+\)$/, "")}</h3>
          <ol>
            {block.steps.map((step) => (
              <li key={step}>
                <RichText text={step} />
              </li>
            ))}
          </ol>
        </section>
      );
    case "anatomy":
      return (
        <Anatomy
          card={block.card}
          callouts={block.callouts}
          caption={block.caption}
        />
      );
    case "cards":
      return <CardRow cards={block.cards} caption={block.caption} />;
    case "example":
      return (
        <section className={styles.example}>
          <h3>
            <span className={styles.exampleLabel}>Example</span> {block.title}
          </h3>
          {block.cards && (
            <div className={styles.exampleCards}>
              {block.cards.map((card) => (
                <GuideCard key={card} card={card} />
              ))}
            </div>
          )}
          <ol>
            {block.steps.map((step) => (
              <li key={step}>
                <RichText text={step} />
              </li>
            ))}
          </ol>
          <p className={styles.outcome}>
            <RichText text={block.outcome} />
          </p>
        </section>
      );
    case "shot":
      return (
        <Shot shot={block.shot} caption={block.caption} marks={block.marks} />
      );
    case "table":
      return (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            {block.caption && <caption>{block.caption}</caption>}
            <thead>
              <tr>
                {block.head.map((cell) => (
                  <th key={cell} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row.join("|")}>
                  {row.map((cell, index) => (
                    <td key={index}>
                      {block.head[index] === "Rule" &&
                      RULE_NUMBER.test(cell) ? (
                        <a href={ruleHref(cell)}>{cell}</a>
                      ) : (
                        <RichText text={cell} rules={false} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** The search: the guide's topics, then the official rules and glossary when present. */
function Search({ official }: { official: OfficialRules }) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();
  const topics = useMemo(() => searchGuide(trimmed, 8), [trimmed]);
  const found = useMemo(
    () =>
      official.state === "ready"
        ? searchRules(official.rules, trimmed, 12)
        : { rules: [], glossary: [] },
    [official, trimmed],
  );
  // A rule number goes straight to its rule.
  const direct = RULE_NUMBER.test(trimmed.replace(/\.$/, "").toLowerCase())
    ? trimmed.replace(/\.$/, "").toLowerCase()
    : null;
  useEffect(() => {
    const leave = () => setShown(false);
    window.addEventListener("hashchange", leave);
    return () => window.removeEventListener("hashchange", leave);
  }, []);
  const nothing =
    trimmed.length >= 2 &&
    topics.length === 0 &&
    found.rules.length === 0 &&
    found.glossary.length === 0 &&
    !direct;
  return (
    <div
      className={styles.search}
      ref={box}
      onBlur={(event) => {
        if (!box.current?.contains(event.relatedTarget as Node))
          setShown(false);
      }}
    >
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (direct) window.location.hash = ruleHref(direct);
          else if (topics[0]) window.location.hash = guideHref(topics[0].id);
          else if (found.rules[0])
            window.location.hash = ruleHref(found.rules[0].number);
        }}
      >
        <label htmlFor="how-to-play-search">Search the rules</label>
        <input
          id="how-to-play-search"
          type="search"
          value={query}
          placeholder="Trample, 702.19, commander tax…"
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setShown(true);
          }}
          onFocus={() => setShown(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setShown(false);
          }}
        />
      </form>
      {shown && trimmed.length >= 2 && (
        <div className={styles.results} aria-live="polite">
          {direct && (
            <p>
              <a href={ruleHref(direct)}>Go to rule {direct}</a>
            </p>
          )}
          {topics.length > 0 && (
            <>
              <h3>In the guide</h3>
              <ul>
                {topics.map((topic) => (
                  <li key={topic.id}>
                    <a href={guideHref(topic.id)}>{topic.title}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {found.glossary.length > 0 && (
            <>
              <h3>Glossary</h3>
              <ul>
                {found.glossary.slice(0, 5).map((entry) => (
                  <li key={entry.term}>
                    <a
                      href={`#how-to-play/glossary`}
                      onClick={() => sessionStorageSet(entry.term)}
                    >
                      {entry.term}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {found.rules.length > 0 && (
            <>
              <h3>Official rules</h3>
              <ul>
                {found.rules.map((hit) => (
                  <li key={hit.number}>
                    <a href={ruleHref(hit.number)}>
                      <strong>{hit.number}</strong>{" "}
                      {hit.text.length > 90
                        ? `${hit.text.slice(0, 88)}…`
                        : hit.text}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {nothing && <p>Nothing found.</p>}
          {official.state === "missing" && (
            <p className={styles.searchNote}>
              The official rules are not in this build: the search covers the
              guide.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The glossary term a search chose, for the glossary to open at. */
const GLOSSARY_TERM = "cd.howToPlay.term";
function sessionStorageSet(term: string) {
  try {
    sessionStorage.setItem(GLOSSARY_TERM, term);
  } catch {
    // Storage may be unavailable; the glossary then opens at its top.
  }
}
function sessionStorageTake(): string | null {
  try {
    const term = sessionStorage.getItem(GLOSSARY_TERM);
    sessionStorage.removeItem(GLOSSARY_TERM);
    return term;
  } catch {
    return null;
  }
}

function RulesContents({
  title,
  official,
}: {
  title: RefObject<HTMLHeadingElement | null>;
  official: OfficialRules;
}) {
  return (
    <>
      <span className={shell.eyebrow}>The official rules</span>
      <h2 ref={title} tabIndex={-1}>
        Comprehensive Rules
      </h2>
      <OfficialNote official={official} />
      {official.state === "ready" && (
        <>
          {official.rules.introduction.map((line) => (
            <p key={line} className={styles.officialIntro}>
              {line}
            </p>
          ))}
          <ol className={styles.ruleSections}>
            {official.rules.sections.map((section) => (
              <li key={section.number}>
                <h3>
                  {section.number}. {section.title}
                </h3>
                <ol>
                  {section.chapters.map((chapter) => (
                    <li key={chapter.number}>
                      <a href={ruleHref(chapter.number)}>
                        <strong>{chapter.number}.</strong> {chapter.title}
                      </a>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

function RuleView({
  number,
  title,
  official,
}: {
  number: string;
  title: RefObject<HTMLHeadingElement | null>;
  official: OfficialRules;
}) {
  const ready = official.state === "ready" ? official.rules : null;
  const chapter = ready
    ? (ready.index.get(chapterOf(number)) as Chapter | undefined)
    : undefined;
  const whole = number.length === 3;
  const target = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!chapter) return;
    if (whole) {
      title.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
      return;
    }
    target.current?.scrollIntoView?.({ block: "center" });
    target.current?.focus({ preventScroll: true });
  }, [chapter, whole, title]);
  if (!ready)
    return (
      <>
        <span className={shell.eyebrow}>The official rules</span>
        <h2 ref={title} tabIndex={-1}>
          Rule {number}
        </h2>
        <OfficialNote official={official} />
      </>
    );
  if (!chapter)
    return (
      <>
        <span className={shell.eyebrow}>The official rules</span>
        <h2 ref={title} tabIndex={-1}>
          No rule {number}
        </h2>
        <p>
          The rules effective {ready.effective} have no rule {number}.{" "}
          <a href="#how-to-play/rules">See the contents</a>.
        </p>
      </>
    );
  const prefix = (rule: Rule) =>
    rule.number === number ||
    (rule.number.startsWith(number) &&
      !/\d/.test(rule.number.charAt(number.length)));
  const neighbours = neighbourChapters(ready, chapter.number);
  return (
    <>
      <span className={shell.eyebrow}>The official rules</span>
      <h2 ref={title} tabIndex={-1}>
        {chapter.number}. {chapter.title}
      </h2>
      <ol className={styles.rules}>
        {chapter.rules.map((rule) => {
          const at = !whole && rule.number === number;
          return (
            <li
              key={rule.number}
              id={`rule-${rule.number}`}
              ref={at ? target : undefined}
              tabIndex={at ? -1 : undefined}
              data-sub={rule.sub || undefined}
              data-target={(!whole && prefix(rule)) || undefined}
            >
              <a href={ruleHref(rule.number)} className={styles.ruleNumber}>
                {rule.number}
              </a>
              <div>
                <p>
                  <RichText text={rule.text} />
                </p>
                {rule.more.map((line) => (
                  <p key={line}>
                    <RichText text={line} />
                  </p>
                ))}
                {rule.examples.map((example) => (
                  <p key={example} className={styles.ruleExample}>
                    <em>Example:</em> <RichText text={example} />
                  </p>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      <nav className={styles.pager} aria-label="Chapters">
        {neighbours.previous ? (
          <a href={ruleHref(neighbours.previous.number)} rel="prev">
            <span aria-hidden="true">◂</span> {neighbours.previous.number}.{" "}
            {neighbours.previous.title}
          </a>
        ) : (
          <a href="#how-to-play/rules">
            <span aria-hidden="true">◂</span> Contents
          </a>
        )}
        {neighbours.next && (
          <a href={ruleHref(neighbours.next.number)} rel="next">
            {neighbours.next.number}. {neighbours.next.title}{" "}
            <span aria-hidden="true">▸</span>
          </a>
        )}
      </nav>
      <OfficialNote official={official} />
    </>
  );
}

function neighbourChapters(rules: ComprehensiveRules, number: string) {
  const all = rules.sections.flatMap((section) => section.chapters);
  const at = all.findIndex((chapter) => chapter.number === number);
  return { previous: all[at - 1], next: all[at + 1] };
}

function Glossary({
  title,
  official,
}: {
  title: RefObject<HTMLHeadingElement | null>;
  official: OfficialRules;
}) {
  const [filter, setFilter] = useState("");
  const [term] = useState(sessionStorageTake);
  const ready = official.state === "ready" ? official.rules : null;
  const wanted = filter.trim().toLowerCase();
  const entries = (ready?.glossary ?? []).filter(
    (entry) => !wanted || entry.term.toLowerCase().includes(wanted),
  );
  useEffect(() => {
    if (!term || !ready) return;
    const found = document.getElementById(`term-${slug(term)}`);
    found?.scrollIntoView?.({ block: "center" });
    found?.focus({ preventScroll: true });
  }, [term, ready]);
  return (
    <>
      <span className={shell.eyebrow}>The official rules</span>
      <h2 ref={title} tabIndex={-1}>
        Glossary
      </h2>
      <OfficialNote official={official} />
      {ready && (
        <>
          <label className={styles.filter}>
            Filter the terms
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <dl className={styles.glossary}>
            {entries.map((entry) => (
              <div
                key={entry.term}
                id={`term-${slug(entry.term)}`}
                tabIndex={-1}
                data-target={entry.term === term || undefined}
              >
                <dt>{entry.term}</dt>
                {entry.definition.map((line) => (
                  <dd key={line}>
                    <RichText text={line} />
                  </dd>
                ))}
              </div>
            ))}
          </dl>
          {entries.length === 0 && <p>No term matches.</p>}
        </>
      )}
    </>
  );
}

function slug(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
