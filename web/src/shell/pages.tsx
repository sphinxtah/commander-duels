import type { ReactNode } from "react";

// The menus' pages (v0.4.5). The top bar holds the main six, as Magic Duels' main menu did; the
// account's menu opens Profile, Settings and Administration, and Friends has its icon beside the
// bell. SysOp's entrance has no link: it opens only from the SysOp networks. The notifications'
// history opens from the bell. Campaign, Learn and Collection, placeholders since v0.0.1, are
// gone: their old addresses open the main menu. Messages, a page until v0.5.1, are on the chat
// bar; its old addresses open the bar (App.tsx).

export const pages = [
  "Home",
  "Play",
  "Tables",
  "Decks",
  "Cards",
  "Shop",
  // Tivit's Auction House (v0.6.0): its main menu tile leads there; the top bar keeps its six.
  "Auctions",
  "Friends",
  "Profile",
  "Settings",
  "Admin",
] as const;
export type Page = (typeof pages)[number] | "SysOp" | "Notifications";
export const mainPages = [
  "Home",
  "Play",
  "Tables",
  "Decks",
  "Cards",
  "Shop",
] as const;

/** The name the title band shows for each page. */
export const pageNames: Record<Page, string> = {
  Home: "Main menu",
  Play: "Play",
  Tables: "Tables",
  Decks: "Decks",
  Cards: "Cards",
  Shop: "Shop",
  Auctions: "Auctions",
  Friends: "Friends",
  Profile: "Profile",
  Settings: "Settings",
  Admin: "Administration",
  SysOp: "SysOp",
  Notifications: "Notifications",
};

export function pageHref(page: Page): string {
  return `#${page.toLowerCase()}`;
}

export type IconName =
  | "home"
  | "play"
  | "tables"
  | "decks"
  | "cards"
  | "shop"
  | "auctions"
  | "friends"
  | "messages"
  | "back";

/** Line icons drawn in the current colour, for links whose words say what they are. */
export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icons[name]}
    </svg>
  );
}

const icons: Record<IconName, ReactNode> = {
  // A keep's gate.
  home: (
    <>
      <path d="M4 21V9l2-1V5h3v2l3-2 3 2V5h3v3l2 1v12" />
      <path d="M10 21v-5a2 2 0 0 1 4 0v5M3 21h18" />
    </>
  ),
  // Two crossed swords.
  play: (
    <>
      <path d="M5 4l9.5 9.5M4 5l1-1M13 16l3-3M15 18l3 3M18 15l3 3" />
      <path d="M19 4L9.5 13.5M20 5l-1-1M11 16l-3-3M9 18l-3 3M6 15l-3 3" />
    </>
  ),
  // A round table and its four seats.
  tables: (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="3.5" r="1.5" />
      <circle cx="12" cy="20.5" r="1.5" />
      <circle cx="3.5" cy="12" r="1.5" />
      <circle cx="20.5" cy="12" r="1.5" />
    </>
  ),
  // A deck: cards stacked.
  decks: (
    <>
      <rect x="7" y="5" width="12" height="16" rx="1.6" />
      <path d="M5 18V4.6A1.6 1.6 0 0 1 6.6 3H15" />
      <path d="M13 10l2 3-2 3-2-3z" />
    </>
  ),
  // A card face with its gem.
  cards: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="1.6" />
      <path d="M8 7h8M12 10.5l2.5 3.5-2.5 3.5-2.5-3.5z" />
    </>
  ),
  // A coin pouch.
  shop: (
    <>
      <path d="M9 6h6l-1.5-3h-3zM9 6c-4 3-5 7-4 11a3 3 0 0 0 3 2.5h8a3 3 0 0 0 3-2.5c1-4 0-8-4-11" />
      <path d="M12 10v6M10.2 11.4h2.8a1.3 1.3 0 0 1 0 2.6h-2a1.3 1.3 0 0 0 0 2.6H14" />
    </>
  ),
  // An auctioneer's gavel over its block (v0.6.0).
  auctions: (
    <>
      <path d="M13.2 4.6l5.6 5.6M10.4 7.4l5.6 5.6M11.8 6l4.2 4.2" />
      <path d="M12.6 10.6L5 18.2a1.4 1.4 0 0 0 2 2l7.6-7.6" />
      <path d="M13 21h8" />
    </>
  ),
  // Two companions.
  friends: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <circle cx="16.5" cy="9" r="2.6" />
      <path d="M15.5 14.2A5 5 0 0 1 21 19" />
    </>
  ),
  // A speech scroll.
  messages: (
    <>
      <path d="M4 5h16v11H11l-4.5 4v-4H4z" />
      <path d="M8 9h8M8 12.5h5" />
    </>
  ),
  back: <path d="M14.5 5l-7 7 7 7" />,
};
