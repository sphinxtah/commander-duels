import createClient from "openapi-fetch";
import type { paths, components } from "./generated/api";

/**
 * A request the network never answered (offline, a dropped connection, a request aborted)
 * comes back as the service's own "unavailable" answer instead of throwing. So every caller
 * handles it on the path it already has for an error, and none leaves an unhandled rejection
 * or a "searching…" that never ends.
 */
export async function answered(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({
        code: "service_unavailable",
        message: "The application service is unavailable. Try again.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
}

export const client = createClient<paths>({ fetch: answered });
export type Bootstrap = components["schemas"]["Bootstrap"];
export type Format = components["schemas"]["Format"];
export type PracticeFormat = components["schemas"]["PracticeFormat"];
export type Me = components["schemas"]["Me"];
export type AdminUser = components["schemas"]["AdminUser"];
export type AuditEntry = components["schemas"]["AuditEntry"];
export type SessionSummary = components["schemas"]["SessionSummary"];
export type ProfileUpdate = components["schemas"]["ProfileUpdate"];
export type Avatar = Me["avatar"];
export type Permission = Me["permissions"][number];
export type ApiError = { code: string; message: string; request_id?: string };
// The Planeswalker Alliance (v0.3.1): wins and tiers, the roster, the starter decks chosen at
// onboarding, and the Godlike tier's custom cards that SysOp uploads.
export type Progress = components["schemas"]["Progress"];
export type TierInfo = components["schemas"]["TierInfo"];
export type TierId = TierInfo["id"];
export type Planeswalker = components["schemas"]["PlaneswalkerInfo"];
export type StarterDeck = components["schemas"]["StarterDeck"];
export type CustomCard = components["schemas"]["CustomCardInfo"];
export type CustomCardUpload = components["schemas"]["CustomCardUpload"];

/**
 * Whether the account still has a step of onboarding ahead: its handle, then its two starter
 * decks (v0.3.1). Every page but Profile points the way until both are done.
 */
export function onboarding(me: Me): boolean {
  return me.onboarding !== "complete";
}

// The session's CSRF token rides on every state-changing request. It lives in memory only and
// comes back with /me after a reload; the session cookie itself is HttpOnly.
let csrfToken: string | undefined;
export function setCsrfToken(token: string | undefined) {
  csrfToken = token;
}
/** The game WebSocket's hello carries the token too. */
export function currentCsrfToken(): string | undefined {
  return csrfToken;
}
client.use({
  onRequest({ request }) {
    if (csrfToken && !["GET", "HEAD"].includes(request.method))
      request.headers.set("X-CSRF-Token", csrfToken);
    return request;
  },
});

/**
 * How long the page waits for an answer it cannot go on without: the foundation, the account,
 * SysOp's entrance check, an approval check. A proxy may hold a stalled request for an hour, so
 * past this the service counts as not answering and the page offers something to press.
 */
export const ANSWER_MS = 7000;

/** A request's signal that aborts by itself after ANSWER_MS. */
export function answerTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWER_MS);
  return {
    signal: controller.signal,
    /** The answer came: the timer stops. */
    done: () => clearTimeout(timer),
    /** The answer is no longer wanted: the request ends now. */
    abort: () => {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

export async function loadFoundation(signal: AbortSignal) {
  const [bootstrap, formats] = await Promise.all([
    client.GET("/api/v1/bootstrap", { signal }),
    client.GET("/api/v1/formats", { signal }),
  ]);
  if (!bootstrap.data || !formats.data)
    throw new Error("Application service unavailable");
  return { bootstrap: bootstrap.data, formats: formats.data };
}

/**
 * The signed-in account, or null when signed out. Throws when the service is unreachable, or
 * when the signal aborts first. It also keeps the CSRF token in step, unless `token` is false:
 * a caller that may drop a late answer (one that arrives after a sign-out) applies the token
 * itself, and only with an answer it uses.
 */
export async function loadMe(
  signal?: AbortSignal,
  { token = true }: { token?: boolean } = {},
): Promise<Me | null> {
  const { data, response } = await client.GET("/api/v1/me", { signal });
  if (response.status === 401) {
    if (token) setCsrfToken(undefined);
    return null;
  }
  if (!data) throw new Error("Application service unavailable");
  if (token) setCsrfToken(data.csrf_token);
  return data;
}

export function describe(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String((error as ApiError).message);
  return "The application service is unavailable. Try again.";
}

/**
 * SysOp's entrance exists only on the production network, so it is not in the public API. A check
 * that fails, or that the signal ends first, counts as off that network.
 */
export async function sysopEntrance(signal?: AbortSignal): Promise<boolean> {
  try {
    return (await fetch("/api/v1/sysop/entrance", { signal })).status === 204;
  } catch {
    return false;
  }
}

/** SysOp's account answer; a network failure is an error like any other, never a throw. */
async function sysopPost(
  path: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ me?: Me; error?: string }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  } catch {
    return { error: describe(undefined) };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return { error: describe(body) };
  const me = body as Me;
  setCsrfToken(me.csrf_token);
  return { me };
}

export function sysopSignIn(
  username: string,
  password: string,
): Promise<{ me?: Me; error?: string }> {
  return sysopPost("/api/v1/sysop/login", {}, { username, password });
}

/** Changing the password ends every SysOp session and starts a new one for this browser. */
export function sysopChangePassword(
  current_password: string,
  new_password: string,
): Promise<{ me?: Me; error?: string }> {
  return sysopPost(
    "/api/v1/sysop/password",
    { "X-CSRF-Token": csrfToken ?? "" },
    { current_password, new_password },
  );
}
