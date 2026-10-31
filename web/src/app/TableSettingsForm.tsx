import { useId, useState, type ReactNode } from "react";
import type { TableSettings } from "../game/table/types";
import {
  ANIMATION_SPEEDS,
  EFFECTS_LEVELS,
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

const effectsNames: Record<TableSettings["effects"], string> = {
  full: "Full",
  subtle: "Subtle",
  off: "Off",
};

/** Settings › Display & accessibility: the special effects (v0.7.0). Reduce motion turns them
 * off whatever this says, as it does the animation. */
export function EffectsField({ compact = false }: { compact?: boolean }) {
  const [settings, update] = useTableSettings();
  const id = useId();
  return (
    <Row
      id={id}
      name="Special effects"
      description={
        compact
          ? undefined
          : "Slashes, bursts, sparks and confetti when something big happens on the table. Subtle keeps the marks and leaves out the particles. Reduce motion turns them off."
      }
    >
      <select
        {...named(id, !compact)}
        value={settings.effects}
        onChange={(event) =>
          update({ effects: event.target.value as TableSettings["effects"] })
        }
      >
        {EFFECTS_LEVELS.map((level) => (
          <option key={level} value={level}>
            {effectsNames[level]}
          </option>
        ))}
      </select>
    </Row>
  );
}

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
        {/* The Settings page shows this under Display & accessibility, beside the animation
            speed; the game's drawer has only this form, so it goes here. */}
        {compact && <EffectsField compact />}
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
        {/* The gameplay music (v0.7.2): one track, during games only. */}
        <Row
          id={`${id}-music`}
          name="Music volume"
          description={said(
            "The soundtrack during games, and only then: it starts from the beginning with each game and loops until the game ends. The menus have no music.",
          )}
        >
          <span className={styles.range}>
            <input
              id={`${id}-music`}
              type="range"
              min={0}
              max={100}
              {...named(`${id}-music`, !compact)}
              value={settings.musicVolume}
              onChange={(event) =>
                change({ musicVolume: Number(event.target.value) })
              }
            />
            <output htmlFor={`${id}-music`} aria-hidden="true">
              {settings.musicVolume}
            </output>
          </span>
        </Row>
        <Row
          id={`${id}-mute-music`}
          name="Mute the music"
          description={said(
            "Silences the soundtrack and keeps the sound effects. Also in the Game menu.",
          )}
        >
          <input
            type="checkbox"
            {...named(`${id}-mute-music`, !compact)}
            checked={settings.musicMuted}
            onChange={(event) => change({ musicMuted: event.target.checked })}
          />
        </Row>
        <Row
          id={`${id}-mute`}
          name="Mute all sound"
          description={said("Silences every sound effect and the music.")}
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
