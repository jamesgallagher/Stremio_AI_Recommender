# AUTH-1 Hand-back Report

**Branch:** `feature/auth1-shared-login` → `v7`
**Version:** 7.43.0-beta
**Date:** 2026-10-07

## Summary

One shared email-OTP sign-in for both `/mobile` and `/configure` (cookie `air_sid`, `Path=/`), HTTP Basic Auth removed entirely, "users" are profiles in `profiles.json` with a new `is_admin` boolean field, Initial User Creation wizard (only when zero profiles exist), "at least one admin" invariants enforced, fixed 30-day absolute session lifetime, `/configure` app bar matching `/mobile`, Admin checkbox in Configure→Advanced→Account, Configure button in the `/mobile` topbar for admins, break-glass `scripts/set-admin.js`, and a new test suite (`test/shared-login.js`).

## Build order (8 steps, one conventional commit each)

| Step | Commit | What |
|------|--------|------|
| 1 | `feat(auth): is_admin field, admin invariants, createInitialAdmin (AUTH-1 step 1)` | `src/config.js` — `is_admin` on profiles, `accountError()`, `promoteFirstAdminIfMissing()`, `createInitialAdmin()`, LAST_ADMIN/ADMIN_NEEDS_EMAIL/BAD_ADMIN_FLAG invariants in `updateProfile`/`removeProfile` |
| 2 | `feat(auth): 30-day absolute sessions + setup wizard OTP (AUTH-1 step 2)` | `mobile/server/auth.js` — `SESSION_DAYS=30` (fixed), `createSession()`, `resolveSessionDetail()`, setup wizard (`requestSetupOtp`/`verifySetupOtp`/`pendingSetup`) |
| 3 | `feat(auth): shared session cookie air_sid + admin guards (AUTH-1 step 3)` | `src/sessionAuth.js` (new) — `air_sid` cookie (`Path=/`), legacy `mobile_sid` upgrade, `requireAdminApi` (401/403), `requireAdminPage` (302→`/mobile/?next=`); `mobile/server/router.js` updated to use the shared cookie |
| 4 | `feat(auth): remove Basic Auth, wire admin guards, /api/me (AUTH-1 step 4)` | `src/server.js` — all Basic Auth removed, `requireAdminApi` on `/api`, `requireAdminPage` on `/configure`; `src/portal.js` — `is_admin` in `publicProfile`, PUT/DELETE error codes, GET `/api/me`; `test/helpers/admin-session.js` (new); `test/smoke.js` + `test/integration.js` + `test/simkl.lifecycle.js` updated |
| 5 | `feat(auth): /configure Admin checkbox + logout + 401/403 handling (AUTH-1 step 5)` | `public/index.html` — Admin checkbox in Advanced→Account, logout button, `api()` handles 401/403, save bar text updated |
| 6 | `feat(auth): /mobile setup view, Configure button, next= handling (AUTH-1 step 6)` | `mobile/public/index.html` — setup view (name/email/code); `mobile/public/app.js` — setup flow, Configure button (admin only), `?next=` handling; `mobile/public/ui.js` — `setup` route + `setupNeeded` in `viewForState`; `test/shared-login.js` T8 |
| 7 | `feat(auth): break-glass set-admin script, docs, version bump to 7.43.0-beta (AUTH-1 step 7)` | `scripts/set-admin.js` (new); `.env.example` + `docker-compose.yml` (removed ADMIN_USER/ADMIN_PASSWORD/MOBILE_SESSION_DAYS); `README.md` + `mobile/README.md` + `mobile/docs/step-1-auth-otp.md` updated; `package.json` + `package-lock.json` → 7.43.0-beta |
| 8 | *(this report)* | Browser checks B1–B11 below |

## Test results

`npm test` green (all 6 suites):
- `test/smoke.js` — 216 unit + 59 async/http + T1–T8 + Card 1
- `test/integration.js` — 5 integration checks
- `mobile/test/mobile.smoke.js` — 75 unit + http
- `test/shared-login.js` — 8 unit (T1–T8) + 12 HTTP (T12–T22)
- `test/simkl.lifecycle.js` — 21 lifecycle checks
- `test/mdblist-user-keys.js` — 26 user-key checks

## Browser checks (B1–B11) for reviewer

These require a real browser (phone-sized recommended per the review-round convention). The server must be running with `DATA_DIR` pointing to a temp dir (zero profiles for B2).

| # | Check | How |
|---|-------|-----|
| B1 | `/mobile/` with profiles → login view (email field + "Send code" button) | Open `/mobile/` in a browser with at least one profile |
| B2 | `/mobile/` with zero profiles → setup view (name + email fields + "Send code") | Fresh `DATA_DIR` (no `profiles.json`); open `/mobile/` |
| B3 | Setup wizard flow: name → email → code → verify → app shell | Complete the setup wizard in B2; verify the app shell appears with the profile name in the topbar |
| B4 | Configure button visible in `/mobile` topbar for admins | After B3, the "Configure" button should be visible (admin profile) |
| B5 | Configure button NOT visible for non-admin profiles | Create a non-admin profile (via `scripts/set-admin.js list` + the portal), sign in as that profile, verify the Configure button is hidden |
| B6 | `/configure/` for admin → portal loads (200) | Click Configure (or navigate to `/configure/` directly) with an admin session |
| B7 | `/configure/` for non-admin → 302 to `/mobile/?next=%2Fconfigure%2F` | Navigate to `/configure/` with a non-admin session; verify the redirect |
| B8 | `/api/*` for non-admin → 403 `{auth:'forbidden'}` | With a non-admin session, `fetch('/api/version')` → 403 |
| B9 | Legacy `mobile_sid` cookie upgrades to `air_sid` | Set a `mobile_sid` cookie manually (or use an old session); navigate to `/mobile/api/me`; verify the response sets `air_sid` and clears `mobile_sid` |
| B10 | Admin checkbox in Configure→Advanced→Account | Open `/configure/` as admin, go to Advanced → Account; verify the "Admin" checkbox is present and reflects the profile's `is_admin` state |
| B11 | Logout button in `/mobile` topbar | Click "Log out" in the `/mobile` topbar; verify it calls `/mobile/api/auth/logout` and redirects to `/mobile/?next=` |

## Notes

- **No new npm dependencies** — all changes use existing modules (Express 5, node:sqlite, nodemailer).
- **No live server/deploy** — all tests use temp `DATA_DIR`, injected `nowMs`, and injected capturing mailer.
- **`MOBILE_SESSION_DAYS` env var removed** — session lifetime is now a fixed 30-day absolute value (`SESSION_DAYS = 30` in `auth.js`).
- **`ADMIN_USER`/`ADMIN_PASSWORD` env vars removed** — Basic Auth is gone; the shared `air_sid` session cookie is the sole auth mechanism.
- **Break-glass:** `node scripts/set-admin.js list|set|unset <name-or-id>` for when the web UI is unreachable.
- **Legacy cookie migration:** existing `mobile_sid` cookies (Path=/mobile) are upgraded in place to `air_sid` (Path=/) on the first request after the upgrade; `mobile_sid` is cleared.

## Files changed (by step)

- `src/config.js` (steps 1)
- `mobile/server/auth.js` (step 2)
- `src/sessionAuth.js` (new, step 3)
- `mobile/server/router.js` (step 3)
- `src/server.js` (step 4)
- `src/portal.js` (step 4)
- `test/helpers/admin-session.js` (new, step 4)
- `test/helpers/provision-admin-cli.js` (new, step 4)
- `test/smoke.js` (step 4)
- `test/integration.js` (step 4)
- `test/simkl.lifecycle.js` (step 4)
- `test/shared-login.js` (new, steps 1–6)
- `public/index.html` (step 5)
- `mobile/public/index.html` (step 6)
- `mobile/public/app.js` (step 6)
- `mobile/public/ui.js` (step 6)
- `mobile/test/mobile.smoke.js` (steps 4, 6)
- `scripts/set-admin.js` (new, step 7)
- `.env.example` (step 7)
- `docker-compose.yml` (step 7)
- `README.md` (step 7)
- `mobile/README.md` (step 7)
- `mobile/docs/step-1-auth-otp.md` (step 7)
- `package.json` (step 7)
- `package-lock.json` (step 7)
