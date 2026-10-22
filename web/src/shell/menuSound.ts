import { readTableSettings } from "../app/tableSettings";
import { getSoundEngine } from "../game/sound/engine";
import type { Cue } from "../game/sound/recipes";

// The menus' sound (v0.4.5), generated like the table's and at its volume and mute (Settings →
// The table), read afresh each time so a change there is heard at once. Browsers start audio only
// inside a press: choosing something starts it, and until then hovering is silent.

/** Hover ticks closer together than this, a pointer sweeping across the tiles, sound once. */
export const HOVER_GAP_MS = 90;
let lastHover = -Infinity;

function play(cue: Cue, unlock: boolean) {
  const engine = getSoundEngine();
  if (unlock && engine.state === "locked") engine.unlock();
  if (engine.state !== "running") return;
  const settings = readTableSettings();
  engine.setVolume(settings.effectsVolume);
  engine.setMuted(settings.muted);
  engine.play(cue);
}

/** A tile or link under the pointer, or reached with the keyboard. */
export function hoverSound(now = performance.now()) {
  if (now - lastHover < HOVER_GAP_MS) return;
  lastHover = now;
  play("menuHover", false);
}

/** A choice made: call it inside the click or key press. */
export function selectSound() {
  play("menuSelect", true);
}

/** Back to the main menu: call it inside the click or key press. */
export function backSound() {
  play("menuBack", true);
}
