# Mobile Companion App — Build Plan

**Status:** ✅ ALL 4 STEPS BUILT & e2e-verified (2026-08-26). Steps 1–4 complete;
tests: `37 unit + http` (mobile) alongside the unchanged `44 + 46` main suite —
`npm test` runs both. Per-step detail + verification notes in each `docs/step-*.md`.

A phone-first companion web app for the AI Recommender, served at **`/mobile`**.
A family member logs in with the email on their profile (passwordless OTP), and
from their phone can **see only their own recommendations**, **search TMDB and
add titles to their Simkl watchlist**, and (nice-to-have) **swipe to remove or
save** recommendations.

This app deliberately reuses the existing engine. It adds a login surface and a
mobile UI on top of code that is already here and already tested:

| The app needs… | Already exists | Where |
|---|---|---|
| A per-person account keyed by email | `profile.email` field (reserved "for the future Mobile Companion passwordless login") | [src/config.js:83](../src/config.js) |
| Per-profile, per-type recommendations | `recommendationStore.getRecommended(profileId, {type})` | [src/recommendationStore.js:177](../src/recommendationStore.js) |
| Remove a recommendation (swipe-right) | `dontRecommend.suppress(profile, {type, imdbId})` — written to be shared by "the Mobile Companion app" | [src/dontRecommend.js](../src/dontRecommend.js) |
| TMDB search with poster + synopsis | `tmdb.searchTitles(key, type, q, limit)` → full metas | [src/services/tmdb.js:101](../src/services/tmdb.js) |
| Read a profile's watchlist | `simkl.getPlanToWatch(profile, kind)` | [src/services/simkl.js:201](../src/services/simkl.js) |
| Rate-limited Simkl/TMDB calls | `governor.schedule(service, fn)` | [src/services/governor.js](../src/services/governor.js) |
| SQLite (sessions, OTPs) | `db.get()` (Node built-in `node:sqlite`, WAL) | [src/db.js](../src/db.js) |
| Secrets sealed at rest | `services/crypto` (used by config/settings) | [src/services/crypto.js](../src/services/crypto.js) |

**One real gap:** Simkl has `addToHistory()` (watched) and `getPlanToWatch()`
(read) but **no plan-to-watch write** — Step 3 adds `simkl.addToPlanToWatch()`.

---

## Locked decisions

1. **Email delivery — Brevo SMTP relay via `nodemailer`.** Sends over
   `smtp-relay.brevo.com` (decided 2026-08-26, superseding the initial HTTP-API
   choice — the Brevo key on hand was an SMTP key, `xsmtpsib-…`, which the HTTP
   API rejects). Adds the `nodemailer` dependency. Credentials in ENV:
   `BREVO_SMTP_LOGIN` (username), `BREVO_SMTP_KEY` (the SMTP key, used as the
   password; `BREVO_API_KEY` accepted as an alias), optional `BREVO_SMTP_HOST` /
   `BREVO_SMTP_PORT`.
2. **Account model — strict 1:1 email ↔ profile.** One profile, one unique email.
   An email that matches **0 or 2+ profiles is a configuration error** the login
   refuses (generic response to the client, warning in the server log — never a
   silent sign-in to an ambiguous account).
3. **Isolation is enforced server-side by the session, never the client.** Every
   data route reads `req.profile.id` from the verified session. The client never
   sends a profile id, so one user cannot request another's data.
4. **OTP: 6-digit numeric, single-use, 1-hour TTL, hashed at rest.**
5. **Self-contained module.** All new code lives under `mobile/`. Exactly **two**
   minimal touch-points in `src/` (see below).

---

## Directory layout (target)

```
mobile/
  README.md                 ← this file (overview + index)
  docs/
    step-1-auth-otp.md       ← login: OTP over Brevo, sessions, isolation
    step-2-responsive-ui.md  ← mobile-first SPA shell, responsive to desktop
    step-3-tmdb-search.md    ← search → poster/synopsis → add to Simkl watchlist
    step-4-recommendations-tabs.md ← Movies/Shows tabs + swipe to remove/save
  server/                   ← backend (built in the steps)
    router.js                ← Express router mounted at /mobile
    auth.js                  ← OTP issue/verify, session guard (pure + wired)
    otpStore.js              ← SQLite: mobile_otp + mobile_session tables
    mail.js                  ← Brevo SMTP client via nodemailer (send-injectable)
    handlers.js              ← search / watchlist / recommendations / suppress
  public/                   ← the mobile SPA (vanilla HTML/CSS/JS, no framework)
    index.html
    app.js
    styles.css
    ui.js                    ← pure client helpers (routing, swipe math) — testable
  test/
    mobile.smoke.js          ← unit + regression tests (same harness as test/smoke.js)
```

### The only two edits outside `mobile/`

1. **Mount the router** in [src/server.js](../src/server.js), alongside the
   existing `/addon`, `/api`, `/configure` mounts:
   ```js
   const mobile = require('../mobile/server/router');
   app.use('/mobile', mobile.router); // OTP-guarded; NOT behind admin Basic Auth
   ```
2. **Add one Simkl function** to [src/services/simkl.js](../src/services/simkl.js):
   `addToPlanToWatch(profile, items)` — it belongs with the other Simkl calls
   (one rate-governed client, no forked duplicate). Everything that *orchestrates*
   it stays in `mobile/`.

Both are documented in the steps that introduce them (router mount → Step 1,
Simkl write → Step 3).

---

## Auth & routing boundary

The existing `/api` is the **admin** portal, behind HTTP Basic Auth
([src/server.js:121](../src/server.js)). The mobile app must **not** live there —
family members are not admins. Instead:

| Route | Auth | Purpose |
|---|---|---|
| `GET /mobile`, `/mobile/*.js/.css` | none | Static SPA shell (public assets, like `/configure`) |
| `POST /mobile/api/auth/request`, `/auth/verify` | none | Issue / verify OTP |
| `GET/POST /mobile/api/*` (all data) | **mobile session** | Guarded; bound to one profile |
| `/api/*` | admin Basic Auth | Unchanged |
| `/addon/:token/*` | install token | Unchanged |

The mobile session guard is a separate mechanism from admin Basic Auth; it never
grants admin access.

---

## Environment variables (added by this feature)

Add to `.env`, `.env.example`, and `docker-compose.yml`. All are read at boot;
none are per-profile.

| Var | Required | Default | Purpose |
|---|---|---|---|
| `BREVO_SMTP_LOGIN` | for real email | — | Brevo SMTP username (dashboard → SMTP & API → SMTP). |
| `BREVO_SMTP_KEY` | for real email | — | Brevo SMTP key (`xsmtpsib-…`), used as the SMTP password. `BREVO_API_KEY` accepted as an alias. Unset → OTP logged to server console (dev/test), no send. |
| `BREVO_SMTP_HOST` | no | `smtp-relay.brevo.com` | SMTP host. |
| `BREVO_SMTP_PORT` | no | `587` | SMTP port (`465` = implicit TLS). |
| `MOBILE_MAIL_FROM` | for real email | — | Verified Brevo sender address (e.g. `no-reply@gallagherhome.au`). |
| `MOBILE_MAIL_FROM_NAME` | no | `AI Recommender` | Sender display name. |
| `MOBILE_SESSION_DAYS` | no | `30` | Session lifetime (rolling). |
| `EXTERNAL_URL` | no (exists) | — | Reused to build the app link inside the OTP email. |

`BREVO_SMTP_KEY` is an infrastructure secret handled like `ADMIN_PASSWORD` — it
stays in ENV (never in `profiles.json`/`settings.json`, never committed;
`.env` is already git-ignored). The at-rest `SECRET_KEY` sealing applies to
stored profile/settings secrets, not ENV.

---

## Testing conventions (all steps)

Mirror [test/smoke.js](../test/smoke.js) exactly — the bar every step is held to:

- **Pure, offline, deterministic.** No real network. External I/O (Brevo, Simkl,
  TMDB) is **dependency-injected** so tests pass fakes. Time is injected
  (`nowMs`) so expiry/TTL is tested without sleeping.
- **Same harness:** a local `ok(name, fn)` + Node `assert`, temp `DATA_DIR`,
  `SECRET_KEY` set to a throwaway value.
- **Two kinds per step:**
  - **Unit tests** — the new logic in isolation (OTP hashing/expiry, body
    builders, mappers, swipe math).
  - **Regression tests** — existing behaviour that must not break, and
    **cross-surface parity** (e.g. mobile "remove" must be byte-for-byte the same
    action as the portal's and the in-player `/dnr` path, since all three call
    `dontRecommend.suppress`).

Run:
```bash
node --experimental-sqlite mobile/test/mobile.smoke.js
```
Wire it into `package.json` so `npm test` runs both suites:
```json
"scripts": {
  "test": "node --experimental-sqlite test/smoke.js && node --experimental-sqlite mobile/test/mobile.smoke.js"
}
```

---

## Build order & dependencies

Steps are sequential; each is shippable on its own. **All four are built.**

1. ✅ **[Step 1 — Login (OTP + sessions)](docs/step-1-auth-otp.md)** — the
   foundation. Router mount, session guard, and the isolation guarantee every
   later step relies on. (Brevo SMTP relay — live-verified.)
2. ✅ **[Step 2 — Responsive mobile UI shell](docs/step-2-responsive-ui.md)** —
   the SPA that hosts login and the feature views; phone-first, desktop-responsive.
3. ✅ **[Step 3 — TMDB search → add to Simkl watchlist](docs/step-3-tmdb-search.md)** —
   session + shell; adds the Simkl plan-to-watch write.
4. ✅ **[Step 4 — Recommendations tabs + swipe](docs/step-4-recommendations-tabs.md)** —
   reuses Step 3's watchlist write for swipe-left and `dontRecommend.suppress`
   for swipe-right; Undo via the new `recommendationStore.removeDontRecommend`.

## Out of scope for v1 (noted, not built)

- **Connecting Simkl from the phone.** The Simkl PIN device flow stays a portal
  action ([src/portal.js:278](../src/portal.js)); the mobile app assumes the
  profile already connected Simkl there. A phone-side connect flow can be a later
  step.
- **Editing filters / catalogs from the phone** (portal owns these).
- **Push notifications / native app wrapper** (the SPA is installable as a PWA —
  see Step 2 — but no app-store build).
