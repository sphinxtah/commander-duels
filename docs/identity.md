# Identity: sign-in, sessions, roles and SysOp

v0.0.5 adds the application's identity layer: Google sign-in, server-side sessions, roles, an append-only audit trail and SysOp, the local root account. It covers AUTH01–AUTH07 and SEC05 as far as they apply before games run through the API, and T01, T02 and the administrative part of T29. Game routing, seat ownership and controller leases (AUTH07's match half) come in v0.0.6.

## Decisions

Agreed on 2026-10-18 at the start of v0.0.5:

- **Google sign-in.** Implement the full flow. Sign-up is **open**: a first sign-in creates an active player. Approval mode stays available as `CD_SIGNUP_POLICY=approval`.
- **SysOp.** Copy Kingdom Connect's design, **without a second factor**: the network check stands in for it.
- **SysOp's powers.** Full access to everything, with no exceptions:
  - **Concealed information.** SysOp sees every hand and library in a running game; this is an exception to SEC05 and NET14, for SysOp only.
  - **Play.** SysOp plays, against bots in particular, to test the engine and the opponents' behaviour.
  - **Any card.** SysOp can put any card in the card database into its own library, to test specific combinations.
- **Screens.** Sign-in, the profile and administration screens in the browser. No game, so this stays a 0.0.x version.

## Google sign-in (AUTH01–AUTH05)

**Primary flow.** Google Identity Services' ID-token flow with a JavaScript callback (`ux_mode: popup`, FedCM for the button where Chrome supports it). The authorization-code redirect flow is not used.

1. The Profile page asks `POST /api/v1/auth/google/start`. The server creates a sign-in challenge:
   - the browser gets a random secret in the `cd_google` cookie (HttpOnly, Secure, SameSite=Strict, path `/api/v1/auth/google`, 10 minutes);
   - the server keeps only the nonce, which is the secret's SHA-256 hash.
2. The page loads Google's script and initializes it with the client ID and that nonce. Google signs the nonce into the ID token.
3. Google's callback hands the page the ID token, and the page posts it to `POST /api/v1/auth/google`.
4. The server verifies it and consumes the challenge:
   - **Verification.** Google's `google-auth` library checks the signature against Google's published certificates (fetched with httpx, cached for their `max-age`), the audience (our client ID), the issuer and the expiry, with 10 seconds of clock skew.
   - **The nonce.** The server checks that the token's nonce is the hash of the presented cookie.
   - **The challenge.** It consumes the challenge with a conditional update, so it works once.

This pair, the cookie and the nonce inside the signed token, is this flow's CSRF and replay protection (AUTH02). Google's own `g_csrf_token` double-submit belongs to its redirect mode, which posts to the server directly; with a callback, the page posts. The protection holds in each case:
- **A stolen token** fails without the matching cookie.
- **A replayed token** finds its challenge consumed.
- **Another site** cannot complete a sign-in. It cannot read the cookie or choose the nonce, and the Origin check refuses its request anyway.

**Accounts.**
- The account is keyed by issuer and Google's stable `sub`, never by email. A changed email address updates the private record, with no duplicate account.
- Google establishes identity only (AUTH04). No Google scopes beyond the ID token's own are requested, and nothing grants roles automatically.
- A first sign-in creates the internal UUID and an account with the Google display name. The player then chooses a unique handle: 3–20 letters, digits, hyphens or underscores, case-insensitively unique, with names such as `sysop` and `admin` reserved.
- Avatars are one of eight built-in symbols, so no remote image is ever fetched.
- The profile also holds the display name, locale, onboarding state and the accessibility preferences, which follow the account across devices.
- Email and the Google subject are private:
  - The subject is never returned.
  - Email goes to its owner, and to administrators, who need it to identify accounts they approve.

**Failures.**
- A refused token returns 401 `invalid_sign_in`, records `auth.google_login_failed` with a reason (`invalid_token`, `nonce_mismatch`, `challenge_used_or_expired`) and creates no session (T02).
- A sign-in post without a challenge is refused without an audit entry, so a bot cannot fill the trail.
- Google being unreachable returns 503 `provider_unavailable`.
- A cancelled or denied Google prompt simply never calls back.
- Without `CD_GOOGLE_CLIENT_ID`, sign-in reports `sign_in_unavailable` and the page says the server is not set up.

**Setting up a client ID.**
1. In Google Cloud Console → APIs & Services → Credentials, create an OAuth client ID of type *Web application*.
2. Add every origin the site is opened from as an authorized JavaScript origin: for local work `http://localhost` and `http://localhost:8080` (Compose) or `http://localhost:5173` (Vite); in production, the site's HTTPS origin.
3. Put the client ID in `CD_GOOGLE_CLIENT_ID`. It is public by design. The ID-token flow needs no client secret, and none belongs in this application.

## Sessions (AUTH03)

- **Token and cookie.**
  - The browser holds a random 256-bit token in `cd_session`: HttpOnly, Secure, SameSite=Lax, path `/api`.
  - The database holds only its SHA-256 hash.
  - Nothing goes in localStorage or in a URL.
- **CSRF.**
  - Every state-changing request needs the session's CSRF token in `X-CSRF-Token`. The browser receives it from `/api/v1/me` and keeps it in memory.
  - Before any session is examined, a middleware refuses a state-changing `/api/` request whose `Origin` is not the site's (`CD_PUBLIC_URL`, plus its loopback twin), or that a browser marks `Sec-Fetch-Site: cross-site`.
- **Lifetimes.**

  | Kind | Idle | Absolute |
  | --- | --- | --- |
  | Player (Google) | 14 days | 30 days |
  | SysOp | 60 minutes | 12 hours |

  Activity extends the idle limit at most once a minute.
- **Rotation.**
  - Every sign-in issues a new session and ends any session the browser presented.
  - Every role or status change raises the account's privilege version. The account's next request swaps its session for a new identifier, with the same sign-in time and limits.
- **Ending sessions.**
  - Sign out ends this session.
  - *Sign out everywhere* ends all of the account's sessions.
  - The Profile page lists the active sessions and ends any one of them.
- **Reauthentication.** Role and account-status changes need a sign-in at most `CD_REAUTH_MINUTES` old (12 hours). An older session gets 401 `reauthentication_required`.

## Roles and permissions (AUTH06, AUTH07, SEC05)

Every active account is a player. Grants add the other roles. Permissions are checked on the server for every request.

| Permission | Player | Moderator | Content editor | Administrator | SysOp |
| --- | :-: | :-: | :-: | :-: | :-: |
| `profile.edit`, `games.play` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `moderation.read` |  | ✓ |  | ✓ | ✓ |
| `content.edit` |  |  | ✓ | ✓ | ✓ |
| `admin.users.read` |  | ✓ |  | ✓ | ✓ |
| `admin.users.manage`, `admin.roles.manage`, `admin.audit.read` |  |  |  | ✓ | ✓ |
| `admin.roles.administrator` |  |  |  |  | ✓ |
| `games.view_concealed` |  |  |  |  | ✓ |
| `cards.any` |  |  |  |  | ✓ |

**Administrators.**
- They approve or deny pending accounts, disable and restore accounts (disabling ends every session), sign accounts out everywhere, and grant or remove the moderator and content-editor roles.
- They cannot change administrators, SysOp or their own account.
- The first administrator is not configured separately (AUTH06): SysOp is the configured bootstrap, and only SysOp makes or removes administrators. No Google account ever becomes an administrator by signing in.

**Pending and denied accounts.**
- In approval mode, a new account is `pending` until approved. It can sign in, see its state and choose a handle, and nothing more.
- A denied account sees that it was not approved.
- A disabled account cannot sign in.

**SysOp-only permissions.**
- Three permissions belong to SysOp alone, and no role can be granted them: `admin.roles.administrator`, `games.view_concealed` and `cards.any`.
- The last two are recorded now and take effect where the features exist:
  - **Inspection.** SysOp's view of every hand and library arrives with authenticated game routing in v0.0.6.
  - **Any card.** Its use of any card in the engine's card database comes with the first way to start a game from a deck list.
- Administrators and moderators keep SEC05's and NET14's restrictions: there is no "view all live hands" for them.

**Errors** follow the scope's rules:
- 401 when signed out;
- 403 when the account lacks the permission or is pending or denied;
- 404, identical to a missing path, for SysOp or another account's session;
- 409 for conflicts such as a taken handle or a change to your own account.

## SysOp, the local root account

SysOp copies Kingdom Connect's root account:
- **Username.** Always `sysop`.
- **Its own entrance.** The browser opens `#sysop`. The API's `/api/v1/sysop/*` routes exist only for clients in `CD_SYSOP_NETWORKS`. Everywhere else they answer exactly like a path that does not exist, and the page looks like any unknown address. They are left out of the published OpenAPI document.
- **Password.** Argon2id (argon2-cffi's current parameters, rehashed on sign-in when they change), at least 12 characters.
  - It is set only from the server console, never through the interface.
  - SysOp can change it in the Profile page by giving the current one.
  - Setting or changing it ends every SysOp session.
- **Lockout.** Five failed sign-ins from one address in 15 minutes lock that address out until the window passes. A success clears its count. A missing account costs the same time as a wrong password.
- **Sessions.**
  - SysOp's sessions are short (table above).
  - They count as signed out whenever a request comes from outside the SysOp networks, so a session carried off the network is useless there.
- **A ghost account.**
  - SysOp never appears in account lists and cannot be changed, demoted or disabled through the interface.
  - Other viewers of the audit log see its actions as the *Site administrator*'s, without its addresses, and never see its sign-in trail.
- **No second factor.** As agreed, the network check stands in for it. Every SysOp sign-in, sign-out, failure, password change and administrative action is audited with its source address.

**Setting the password.** Running this creates SysOp the first time:

```sh
docker compose exec api python -m api.cli sysop-password
```

It asks twice, without echo. For automation, `--stdin` reads one line, and `--password-file PATH` reads a mounted secret.

**Networks and proxies.**
- `CD_SYSOP_NETWORKS` is a comma-separated CIDR list, for example the homelab LAN. Empty disables the entrance.
- `CD_TRUSTED_PROXIES` lists the proxies whose `X-Forwarded-For` is believed. The API walks the chain from the nearest hop and takes the first address that is not a trusted proxy. A malformed chain counts as unknown.
- A SysOp network that overlaps a trusted proxy is refused at startup: it would open SysOp to everyone that proxy forwards for.
- Uvicorn runs with `--no-proxy-headers`, so only this logic decides.
- In Compose, the web container is the one trusted proxy (`172.30.233.10`). Docker Desktop delivers this computer's browser requests from the network's gateway (`172.30.233.1`, measured), and the ports are published on 127.0.0.1 only, so the gateway is this computer and the development SysOp network.
- For the homelab deployment:
  - Set the LAN's CIDR.
  - List the host proxy and the web container as trusted proxies.
  - Re-test the entrance from outside the network: it must answer *not found*.

## Audit trail

`audit_events` records the time, actor, action, target account, source address, request ID and small details (never tokens, passwords or credentials). PostgreSQL refuses `UPDATE` and `DELETE` on it with a trigger, so the trail is append-only for the application's database role.

Actions recorded:
- **Sign-in:** `auth.google_signup`, `auth.google_login`, `auth.google_login_failed` and `auth.google_login_refused`.
- **Sessions:** `auth.logout`, `auth.logout_all` and `auth.session_revoked`.
- **SysOp:** `auth.sysop_login`, `auth.sysop_login_failed`, `auth.sysop_logout`, `account.sysop_password_changed` and `account.sysop_password_set` (from the console).
- **Profile:** `profile.updated`.
- **Administration:** `admin.user_status_changed`, `admin.role_granted`, `admin.role_revoked` and `admin.sessions_revoked`.

Administrators read the trail newest first in the Administration page, filtered by action prefix.

## Data

Migration `0002_identity`:
- extends `users` with the handle, display name, kind (`player` or `sysop`), status, onboarding, avatar, locale, preferences, the SysOp password hash and the privilege version;
- adds a partial unique index that allows one SysOp;
- adds the email to `external_identities`, which stays private;
- adds `sessions`, `role_grants`, `audit_events` and `login_challenges`.

Timestamps are UTC-aware, and identifiers are UUIDs.

## Not in v0.0.5

- Routing games through the API, seat ownership and controller leases. The inspection view, SysOp's practice games and its any-card test decks are part of that work (v0.0.6).
- Account deletion and data export; moderation reports; content publishing (the roles exist, their tools do not).
- Signing in from the installed PWA (T01's second half arrives with M5).
- A second factor for SysOp, by decision.
