import { useEffect } from "react";
import { useTableSettings } from "../app/tableSettings";
import { createGameMusic, type GameMusic } from "../game/music/gameMusic";
import { getMenuMusic, type MenuMusic } from "../shell/music/menuMusic";
import { useMenuMusicSettings } from "../shell/music/menuMusicSettings";

// The campaign's cut-scene music (v0.8.1, the owner's track): one long track, streamed from
// /music/campaign.mp3, under every cut scene between the duels. It fades in as a scene opens and out
// as it ends, and goes on from where it stopped at the next scene rather than beginning again. The
// menu playlist holds its place meanwhile and plays on after the scene. The level is the menu
// music's (its volume and mute, and Mute all sound), and Story settings can turn it off. Like the
// game's track it is not in the public repository: the owner's private web image carries it, and
// elsewhere the address answers 404 and the scenes stay quiet, the playlist held all the same.

export const CAMPAIGN_MUSIC_URL = "/music/campaign.mp3";

let music: GameMusic | null = null;

/** The page's one player for the cut scenes. Asking for it makes no element; start() does. */
export function getCampaignMusic(): GameMusic {
  return (music ??= createGameMusic({
    src: CAMPAIGN_MUSIC_URL,
    restart: false,
  }));
}

export function useCampaignMusic({
  on,
  player,
  menu,
}: {
  /** A cut scene is on screen and its music is wanted (Story settings). */
  on: boolean;
  /** The page's players unless a test brings its own. */
  player?: GameMusic;
  menu?: MenuMusic;
}): void {
  const scenes = player ?? getCampaignMusic();
  const playlist = menu ?? getMenuMusic();
  const [settings] = useMenuMusicSettings();
  const [table] = useTableSettings();

  useEffect(() => {
    scenes.setLevel(settings.volume, settings.muted || table.muted);
  }, [scenes, settings.volume, settings.muted, table.muted]);

  useEffect(() => {
    if (!on) return;
    playlist.hold(true);
    scenes.start();
    return () => {
      scenes.stop();
      playlist.hold(false);
    };
  }, [scenes, playlist, on]);
}
