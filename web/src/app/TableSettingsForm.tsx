import { useId, useState, type ReactNode } from "react";
import type { TableSettings } from "../game/table/types";
import {
  ANIMATION_SPEEDS,
  TIMER_SECONDS,
  useTableSettings,
} from "./tableSettings";
import styles from "./Settings.module.css";

// The table's settings (cd.table.v1), on the Settings page and, compact, in the game's Options
// drawer. Each control is named by its title alone; the line under it is its description.

function Row({
  id,
  name,
  description,
  children,
}: {
  id: string;
  name: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <label className={styles.row}>
      <span>
        <strong id={`${id}-name`}>{name}</strong>
        {description && <small id={`${id}-text`}>{description}</small>}
      </span>
      {children}
    </label>
  );
}

function named(id: string, described: boolean) {
  return {
    "aria-labelledby": `${id}-name`,
    "aria-describedby": described ? `${id}-text` : undefined,
  };
}

const speedNames: Record<TableSettings["animationSpeed"], string> = {
  normal: "Normal",
  fast: "Fast",
  faster: "Faster",
};

/** Settings › Display & accessibility: how fast the table moves (Reduce motion stops it). */
export function AnimationSpeedField({
  compact = false,
}: {
  compact?: boolean;
}) {
  const [settings, update] = useTableSettings();
  const id = useId();
  return (
    <Row
      id={id}
      name="Animation speed"
      description={
        compact
          ? undefined
          : "How quickly cards move on the table. Reduce motion stills them, whatever this says."
      }
    >
      <select
        {...named(id, !compact)}
        value={settings.animationSpeed}
        onChange={(event) =>
          update({
            animationSpeed: event.target
              .value as TableSettings["animationSpeed"],
          })
        }
      >
        {ANIMATION_SPEEDS.map((speed) => (
          <option key={speed} value={speed}>
            {speedNames[speed]}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function TableSettingsForm({ compact = false }: { compact?: boolean }) {
  const [settings, update] = useTableSettings();
  const [message, setMessage] = useState("");
  const id = useId();
  const Heading = compact ? "h3" : "h2";
  const said = (text: string) => (compact ? undefined : text);
  function change(patch: Partial<TableSettings>) {
    setMessage(
      update(patch)
        ? "Saved on this device."
        : "Applied for this visit. Browser storage is unavailable.",
    );
  }
  return (
    <div className={compact ? styles.compact : undefined}>
      <section className={styles.panel} aria-labelledby={`${id}-table`}>
        <Heading id={`${id}-table`}>The table</Heading>
        <Row
          id={`${id}-fullscreen`}
          name="Full screen when a game starts"
          description={said(
            "Starting or resuming a game fills the screen. F, or the Full screen button, leaves it and comes back.",
          )}
        >
          <input
            type="checkbox"
            {...named(`${id}-fullscreen`, !compact)}
            checked={settings.fullscreenOnStart}
            onChange={(event) =>
              change({ fullscreenOnStart: event.target.checked })
            }
          />
        </Row>
        <Row
          id={`${id}-timer`}
          name="Response timer"
          description={said(
            "When an opponent's spell or attack gives you the chance to respond, the game continues for you after this long. Stop Timer, Space or T stops it.",
          )}
        >
          <select
            {...named(`${id}-timer`, !compact)}
            value={settings.responseTimerSeconds}
            onChange={(event) =>
              change({
                responseTimerSeconds: Number(
                  event.target.value,
                ) as TableSettings["responseTimerSeconds"],
              })
            }
          >
            {TIMER_SECONDS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds === 0 ? "Off" : `${seconds} seconds`}
              </option>
            ))}
          </select>
        </Row>
        <Row
          id={`${id}-painter`}
          name="Draw the table with"
          description={said(
            "Automatic draws the table with WebGL where the browser has it. The plain table works without it and still shows every card.",
          )}
        >
          <select
            {...named(`${id}-painter`, !compact)}
            value={settings.painter}
            onChange={(event) =>
              change({
                painter: event.target.value as TableSettings["painter"],
              })
            }
          >
            <option value="auto">Automatic</option>
            <option value="dom">Plain table without WebGL</option>
          </select>
        </Row>
      </section>
      <section className={styles.panel} aria-labelledby={`${id}-sound`}>
        <Heading id={`${id}-sound`}>Sound</Heading>
        <Row
          id={`${id}-volume`}
          name="Sound effects volume"
          description={said(
            "Sounds for cards, combat and the end of a game, made in the browser. They start after your first click in a game.",
          )}
        >
          <span className={styles.range}>
            <input
              id={`${id}-volume`}
              type="range"
              min={0}
              max={100}
              {...named(`${id}-volume`, !compact)}
              value={settings.effectsVolume}
              onChange={(event) =>
                change({ effectsVolume: Number(event.target.value) })
              }
            />
            {/* The range reports its own value; the number is for the eye. */}
            <output htmlFor={`${id}-volume`} aria-hidden="true">
              {settings.effectsVolume}
            </output>
          </span>
        </Row>
        <Row
          id={`${id}-mute`}
          name="Mute all sound"
          description={said("Silences every sound effect.")}
        >
          <input
            type="checkbox"
            {...named(`${id}-mute`, !compact)}
            checked={settings.muted}
            onChange={(event) => change({ muted: event.target.checked })}
          />
        </Row>
        <p role="status">
          {message ||
            "These settings are kept on this device, not in your account."}
        </p>
      </section>
    </div>
  );
}
