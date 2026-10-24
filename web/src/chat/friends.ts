import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backgroundRead, client, describe } from "../api";
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
// or a read mark. At the game's table, while the bar is folded away, it asks for nothing. What it
// asks on its own, not at the player's click or a page's first load, is marked as the page's own
// (api.ts backgroundRead), so a tab left open still reaches its idle limit (v0.5.1).

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
  /** Whether a player is a friend, as the list knows now; undefined before it knows (v0.5.1).
   * A window whose conversation says otherwise asks again (Conversation.tsx). */
  friend: (playerId: string) => boolean | undefined;
  state: "loading" | "ready" | "error";
  error: string;
}

// While the list is open, a burst of events asks once.
const SETTLE_MS = 250;

/** An answer, with when it was asked for, against the other's (v0.5.1). */
interface Asked<T> {
  data: T;
  turn: number;
}

export function useBarPeople(chat: Chat, enabled = true): BarPeople {
  const [list, setList] = useState<Asked<FriendList> | null>(null);
  const [conversations, setConversations] = useState<Asked<
    ConversationItem[]
  > | null>(null);
  const [error, setError] = useState("");
  const { panel, live, listen } = chat;
  // Each question's turn, so the newer of the two answers says who is a friend.
  const turns = useRef(0);

  // `background`: the bar asks on its own, on its timer or after the socket said something, not
  // because the player did anything; the API does not count it as activity (v0.5.1).
  const loadFriends = useCallback(async (background: boolean) => {
    const turn = ++turns.current;
    try {
      const { data, error } = await client.GET(
        "/api/v1/friends",
        backgroundRead(background),
      );
      if (data) {
        setList({ data, turn });
        setError("");
      } else setError(describe(error));
    } catch {
      // An unreachable service: the next turn asks again.
    }
  }, []);
  const loadConversations = useCallback(async (background: boolean) => {
    const turn = ++turns.current;
    try {
      const { data } = await client.GET(
        "/api/v1/conversations",
        backgroundRead(background),
      );
      if (data) setConversations({ data: data.conversations, turn });
    } catch {
      // As above.
    }
  }, []);

  // Whether the list has been open since the bar last asked for the friends.
  const asked = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    void loadFriends(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void loadFriends(true);
    }, FRIENDS_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      asked.current = false;
    };
  }, [enabled, loadFriends]);
  // Opening the list asks again at once (the friends too, unless the bar just did); the socket
  // coming back too, since it resends nothing, though that is the bar's own doing.
  const listing = enabled && panel;
  const listed = useRef(false);
  useEffect(() => {
    if (!listing) {
      listed.current = false;
      return;
    }
    const background = listed.current;
    listed.current = true;
    void loadConversations(background);
    if (asked.current) void loadFriends(background);
    asked.current = true;
  }, [listing, live, loadFriends, loadConversations]);
  useEffect(() => {
    if (!listing) return;
    let timer: number | undefined;
    const stop = listen(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadConversations(true), SETTLE_MS);
    });
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, [listing, listen, loadConversations]);

  return useMemo(() => {
    const items = conversations?.data ?? [];
    const unread = new Map(items.map((item) => [item.player.id, item.unread]));
    const friends = new Map(
      (list?.data.friends ?? []).map((player) => [player.id, player]),
    );
    // Who is a friend: the friends list says, unless the conversations were asked for after it
    // (a friendship that began or ended since, v0.5.1). An older conversation's word never brings
    // back a friendship that ended, or a block, nor the presence the two shared before.
    const newer = !list || (conversations?.turn ?? 0) > list.turn;
    if (newer)
      for (const item of items) {
        if (!item.friends) friends.delete(item.player.id);
        else if (!friends.has(item.player.id))
          friends.set(item.player.id, item.player);
      }
    const sorted = [...friends.values()]
      .sort(
        (one, other) =>
          presenceRank(one.presence) - presenceRank(other.presence) ||
          one.handle.localeCompare(other.handle),
      )
      .map((player) => ({ player, unread: unread.get(player.id) ?? 0 }));
    const earlier = items
      .filter((item) => !friends.has(item.player.id))
      .map((item) => ({
        player: item.friends ? { ...item.player, presence: null } : item.player,
        unread: item.unread,
      }));
    const known = new Map<string, PlayerSummary>();
    for (const each of [...earlier, ...sorted])
      known.set(each.player.id, each.player);
    return {
      friends: sorted,
      earlier,
      online: list
        ? sorted.filter(
            ({ player }) =>
              player.presence && player.presence.state !== "offline",
          ).length
        : null,
      requests: list?.data.incoming.length ?? 0,
      known,
      friend: (playerId: string) => (list ? friends.has(playerId) : undefined),
      state: list ? "ready" : error ? "error" : "loading",
      error,
    };
  }, [list, conversations, error]);
}
