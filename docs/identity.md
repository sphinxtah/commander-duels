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

## Before the app: the landing page (v0.3.0)

Asked for by the owner on 2026-10-20 ([the plan](plans/0.3.0.md#added-during-v030-the-sign-in-landing-page)). Nothing of the app is drawn or asked for until the account is active.

**A visitor who is not signed in** sees the landing page at every address:
- **What it shows.** The owner's wordless CD mark (the favicon's, `/brand/mark.webp`, with 2x and 3x copies for high-density screens and phones) in the middle of the window, and the Google sign-in button below it. There are no words above the button, and none of the app: no sidebar, navigation, top bar, version, banner art, footer, Fan Content notice, install banner or update notice. A heading that only screen readers hear, "Sign in", names the page; the mark is decorative.
- **What it says.** Anything the page must say comes below the button, small: a refused sign-in, an unreachable service with Try again, sign-in not set up on the server, "Signing you in…", and after a sign-out "You signed out." (or why the other sessions could not be ended). While the page checks the sign-in or loads Google's script, it shows the mark alone and says so to screen readers only. The old Profile sign-in's note on what Google shares, and its line on approval, are gone with it.
- **A service that does not answer.** A proxy may hold a stalled request for an hour, so the page gives each of its first questions (the bootstrap and formats, the account, SysOp's entrance) 7 seconds. Past that the service counts as unreachable: the page offers Try again, or the sign-in button when only the account check stalled, never the mark alone with nothing to press.
- **Focus.** When what the page shows changes after it has loaded (a sign-in that must wait, an approval, a refusal found on a check, a sign-out from Profile or from the wait), focus moves to the new heading, as following a link does, so a screen reader says where the page went.
- **The address is kept** (T01), so the screen it names opens after sign-in and approval. This replaces v0.0.5's return to the intended screen, which went through Profile. A `#game/<id>` address never opens the table or its WebSocket before then. A session that ends while the table is open (it expired, or Sign out everywhere ended it from another browser) shows the landing page in the table's place when the page next checks the account, as on coming back online; the table's full screen ends, and an update waiting for the game to end applies, as on leaving the table.
- **SysOp's entrance.** `#sysop` stays unlinked. On SysOp's networks it shows the SysOp password form under the mark, and Administration opens after it as before; off them it is the landing page like any address. Nothing shows at `#sysop` until the server has said which; a check that has not answered in 7 seconds counts as off them.

**An account waiting for approval** (`pending`) sees only a plain page under the mark: "Your account is waiting for approval.", its email address, Check again and Sign out. It chooses its handle on Profile once approved. Approval opens the address it was given, rarely Profile, so until it has a handle every other page starts with a line pointing to Profile, and the sidebar says "Choose your handle" where it would say "Signed in".
- The page asks `GET /api/v1/me` again every minute while it is shown, whenever the window regains focus or is shown again, and on Check again. So an approval opens the app, at the address it was given, without a reload. A hidden page waits, and a sign-out under way has the last word. A check gives up after 7 seconds, so a stalled one never holds off the next.
- **A denied account**, or any other that is not active, sees "Your account was not approved." and "Contact the operator of this server if you think this is a mistake.", its email address and Sign out.

**Nothing is asked for.** The API refuses pending and denied accounts their data (403). Before the account is active, the page asks only for the bootstrap, the formats, `/api/v1/me`, a sign-in challenge and SysOp's entrance check; no page of the app is drawn, so none asks for decks, cards, games or sessions.

## Google sign-in (AUTH01–AUTH05)

**Primary flow.** Google Identity Services' ID-token flow with a JavaScript callback (`ux_mode: popup`, FedCM for the button where Chrome supports it). The authorization-code redirect flow is not used.

1. The sign-in page (the Profile page before v0.3.0, [the landing page](#before-the-app-the-landing-page-v030) since) asks `POST /api/v1/auth/google/start`. The server creates a sign-in challenge:
   - the browser gets a random secret in the `cd_google` cookie (HttpOnly, Secure, SameSite=Strict, path `/api/v1/auth/google`, 10 minutes);
   - the server keeps only the nonce, which is the secret's SHA-256 hash.
2. The page loads Google's script and initializes it with the client ID and that nonce. Google signs the nonce into the ID token.
3. Google's callback hands the page the ID token, and the page posts it to `POST /api/v1/auth/google`.
4. The server verifies it and consumes the challenge:
   - **Verification.** Google's `google-auth` library checks the signature against Google's published certificates (fetched with httpx, cached for their `max-age`), the audience (our client ID), the issuer and the expiry, with 10 seconds of clock skew.
   - **The nonce.** The server checks that the token's nonce is the hash of the presented cookie.
   - **The challenge.** It consumes the challenge with a conditional update, so it works once.

**Renewing the challenge** (since v0.1.1). The page renews an idle challenge after 9 minutes, measured by the wall clock, because timers stop while a computer or phone sleeps but the challenge keeps ageing. It checks every 15 seconds, when the page regains focus or is shown again, and when the pointer or keyboard reaches the button, so a device that slept renews before use.
- **Hidden tabs.** A hidden tab does not renew. Showing it again renews at once if the challenge is old.
- **A sign-in under way.** A new challenge replaces the `cd_google` cookie that Google's answer is checked against, so the page never renews while the server checks an answer. After the button is pressed, the 9-minute renewal also waits while a sign-in may be under way: for 2 minutes after the press, or while the page lacks focus, as it does while Google's pop-up has it. Google reports nothing when its window is closed without signing in, so an older press counts as given up once the page has focus again. A pressed challenge past its 10 minutes is replaced regardless.
- **After a failed sign-in.** A refusal or a network failure leaves the challenge spent or doubtful, so the page asks Google again with a new one.

This pair, the cookie and the nonce inside the signed token, is this flow's CSRF and replay protection (AUTH02). Google's own `g_csrf_token` double-submit belongs to its redirect mode, which posts to the server directly; with a callback, the page posts. The protection holds in each case:
- **A stolen token** fails without the matching cookie.
- **A replayed token** finds its challenge consumed.
- **Another site** cannot complete a sign-in. It cannot read the cookie or choose the nonce, and the Origin check refuses its request anyway.

**Accounts.**
- The account is keyed by issuer and Google's stable `sub`, never by email. A changed email address updates the private record, with no duplicate account.
- Google establishes identity only (AUTH04). No Google scopes beyond the ID token's own are requested, and nothing grants roles automatically.
- A first sign-in creates the internal UUID and an account with the Google display name. The player then chooses a unique handle: 3–20 letters, digits, hyphens or underscores, case-insensitively unique, with names such as `sysop`, `admin` and `site-administrator` reserved.
- Avatars are one of eight built-in symbols, so no remote image is ever fetched.
- The profile also holds the display name, locale, onboarding state and the accessibility preferences, which follow the account across devices.
- Email and the Google subject are private:
  - The subject is never returned.
  - Email goes to its owner, and to administrators (`admin.users.manage`), who need it to identify accounts they approve. Moderators see the account list without email and cannot search by it.

**Failures.**
- **Without a challenge.** A post without one of our challenges (no `cd_google` cookie, or a cookie for a challenge the server never issued) is refused 401 `invalid_sign_in` without an audit entry, so a bot cannot fill the trail.
- **Every attempt with a live challenge spends it,** whatever the outcome; only a Google outage leaves it for a retry. So each recorded failure costs the client a new `/auth/google/start`, which the page asks for anyway.
- **A refused token** returns 401 `invalid_sign_in`, records `auth.google_login_failed` with a reason (`invalid_token`, `nonce_mismatch`, `challenge_used_or_expired`) and creates no session (T02). A malformed token header, such as a list-valued `kid` or `alg`, is an ordinary `invalid_token`.
- **A spent or expired challenge** is recorded as `challenge_used_or_expired` only for a token Google signed for that very challenge, such as a replay. Anything else on a spent challenge is refused unrecorded.
- **Too many failures.** After 10 recorded failures from one address in 15 minutes, further failures from it return 429 `too_many_attempts` and are not recorded. A genuine sign-in from that address still works. The count is per exact address, which suits the IPv4-only site; if it ever serves IPv6, sources must be counted by /64.
- **Two first sign-ins at once** of one Google account: the second gets 409 `sign_in_conflict`, which asks the player to try again.
- **Google being unreachable** returns 503 `provider_unavailable`. It is never counted as a failure, so it is reported even to an address at its limit, and the challenge stays unspent.
- **On the page.** A cancelled or denied Google prompt simply never calls back. A network failure while posting Google's token shows the service-unavailable message, and the page asks Google again with a new challenge.
- **Not set up.** Without `CD_GOOGLE_CLIENT_ID`, sign-in reports `sign_in_unavailable` and the page says the server is not set up. Until the bootstrap loads, the landing page tells screen readers that sign-in is being prepared; if the service did not answer, it says so below the mark, with a Try again button.

**Challenge limits.** The web container lets each visitor address ask for 10 challenges a minute (`POST /api/v1/auth/google/start`), after a first burst of 20, because each one is a database row. Past that it answers 429 with the API's error shape (`too_many_attempts`). It keys on `X-Forwarded-For`, which on the live site only the TSH proxy sets, to the visitor's address alone; requests without the header (local runs, the browser tests) are not limited. Challenges are deleted a day after they expire.

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
  - Every role or status change raises the account's privilege version. The account's next request swaps its session for a new identifier, with the same sign-in time, limits and CSRF token.
  - **The new cookie** (since v0.1.1) is sent on every response to the request that rotated the session, errors and empty responses included. The correlation middleware adds it, so no route copies it, except when the response sets or clears the session cookie itself: sign-out, sign-out everywhere, ending the current session, a new sign-in, or SysOp's password change.
  - **The old token's grace.** For 60 seconds the old token still signs requests in, as the newest session in its chain. This covers requests the browser sent before it read the new cookie. Rotation keeps the CSRF token, and that token, which sessions never otherwise share, links the old session to the new one. Such a request sets no cookie and never rotates the session it stands for, even if that session is itself due for rotation. Only the new cookie's own next request rotates it, so a stale token can never mint a fresh session.
  - **The grace ends** as soon as the chain has no live session: sign-out, sign-out everywhere, an administrator's sign-out, a new sign-in that replaces the session, or SysOp's password change, which issues a new CSRF token. A disabled account is refused by the status check, as always.
  - **No late clearing.** A rotated token is never answered with the cookie-clearing header, so a late response cannot erase the new cookie. The exception is when the session it stands for is itself unusable: expired, its account disabled, or a SysOp session used from off its network. The 401 then clears the cookie, as it would for that session's own token.
  - **A bug's 500.** Starlette answers an unhandled exception outside every middleware. The API's handler for it adds what the correlation middleware would: the rotated cookie, the request ID and the usual headers. It also gives the 500 the usual error shape, `internal_error`, with no details. Starlette then re-raises the exception, so the server still logs it.
- **Ending sessions.**
  - Sign out ends this session.
  - *Sign out everywhere* ends all of the account's sessions.
  - The Profile page lists the active sessions and ends any one of them.
  - **On the page** (since v0.1.1):
    - The page shows the signed-out screen only when the server confirms. A 401 also counts, because the session had already ended. Any other refusal, or a network failure, shows the error and keeps the account. Since v0.3.0 the signed-out screen is the landing page, which says "You signed out." below its button, at the same address.
    - While a sign-out is pending, further presses of Sign out and Sign out everywhere are ignored: a second request would find the session already ended.
    - *Sign out everywhere* from a session that had already ended says the account's other sessions could not be ended from this browser.
    - On `csrf_failed` (another tab signed this browser in since the page loaded), the page refreshes its token from `/api/v1/me` and tries once more. If the browser now holds another account, the page shows that account and asks to sign out again. After *Sign out everywhere* it also says the first account's sessions were not ended, and that ending them means signing in as that account and choosing *Sign out everywhere*.
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
- They cannot change administrators, SysOp or their own account. This holds whatever the administrator's status: grants survive a disable, so only SysOp can restore, deny, sign out or change the lesser roles of an account holding an administrator grant. The account list reports a disabled, pending or denied account's dormant grants in `roles` (without `player`, which only active accounts hold), so the Administration page locks the row.
- The account search matches the handle, the display name and, for administrators only, the email, as written: `%`, `_` and `\` are literal, and names and email compare without regard to case.
- The first administrator is not configured separately (AUTH06): SysOp is the configured bootstrap, and only SysOp makes or removes administrators. No Google account ever becomes an administrator by signing in.

**Pending and denied accounts.**
- In approval mode, a new account is `pending` until approved. It can sign in, see its state and change its own profile, and nothing more. Since v0.3.0 the page offers the handle only once the account is approved ([what it sees](#before-the-app-the-landing-page-v030)); the API still accepts one before.
- A denied account sees that it was not approved.
- A disabled account cannot sign in.

**SysOp-only permissions.**
- Three permissions belong to SysOp alone, and no role can be granted them: `admin.roles.administrator`, `games.view_concealed` and `cards.any`.
- The last two took effect in v0.0.6 ([games through the API](games.md#sysops-powers)):
  - **Inspection.** SysOp's view of every hand and library, in any running game, audited at every opening.
  - **Any card.** Deck lists naming any card in the engine's card database, on SysOp's practice games.
- Administrators and moderators keep SEC05's and NET14's restrictions: there is no "view all live hands" for them.

**Errors** follow the scope's rules:
- 401 when signed out;
- 403 when the account lacks the permission or is pending or denied;
- 404, identical to a missing path, for SysOp or another account's session;
- 409 for conflicts such as a taken handle or a change to your own account;
- 422 `invalid_request` for input the contract does not allow. That includes a NUL character in a display name, a status reason, the account search or the audit filter, which PostgreSQL cannot store.

## SysOp, the local root account

SysOp copies Kingdom Connect's root account:
- **Username.** Always `sysop`.
- **Its own entrance.** The browser opens `#sysop`. The API's `/api/v1/sysop/*` routes exist only for clients in `CD_SYSOP_NETWORKS`. Everywhere else they answer exactly like a path that does not exist, and the page looks like any unknown address. They are left out of the published OpenAPI document.
- **Password.** Argon2id (argon2-cffi's current parameters, rehashed on sign-in when they change), at least 12 characters.
  - It is set only from the server console, never through the interface.
  - SysOp can change it in the Profile page by giving the current one.
  - Setting or changing it ends every SysOp session.
- **Lockout.** Five failed attempts from one address in 15 minutes lock that address out until the window passes.
  - Failed attempts are sign-ins, and wrong current passwords on the Profile page's password change.
  - A success at that address (a sign-in or a password change) clears its count. Setting the password from the server console clears every address's count, as the 429 message says.
  - Attempts are checked one at a time, so a burst of guesses cannot outrun the count.
  - A missing account costs the same time as a wrong password.
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
- On the live site ([the live site](deployment.md), since v0.1.0):
  - SysOp's network is the home LAN, 10.10.1.0/24. The UniFi hairpin keeps LAN addresses, so SysOp signs in through the public name.
  - The trusted proxies are the TSH nginx proxy (10.10.50.2) and the web container. The proxy replaces `X-Forwarded-For`, and the web container appends the proxy's address.
  - The entrance is re-tested from outside the network at each version: it must answer *not found*.
  - Sign-up needs approval (`CD_SIGNUP_POLICY=approval`); SysOp approves every account until the site opens to the public at v1.0.0.

## Audit trail

`audit_events` records the time, actor, action, target account, source address, request ID and small details (never tokens, passwords or credentials). PostgreSQL refuses `UPDATE` and `DELETE` on it with a trigger, so the trail is append-only for the application's database role.

Actions recorded:
- **Sign-in:** `auth.google_signup`, `auth.google_login`, `auth.google_login_failed` and `auth.google_login_refused`.
- **Sessions:** `auth.logout`, `auth.logout_all` and `auth.session_revoked`.
- **SysOp:** `auth.sysop_login`, `auth.sysop_login_failed`, `auth.sysop_logout`, `account.sysop_password_changed` and `account.sysop_password_set` (from the console).
- **Profile:** `profile.updated`.
- **Administration:** `admin.user_status_changed`, `admin.role_granted`, `admin.role_revoked` and `admin.sessions_revoked`.

Administrators read the trail newest first in the Administration page, filtered by action prefix, without regard to case. A player without a handle appears as `<display name> (no handle, <first 8 characters of its id>)`, so no player can pass for the Site administrator or another player.

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
