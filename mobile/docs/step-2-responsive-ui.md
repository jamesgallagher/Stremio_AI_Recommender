# Step 2 — Responsive mobile-first UI shell

**Status:** ✅ BUILT (2026-08-26). SPA in `mobile/public/` (`index.html`,
`styles.css`, `app.js`, pure `ui.js`, `manifest.webmanifest`), served at `/mobile`
via `express.static` + SPA fallback in the router. Tests: `20 unit + http` (added
`ui` routing/view helpers + shell/static/fallback/config HTTP checks).

**e2e-verified in a real browser (2026-08-26):** login → OTP → authed shell →
tab nav → reload (session persists via the HttpOnly cookie) → logout (server-side
revoke, `/me` → 401). Mobile 375px and desktop 1280px: no horizontal scroll, and
the tab bar moves from fixed-bottom (phone) to static-top (≥768px). *(This host
can't composite screenshots; verified via the accessibility tree + real handler
calls.)*

**Depends on:** Step 1 (auth endpoints). **Unlocks:** Steps 3–4 (feature views).

## Goal

The single-page app that hosts login and the feature views. Built **phone-first**
— thumb-reachable, full-bleed, touch-sized — and **responsive** so the same page
works on a desktop browser when a user logs in there. No framework: vanilla
HTML/CSS/JS, matching [public/index.html](../../public/index.html) (CSS-variable
theme, dark, `system-ui` font).

## Design

### Served statically at `/mobile`

Add to `mobile/server/router.js` (Step 1's router):
```js
router.use(express.static(path.join(__dirname, '..', 'public')));
// SPA fallback: deep links (/mobile/search) return index.html
router.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
```
Static assets are public (like `/configure`); the **data** behind
`/mobile/api/*` is what requires a session (Step 1). The fallback must be
registered **after** the `/api/*` routes so it never shadows them.

### Layout & views

One `index.html`, one `app.js` state machine, one `styles.css`. Client-side
views (hash or History API routing — a tiny hand-rolled router in `ui.js`):

- **`#/login`** — email field → "Send code" → code field → "Verify". Talks to
  Step 1's `/auth/request` and `/auth/verify`. On success, route to `#/recs`.
- **`#/recs`** — the Movies/Shows tabs (Step 4).
- **`#/search`** — TMDB search (Step 3).
- Boot: `GET /mobile/api/me`; 200 → app shell, 401 → `#/login`.

**Chrome:**
- **Top bar:** app name + the signed-in profile name + a logout button.
- **Bottom tab bar** (phone): Recommendations · Search — thumb-reachable, fixed,
  `padding-bottom: env(safe-area-inset-bottom)`. On desktop (`min-width: 768px`)
  it moves to the top bar / a side rail.

### Responsive rules (mobile-first CSS)

- Base stylesheet targets a narrow viewport; `@media (min-width: 768px)` and
  `(min-width: 1024px)` progressively enhance to a centered, max-width column
  (mirror the portal's `.wrap { max-width: 860px; margin: 0 auto }`).
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.
- Touch targets ≥ 44×44 px; `font-size ≥ 16px` on inputs (prevents iOS zoom-on-focus).
- Fluid units (`rem`, `%`, `min()/clamp()`, grid `auto-fill minmax`), `max-width:100%`
  on posters; nothing forces horizontal scroll.
- Reuse the portal's color tokens (`--bg/--card/--accent/--ok/--warn/--err`) for
  a consistent look; respect `prefers-color-scheme` (tokens already dark-first).
- **Honest states:** distinct loading / empty / error UI. Empty means empty — no
  padded placeholder rows (the "quality over quantity" principle the engine
  already follows at serve time).

### Testable client core (`mobile/public/ui.js`)

Extract the **pure** front-end logic into functions Node can test without a DOM
(the swipe math lands here in Step 4):
- `parseRoute(hash) → { view, params }`
- `viewForState({ authed, route }) → 'login' | 'recs' | 'search'`
- `apiFetch(path, opts)` wrapper that always sends `credentials:'same-origin'`
  and maps `401 → sign- out` (a thin, mockable layer).

DOM wiring lives in `app.js` and is exercised by the e2e pass, not unit tests.

### PWA (nice-to-have)

- `mobile/public/manifest.webmanifest` (name, icons from `public/logo.png`,
  `display:standalone`, `theme-color`, `start_url:/mobile`), linked from `<head>`.
- Makes the app installable to the home screen. No service worker required for v1
  (offline is not a goal). Mark optional.

### Implementation checklist

- [ ] `mobile/public/index.html` — shell, viewport meta, token colors, manifest link.
- [ ] `mobile/public/styles.css` — mobile-first + `@media` breakpoints, safe-area insets, ≥44px targets.
- [ ] `mobile/public/ui.js` — pure helpers (`parseRoute`, `viewForState`, `apiFetch`).
- [ ] `mobile/public/app.js` — boot (`/me`), router, login form wiring, top/bottom nav, logout.
- [ ] `router.js` — `express.static` + SPA fallback (after the API routes).
- [ ] (optional) `manifest.webmanifest`.

---

## Unit tests (`mobile/test/mobile.smoke.js`)

Front-end without a browser → test the **pure helpers** and the **served shell**.

1. **`ui: parseRoute maps hash → view`** — `#/search` → `{view:'search'}`;
   `''`/`#/` → the default; unknown → login/fallback.
2. **`ui: viewForState gates on auth`** — `{authed:false}` always → `'login'`
   regardless of route; `{authed:true, route:'search'}` → `'search'`.
3. **`shell: GET /mobile serves the SPA`** — 200, `content-type: text/html`, body
   contains the `viewport-fit=cover` meta and references `app.js` + `styles.css`.
4. **`shell: SPA fallback for deep links`** — `GET /mobile/search` returns the
   same `index.html` (client router takes over), **not** 404.
5. **`css: responsive contract present`** — `styles.css` contains
   `@media (min-width: 768px)`, `env(safe-area-inset`, and a `max-width` container
   rule. A cheap string-level guard that the mobile-first/responsive intent
   didn't regress (real layout is checked in the e2e pass).
6. **`shell: viewport meta is exactly the mobile-first value`** — assert the meta
   string equals `width=device-width, initial-scale=1, viewport-fit=cover`.

## Regression tests

1. **`regression: /configure and / still serve the admin portal`** — `GET /`
   still redirects to `/configure/`; `/configure/` still serves
   [public/index.html](../../public/index.html) behind Basic Auth. The new
   `/mobile` static mount didn't shadow them.
2. **`regression: SPA fallback does not swallow /mobile/api`** — `GET
   /mobile/api/me` without a session returns **401 JSON**, not the HTML shell
   (fallback registered after the API routes).
3. **`regression: static assets served without Basic Auth`** — `GET
   /mobile/styles.css` returns 200 with no credentials (public shell), while
   `/mobile/api/*` data still needs a session.
4. **`regression: /addon and /health unaffected`** — both still resolve to their
   own handlers with `/mobile` mounted.

## Acceptance criteria (verified in the e2e pass)

Beyond the Node tests above, a manual/e2e check (Browser MCP or Playwright at
`375×812` mobile and `1280×800` desktop):
- No horizontal scroll at either size; the body never overflows sideways.
- Login → tabs flow is reachable one-handed on a phone; the same page is usable
  and centered on desktop.
- Tap targets are comfortably ≥44px; inputs don't trigger iOS zoom.

## Risks / notes

- **e2e vs unit split:** committed tests stay Node-only (matches
  [test/smoke.js](../../test/smoke.js)); genuine layout/interaction is validated
  with the browser tooling as an e2e step, not baked into the smoke suite.
- Keep `app.js` framework-free and dependency-free to match the repo; the shell
  should stay a couple of small files, not a build pipeline.
