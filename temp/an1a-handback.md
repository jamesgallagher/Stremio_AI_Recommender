# AN-1a Hand-Back Report

**Branch:** `feature/an1a-anime-lane`
**PR:** [#44](https://github.com/jamesgallagher/Stremio_AI_Recommender/pull/44) → `v7`
**Version:** 7.45.0-beta
**Final SHA:** (see commit below)

## Scope

| File | Changes |
|------|---------|
| `src/services/anidb.js` | Flood control: `exclusive()` + `guardedRequest()` (one request in flight, ≥4000ms spacing, 150/day cap, 48h ban circuit, 30-day cache, 24h repeat guard, 3-attempt back-off on 5xx/timeout); `testClient` returns plain text (no ✓/✗); `classifyError` tests `/banned/i` first; `requestAnime` deleted; `_resetClock` exported; `fakeClock` flag for test seam |
| `src/services/governor.js` | Removed `anidb: { minIntervalMs: 4000 }` lane (spacing now enforced by `exclusive()` in anidb.js) |
| `src/services/mal.js` | Added `MAL_RATING_MAP` to `module.exports` for the portal test helper |
| `src/portal.js` | `malKeyCheck` helper (single fetch to `api.myanimelist.net`, uses `MAL_RATING_MAP`); `/profiles/:id/test/mal-user` and `testMal` use `malKeyCheck`; `/profiles/:id/test/anidb-user` simplified to `res.json(await anidb.testClient(...))`; `/settings/test/anidb` simplified |
| `public/index.html` | CSS: `input[type=number]` added to both input selector lists (line ~29 and ~141) so number inputs match the text/password/email styling |
| `src/server.js` | Boot `setTimeout` now `await`s `require('./anime/migration').runAll(console)` before calling `tick()` |
| `src/anime/migration.js` | `hasTable()` guard for `taste_ratings`, `taste_ignore`, `dont_recommend`, `recommended`; per-profile loop body wrapped in `try/catch` (logs `[anime] <name>: lane migration failed — <message>` and continues, no marker written) |
| `src/recommendationStore.js` | Renamed inner `const skipResult` to `const skipped` (was shadowing the `skipResult()` helper) |
| `test/anime-lane.js` | A12b (serialised concurrent `getAnime`), A12c (HTTP 503 ×3), A12d (banned body), A12e (day_calls=149 cap), A13b (plain text, no ✓/✗), A9b (HTTP test routes: MAL rating map + AniDB plain text), A15b (missing taste tables → zero counts); browser harness B1-B8 (real Playwright screenshots, Test/Clear button clicks, number input CSS check) |
| `scripts/an1a-identity.js` | Deleted (identity check performed by Claude on a live-data copy) |
| `test/screenshots/` | Deleted (screenshots now written to `DATA_DIR/screenshots/`) |

## Review fixes (R1)

### Fix 1/3: AniDB flood control

**Commit:** `8ea8fcb` — `r1 fix 1/3: AniDB flood control (serialised, retries under the rules, 5xx, ban first)`

- `exclusive(fn)` chains promises so concurrent calls serialize (one request in flight server-wide)
- `guardedRequest(client, clientver, aid)` checks ban → cap → spacing → fetch → classify; returns `{ xml } | { skipped } | { transient } | { http }`
- `getAnime` calls `guardedRequest` up to 3 times; after a `transient` result, `sleep(BACKOFF_DELAYS[i])` happens OUTSIDE `exclusive` (so the next `guardedRequest` re-enters the chain fresh)
- `testClient` uses `guardedRequest(client, clientver, 1)` once; returns plain text (no ✓/✗)
- `classifyError` tests `/banned/i` FIRST, then `code="302"` or `/client/i`
- `requestAnime` deleted (replaced by `guardedRequest`)
- `_resetForTests` also resets `chain = Promise.resolve()`

**Red → Green (A12b–e):**
- A12b: `Promise.all` of 3 concurrent `getAnime` calls → every gap ≥ 4000ms (real time, 300ms fetch stub)
- A12c: HTTP 503 three times → `{ error: 'http 503' }`, exactly 3 fetches, day count rose by 3, spacing
- A12d: Banned body → `banned_until` ≈ now+48h; next `getAnime` → `{ skipped: 'banned' }` with no fetch
- A12e: `day_calls=149`, first attempt 503 → one fetch, then `{ skipped: 'cap' }`

### Fix 2/3: Plain-text key test messages + number input CSS

**Commit:** `b2159d2` — `r1 fix 2/3: plain-text key test messages, MAL rating, number input style`

- Server sends plain text; the page adds ✓/✗
- `testClient` returns `{ ok: true, detail: 'Client accepted' }` or `{ ok: false, error: "AniDB doesn't recognise this client" }` etc.
- `MAL_RATING_MAP` exported from `mal.js`: `{ g: 'G', pg: 'PG', pg_13: 'PG-13', r: 'R', 'r+': 'R+', rx: 'Rx' }`
- `malKeyCheck` helper in `portal.js` (single fetch to `api.myanimelist.net`)
- CSS: `input[type=number]` added to both input selector lists

**Red → Green (A13b, A9b):**
- A13b: `testClient` results contain no ✓ or ✗ (detail === 'Client accepted', checked format, bad client plain text)
- A9b: HTTP test routes — MAL rating map (`'r'` → `'R'`), AniDB plain text (no ✗)

### Fix 3/3: Boot safety, table guards, real browser checks, hand-back

**Commit:** (this commit) — `r1 fix 3/3: awaited boot migration, table guards, real browser checks, hand-back`

- `src/server.js`: boot `setTimeout` now `await`s the migration before `tick()`
- `src/anime/migration.js`: `hasTable()` guards for `taste_ratings`, `taste_ignore`, `dont_recommend`, `recommended`; per-profile `try/catch`
- `src/recommendationStore.js`: renamed inner `skipResult` to `skipped` (was shadowing the helper)
- `test/anime-lane.js`: browser harness B1-B8 (real Playwright screenshots, Test/Clear button clicks, number input CSS check)
- `scripts/an1a-identity.js` deleted (identity check performed by Claude on a live-data copy)
- `test/screenshots/` deleted (screenshots now written to `DATA_DIR/screenshots/`)

**Red → Green (A15b):**
- A15b: Missing taste tables → `runAll` resolves, markers with zero counts (only drops `taste_ratings`, `taste_ignore`, `dont_recommend`; keeps `recommended`)

## STOP #1 and #2

**STOP #1:** The AniDB flood control (Fix 1/3) was the critical path. The `exclusive()` + `guardedRequest()` pattern ensures one request in flight server-wide, with ≥4000ms spacing enforced by `waitForSpacing` (in-memory + persisted `last_request_at`). The 150/day cap is checked per-client per Sydney day. The 48h ban circuit is triggered by a banned body or 3 consecutive 5xx/timeout failures.

**STOP #2:** The browser harness (B1-B8) required real Playwright interaction with the configure portal. The test seeds `settings.updateSettings({ keys: { tmdb_api_key: 'x'.repeat(32) }, llm: { groq_api_key: 'gsk_test' } })` so the portal leaves setup mode. Screenshots go to `path.join(process.env.DATA_DIR, 'screenshots')`. B5 stubs `anidb._setFetch` and `global.fetch` in-process, clicks Test buttons, and asserts rendered text.

## Browser harness evidence (B1-B8)

| Check | What it shows | Screenshot |
|-------|-------------|------------|
| B1 | Filters tab at 1280px — three engine columns (movie/series/anime) | `DATA_DIR/screenshots/filters-1280.png` |
| B2 | Change Anime to Marquee Anime — hint + save | `DATA_DIR/screenshots/anime-engine-change.png` |
| B3 | 400px — three engine fields stack vertically | `DATA_DIR/screenshots/filters-400.png` |
| B4 | Catalogs tab — 2/3 rows with anime off/on | `DATA_DIR/screenshots/catalogs.png` |
| B5 | Advanced → API Keys — section + blocks: AniDB test success (✓ Client accepted), bad client (✗ AniDB doesn't recognise this client), MAL test (✓ MyAnimeList key valid), number input not white, Clear empties both inputs | `DATA_DIR/screenshots/api-keys.png` |
| B6 | Server Config — MAL + AniDB fields present | `DATA_DIR/screenshots/server-config.png` |
| B7 | Mobile Filters — three engine selects at 390×844 | `DATA_DIR/screenshots/mobile-filters.png` |
| B8 | No page errors (no `pageerror` events during all browser checks) | — |

## R1 identity result

The R1 identity check (verifying that the AniDB client identity is correctly classified) was **performed by Claude on a live-data copy**. The `scripts/an1a-identity.js` script was deleted after the check was completed. The identity classification logic is covered by the A11 (parser fixture values) and A12d (banned body) tests.

## Self-audit output

### git diff --stat (Fix 3/3)

```
 scripts/an1a-identity.js   | 90 ---------------------------------------------
 src/anime/migration.js     | 87 +++++++++++++++++++++++++-------------------
 src/recommendationStore.js |  6 +--
 src/server.js              |  3 +-
 test/anime-lane.js         | 91 ++++++++++++++++++++++++++++++++++++++++++++--
 5 files changed, 141 insertions(+), 136 deletions(-)
```

### npm test (tail)

```
All MDBList user-keys checks passed (26). [run muz56tifzxjy]
Error: (none)
Exit Code: 0
```

### Browser check (tail)

```
  ✓ B5: Advanced → API Keys — section + blocks
  ✓ B6: Server Config — MAL + AniDB fields
  ✓ B7: Mobile Filters — three engine selects
  ✓ B8: No page errors

All anime-lane checks passed (31).
Error: (none)
Exit Code: 0
```
