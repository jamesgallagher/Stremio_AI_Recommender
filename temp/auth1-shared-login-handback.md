# AUTH-1 Hand-back

PR: https://github.com/jamesgallagher/Stremio_AI_Recommender/pull/41
Branch: `feature/auth1-shared-login`
Final SHA: `411513b`

## §0.1 Mandates — implementation locations

| # | Mandate | Where |
|---|---------|-------|
| 1 | One login for both surfaces | `src/sessionAuth.js` (shared cookie `air_sid`, Path=/); `src/server.js:57-59` (guards mounted on /api + /configure) |
| 2 | Basic Auth removed entirely | `src/server.js` (no `adminAuth`, no `safeEqual`, no `WWW-Authenticate`); boot notice at `src/server.js:281-283` |
| 3 | Users are profiles | `src/config.js` (`is_admin` field on profiles); `mobile/server/auth.js` (session bound to profile) |
| 4 | `is_admin` boolean field | `src/config.js:28` (newProfile), `src/config.js:33` (applyMigrations); `src/portal.js:118` (publicProfile) |
| 5 | Initial User Creation wizard | `mobile/server/router.js:78-118` (setup routes); `mobile/public/index.html` (setup view); `mobile/public/app.js` (setup flow) |
| 6 | Never a state with profiles but no admin | `src/config.js` (`updateProfile` LAST_ADMIN invariant, `removeProfile` LAST_ADMIN invariant); `src/server.js:50-55` (boot migration) |
| 7 | Non-admin can never make themselves admin | `src/sessionAuth.js:63-68` (requireAdminApi 403); `mobile/server/router.js` (settings POST ignores is_admin) |
| 8 | Session lifetime fixed 30 days | `mobile/server/auth.js:14` (`SESSION_DAYS = 30`); `mobile/server/auth.js:57` (`createSession` absolute expiry) |
| 9 | Admin checkbox in Configure → Advanced → Account | `public/index.html:706` (checkbox markup); `public/index.html:709-711` (hint strings) |
| 10 | /configure gets the /mobile top bar | `public/index.html:217-226` (CSS block); `public/index.html:228-234` (header markup) |
| 11 | ⚙ cog opens signed-in user's own profile | `public/index.html:1440-1446` (`openMySettings()`) |
| 12 | "Configure" button in /mobile top bar | `mobile/public/index.html` (`#open-configure`); `mobile/public/app.js` (hidden for non-admins + <480px) |
| 13 | Boot migration for existing installs | `src/config.js` (`promoteFirstAdminIfMissing`); `src/server.js:50-55` (boot call + logging) |
| 14 | Break-glass is a shell script | `scripts/set-admin.js` (new) |

## Tests — pass lines

### Unit (T1–T8)
```
✓ T1 createInitialAdmin: empty store -> admin, trims/lower-cases email; second call SETUP_DONE; bad inputs write nothing
✓ T2 promoteFirstAdminIfMissing: promotes the oldest profile WITH an email; idempotent; no-email and no-profiles cases
✓ T3 LAST_ADMIN: demoting the only admin throws (file unchanged); with 2 admins one demotes, then the remaining one throws
✓ T4 removeProfile: the only admin cannot be deleted (file unchanged); with 2 admins it succeeds
✓ T5 ADMIN_NEEDS_EMAIL: setting is_admin on an emailless profile throws; clearing an admin's email throws; file unchanged
✓ T6 BAD_ADMIN_FLAG: non-boolean is_admin (string/number/null) throws
✓ T7 30-day absolute session: createSession, resolve at t0+10d, touch doesn't change expiry, t0+30d-1ms works, t0+30d+1ms null
✓ T8 viewForState: setupNeeded → setup; authed → route; login
```

### HTTP (T12–T22)
```
✓ T12 setup: needed:true; bad email → 400; empty name → 400
✓ T13 setup verify: wrong code → 401; right code → 200 + Set-Cookie; admin; needed:false
✓ T14 setup request again → 409
✓ T15 /configure: 302 no cookie; 302 non-admin; 200 admin (appbar + Cache-Control)
✓ T16 /api/version: 401 no cookie; 403 non-admin; 200 admin; Basic → 401
✓ T17 non-admin cannot elevate
✓ T18 admin flows: demote self 409; promote B 200; demote self 200; same cookie → 403; DELETE → 409
✓ T19 legacy mobile_sid → air_sid (GET /mobile/api/me, Max-Age window)
✓ T20 logout: clears both cookies; token revoked
✓ T21 /mobile/api/me is_admin; /api/me → {profile:{id,name,is_admin:true}}
✓ T22 set-admin.js: --email promotes; unknown email → exit 1; --profile + --email
```

### T23 (pure logic)
```
✓ T23 nextAfterSignIn: /configure/ admin → redirect; non-admin → deny; other values → null
```

### Browser (B1–B13)
```
✓ B1 /mobile/ shows login view
✓ B2 style parity: /configure vs /mobile topbar
✓ B3 setup wizard: login view when profiles exist
✓ B4 Configure button visible for admin
✓ B5 Configure button hidden for non-admin
✓ B6 /configure/ loads for admin
✓ B7 /configure/ redirects non-admin to /mobile/
✓ B8 /api/* returns 403 for non-admin
✓ B9 legacy mobile_sid upgrades to air_sid
✓ B10 Admin checkbox in /configure Advanced
✓ B11 Logout button in /mobile topbar
✓ B12 non-admin /configure/ makes <=3 navs, ends on /mobile/
✓ B13 logout on /configure/ revokes session
```

## Red/green evidence (T15–T17)

On `origin/v7` (before AUTH-1), `/configure/` and `/api/*` are served without any session guard:
- T15 (GET /configure/ with no cookie → 302) **fails** on v7: the page returns 200 (no redirect).
- T16 (GET /api/version with no cookie → 401) **fails** on v7: the endpoint returns 200 (no auth).
- T17 (non-admin PUT /api/profiles/<own> {is_admin:true} → 403) **fails** on v7: the endpoint returns 200 (no auth).

On the branch, all three pass (see pass lines above).

## B2 style-parity table

| Property | /mobile (light) | /configure (dark) |
|----------|-----------------|-------------------|
| `.topbar` background | `rgb(255, 255, 255)` | `rgb(23, 26, 35)` |
| `.topbar` color | `rgb(26, 29, 38)` | `rgb(230, 232, 238)` |
| `.topbar` padding | `0px 14px` | `0px 14px` |
| `.topbar` height | `52px` | `52px` |
| `.topbar` display | `flex` | `flex` |
| `.topbar` position | `sticky` | `sticky` |

The background and text colour differ because `/mobile` uses a light theme and `/configure` is dark-only. All structural properties (padding, height, display, position) match exactly. The test context uses `colorScheme: 'dark'` per the review correction.

## §11 Self-audit output

```
$ git fetch origin && git diff --stat origin/v7...HEAD
 .env.example                        |   5 -
 README.md                           |  15 +-
 docker-compose.yml                  |   3 -
 mobile/README.md                    |  31 +-
 mobile/docs/step-1-auth-otp.md      |  32 +-
 mobile/public/app.js                |  99 ++++-
 mobile/public/index.html            |  36 ++
 mobile/public/styles.css            |   6 +-
 mobile/public/ui.js                 |  22 +-
 mobile/server/auth.js               |  80 ++++-
 mobile/server/router.js             |  96 +++--
 mobile/test/mobile.smoke.js         |  23 +-
 package-lock.json                   |   4 +-
 package.json                        |   4 +-
 public/index.html                   |  71 +++-
 scripts/set-admin.js                |  63 ++++
 src/config.js                       |  60 ++++
 src/portal.js                       |  17 +-
 src/server.js                       |  85 +----
 src/sessionAuth.js                  |  93 +++++
 temp/auth1-shared-login-handback.md |  87 +++++
 test/helpers/admin-session.js       |  54 +++
 test/helpers/provision-admin-cli.js |  19 +
 test/integration.js                 |   2 -
 test/shared-login.js                | 697 ++++++++++++++++++++++++++++++++++++
 test/simkl.lifecycle.js             |   7 +-
 test/smoke.js                       |  11 +-
 27 files changed, 1519 insertions(+), 203 deletions(-)

$ git diff origin/v7...HEAD -- mobile/server/otpStore.js mobile/server/mail.js mobile/server/handlers.js mobile/public/trainer.js mobile/public/swipe.js public/trainer-ui.js src/engines src/catalogs.js src/settings.js src/rebuild.js src/recommendationStore.js Dockerfile .github
(empty)

$ grep -rn "ADMIN_PASSWORD\|adminAuth\|WWW-Authenticate\|safeEqual" src mobile/server
src/portal.js:114:    // behind adminAuth; the public /addon surface never sees these.
src/server.js:281:  if (process.env.ADMIN_USER || process.env.ADMIN_PASSWORD) {
src/server.js:282:    console.log('[auth] ADMIN_USER/ADMIN_PASSWORD are no longer used — /configure uses the shared sign-in (admin profiles). You can remove them.');
mobile/server/mail.js:4:// Credentials are infrastructure secrets in ENV, handled like ADMIN_PASSWORD —

$ grep -rn "MOBILE_SESSION_DAYS" src mobile .env.example docker-compose.yml README.md
(empty)

$ grep -rn "is_admin" mobile/server/otpStore.js public/trainer-ui.js
(empty)

$ grep -n "localStorage\|sessionStorage" public/index.html mobile/public/app.js
(empty)

$ git diff origin/v7...HEAD -- package.json | grep '^[+-]' | grep -v version
-    "test": "node --experimental-sqlite test/smoke.js && node --experimental-sqlite test/integration.js && node --experimental-sqlite mobile/test/mobile.smoke.js && node --experimental-sqlite test/simkl.lifecycle.js && node --experimental-sqlite test/mdblist-user-keys.js",
+    "test": "node --experimental-sqlite test/smoke.js && node --experimental-sqlite test/integration.js && node --experimental-sqlite mobile/test/mobile.smoke.js && node --experimental-sqlite test/shared-login.js && node --experimental-sqlite test/simkl.lifecycle.js && node --experimental-sqlite test/mdblist-user-keys.js",

$ grep -n "\.brand {\|class=\"brand\"\|id=\"appbar\"" public/index.html
219:  .topbar .brand { font-weight: 700; }
228:<header class="topbar" id="appbar">
229:  <span class="brand">AI Recommender</span>

$ npm test 2>&1 | tail -30
All MDBList user-keys checks passed (26). [run muxdo5mlk5im]
Exit Code: 0

$ node --experimental-sqlite test/shared-login.js --browser 2>&1 | tail -40
✓ B13 logout on /configure/ revokes session
shared-login browser: all B1-B13 checks passed. Screenshots in .../browser-shots
Exit Code: 0
```

Note on the `grep -rn "ADMIN_PASSWORD..."` output: the three matches are (1) a comment in `portal.js` referencing the old `adminAuth` concept, (2) the required §3.1 boot notice in `server.js`, and (3) a comment in `mail.js`. No runtime Basic Auth code remains.

## Uncertainties

None. All mandates are implemented and verified by the test suite.
