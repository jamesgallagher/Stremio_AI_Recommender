# WD-1 Hand-back — Stamp the release date when marking a title as viewed

## 1. Branch / Commits / PR

- **Branch:** `feature/wd1-release-date-watched` (off `origin/main`)
- **PR:** [#70](https://github.com/jamesgallagher/Stremio_AI_Recommender/pull/70) (base `main`)
- **Version:** `7.55.1` (plain semver, no `-beta`)

## 2. Test counts

| Before (origin/main) | After (HEAD) |
|---|---|
| 22 suites | 23 suites (added `test/release-date.js`) |
| All green | All green |

New tests: R1-R16 in `test/release-date.js` (16 assertions), R13 in `mobile/test/mobile.smoke.js` (1 test).

## 3. Red evidence

**R1** (first build):
```
AssertionError: Expected values to be strictly equal:
+ actual - expected
+ undefined
- '2010-07-16T00:00:00Z'
    at test/release-date.js:18:10
```

**R10** (review round 1 — temporarily broke `markWatched` to not pass `watchedAt`):
```
✗ R10: markWatched passes TMDB-resolved watched_at to Simkl body; result has watchedAt: Expected values to be strictly equal:
```

**R16** (review round 1 — temporarily broke `useReleaseDate` check):
```
✗ R16: markWatched with useReleaseDate:false -> no watched_at, resolver never called: Expected values to be strictly equal:
```

## 4. Review round 1 fixes (F1-F4)

| Fix | What | Status |
|---|---|---|
| **F1** | R10/R12/R13 monkey-patch `tmdb.releaseDateFor` (no network calls). Added R14 (null date → no watched_at), R15 (future date → clamped to now). No `[tmdb] releaseDateFor ... failed` noise in output. | ✅ |
| **F2** | Rewrote `test/verify-release-date-live.js`: uses `config.listProfiles()`, `simkl.getAllItems()`, `simkl.removeFromHistory()`. Picks throwaway titles from a hard-coded candidate list. Tests overwrite behaviour on the throwaway movie (no `EXISTING_TITLE`). `--dry` flag prints the plan. Smoke-tested locally (reports "Profile not found" outside the container, as expected). | ✅ |
| **F3** | Added `useReleaseDate` flag to `markWatched` (default `true`). `markFinished` passes `useReleaseDate: false` — trainer "mark finished" does NOT back-date. Added R16. Reverted the `year` pass-through in `src/trainer.js`. | ✅ |
| **F4** | This hand-back updated. | ✅ |

## 5. Files changed (total)

| File | Change |
|---|---|
| `src/releaseDate.js` | **New** — `resolveReleaseDate()` |
| `test/release-date.js` | **New** — R1-R16 |
| `src/services/tmdb.js` | Added `releaseDateFor()` (one lean TMDB call) |
| `src/markWatched.js` | `buildWatchedHistoryBody` accepts `watchedAt`; `markWatched` resolves date (when `useReleaseDate`), maps anime→series, returns `watchedAt` |
| `src/trainer.js` | Passes `useReleaseDate: false` (no back-dating) |
| `test/smoke.js` | Updated existing assertion + added watchedAt checks |
| `test/integration.js` | Updated markWatched args assertion (`useReleaseDate: false`) |
| `mobile/test/mobile.smoke.js` | R13: anime type returns 200, monkey-patched tmdb |
| `package.json` | Version 7.55.1; added `test/release-date.js` to test chain |
| `test/verify-release-date-live.js` | **New** — live check script (not in npm test) |

## 6. Live check

**Still pending.** The live check requires a running server with Simkl + TMDB configured against the Unraid test profile (Siobhan). The script is at `test/verify-release-date-live.js` and supports `--dry`.

**To run:**
```
docker exec ai_recommender node --experimental-sqlite /app/test/verify-release-date-live.js --dry
docker exec ai_recommender node --experimental-sqlite /app/test/verify-release-date-live.js
```

**Expected findings to report here after running:**
1. Throwaway movie: stored `watched_at` in Simkl history (should be the movie's release date).
2. Throwaway series: stored `watched_at` in Simkl history (should be the series' first_air_date).
3. Overwrite test: does re-posting with `watched_at` update the date or does Simkl ignore it? (Print before/after.)

These findings decide the WD-2 design.

## 7. What could/couldn't be verified

- **Verified:** All R1-R16 pass; `npm test` fully green (23 suites); no `[tmdb]` noise in test output; frozen files untouched.
- **Not verified (needs live server):** Whether Simkl actually stores the `watched_at` we send, and whether re-posting updates an existing entry's date. This is the live check above.
- **Smoke test (local):** `node --experimental-sqlite test/verify-release-date-live.js --dry` runs without throwing (reports "Profile not found" since no Siobhan profile exists outside the container).
