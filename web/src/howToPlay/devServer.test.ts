import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES_PREFIX, rulesFile, rulesFolder } from "../../plugins/rules";
import { RULES_URL } from "./rules";

// The dev server's rules folder (web/plugins/rules.ts) answers the address How to play asks for,
// as nginx does on the built site (v0.8.6).

describe("the rules folder in dev", () => {
  it("serves the official text's address, and only plain file names under /rules/", () => {
    expect(RULES_URL.startsWith(RULES_PREFIX)).toBe(true);
    expect(rulesFile(RULES_URL)).toBe("comprehensive-rules.txt");
    expect(rulesFile("/rules/source.json?x=1")).toBe("source.json");
    expect(rulesFile("/rules/")).toBeUndefined();
    expect(rulesFile("/rules/../VERSION")).toBeUndefined();
    expect(rulesFile("/rules/.env")).toBeUndefined();
    expect(rulesFile("/rules/a/b.txt")).toBeUndefined();
    expect(rulesFile("/rulesx/a.txt")).toBeUndefined();
  });

  it("is the folder beside compose.yaml", () => {
    expect(rulesFolder("/repo/web")).toBe(resolve("/repo/rules"));
  });
});
