import {
  auctionNotice,
  auctionNoticeLink,
  auctionNoticeWords,
} from "../auctions/auctions";
import type { components } from "../generated/api";

// Finding other players, friends, presence and the notification bell (v0.4.3). The server
// decides everything here: who a search finds, whose presence an account may see and what it
// shows. docs/social.md describes it.

export type PlayerRef = components["schemas"]["PlayerRef"];
export type PlayerSummary = components["schemas"]["PlayerSummary"];
export type PlayerProfile = components["schemas"]["PlayerProfile"];
export type Presence = components["schemas"]["Presence"];
export type FriendList = components["schemas"]["FriendList"];
export type UnnamedPlayer = components["schemas"]["UnnamedPlayer"];
export type WaitingRequest = components["schemas"]["WaitingRequest"];
export type BlockedPlayer = components["schemas"]["BlockedPlayer"];
export type PrivacySettings = components["schemas"]["PrivacySettings"];
export type NotificationItem = components["schemas"]["NotificationItem"];
export type NotificationPage = components["schemas"]["NotificationPage"];
export type FriendState = PlayerSummary["friendship"];

/** #player/<id> opens a player's profile. */
export const PLAYER_ROUTE = /^#player\/([0-9a-f-]{36})$/i;

export function playerLink(id: string): string {
  return `#player/${id}`;
}

const formatNames: Record<string, string> = {
  commander: "Commander",
  legacy: "Legacy",
  two_headed_giant: "Two-Headed Giant",
};

/** "Online", "Playing Commander at a table", "Idle"…; empty when the player does not share it. */
export function presenceWords(presence: Presence | null | undefined): string {
  if (!presence) return "";
  let words: string;
  if (presence.state === "in_game") {
    const name = formatNames[presence.game_format ?? ""] ?? "a game";
    words =
      presence.game_kind === "table"
        ? `Playing ${name} at a table`
        : `Playing a ${name} practice game`;
  } else if (presence.state === "in_queue") {
    // Waiting in a public queue (v0.5.0).
    const name = formatNames[presence.game_format ?? ""];
    words = name ? `Looking for a ${name} game` : "Looking for a game";
  } else {
    words = { online: "Online", idle: "Idle", offline: "Offline" }[
      presence.state
    ];
  }
  return presence.appears_offline ? `${words} (appears offline)` : words;
}

/** Friends first by what they are doing: in a game (or, since v0.5.0, a queue), online, idle,
 * offline, then unknown. */
export function presenceRank(presence: Presence | null | undefined): number {
  if (!presence) return 4;
  if (presence.state === "in_queue") return 0;
  return ["in_game", "online", "idle", "offline"].indexOf(presence.state);
}

/** Where a notification leads: a message to its conversation, a rematch (v0.5.0) to its
 * game's result screen, an invitation to the Two-Headed Giant queue (v0.5.1) to Find a game on
 * the Play page, anything else to the player's profile. Null without a player. */
export function notificationLink(item: NotificationItem): string | null {
  if (item.kind === "rematch" && item.game_id) return `#game/${item.game_id}`;
  if (item.kind === "team_invite") return "#find";
  if (!item.actor) return null;
  return playerLink(item.actor.id);
}

export function notificationWords(item: NotificationItem): string {
  // The auction house's five kinds (v0.6.0).
  const auction = auctionNotice(item);
  if (auction) return auctionNoticeWords(auction.kind, auction.auction);
  const who = item.actor?.handle ?? "A player who has left";
  switch (item.kind) {
    case "friend_request":
      return `${who} wants to be your friend.`;
    case "friend_accepted":
      return `${who} accepted your friend request.`;
    case "friend_online":
      return `${who} is online.`;
    case "message":
      return item.messages > 1
        ? `${who} sent you ${item.messages} messages.`
        : item.messages === 1
          ? `${who} sent you a message.`
          : `${who} sent you messages.`;
    case "quest_completed":
      return item.award
        ? `Quest complete: ${item.award.name}. +${item.award.tokens.toLocaleString("en-US")} tokens.`
        : "You completed a daily quest.";
    case "achievement_earned":
      return item.award
        ? `Achievement earned: ${item.award.name}. +${item.award.tokens.toLocaleString("en-US")} tokens.`
        : "You earned an achievement.";
    case "rematch":
      return item.request_pending
        ? `${who} offers a rematch.`
        : `${who} offered a rematch.`;
    case "team_invite":
      return item.request_pending
        ? `${who} invites you to play Two-Headed Giant as their teammate.`
        : `${who} invited you to play Two-Headed Giant as their teammate.`;
    case "auction_outbid":
    case "auction_won":
    case "auction_sold":
    case "auction_unsold":
    case "auction_cancelled":
      // Said above by auctionNoticeWords; this only closes the switch.
      return "News from Tivit's Auction House.";
  }
}

/** Where a notification no player caused leads (v0.5.0): the quests' main menu, or Profile;
 * since v0.6.0 an auction's, the auction house's transfer targets or transfer list. */
export function awardLink(item: NotificationItem): string | null {
  const auction = auctionNotice(item);
  if (auction) return auctionNoticeLink(auction.kind);
  if (item.kind === "quest_completed") return "#home";
  if (item.kind === "achievement_earned") return "#profile";
  return null;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Whether the text is a whole email address. The search takes any text with an @ as one; the
 * page sends it only on Enter, so typing an address letter by letter spends no searches.
 */
export function looksLikeEmail(text: string): boolean {
  return text.includes("@");
}
