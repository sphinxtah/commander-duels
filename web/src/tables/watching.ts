import { useCallback } from "react";
import { client } from "../api";
import type { components } from "../generated/api";
import { useLobby } from "./lobby";
import { usePolled, type TableView } from "./tables";

// Spectators at a table (v1.0.0, docs/tables.md): what the opening form, a table's page and the
// lobby share. The host sets who may watch: nobody, the friends the table's players invite, or
// anyone (a public table alone). Invited spectators watch live; where anyone may watch, the game
// is shown a minute behind. Behind the gate `spectators`.

/** The workflow's id, as the rollout knows it (docs/operations.md). */
export const SPECTATORS = "spectators";

export type WatchSetting = TableView["spectators"];
export type Spectators = components["schemas"]["Spectators"];
export type SpectatorView = components["schemas"]["SpectatorView"];
export type Watchable = components["schemas"]["Watchable"];

/** The host's choices, in the order the form shows them. */
export const WATCH_SETTINGS: { value: WatchSetting; words: string }[] = [
  { value: "nobody", words: "Nobody" },
  { value: "invited", words: "Friends the players invite: live" },
  { value: "anyone", words: "Anyone: a minute behind the game" },
];

/** Who may watch a table's game, as a sentence. */
export function watchSentence(setting: WatchSetting): string {
  if (setting === "invited")
    return "The friends this table’s players invite watch its game, live.";
  if (setting === "anyone")
    return "Anyone may watch this table’s game, a minute behind it.";
  return "Nobody watches this table’s game.";
}

/** How often a table's page asks who is invited to watch. */
export const SPECTATORS_POLL_MS = 10_000;
/** How often the lobby asks which games the account may watch. */
export const WATCHABLE_POLL_MS = 15_000;

/** The people invited to watch a table, for its players and for those invited: null while it is
 * not theirs to read (the gate is closed, or the account neither plays nor was invited). */
export function useSpectators(
  code: string,
  wanted: boolean,
): [Spectators | null | undefined, () => void] {
  const load = useCallback(async (): Promise<Spectators | null> => {
    if (!wanted) return null;
    const { data } = await client.GET("/api/v1/tables/{code}/spectators", {
      params: { path: { code } },
    });
    return data ?? null;
  }, [code, wanted]);
  return usePolled(load, SPECTATORS_POLL_MS);
}

/** The tables whose game the account may watch now; empty while the gate is closed. Asked again
 * as soon as the live lobby says the tables changed: a table that starts is one to watch. */
export function useWatchable(wanted: boolean): Watchable[] {
  const { revision } = useLobby();
  const load = useCallback(async (): Promise<Watchable[]> => {
    if (!wanted) return [];
    const { data } = await client.GET("/api/v1/spectating");
    return data ?? [];
    // The lobby's revision asks again at once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, revision]);
  return usePolled(load, WATCHABLE_POLL_MS)[0] ?? [];
}
