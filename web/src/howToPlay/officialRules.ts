import { useEffect, useState } from "react";
import { parseRules, RULES_URL, type ComprehensiveRules } from "./rules";

// The official text is fetched once per visit, when How to play first needs it (about 1 MB, a
// quarter of that over the wire), and parsed in the browser. A 404 is the public build: no
// official text, which the page says plainly.

export type OfficialRules =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "failed" }
  | { state: "ready"; rules: ComprehensiveRules };

let pending: Promise<OfficialRules> | undefined;

export function loadOfficialRules(): Promise<OfficialRules> {
  pending ??= fetch(RULES_URL, { cache: "no-cache" })
    .then(async (response): Promise<OfficialRules> => {
      if (response.status === 404) return { state: "missing" };
      if (!response.ok) return { state: "failed" };
      const type = response.headers.get("Content-Type") ?? "";
      // The app's own page answers an unknown address on some servers: not the rules.
      if (type.includes("text/html")) return { state: "missing" };
      try {
        return { state: "ready", rules: parseRules(await response.text()) };
      } catch {
        return { state: "failed" };
      }
    })
    .catch((): OfficialRules => ({ state: "failed" }))
    .then((result) => {
      // A failure may be passing: the next visit to the page asks again.
      if (result.state === "failed") pending = undefined;
      return result;
    });
  return pending;
}

/** For tests: forget the fetched rules. */
export function forgetOfficialRules(): void {
  pending = undefined;
}

export function useOfficialRules(): OfficialRules {
  const [rules, setRules] = useState<OfficialRules>({ state: "loading" });
  useEffect(() => {
    let live = true;
    void loadOfficialRules().then((loaded) => {
      if (live) setRules(loaded);
    });
    return () => {
      live = false;
    };
  }, []);
  return rules;
}
