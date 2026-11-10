import { useEffect, useState } from "react";
import { client, describe } from "../api";
import { hudChanged } from "../shell/hud";
import type { QuestBoards } from "./quests";

/** The account's quest boards (v0.9.5), asked for once: the server draws them at the period's
 * first look and pays what already completed one, so the top bar's tokens are asked for again
 * when it did. `none` is an account the service gives no quests to (signed out meanwhile). */
export function useQuestBoards(): {
  boards?: QuestBoards;
  error: string;
  none: boolean;
} {
  const [boards, setBoards] = useState<QuestBoards>();
  const [error, setError] = useState("");
  const [none, setNone] = useState(false);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/me/quests")
      .then(({ data, error: refused, response }) => {
        if (!active) return;
        if (response?.status === 401 || response?.status === 403)
          return setNone(true);
        if (!data) return setError(describe(refused));
        setBoards(data);
        if (data.paid > 0) hudChanged();
      })
      .catch(() => active && setError(describe(undefined)));
    return () => {
      active = false;
    };
  }, []);
  return { boards, error, none };
}
