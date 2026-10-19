# ADR-0004 — Web authentication on Better Auth (spike S6)

- **Status:** accepted. Decision: **GO** on Better Auth 1.7.7 for D-13. The one schema gap found by the spike (three `two_factor` columns) was closed by migration `0001_two_factor_lockout`.
- **Date:** 2026-10-15
- **Scope:** plan D-08, D-13, T-05, §7.1 (WS tickets), §8.1–§8.2, §9 (auth tables), §10.2 (web auth), Phase 0 S6 and the server-side auth core of Phase 2 (the UI comes later).
- **Versions:** `better-auth` 1.7.7 (`@better-auth/core` and `@better-auth/drizzle-adapter` 1.7.7), `drizzle-orm` 0.45.4, `better-sqlite3` 13.0.3, Next.js 16.4.0, Node 24.16.0.
- **Code:** `apps/web/lib/auth/` (`auth.ts` Better Auth config and hooks, `gate.ts`, `requirements.ts`, `lockout.ts`, `setup.ts`, `account.ts`, `queries.ts`, `runtime.ts`, `server.ts`), `apps/web/lib/ws-ticket.ts`, `apps/web/lib/config.ts`, `apps/web/app/api/auth/[...all]/route.ts`, `apps/web/app/api/ws/ticket/route.ts`.
- **Evidence:** T0 tests in `apps/web/test/` run Better Auth in-process over a temp SQLite DB with `migrateDb` applied (`auth.test.ts`, `ws-ticket.test.ts`, `setup.test.ts`, `password.test.ts`, `lockout.test.ts`). Behaviours not covered there were checked by reading the installed Better Auth sources.

## Context

D-13 asks for username + password login, optional TOTP that an admin can make mandatory, rate limiting and lockout. T-05 picked Better Auth with the `username`, `twoFactor` and `admin` plugins and the Drizzle adapter, to be validated before Phase 2. S6 checks each requirement: covered by Better Auth, implemented by Termdock, or not possible.

## Schema fit

Better Auth 1.7.7's `twoFactor` plugin declares `verified` (pending vs confirmed enrollment), `failedVerificationCount` and `lockedUntil` (second-factor lockout). Schema v1 lacked them. The adapter's schema check gates every auth request, so even `createUser` failed with `SCHEMA_MISMATCH`, and turning the check off would not help (`/two-factor/enable` always writes `verified`). Migration `0001_two_factor_lockout` added the columns (`verified` boolean NOT NULL default true, `failed_verification_count` integer NOT NULL default 0, `locked_until` timestamp_ms nullable) and the index `two_factor_user_idx`. Everything else fits schema v1 unchanged.

Model and field mapping:

- Adapter: `drizzleAdapter(db, { provider: 'sqlite', schema })`, with `schema` from `@termdock/db`. Drizzle property names are already Better Auth's field names, so **no field remapping** is needed.
- `session: { modelName: 'authSession' }` (table `auth_session`). `user`, `account`, `verification` and `twoFactor` match their default model names.
- Additional user fields declared with `input: false`: `locale` (default `'en'`), `totpRequired`, `mustChangePassword` (default `false`). A user cannot set them through `/update-user`: a truthy value is rejected and a falsy one ignored. Server code (admin `createUser` `data`, the internal adapter) can write them.
- Record ids are UUIDv7 (`advanced.database.generateId`, T-13). Session tokens still come from Better Auth's own random generator; `generateId` does not affect them.

## Per-requirement result

| Requirement | Result | How |
|---|---|---|
| Username login | **Covered** | `username` plugin, `POST /api/auth/sign-in/username`. Usernames are normalized to lowercase. `emailAndPassword` is enabled only because the plugin requires it. `/sign-in/email` is disabled, since it would bypass the per-username lockout. |
| Public sign-up disabled | **Covered** | `disableSignUp: true`, and `/sign-up/email` is disabled outright (404). Users come from admins or first-run setup. |
| Admin creates users, roles admin/user | **Covered** | `admin` plugin (`createUser`, `setRole`, `listUsers`, …). Termdock's `createUserWithTemporaryPassword` adds `mustChangePassword` and optional `totpRequired`. |
| Disable user (`banned`) | **Covered** | `banUser` sets `banned` and deletes the user's auth sessions. A session-create hook rejects banned users at sign-in (403). |
| Session revocation when banned | **Covered + ours** | `getSession` does **not** re-check `banned` on an existing session (a ban written straight to the DB leaves it valid). So the gate rejects banned users (honouring `banExpires`, as session-manager does), and Termdock's Better Auth `hooks.before` answers `403 BANNED_USER` on every non-allowlisted endpoint. Closing open WebSockets at once through `POST /internal/v1/auth-sessions/revoke` belongs to the admin actions (Phase 2 UI); until then the daemon's 60 s revalidation closes them. |
| TOTP + trusted device | **Covered** | `twoFactor` plugin: `enable` (requires the password) → `verify-totp` (sets `verified` and `twoFactorEnabled`). At sign-in Better Auth returns `{ twoFactorRedirect: true }` and sets a 10-minute `two_factor` cookie. `verify-totp` with `trustDevice: true` then sets a 30-day signed `trust_device` cookie. Second-factor lockout: 10 failures → 15 min per account. Plugin rate limit: 3 per 10 s per IP. |
| Forced TOTP enrollment (`totpRequired`, `require_totp`) | **Ours** | The gate holds the user on enrollment while `user.totpRequired` or `instance_settings.require_totp` (`value_json` `true`) is set and `twoFactorEnabled` is false. `/two-factor/disable` answers `403 TOTP_REQUIRED` for such users. |
| Temporary password, forced change (`mustChangePassword`) | **Ours** (Better Auth primitives) | `createUserWithTemporaryPassword` and `setTemporaryPassword` set the flag; `setTemporaryPassword` also revokes the user's sessions. The gate holds the user on the change. An after-hook on `/change-password` clears the flag on success, whether called through the HTTP endpoint or the `changePassword` helper (which also revokes other sessions). A before-hook rejects a new password equal to the current one. |
| Admin TOTP reset | **Ours** | Not in the admin plugin. `resetUserTotp` (admin only) deletes the `two_factor` row, clears `two_factor_enabled` and deletes the user's `trust-device-*` verification rows, all in one transaction. If TOTP is required, the gate forces a new enrollment. |
| Lockout per (username, IP), progressive delay | **Ours** | Better Auth's limiter keys on `IP|path` only. `LoginLockout` (`lib/auth/lockout.ts`) counts 401 results of `/sign-in/username` per (lowercased username, client IP). 5 failures → 30 s lock, doubling per further failure, capped at 15 min, cleared on a correct password. A locked attempt is rejected before the password check (`429 SIGN_IN_LOCKED` with `Retry-After`) and does not extend the lock. A lock is logged at WARN. It is never a global lock, so another IP still signs in (tested). Unknown usernames are locked the same way (no enumeration signal). State is **in memory**: one web instance in the MVP, pairs forgotten after 1 h quiet, at most 10 000 tracked pairs. |
| argon2id hashing | **Covered (hook) + ours** | `emailAndPassword.password.{hash, verify}` replaces scrypt on every path: sign-in (including the dummy hash for unknown users), admin create/set-password, change-password and the password check in `/two-factor/enable`. `packages/shared/src/password.ts` (in `apps/web/lib/auth/` until session-manager's reset-password CLI needed it, plan D-36) uses Node's `crypto.argon2` with OWASP's minimum argon2id parameters (m = 19 MiB, t = 2, p = 1; about 0.1–0.2 s here). Hashes are PHC strings, so parameters can rise later without breaking old hashes. Out-of-bounds stored parameters are a mismatch, never a CPU sink. |
| Client IP from the proxy | **Covered** | `ipAddressHeaders: ['x-forwarded-for']`. Without `trustedProxies`, Better Auth trusts only a single-value header. Caddy (≥ 2.5) overwrites the header with the peer address unless the peer is a trusted proxy, so behind Caddy it always has one value. **Assumption:** web is reachable only through Caddy (compose network `edge`, §4.3). Anyone who reaches `web:3000` directly can spoof the IP, which weakens the lockout and the limiter. |
| Cookies `HttpOnly; Secure; SameSite=Strict` | **Covered (config)** | The default is `Lax`. Termdock sets `defaultCookieAttributes: { httpOnly, secure, sameSite: 'strict' }`, `useSecureCookies` and `cookiePrefix: 'termdock'`, giving `__Secure-termdock.session_token=…; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Strict` (tested). |
| 7-day sliding session | **Covered** | `expiresIn` 7 days, `updateAge` 1 day. `cookieCache` stays off, so every check reads `auth_session` and revocation is immediate. |
| Rate limiting | **Covered (config)** | Better Auth enables its limiter only in production; Termdock sets `rateLimit.enabled: true` (memory storage; sign-in 3 per 10 s per IP). |

Not possible: nothing among the S6 requirements.

## Termdock additions

- **Auth gate** (`authGate` in `lib/auth/gate.ts`, `requireSession` in `lib/auth/server.ts`). Every page, Server Action and route handler uses it. Results, in order:
  - no session → `/login`, or `/setup` while no user exists
  - banned → `/login`
  - pending password change → `/login/change-password`
  - pending TOTP enrollment → `/login/enroll-totp`
  - otherwise the user and auth session

  A page that serves a requirement passes `allow: [requirement]`. The route names live in `AUTH_ROUTES`, so the UI phase can rename them in one place.
- **Better Auth path allowlist.** `/api/auth/*` is reachable with the session cookie, so a global `hooks.before` serves only these paths while a requirement is pending: `/get-session`, `/sign-out`, `/change-password`, `/two-factor/enable`, `/two-factor/verify-totp` (also the normal second sign-in step, which has no session) and `/two-factor/get-totp-uri`. `/sign-in/username` is allowed too, so the user can sign in again. Everything else answers `403 AUTH_REQUIREMENT_PENDING` (tested on `/list-sessions`).
- **Disabled Better Auth paths:** `/sign-in/email`, `/sign-up/email`, `/admin/impersonate-user`, `/admin/stop-impersonating`. Impersonation would let an admin mint WS tickets as another user and drive their terminals, which contradicts D-08 isolation.
- **First-run setup token** (`lib/auth/setup.ts`). While no user exists, a 192-bit token is generated and logged once at WARN with the setup URL. Only its SHA-256 stays in memory; the test checks that the token appears neither in the DB nor in its WAL file. `complete(token, { username, email, password })` checks the token in constant time, creates the first admin through the admin plugin's server-side `createUser`, then closes setup. No token is ever generated once a user exists, even after a restart. A failed attempt (bad input) keeps the token usable; concurrent attempts are refused (`CONFLICT`). The token is generated when the auth runtime is first built. For a token at boot, `apps/web/instrumentation.ts` should call `getAuthRuntime()` (for the `nodejs` runtime only); that file is outside this change.
- **WS ticket issuer** (`lib/ws-ticket.ts`, `POST /api/ws/ticket`; other methods get 405). `Origin` must equal TERMDOCK_PUBLIC_URL's origin, else 403. Then the gate runs: no session or a banned user → 401; pending password change or TOTP enrollment → 403. On success it returns `{ ticket, expiresAt }` from `signTicket(wsSecret, { uid, asid })`. Every response carries `Cache-Control: no-store`. The key is TERMDOCK_WS_SECRET_FILE's trimmed content as UTF-8 bytes, as in session-manager; a test verifies the ticket with the daemon's derivation and rejects its replay.
- **Server-only boundary.** `server-only` is not a dependency, but Next declares its types and aliases it in the bundler. So `lib/auth/server.ts`, the only module that builds the process-wide runtime, imports it. Modules shared with tests import a runtime guard (`lib/server-guard.ts`). The runtime lives on `globalThis` (Next may load a module once per bundle layer) and is built lazily, so `next build` needs no secrets.
- **Config** (`lib/config.ts`, zod): `TERMDOCK_PUBLIC_URL`, `TERMDOCK_DATA_DIR` (default `/data`, DB at `app.db`), `BETTER_AUTH_SECRET_FILE`, `TERMDOCK_WS_SECRET_FILE`, `TERMDOCK_INTERNAL_URL`, `TERMDOCK_INTERNAL_TOKEN_FILE`. Secrets are trimmed file contents of at least 32 characters. `telemetry` is off.

## Other findings

- **TOTP codes can be replayed within their window.** Better Auth accepts the current code ±1 period (about 90 s) and does not record used codes. An attacker needs the password plus a freshly observed code, so this is accepted for the MVP. If it matters later, a small used-code cache keyed by (user, counter) closes it.
- **Enrollment rotates the auth session.** `verify-totp` during enrollment (and `enable`/`disable` in some modes) creates a new auth session and deletes the old one, so `asid` changes. Tickets are minted afterwards, so this is harmless.
- **Banned accounts confirm a correct password.** Better Auth rejects a banned user (403) only after the password verifies, so a 403 tells the caller the password was right. The account is disabled anyway, so this is accepted.
- **The per-IP sign-in limiter is shared across usernames.** Better Auth's default rule (3 sign-ins per 10 s per IP) can trip for several users behind one NAT or VPN egress. It can be tuned with `rateLimit.customRules` if that happens.
- **Users can rename themselves.** The username plugin lets a user change their own `username` through `/update-user`. That doesn't weaken the lockout, but if admins should own usernames, set `immutableUsername` or fence the field (open question).
  - **Update (2026-10-16):** settled. Admins own usernames: `apps/web/lib/auth/auth.ts` configures `username({ immutableUsername: true })` (since the auth core landed on 2026-10-15), so users cannot rename themselves ([security model](../security.md#authentication)).

## Decision

**GO** on Better Auth 1.7.7 for D-13 with migration 0001 applied. Better Auth supplies:

- username login
- TOTP with a trusted device
- admin user management and `banned`
- session storage and revocation
- per-IP rate limiting
- argon2id through its hash hooks

Termdock adds:

- the per-(username, IP) progressive lockout (in memory)
- the forced password change and forced TOTP enrollment
- the admin TOTP reset
- the auth gate, with the Better Auth path allowlist and the `banned` re-check
- the disabled paths
- the first-run setup token
- the WS ticket issuer

## Risks

- Better Auth evolves quickly (1.7 added the three 2FA columns). Any upgrade must be followed by the schema check, which the T0 auth tests exercise because the auth instance initializes against the migrated schema.
- The lockout is in memory and the limiter works per instance. Both are fine for a single web instance; revisit if web is scaled out. A restart clears the lockout counters.
- IP-based controls trust `X-Forwarded-For`, so they are only as strong as the "only Caddy reaches web" network rule.
- A compromised web process can still mint tickets (plan §10.1). Nothing here changes that.
