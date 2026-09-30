# ME-03 — Simkl ratings + collaborative recommendations

**Depends on:** ME-00 (shapes) · **Blocks:** ME-04, ME-05 · Spec: §2, §4, §5 (S2)

## Deliverable
In `src/services/simkl.js` (authed GET via the existing `authedGet` → `simkl_get` governor lane):
- `getRatings(profile, 'movies')` → `[{tmdb_id, imdb_id, simkl_id, rating (1–10), rated_at}]`
- `getMovieSummary(profile, simklId)` → `{ users_recommendations: [{tmdb_id?, imdb_id?, simkl_id, title, year}] }`
  (use the ids ME-00 confirmed; if tmdb is missing, resolve via `tmdb.findByImdbId`)

Engine-owned tables (`src/engines/marquee/simklCache.js`). **Don't touch the shared schemas.**
```sql
marquee_ratings   (profile_id, tmdb_id, rating, rated_at, PRIMARY KEY(profile_id, tmdb_id))
marquee_simkl_recs(simkl_id PRIMARY KEY, recs TEXT /*JSON*/, fetched_at INT)   -- server-wide, 30-day TTL
```
- Ratings sync: **activities-gated**. Re-pull only when Simkl `/sync/activities` shows the
  ratings timestamp moved. Reuse the sync-state approach from `watchedStore.syncFromSimkl`,
  in the engine's own row.
- Recs fetch: `ensureRecs(profile, simklIds, {maxUncached: 40})`. It skips cached/fresh ids
  and never exceeds the cap per build.

## Traps
- **Simkl suspends client_ids for abuse, and there's no appeal.** Every call goes through the
  governor, with no parallel bursts beyond it and no retries in a loop.
- Seeds need a `simkl_id`. The watched store has it (`watched.simkl_id`).

## Tests
Stubbed fetch: ratings parse (per the ME-00 shape), activities gate (no refetch when unchanged),
recs cap honoured (41st uncached id is not fetched), TTL expiry refetch.

## Acceptance
No Simkl write endpoints are used. The tests pass.
