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
    const response = await fetch(request);
    recordRequest(request, response);
    return response;
  } catch {
    recordRequest(request, null);
    return new Response(
      JSON.stringify({
        code: "service_unavailable",
        message: "The application service is unavailable. Try again.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
}

export type RecentRequest = components["schemas"]["RecentRequest"];
/** How many of the page's latest API requests a problem report carries (v0.4.1). */
export const RECENT_REQUESTS = 20;
const recent: RecentRequest[] = [];
const METHODS = new Set<string>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
// Asked by the page on its own (Administration's counts, the presence check-in): they would
// push out what the person did.
const UNRECORDED = new Set(["/api/v1/admin/counts", "/api/v1/presence"]);
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Marks a read the page makes on its own (v0.5.1), on a timer or after the chat's socket told it
 * something: the API does not count it as activity, so a tab left open still reaches its idle
 * limit (identity.BACKGROUND_HEADER, honoured for GET only), and a problem report leaves it out.
 * The person's own clicks and a page's first load go unmarked. */
export const BACKGROUND_HEADER = "X-Background";

/** A GET's options, marked as the page's own when `background` is true. */
export function backgroundRead(background: boolean): {
  headers?: Record<string, string>;
} {
  return background ? { headers: { [BACKGROUND_HEADER]: "1" } } : {};
}

/**
 * Notes an API request for a problem report: its method, its path without the query, the
 * answer's status (0 when none came), its X-Request-ID and the time. Never a body, a query or
 * another header. Only the latest RECENT_REQUESTS are kept, in this page's memory; a read the
 * page made on its own (BACKGROUND_HEADER) is not noted.
 */
export function recordRequest(request: Request, response: Response | null) {
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return;
  }
  if (!path.startsWith("/api/") || UNRECORDED.has(path)) return;
  if (request.headers.get(BACKGROUND_HEADER) === "1") return;
  if (!METHODS.has(request.method)) return;
  const id = response?.headers.get("X-Request-ID") ?? null;
  recent.push({
    method: request.method as RecentRequest["method"],
    path: path.slice(0, 200),
    status: response?.status ?? 0,
    request_id: id && REQUEST_ID.test(id) ? id : null,
    at: new Date().toISOString(),
  });
  if (recent.length > RECENT_REQUESTS)
    recent.splice(0, recent.length - RECENT_REQUESTS);
}

/** The latest API requests, oldest first: copies, so a report keeps them as they were. */
export function recentRequests(): RecentRequest[] {
  return recent.map((entry) => ({ ...entry }));
}

/** Forgets every recorded request; for tests. */
export function forgetRequests() {
  recent.length = 0;
}

export const client = createClient<paths>({ fetch: answered });
export type Bootstrap = components["schemas"]["Bootstrap"];
export type Format = components["schemas"]["Format"];
export type PracticeFormat = components["schemas"]["PracticeFormat"];
export type Me = components["schemas"]["Me"];
export type AdminUser = components["schemas"]["AdminUser"];
export type AccountReset = components["schemas"]["AccountReset"];
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
// Tokens (v0.4.0): what wins pay, SysOp's grants and the economy's settings.
export type Tokens = components["schemas"]["Tokens"];
export type TokenLine = components["schemas"]["TokenLine"];
export type EconomySettings = components["schemas"]["EconomySettings"];
// Problem reports (v0.4.1): what a player sends, and what Administration reads and counts.
export type ReportContext = components["schemas"]["ReportContext"];
export type ReportSummary = components["schemas"]["ReportSummary"];
export type ReportDetail = components["schemas"]["ReportDetail"];
export type ReportStatus = ReportSummary["status"];
export type AdminCounts = components["schemas"]["AdminCounts"];

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
