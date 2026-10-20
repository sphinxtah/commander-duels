import createClient from "openapi-fetch";
import type { paths, components } from "./generated/api";

export const client = createClient<paths>();
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

export async function loadFoundation(signal: AbortSignal) {
  const [bootstrap, formats] = await Promise.all([
    client.GET("/api/v1/bootstrap", { signal }),
    client.GET("/api/v1/formats", { signal }),
  ]);
  if (!bootstrap.data || !formats.data)
    throw new Error("Application service unavailable");
  return { bootstrap: bootstrap.data, formats: formats.data };
}

/** The signed-in account, or null when signed out. Throws when the service is unreachable. */
export async function loadMe(): Promise<Me | null> {
  const { data, response } = await client.GET("/api/v1/me");
  if (response.status === 401) {
    setCsrfToken(undefined);
    return null;
  }
  if (!data) throw new Error("Application service unavailable");
  setCsrfToken(data.csrf_token);
  return data;
}

export function describe(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String((error as ApiError).message);
  return "The application service is unavailable. Try again.";
}

/** SysOp's entrance exists only on the production network, so it is not in the public API. */
export async function sysopEntrance(): Promise<boolean> {
  try {
    return (await fetch("/api/v1/sysop/entrance")).status === 204;
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
