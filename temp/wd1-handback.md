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

## 4. Review round 1 fixes (F1-F4) — ACCEPTED

| Fix | What | Status |
|---|---|---|
| **F1** | R10/R12/R13 monkey-patch `tmdb.releaseDateFor` (no network calls). Added R14, R15. | ✅ |
| **F2** | Live check rewritten. | ✅ |
| **F3** | `useReleaseDate` flag; trainer passes `false`. R16. | ✅ |
| **F4** | Hand-back updated. | ✅ |

## 5. Review round 2 fixes (G1-G5)

| Fix | What | Status |
|---|---|---|
| **G1** | Replaced `watchedStore.deleteForProfile` (BLOCKER — wipes entire local DB) with `watchedStore.removeWatched` (per-title). Comment explains why. | ✅ |
| **G2** | Exclusion set built from ALL statuses (`completed`, `plantowatch`, `watching`, `hold`, `dropped`) for movies, shows, AND anime. Pending shim check added. | ✅ |
| **G3** | Candidate names removed — script prints only the IMDb id (no guessed titles). | ✅ |
| **G4** | `--selftest` flag added: fake profile + stubbed `simkl.getAllItems` (no network, no DB). Two cases: all-absent (first chosen) and plantowatch-skip (second chosen). | ✅ |
| **G5** | Overwrite test prints `res4.watchedAt`; says "UNDETERMINED (no release date resolved)" when null. Only says UPDATED/IGNORED when `watchedAt` is non-null. | ✅ |

## 6. `--selftest` output

```
=== WD-1 Live Check: SELFTEST (fake profile, stubbed Simkl) ===

--- Case 1: all candidates absent ---
  Chosen movie: tt0068646
  Chosen series: tt0903747
  ✓ Case 1 passed (first candidate chosen when all absent)
--- Case 2: first movie candidate in plantowatch ---
  Chosen movie: tt0111161
  Chosen series: tt0903747
  ✓ Case 2 passed (plantowatch candidate skipped)

=== SELFTEST PASSED ===
```

## 7. Live check

**The live run against Siobhan has NOT been done.** It requires a running server with Simkl + TMDB configured inside the container. **James or Claude will run it** via:

```
docker exec ai_recommender node --experimental-sqlite /app/test/verify-release-date-live.js --dry
docker exec ai_recommender node --experimental-sqlite /app/test/verify-release-date-live.js
```

Expected findings to report after running:
1. Throwaway movie: stored `watched_at` in Simkl history (should be the movie's release date).
2. Throwaway series: stored `watched_at` in Simkl history (should be the series' first_air_date).
3. Overwrite test: does re-posting with `watched_at` update the date or does Simkl ignore it? (Print before/after.)

These findings decide the WD-2 design.

## 8. Notes

- There is no per-title delete function for `series_progress` in `watchedStore.js`. The throwaway series is just marked watched (no episode progress), so no `series_progress` row should exist for it. If one does appear after the live run, it will need manual cleanup.
- `deleteForProfile` appears in the script ONLY in explanatory comments (zero actual calls). Verified via grep.
