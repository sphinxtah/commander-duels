import { useEffect } from "react";
import type { TableSettings } from "../table/types";
import { getGameMusic, type GameMusic } from "./gameMusic";

// The game screen's music (v0.7.2): the track plays while the game is live, at the table settings'
// music volume, and stops as the game ends (the result shows over a fading track, so the victory
// or defeat chime stands alone) or the player leaves the table. Mute all sound and the music's own
// mute both silence it.

export function useGameMusic({
  live,
  settings,
  player,
}: {
  /** The game has a table on screen and is not over. */
  live: boolean;
  settings: TableSettings;
  /** The page's player unless a test brings its own. */
  player?: GameMusic;
}): void {
  const music = player ?? getGameMusic();

  useEffect(() => {
    music.setLevel(settings.musicVolume, settings.muted || settings.musicMuted);
  }, [music, settings.musicVolume, settings.muted, settings.musicMuted]);

  useEffect(() => {
    if (live) music.start();
    else music.stop();
  }, [music, live]);

  // Leaving the table (or the next game's screen replacing this one) stops it.
  useEffect(() => () => music.stop(), [music]);
}
