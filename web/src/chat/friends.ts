import { useCallback, useEffect, useMemo, useState } from "react";
import { client, describe } from "../api";
import { FRIENDS_REFRESH_MS } from "../social/FriendsPage";
import {
  presenceRank,
  type FriendList,
  type PlayerSummary,
} from "../social/social";
import type { Chat, ConversationItem } from "./chat";

// The chat bar's friends list (v0.5.1): the account's friends with their presence, online first,
// each with their unread messages, and the conversations with players who are no longer friends,
// which stay readable. Friends are asked for again every 30 seconds while the tab is shown, as
// the Friends page does, so the bar's "3 online" stays true; the conversations, for the unread
// counts, when the list opens and, while it is open, whenever the chat's socket tells of a message
// or a read mark.

/** A player on the list, and what is unread from them. */
export interface BarPerson {
  player: PlayerSummary;
  unread: number;
}

export interface BarPeople {
  /** The friends, by what they are doing (in a game or a queue, online, idle, offline), then
   * by handle. */
  friends: BarPerson[];
  /** Conversations with players who are no longer friends, the latest first. */
  earlier: BarPerson[];
  /** Friends online, idle, in a game or a queue; null before the first answer. */
  online: number | null;
  /** Friend requests waiting for the account's answer, on the Friends page. */
  requests: number;
  /** Every player the list knows, for the windows' title bars: the freshest presence. */
  known: Map<string, PlayerSummary>;
  state: "loading" | "ready" | "error";
  error: string;
}

// While the list is open, a burst of events asks once.
const SETTLE_MS = 250;

export function useBarPeople(chat: Chat): BarPeople {
  const [list, setList] = useState<FriendList | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[] | null>(
    null,
  );
  const [error, setError] = useState("");
  const { panel, live, listen } = chat;

  const loadFriends = useCallback(async () => {
    try {
      const { data, error } = await client.GET("/api/v1/friends");
      if (data) {
        setList(data);
        setError("");
      } else setError(describe(error));
    } catch {
      // An unreachable service: the next turn asks again.
    }
  }, []);
  const loadConversations = useCallback(async () => {
    try {
      const { data } = await client.GET("/api/v1/conversations");
      if (data) setConversations(data.conversations);
    } catch {
      // As above.
    }
  }, []);

  useEffect(() => {
    void loadFriends();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void loadFriends();
    }, FRIENDS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadFriends]);
  // Opening the list asks again at once; the socket coming back too, since it resends nothing.
  useEffect(() => {
    if (!panel) return;
    void loadFriends();
    void loadConversations();
  }, [panel, live, loadFriends, loadConversations]);
  useEffect(() => {
    if (!panel) return;
    let timer: number | undefined;
    const stop = listen(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadConversations(), SETTLE_MS);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, [panel, listen, loadConversations]);

  return useMemo(() => {
    const unread = new Map(
      (conversations ?? []).map((item) => [item.player.id, item.unread]),
    );
    const friends = new Map(
      (list?.friends ?? []).map((player) => [player.id, player]),
    );
    // A conversation with a friend the friends list has not shown yet (it was asked for first)
    // counts as a friend's.
    for (const item of conversations ?? [])
      if (item.friends && !friends.has(item.player.id))
        friends.set(item.player.id, item.player);
    const sorted = [...friends.values()]
      .sort(
        (one, other) =>
          presenceRank(one.presence) - presenceRank(other.presence) ||
          one.handle.localeCompare(other.handle),
      )
      .map((player) => ({ player, unread: unread.get(player.id) ?? 0 }));
    const earlier = (conversations ?? [])
      .filter((item) => !item.friends && !friends.has(item.player.id))
      .map((item) => ({ player: item.player, unread: item.unread }));
    const known = new Map<string, PlayerSummary>();
    for (const each of [...earlier, ...sorted])
      known.set(each.player.id, each.player);
    return {
      friends: sorted,
      earlier,
      online: list
        ? list.friends.filter(
            (friend) => friend.presence && friend.presence.state !== "offline",
          ).length
        : null,
      requests: list?.incoming.length ?? 0,
      known,
      state: list ? "ready" : error ? "error" : "loading",
      error,
    };
  }, [list, conversations, error]);
}
