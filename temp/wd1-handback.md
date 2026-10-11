# WD-1 Hand-back — Stamp the release date when marking a title as viewed

## 1. Branch / Commits / PR

- **Branch:** `feature/wd1-release-date-watched` (off `origin/main`)
- **Commit:** `6c83189` — `feat: WD-1 — stamp the release date when marking a title as viewed`
- **PR:** [#70](https://github.com/jamesgallagher/Stremio_AI_Recommender/pull/70) (base `main`)
- **Version:** `7.55.1` (plain semver, no `-beta`)

## 2. Test counts

| Before (origin/main) | After (HEAD) |
|---|---|
| 22 suites | 23 suites (added `test/release-date.js`) |
| All green | All green |

New tests: R1-R12 in `test/release-date.js` (12 assertions), R13 in `mobile/test/mobile.smoke.js` (1 test).

## 3. Red evidence (shown before implementation)

R1 failed on first run:
```
AssertionError: Expected values to be strictly equal:
+ actual - expected
+ undefined
- '2010-07-16T00:00:00Z'
    at test/release-date.js:18:10
```

## 4. Files changed

| File | Change |
|---|---|
| `src/releaseDate.js` | **New** — `resolveReleaseDate()` |
| `test/release-date.js` | **New** — R1-R12 |
| `src/services/tmdb.js` | Added `releaseDateFor()` (one lean TMDB call) |
| `src/markWatched.js` | `buildWatchedHistoryBody` accepts `watchedAt`; `markWatched` resolves date, maps anime→series, returns `watchedAt`; header comment rewritten |
| `src/trainer.js` | Passes `year` from meta's `releaseInfo` |
| `test/smoke.js` | Updated existing assertion + added watchedAt checks |
| `test/integration.js` | Updated markWatched args assertion (now includes `year: null`) |
| `mobile/test/mobile.smoke.js` | R13: anime type returns 200 |
| `package.json` | Version 7.55.1; added `test/release-date.js` to test chain |

## 5. Frozen files (unchanged)

`recency.js`, `db.js`, `watchedStore.js`, `simkl.js`, `tasteConfig.js`, `seriesEngagement.js` — all verified unchanged via `git diff`.

## 6. Live check

**Not yet run.** The live check requires a running server with Simkl + TMDB configured against the Unraid test profile (Siobhan). The script is at `test/verify-release-date-live.js`.

**To run:**
```
node --experimental-sqlite test/verify-release-date-live.js
```

**Expected findings to report here after running:**
1. Throwaway movie: stored `watched_at` in Simkl history (should be the movie's release date).
2. Throwaway series: stored `watched_at` in Simkl history (should be the series' first_air_date).
3. Already-in-history title: does re-posting with `watched_at` update the date or does Simkl ignore it? (Print before/after.)

These findings decide the WD-2 design.

## 7. What could/couldn't be verified

- **Verified:** All R1-R13 pass; `npm test` fully green (23 suites); frozen files untouched.
- **Not verified (needs live server):** Whether Simkl actually stores the `watched_at` we send, and whether re-posting updates an existing entry's date. This is the live check above.
