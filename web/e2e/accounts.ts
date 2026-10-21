import type { Page } from "@playwright/test";
import type { Me } from "../src/api";

/**
 * Signs the page in as a stand-in account that page.route answers for the API (v0.3.0), for
 * journeys that need an account in some state but none of its data, so they run without SysOp's
 * password. The stand-in may neither play nor build decks, so no page asks the API for anything
 * on its behalf, and /me keeps the preferences a PATCH saves, as the server does. The returned
 * function changes the account, as an approval would; the page sees it the next time it asks.
 */
export async function standIn(page: Page, changes: Partial<Me> = {}) {
  const account: Me = {
    id: "00000000-0000-4000-8000-0000000000e2",
    kind: "player",
    status: "active",
    onboarding: "complete",
    handle: "stand-in",
    display_name: "Stand-in",
    email: "stand-in@example.com",
    avatar: "sigil",
    locale: "en",
    csrf_token: "stand-in-token",
    permissions: ["profile.edit"],
    roles: ["player"],
    preferences: { large_text: false, reduced_motion: false },
    session: {
      id: "00000000-0000-4000-8000-0000000000e3",
      kind: "google",
      authenticated_at: "2026-10-20T10:00:00Z",
      idle_expires_at: "2026-11-03T10:00:00Z",
      absolute_expires_at: "2026-11-19T10:00:00Z",
    },
    ...changes,
  };
  await page.route("**/api/v1/me", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        preferences?: Partial<Me["preferences"]>;
      };
      account.preferences = { ...account.preferences, ...body.preferences };
    }
    await route.fulfill({ json: account });
  });
  return (next: Partial<Me>) => void Object.assign(account, next);
}
