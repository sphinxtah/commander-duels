import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { client } from "../api";
import type { components } from "../generated/api";
import styles from "./setCodes.module.css";

// The edition codes beside a set-code field (v0.9.6, the owner's request): an "i" that opens a
// small pop-up listing every edition's code and name, oldest to newest, from the catalog
// (GET /api/v1/sets?every=true, read once a page). Choosing one fills the field.

type SetSummary = components["schemas"]["SetSummary"];

let cached: Promise<SetSummary[] | null> | null = null;

/** Every edition of the catalog, oldest first; null when it could not be read. */
export function loadSetCodes(): Promise<SetSummary[] | null> {
  cached ??= client
    .GET("/api/v1/sets", { params: { query: { every: true } } })
    .then(({ data }) => (data ? oldestFirst(data) : null))
    .catch(() => null)
    .then((found) => {
      if (found === null) cached = null;
      return found;
    });
  return cached;
}

/** Oldest to newest, by release date; a set without one last; ties by code. */
export function oldestFirst(sets: SetSummary[]): SetSummary[] {
  return [...sets].sort(
    (one, other) =>
      (one.released_at ?? "9999").localeCompare(other.released_at ?? "9999") ||
      one.code.localeCompare(other.code),
  );
}

export function SetCodesInfo({
  onPick,
}: {
  /** Fills the field with the code chosen. */
  onPick?: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState<SetSummary[] | null | undefined>();
  const [filter, setFilter] = useState("");
  const box = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const id = useId();

  // The pop-up sits on the page itself, below the "i", so no panel's overflow clips it.
  function locate() {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(330, window.innerWidth * 0.8);
    // Above the "i" when the window has no room for it below.
    const above = rect.bottom + 400 > window.innerHeight && rect.top > 400;
    setPlace({
      ...(above
        ? { bottom: window.innerHeight - rect.top + 8 }
        : { top: rect.bottom + 8 }),
      left: Math.max(8, Math.min(rect.left - 8, window.innerWidth - width - 8)),
      width,
    });
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    void loadSetCodes().then((found) => {
      if (active) setSets(found);
    });
    locate();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !popup.current?.contains(target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", locate, true);
    window.addEventListener("resize", locate);
    return () => {
      active = false;
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", locate, true);
      window.removeEventListener("resize", locate);
    };
  }, [open]);

  const wanted = filter.trim().toLowerCase();
  const shown = (sets ?? []).filter(
    (set) =>
      !wanted ||
      set.code.toLowerCase().includes(wanted) ||
      set.name.toLowerCase().includes(wanted),
  );

  return (
    <span className={styles.info} ref={box}>
      <button
        type="button"
        className={styles.button}
        aria-label="Edition codes"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        i
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={popup}
            className={styles.popup}
            style={place}
            role="dialog"
            aria-label="Edition codes, oldest to newest"
          >
            <div className={styles.head}>
              <strong>Edition codes</strong>
              <span>Oldest to newest</span>
              <button
                type="button"
                className={styles.close}
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            <input
              className={styles.filter}
              type="search"
              value={filter}
              placeholder="Find an edition"
              aria-label="Find an edition"
              onChange={(event) => setFilter(event.target.value)}
            />
            {sets === undefined ? (
              <p role="status" className={styles.note}>
                Reading the editions…
              </p>
            ) : sets === null ? (
              <p role="alert" className={styles.note}>
                The editions could not be read. Try again.
              </p>
            ) : (
              <ol className={styles.list}>
                {shown.map((set) => (
                  <li key={set.code}>
                    <button
                      type="button"
                      disabled={!onPick}
                      onClick={() => {
                        onPick?.(set.code.toUpperCase());
                        setOpen(false);
                      }}
                    >
                      <code>{set.code.toUpperCase()}</code>
                      <span>{set.name}</span>
                      <small>{set.released_at?.slice(0, 4) ?? ""}</small>
                    </button>
                  </li>
                ))}
                {shown.length === 0 && (
                  <li className={styles.note}>No edition matches.</li>
                )}
              </ol>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
