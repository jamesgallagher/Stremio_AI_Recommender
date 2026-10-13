# Mobile Companion

A phone-first web app (installable PWA, vanilla JS, no framework) served at
**`/mobile`**. Every family member signs in with the email on their profile
(passwordless) and sees **only their own** data. It reuses the main engine and stores —
this directory adds the login surface and the mobile UI, nothing parallel.

## What it does

| Tab / area | Function |
|---|---|
| **Recommendations** | Movies / Shows (and Anime when enabled) lists mirroring what Stremio/Nuvio serve. Swipe or tap to **mark as watched**, **not interested**, or save to **Watch Later**; Undo supported. Tap a title for the detail sheet |
| **Search** | TMDB search (Movies / Shows) with poster and synopsis; add to the Simkl Watch Later list. Age-gated for age-limited profiles, fail-closed |
| **Ratings** | The taste trainer: **Quick** (one unrated watch at a time) and **List** (filtered, paged history). Rate 1–10 (10 = Loved), ignore, mark unfinished / unwatched. See [docs/trainer](../docs/trainer/00-design-spec.md) |
| **Settings (⚙)** | Filters (rating floor, vote floor, release year, excluded genres, list size, title decay), per-lane engine, and catalog toggles with a preview of what each catalog currently serves |
| **Configure** | Admin profiles also get a link to `/configure/` |

On profiles with an age limit, rating floor, release year, excluded genres and the
Anime switch are parental controls: shown read-only, managed by the admin. The age
limit itself is never shown or editable here.

Out of scope: connecting Simkl (a portal action), push notifications, an app-store build.

## Sign-in and isolation

- **Passwordless email OTP.** A 6-digit code, single-use, hashed at rest, valid
  **60 minutes**, **5 wrong tries** then it dies, **5 code requests per email per
  hour**. Constant-time comparison.
- **Strict 1:1 email ↔ profile.** An email matching 0 or 2+ profiles is a
  configuration error: the client gets a generic response and the log gets a warning.
- **Session cookie `air_sid`** — fixed 30 days (not extended by activity), `Secure`
  unless `MOBILE_INSECURE_COOKIE=1`, `SameSite=Lax`. The same session serves the admin
  portal, where `requireAdminApi` / `requireAdminPage` additionally require `is_admin`.
- **Isolation is server-side.** Every data route takes the profile from the verified
  session; the client never sends a profile id.
- **First run.** With zero profiles the server logs a one-time setup token; the setup
  wizard requires that token plus a name and email, then emails a code that creates the
  first admin. An exposed empty instance can't be claimed by whoever types an email.
- Email is sent through the **Brevo SMTP relay** (`nodemailer`). With no SMTP
  credentials configured, codes are written to the server log (dev only).

| Route | Auth | Purpose |
|---|---|---|
| `GET /mobile`, static assets | none | SPA shell |
| `POST /mobile/api/auth/request`, `/auth/verify` | none | Issue / verify a code |
| `GET /mobile/api/setup`, `POST …/setup/request`, `…/setup/verify` | none (token-gated) | First-run wizard |
| `/mobile/api/*` (everything else) | session | Bound to one profile |
| `/api/*`, `/configure/` | admin session | 401/403 for non-admins |
| `/addon/:token/*` | install token | Stremio/Nuvio |

Data routes: `search`, `watchlist` (+ `/remove`), `recommendations`, `recommend/suppress`
and `/unsuppress`, `watched`, `trainer` (+ `/rate`, `/ignore`, `/finished`,
`/unwatched`, `/rebuild`), `settings` (GET/POST), `catalogs/:id/preview`, `title-detail`.

## Environment

All read at boot; none are per-profile. `BREVO_SMTP_KEY` is an infrastructure secret —
keep it in the container environment, never in `profiles.json`/`settings.json` or git.

| Var | Default | Purpose |
|---|---|---|
| `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY` | — | Brevo SMTP username and key (dashboard → SMTP & API → SMTP). `BREVO_API_KEY` is accepted as an alias for the key |
| `BREVO_SMTP_HOST`, `BREVO_SMTP_PORT` | `smtp-relay.brevo.com`, `587` | `465` = implicit TLS |
| `MOBILE_MAIL_FROM`, `MOBILE_MAIL_FROM_NAME` | —, `AI Recommender` | Verified sender address and display name |
| `MOBILE_INSECURE_COOKIE` | — | `1` for bare-HTTP LAN testing only |
| `EXTERNAL_URL` | — | Builds the app link inside the sign-in email |

## Layout

```
mobile/
  server/   router.js (mounted at /mobile) · auth.js (OTP, sessions, setup token)
            otpStore.js (SQLite mobile_otp / mobile_session) · mail.js (Brevo/nodemailer)
            handlers.js (search, watchlist, recommendations, trainer, settings, preview)
  public/   index.html · app.js · ui.js (pure helpers) · swipe.js · trainer.js · styles.css
            manifest.webmanifest
  test/     mobile.smoke.js
```

Shared with the portal rather than duplicated: `catalogServe.js` (preview == serve),
`searchGate.js` (search age gate), `dontRecommend.js` / `markWatched.js` (one action
path for the portal, the Companion and the in-player "not interested"),
`public/trainer-ui.js` and `public/title-detail.js` (served to both UIs).

## Testing

Pure, offline and deterministic: external I/O (Brevo, Simkl, TMDB) and time are
injected. Run `npm run test:mobile`, or the whole chain with `npm test`.
