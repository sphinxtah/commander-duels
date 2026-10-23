import type { TokenLine } from "../api";

// Tokens (v0.4.0). Wins pay them: 5 to 20 per beaten bot by its skill, 50 to 500 per beaten
// player by that player's wins; since v0.5.0 daily quests and achievements pay too. Every account
// starts with 1,000, SysOp may give more, and Leng's card shop sells packs for them. The server's
// ledger is the only record (api/economy.py).

/** "1 token", "1,250 tokens". */
export function tokens(count: number): string {
  return `${count.toLocaleString("en-US")} ${Math.abs(count) === 1 ? "token" : "tokens"}`;
}

/** An entry's amount as a change: "+14", "−500", "0". */
export function change(amount: number): string {
  const size = Math.abs(amount).toLocaleString("en-US");
  return amount > 0 ? `+${size}` : amount < 0 ? `−${size}` : "0";
}

/** What an entry was for, in words. */
export function lineWords(line: TokenLine): string {
  switch (line.kind) {
    case "bot_win":
      return `Beat ${line.opponent ?? "a bot"}`;
    case "human_win":
      return `Beat ${line.opponent ?? "a player"}`;
    case "back_pay":
      return `Beat ${line.opponent ?? "a bot"} before tokens began`;
    case "welcome":
      return "Welcome grant";
    case "grant":
      return line.amount < 0 ? "Taken back by SysOp" : "Given by SysOp";
    case "pack":
      return line.reason ?? "A pack from Leng's card shop";
    case "quest":
      return `Daily quest: ${line.reason ?? "completed"}`;
    case "achievement":
      return `Achievement: ${line.reason ?? "earned"}`;
  }
}

/** Entries whose reason is what they were for, said by lineWords already. */
export function namedByReason(line: TokenLine): boolean {
  return (
    line.kind === "pack" || line.kind === "quest" || line.kind === "achievement"
  );
}
