# Step 1 — Login: passwordless OTP + sessions

**Status:** ✅ BUILT (2026-08-26). All modules under `mobile/server/`, tests in
`mobile/test/mobile.smoke.js` (18 unit + HTTP regression), wired into `npm test`.
Existing suite still green (44 unit + 46 http) — with a small hermeticity fix so
`test/smoke.js` pins `ADMIN_USER`/`ADMIN_PASSWORD`/`EXTERNAL_URL` off (a populated
`.env` had been leaking them in via dotenv).

**Live-verified 2026-08-26:** switched to the **Brevo SMTP relay** (`nodemailer`) —
the key on hand was an SMTP key, not a REST key. Real OTP emails delivered via
`smtp-relay.brevo.com` (verify ~1.5s, send ~2.3s), so the send is now
**fire-and-forget** (see the issue flow) to keep login instant.

**Depends on:** nothing (foundation). **Unlocks:** every other step.

## Goal

A family member enters the email on their profile, receives a one-time code by
email (via Brevo), and is signed in. The session is bound to exactly one profile,
so from that point on the app can **only** ever read/write that profile's data.

- OTP is **6-digit numeric, single-use, valid for 1 hour**, then invalid.
- Email is the **unique identifier** — **strict 1:1** with a profile.
- **A user can never see another user's recommendations** — enforced by the
  server binding the session to a `profile_id`, never trusting a client-supplied id.

---

## Design

### New routes (in `mobile/server/router.js`, mounted at `/mobile`)

| Method & path | Auth | Body / query | Response |
|---|---|---|---|
| `POST /mobile/api/auth/request` | none | `{ email }` | `200 { ok: true }` **always** (generic — no account enumeration) |
| `POST /mobile/api/auth/verify` | none | `{ email, code }` | `200 { ok, profile:{ id, name } }` + `Set-Cookie: mobile_sid` / `401 { error }` |
| `POST /mobile/api/auth/logout` | session | — | `200 { ok }` (revokes session) |
| `GET  /mobile/api/me` | session | — | `200 { profile:{ id, name, simkl_connected } }` |

`request` **always** answers `200 { ok: true }` regardless of whether the email
matches — the code is only generated and sent when exactly **one** profile
matches. This prevents probing which emails are registered.

### Storage (`mobile/server/otpStore.js`, via `db.get()`)

Two tables in the existing `store.db` (created idempotently, same pattern as
`recommendationStore.init()` in [src/recommendationStore.js:71](../../src/recommendationStore.js)):

```sql
CREATE TABLE IF NOT EXISTS mobile_otp (
  id          TEXT PRIMARY KEY,     -- random id
  email       TEXT NOT NULL,        -- normalised (trim + lowercase)
  profile_id  TEXT NOT NULL,        -- resolved at issue time (1:1)
  code_hash   TEXT NOT NULL,        -- sha256(code) — NEVER the plaintext code
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,     -- created_at + 3_600_000 (1 hour)
  used_at     INTEGER,              -- set on successful verify → single-use
  attempts    INTEGER DEFAULT 0     -- wrong-code guesses; invalidate after MAX_ATTEMPTS
);
CREATE INDEX IF NOT EXISTS ix_otp_email ON mobile_otp (email);

CREATE TABLE IF NOT EXISTS mobile_session (
  token_hash  TEXT PRIMARY KEY,     -- sha256(token) — the raw token only lives in the cookie
  profile_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,     -- created_at + MOBILE_SESSION_DAYS
  last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sess_profile ON mobile_session (profile_id);
```

Both the OTP code and the session token are stored **hashed** — a leaked DB
backup cannot be used to log in. This mirrors how the codebase already treats
secrets (sealed at rest, admin password compared via `crypto.timingSafeEqual`).

### Issue flow (`auth.requestOtp`)

1. Normalise email (`String(email).trim().toLowerCase()`).
2. `const matches = config.listProfiles().filter(p => (p.email||'').trim().toLowerCase() === email)`.
3. **Strict 1:1 branch:**
   - `matches.length === 1` → generate code, store hashed, send email.
   - `matches.length === 0` → do nothing (generic 200).
   - `matches.length > 1` → **config error**: do nothing, `console.warn('[mobile] email X maps to N profiles — refusing OTP')`, generic 200.
4. Rate limit per email (sliding window, same idea as
   [src/server.js:73](../../src/server.js) `authFailures`): max `MAX_REQUESTS` =
   5 / 15 min. Over the limit → generic 200, no send (the caller can't tell).
   *(Built per-email; per-IP limiting is a noted future hardening — the router
   would pass `req.ip` into `requestOtp`.)*
5. Code = `String(crypto.randomInt(0, 1_000_000)).padStart(6,'0')`.
6. Purge this email's prior unused OTPs (one live code at a time).
7. Send via `mail.sendOtpEmail({ to, code, ttlMinutes: 60 })` **fire-and-forget**
   (not awaited): the code is already stored, so the response never waits on the
   ~2s SMTP send, and match/miss take about the same time (no enumeration by
   timing). Send failures are logged; the user can request a resend.

### Verify flow (`auth.verifyOtp`)

1. Normalise email; look up the newest non-expired, unused OTP for that email.
2. No row / expired → `401`.
3. `attempts >= MAX_ATTEMPTS` (e.g. 5) → invalidate (set `used_at`), `401`.
4. `sha256(code) !== code_hash` → `attempts++`, `401`.
5. Match → set `used_at = now` (**single-use**), create a session:
   - `token = crypto.randomBytes(32).toString('hex')`.
   - Store `sha256(token)` with `profile_id`, `expires_at = now + days`.
   - `Set-Cookie: mobile_sid=<token>; HttpOnly; Secure; SameSite=Lax; Path=/mobile; Max-Age=<days>`.
6. Respond `{ ok:true, profile:{ id, name } }`.

### Session guard (`auth.requireSession` middleware)

- Read `mobile_sid` cookie (parse without adding a dep — a tiny cookie reader, or
  `req.headers.cookie` split; Express 5 has no built-in cookie parser and we're
  avoiding new deps).
- `row = sessionByHash(sha256(token))`; missing or `expires_at < now` → `401`.
- Load the profile: `req.profile = config.getProfile(row.profile_id)`; gone → `401` + delete session.
- Touch `last_seen_at` (optionally slide `expires_at`).
- `next()`.

**This middleware is the isolation guarantee.** Every route in Steps 3–4 sits
behind it and uses `req.profile.id`. No handler ever reads a profile id from the
request body or query.

### Mail client (`mobile/server/mail.js`)

Sends over Brevo's **SMTP relay** (`smtp-relay.brevo.com`) via `nodemailer`
(decided 2026-08-26 — the Brevo key on hand is an SMTP key, `xsmtpsib-…`).

```js
// Brevo SMTP relay via nodemailer. Config from ENV (login/key/host/port/from).
async function sendOtpEmail({ to, code, ttlMinutes = 60, appUrl = '' }, send = defaultSend) {
  if (!mailConfigured()) {       // needs login + key + a From address
    console.log(`[mobile] (mail not configured) OTP for ${to}: ${code}`);
    return { sent: false, dev: true };
  }
  const msg = buildOtpMessage({ to, from: MOBILE_MAIL_FROM, ..., code, ttlMinutes, appUrl });
  const info = await send(msg); // defaultSend = transporter().sendMail(msg)
  return { sent: true, id: info?.messageId };
}
```

- `buildOtpMessage(...)` is **pure** (returns the nodemailer message: `{from,to,
  subject,text,html}`) → unit-tested without sending.
- `send` is injectable (default: the SMTP transporter's `sendMail`); tests pass a
  fake, so they stay offline. `verifyTransport()` checks connection + auth with
  no send (nodemailer `transporter.verify()`) — used for the credential test.
- ENV: `BREVO_SMTP_LOGIN` (username), `BREVO_SMTP_KEY` (password; `BREVO_API_KEY`
  alias), `BREVO_SMTP_HOST` (default `smtp-relay.brevo.com`), `BREVO_SMTP_PORT`
  (default `587`; `465` = implicit TLS).
- Governor: email is one-off and low-volume; no governor slot needed (unlike
  Simkl/TMDB).

### Implementation checklist

- [x] `mobile/server/otpStore.js` — table DDL + `insertOtp/newestUnusedOtp/markOtpUsed/incOtpAttempts/purgeUnusedOtps`, `insertSession/sessionByToken/touchSession/deleteSession`, `pruneExpired`.
- [x] `mobile/server/mail.js` — `buildOtpMessage` (pure) + `sendOtpEmail` (injectable send) + `verifyTransport` + nodemailer SMTP transporter.
- [x] `mobile/server/auth.js` — `requestOtp`, `verifyOtp`, `resolveSession`, `logout`; email normalisation; per-email rate limiter; all time via injected `nowMs`.
- [x] `mobile/server/router.js` — the four routes + `requireSession` guard + cookie helpers.
- [x] Mount in [src/server.js](../../src/server.js): `app.use('/mobile', require('../mobile/server/router').router)` (before admin auth).
- [x] Add `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`, `BREVO_SMTP_HOST`, `BREVO_SMTP_PORT`, `MOBILE_MAIL_FROM`, `MOBILE_MAIL_FROM_NAME`, `MOBILE_SESSION_DAYS`, `MOBILE_INSECURE_COOKIE` to `.env.example` + `docker-compose.yml`.
- [x] Prune expired OTPs/sessions on the existing hourly tick ([src/server.js](../../src/server.js)).
- [x] `mobile/test/mobile.smoke.js` + `npm test` / `npm run test:mobile` wiring.

> **Note:** `requireSession` lives in `router.js` (exported for reuse by Steps
> 3–4), not `auth.js` — `auth.js` exposes the transport-agnostic `resolveSession`
> that the middleware wraps. Same split as the rest of the app (logic vs wiring).

---

## Unit tests (`mobile/test/mobile.smoke.js`)

Pure/offline. Inject `nowMs` and a fake mail transport. Each is one `ok(...)`.

1. **`otp: code is 6 numeric digits`** — `generateCode()` returns `/^\d{6}$/`.
2. **`otp: code stored hashed, never plaintext`** — after `requestOtp`, the
   `mobile_otp` row's `code_hash` ≠ the code and equals `sha256(code)`.
3. **`otp: single-use`** — `verifyOtp(email, code)` succeeds once; a second call
   with the same code → `{ ok:false }` (row `used_at` set).
4. **`otp: 1-hour expiry`** — issue at `t0`; `verifyOtp` at `t0 + 61*60_000` →
   fails; at `t0 + 59*60_000` → succeeds (inject `nowMs`).
5. **`otp: wrong code fails, attempts invalidate after MAX`** — 5 wrong guesses
   then the correct code → fails (locked out); a fresh request re-enables.
6. **`otp: strict 1:1 mapping`** — seed one profile with `email:'a@x'`:
   `requestOtp('a@x')` writes exactly one row; `requestOtp('none@x')` writes zero;
   two profiles sharing `dup@x` → zero rows + returns generic ok (config error).
7. **`otp: email match is case/space-insensitive`** — `'  A@X.com '` matches
   profile `email:'a@x.com'`.
8. **`otp: one live code per email`** — a second `requestOtp` purges the first
   code (old code no longer verifies).
9. **`session: verify creates a session bound to the right profile`** — after
   `verifyOtp`, `requireSession` with the issued token resolves `req.profile.id`
   to the issuing profile.
10. **`session: token stored hashed`** — the `mobile_session` row's `token_hash`
    ≠ the cookie token and equals `sha256(token)`.
11. **`session: expiry`** — a session past `expires_at` → guard rejects (401).
12. **`session: logout revokes`** — after `logout`, the token no longer resolves.
13. **`isolation: a session for profile A never resolves to B`** — two profiles,
    two sessions; each token resolves only to its own `profile_id` (the core
    security property, asserted directly).
14. **`mail: buildOtpMessage shape`** — pure builder returns the nodemailer
    message `{ from:{name,address}, to, subject, text, html }` with the code and
    "60 minutes" present in the text and the correct sender.
15. **`mail: unconfigured → dev log, no send`** — `sendOtpEmail` with the SMTP
    env unset returns `{ sent:false, dev:true }` (fake send not called). A second
    case sets the SMTP env and asserts the configured branch builds the message
    and calls `send`.
16. **`rate limit: N+1 request in-window is suppressed`** — after `MAX_REQUESTS`
    within the window, the next `requestOtp` sends nothing; after the window it
    sends again.

---

## Regression tests

Guard the existing app — these assert nothing that already works has moved.

1. **`regression: admin /api still requires Basic Auth`** — a request to a
   portal route without credentials still returns `401` (the mobile mount didn't
   loosen it).
2. **`regression: mobile auth routes need NO Basic Auth`** — `POST
   /mobile/api/auth/request` is reachable without admin credentials (it lives
   outside the `/api` auth middleware).
3. **`regression: data routes need a session`** — any `/mobile/api/*` data route
   without a valid `mobile_sid` returns `401` (no accidental open door).
4. **`regression: new tables don't disturb existing ones`** — after
   `otpStore.init()`, the existing `watchedStore` / `recommendationStore` smoke
   assertions still pass against the same `store.db`.
5. **`regression: profile shape unchanged`** — `config.addProfile('X')` still
   produces the documented shape incl. the `email:''` field; `updateProfile({email})`
   still trims and stores (already covered by [test/smoke.js](../../test/smoke.js)
   `config: profile CRUD` — re-assert the email path).
6. **`regression: boots with mail unconfigured`** — the router loads and the
   server starts with no SMTP env (degrades to log-only), no throw.
7. **`regression: route table has no collisions`** — `/mobile`, `/api`,
   `/addon/:token`, `/configure`, `/health` all resolve to their own handlers.

## Acceptance criteria

- Entering a valid profile email delivers a 6-digit code within seconds; entering
  it signs the user in for `MOBILE_SESSION_DAYS`.
- A code works exactly once and dies at 1 hour.
- No response, log line, or timing difference reveals whether an email is
  registered.
- With a session for profile A, no request can retrieve profile B's data
  (verified by test 13 and by Steps 3–4 isolation tests).

## Risks / notes

- **Brevo sender verification:** `MOBILE_MAIL_FROM` must be a verified sender/
  domain in Brevo or sends 400. Document in the ops notes.
- **Cookie over HTTP on LAN:** `Secure` cookies need HTTPS. In production the app
  is behind the Cloudflare Tunnel (HTTPS) — fine. For bare-LAN testing, allow a
  `MOBILE_INSECURE_COOKIE=1` escape hatch (documented, default off).
- **One new dependency:** `nodemailer` (for the Brevo SMTP relay — decided
  2026-08-26). No `cookie-parser` or `jsonwebtoken` — cookie parsing and sessions
  are a few lines, consistent with the rest of the repo.
- **SMTP login vs account email:** Brevo's SMTP username (`BREVO_SMTP_LOGIN`) is
  the value on the dashboard's SMTP tab (often `…@smtp-brevo.com`), NOT the Brevo
  account email. A wrong login fails auth — use `verifyTransport()` to check.
