import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { client, describe } from "../api";
import { requestKey } from "../auctions/auctions";
import account from "../Account.module.css";
import shell from "../App.module.css";
import { hudChanged } from "../shell/hud";
import styles from "../tokens/tokens.module.css";
import admin from "./admin.module.css";

/**
 * SysOp's grants for testing (v0.8.8, api/testing.py), on any account's row in Administration,
 * its own first: packs, wins by format (counted by quests and achievements, never by the
 * statistics), cards into the library, and campaign progress without its spoils. Tokens and an
 * account's total wins keep their own forms beside it. Every grant needs a reason and is audited.
 */
type Kind = "packs" | "results" | "cards" | "campaign";
const kinds: { kind: Kind; name: string }[] = [
  { kind: "results", name: "Wins by format" },
  { kind: "packs", name: "Packs" },
  { kind: "cards", name: "Cards" },
  { kind: "campaign", name: "Campaign progress" },
];
const formats = [
  { id: "commander", name: "Commander" },
  { id: "legacy", name: "Legacy" },
  { id: "two_headed_giant", name: "Two-Headed Giant" },
  { id: "kings_table", name: "King's Table" },
] as const;
const COLORS = ["W", "U", "B", "R", "G"] as const;

function Reason({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={account.field}>
      <span>Reason (3–200 characters, for the audit log)</span>
      <input
        value={value}
        minLength={3}
        maxLength={200}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </label>
  );
}

/** A grant's form: its fields, the reason, the outcome and the buttons. */
function Grant({
  label,
  action,
  children,
  reason,
  setReason,
  busy,
  error,
  saved,
  onSubmit,
  onCancel,
}: {
  label: string;
  action: string;
  children: ReactNode;
  reason: string;
  setReason: (value: string) => void;
  busy: boolean;
  error: string;
  saved: string;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy) onSubmit();
  }
  return (
    <form className={styles.form} onSubmit={submit} aria-label={label}>
      <div className={admin.grantFields}>
        {children}
        <Reason value={reason} onChange={setReason} />
      </div>
      <p role="status" className={account.fine}>
        {saved}
      </p>
      {error && (
        <p role="alert" className={account.error}>
          {error}
        </p>
      )}
      <div className={account.actions}>
        <button type="submit" className={shell.primary} aria-disabled={busy}>
          {action}
        </button>
        {onCancel && (
          <button
            type="button"
            className={account.secondary}
            onClick={onCancel}
          >
            Close
          </button>
        )}
      </div>
    </form>
  );
}

/** The state every grant's form shares: its reason, whether it is sending, and what came of it. */
function useGrant() {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  async function send(run: (why: string) => Promise<string | null>) {
    const why = reason.trim();
    if (why.length < 3 || why.length > 200)
      return setError("Give a reason of 3 to 200 characters.");
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const done = await run(why);
      if (done !== null) {
        setSaved(done);
        setReason("");
      }
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }
  return { reason, setReason, busy, error, setError, saved, send };
}

function GrantResults({ userId, subject, own, onWins, onCancel }: Props) {
  const grant = useGrant();
  const [format, setFormat] =
    useState<(typeof formats)[number]["id"]>("commander");
  const [count, setCount] = useState("1");
  const [colors, setColors] = useState<string[]>([]);
  const [against, setAgainst] = useState<"bots" | "players">("bots");
  const [skill, setSkill] = useState("4");
  // A Commander table's size (v0.9.7), for the quests that ask for a four-player game.
  const [seats, setSeats] = useState("2");
  return (
    <Grant
      label={own ? "Grant yourself wins" : `Grant wins to ${subject}`}
      action="Grant wins"
      {...grant}
      onCancel={onCancel}
      onSubmit={() =>
        void grant.send(async (reason) => {
          const value = Number(count);
          if (!Number.isInteger(value) || value < 1 || value > 100) {
            grant.setError("Grant 1 to 100 wins at a time.");
            return null;
          }
          const { data, error } = await client.POST(
            "/api/v1/admin/users/{user_id}/results",
            {
              params: { path: { user_id: userId } },
              body: {
                format,
                count: value,
                colors: COLORS.filter((color) => colors.includes(color)).join(
                  "",
                ),
                against,
                bot_skill: Number(skill),
                seats: format === "commander" ? Number(seats) : null,
                reason,
              },
            },
          );
          if (!data) {
            grant.setError(describe(error));
            return null;
          }
          onWins?.(data.progress.wins, data.progress.tier.id);
          if (own) hudChanged();
          const paid = data.quest_tokens + data.achievement_tokens;
          return `${data.granted} ${data.granted === 1 ? "win" : "wins"} granted: ${data.progress.wins.toLocaleString("en-US")} wins in all${paid ? `, ${paid.toLocaleString("en-US")} tokens from quests and achievements` : ""}.`;
        })
      }
    >
      <label className={account.field}>
        <span>Format</span>
        <select
          value={format}
          onChange={(event) => setFormat(event.target.value as typeof format)}
        >
          {formats.map((found) => (
            <option key={found.id} value={found.id}>
              {found.name}
            </option>
          ))}
        </select>
      </label>
      {format === "commander" && (
        <label className={account.field}>
          <span>Players at the table</span>
          <select
            value={seats}
            onChange={(event) => setSeats(event.target.value)}
          >
            {[2, 3, 4].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={account.field}>
        <span>Wins (1–100)</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          step={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          required
        />
      </label>
      <fieldset className={admin.grantColors}>
        <legend title="None: a colorless deck">Deck colours</legend>
        {COLORS.map((color) => (
          <label key={color}>
            <input
              type="checkbox"
              checked={colors.includes(color)}
              onChange={(event) =>
                setColors((current) =>
                  event.target.checked
                    ? [...current, color]
                    : current.filter((found) => found !== color),
                )
              }
            />
            {color}
          </label>
        ))}
      </fieldset>
      <label className={account.field}>
        <span>Against</span>
        <select
          value={against}
          onChange={(event) =>
            setAgainst(event.target.value as "bots" | "players")
          }
        >
          <option value="bots">Bots</option>
          <option value="players">Players</option>
        </select>
      </label>
      {against === "bots" && (
        <label className={account.field}>
          <span>Bots' skill</span>
          <select
            value={skill}
            onChange={(event) => setSkill(event.target.value)}
          >
            {[1, 2, 3, 4, 5, 6].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      )}
    </Grant>
  );
}

type Product = { id: string; name: string; ready: boolean };

function GivePacks({ userId, subject, own, onCancel }: Props) {
  const grant = useGrant();
  const [products, setProducts] = useState<Product[]>();
  const [product, setProduct] = useState("");
  const [count, setCount] = useState("1");
  const pending = useRef<{ key: string; asked: string } | null>(null);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/admin/shop")
      .then(({ data }) => {
        if (!active || !data) return;
        const found = data.products.map((item) => ({
          id: item.id,
          name: `${item.name} (${item.set_code.toUpperCase()})`,
          ready:
            item.data_status === "ready" || item.data_status === "unresolved",
        }));
        setProducts(found);
        setProduct(
          (current) => current || found.find((item) => item.ready)?.id || "",
        );
      })
      .catch(() => {
        if (active) setProducts([]);
      });
    return () => {
      active = false;
    };
  }, []);
  if (!products) return <p role="status">Opening the shop's packs…</p>;
  return (
    <Grant
      label={own ? "Give yourself packs" : `Give packs to ${subject}`}
      action="Give packs"
      {...grant}
      onCancel={onCancel}
      onSubmit={() =>
        void grant.send(async (reason) => {
          const value = Number(count);
          if (!product) {
            grant.setError("Choose a pack.");
            return null;
          }
          if (!Number.isInteger(value) || value < 1 || value > 100) {
            grant.setError("Give 1 to 100 packs at a time.");
            return null;
          }
          const asked = JSON.stringify([userId, product, value, reason]);
          if (pending.current?.asked !== asked)
            pending.current = { key: requestKey(), asked };
          const { data, error } = await client.POST(
            "/api/v1/admin/users/{user_id}/packs",
            {
              params: { path: { user_id: userId } },
              body: { product, count: value, reason, key: pending.current.key },
            },
          );
          if (!data) {
            grant.setError(describe(error));
            return null;
          }
          pending.current = null;
          const name =
            products.find((item) => item.id === product)?.name ?? "packs";
          return `${data.granted} × ${name} given: ${own ? "open them" : "they open them"} at Leng's Card Shop.`;
        })
      }
    >
      <label className={account.field}>
        <span>Pack</span>
        <select
          value={product}
          onChange={(event) => setProduct(event.target.value)}
        >
          {products.length === 0 && <option value="">No packs yet</option>}
          {products.map((item) => (
            <option key={item.id} value={item.id} disabled={!item.ready}>
              {item.name}
              {item.ready ? "" : " — no booster data yet"}
            </option>
          ))}
        </select>
      </label>
      <label className={account.field}>
        <span>Packs (1–100)</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          step={1}
          value={count}
          onChange={(event) => setCount(event.target.value)}
          required
        />
      </label>
    </Grant>
  );
}

type Found = { id: string; name: string; set: string | null };

function GiveCards({ userId, subject, own, onCancel }: Props) {
  const grant = useGrant();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>();
  const [card, setCard] = useState("");
  const [quantity, setQuantity] = useState("4");
  const [foil, setFoil] = useState(false);
  const latest = useRef(0);
  async function search() {
    const words = query.trim();
    if (!words) return;
    const ticket = ++latest.current;
    const { data, error } = await client
      .GET("/api/v1/cards", {
        params: { query: { name: words, page_size: 20 } },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    if (ticket !== latest.current) return;
    if (!data) return grant.setError(describe(error));
    const cards = data.items.map((item) => ({
      id: item.id,
      name: item.name,
      set: item.set_code,
    }));
    setFound(cards);
    setCard(cards[0]?.id ?? "");
  }
  return (
    <Grant
      label={own ? "Give yourself cards" : `Give cards to ${subject}`}
      action="Give cards"
      {...grant}
      onCancel={onCancel}
      onSubmit={() =>
        void grant.send(async (reason) => {
          const value = Number(quantity);
          if (!card) {
            grant.setError("Find a card and choose it first.");
            return null;
          }
          if (!Number.isInteger(value) || value < 1 || value > 99) {
            grant.setError("Give 1 to 99 copies at a time.");
            return null;
          }
          const { data, error } = await client.POST(
            "/api/v1/admin/users/{user_id}/cards",
            {
              params: { path: { user_id: userId } },
              body: {
                card_id: card,
                quantity: value,
                finish: foil ? "foil" : "nonfoil",
                reason,
              },
            },
          );
          if (!data) {
            grant.setError(describe(error));
            return null;
          }
          return `${data.quantity} × ${data.name}${data.finish === "foil" ? " (foil)" : ""} given, in its default edition.`;
        })
      }
    >
      <div className={admin.grantSearch}>
        <label className={account.field}>
          <span>Card name</span>
          <input
            type="search"
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
          />
        </label>
        <button
          type="button"
          className={account.secondary}
          onClick={() => void search()}
        >
          Find
        </button>
      </div>
      {found && (
        <label className={account.field}>
          <span>Card</span>
          <select
            value={card}
            onChange={(event) => setCard(event.target.value)}
          >
            {found.length === 0 && (
              <option value="">No card in the game matches</option>
            )}
            {found.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.set ? ` (${item.set.toUpperCase()})` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={account.field}>
        <span>Copies (1–99)</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={99}
          step={1}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          required
        />
      </label>
      <label className={admin.grantCheck}>
        <input
          type="checkbox"
          checked={foil}
          onChange={(event) => setFoil(event.target.checked)}
        />
        Foil
      </label>
    </Grant>
  );
}

function SetCampaign({ userId, subject, own, onCancel }: Props) {
  const grant = useGrant();
  const [through, setThrough] = useState("0");
  const [encounters, setEncounters] =
    useState<{ number: number; name: string }[]>();
  useEffect(() => {
    let active = true;
    // The encounters' names come from SysOp's own view of the campaign: the same for everyone.
    void client
      .GET("/api/v1/campaign")
      .then(({ data }) => {
        if (active && data)
          setEncounters(
            data.encounters.map((item) => ({
              number: item.number,
              name: item.name,
            })),
          );
      })
      .catch(() => {
        if (active) setEncounters([]);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <Grant
      label={
        own
          ? "Set your campaign progress"
          : `Set ${subject}'s campaign progress`
      }
      action="Set progress"
      {...grant}
      onCancel={onCancel}
      onSubmit={() =>
        void grant.send(async (reason) => {
          const { data, error } = await client.POST(
            "/api/v1/admin/users/{user_id}/campaign",
            {
              params: { path: { user_id: userId } },
              body: { won_through: Number(through), reason },
            },
          );
          if (!data) {
            grant.setError(describe(error));
            return null;
          }
          return data.completed.length
            ? `Encounters 1–${data.completed.length} won; encounter ${data.highest_unlocked} is open.`
            : "The campaign starts over at its first encounter.";
        })
      }
    >
      <label className={account.field}>
        <span>Won through (seals and chapter rewards, never the spoils)</span>
        <select
          value={through}
          onChange={(event) => setThrough(event.target.value)}
        >
          <option value="0">None: start the campaign over</option>
          {(encounters ?? []).map((item) => (
            <option key={item.number} value={item.number}>
              {item.number}. {item.name}
            </option>
          ))}
        </select>
      </label>
    </Grant>
  );
}

type Props = {
  userId: string;
  /** Whose grants, as the forms name them: an account's handle. */
  subject: string;
  /** SysOp's own account: the forms say "yourself", and its balance in the top bar updates. */
  own: boolean;
  onWins?: (wins: number, tier: string) => void;
  onCancel?: () => void;
};

export function TestingGrants(props: Props) {
  const [kind, setKind] = useState<Kind>("results");
  return (
    <section
      className={admin.testing}
      aria-label={
        props.own
          ? "Your testing grants"
          : `Testing grants for ${props.subject}`
      }
    >
      <div
        role="radiogroup"
        aria-label="What to grant"
        className={admin.grantKinds}
      >
        {kinds.map((found) => (
          <label key={found.kind}>
            <input
              type="radio"
              name={`grant-${props.userId}`}
              checked={kind === found.kind}
              onChange={() => setKind(found.kind)}
            />
            {found.name}
          </label>
        ))}
      </div>
      {kind === "results" && <GrantResults {...props} />}
      {kind === "packs" && <GivePacks {...props} />}
      {kind === "cards" && <GiveCards {...props} />}
      {kind === "campaign" && <SetCampaign {...props} />}
    </section>
  );
}
