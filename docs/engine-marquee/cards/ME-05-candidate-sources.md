# ME-05 — Candidate sources S1–S7

**Depends on:** ME-01..04 · **Blocks:** ME-06 · Spec: §5, §6.2

## Deliverable
`src/engines/marquee/sources.js`
```js
gatherCandidates(profile, ctx, { taste, brief, seeds, envelope, cfg, fetchers, log }) -> Candidate[]  // ≤ cfg.lookup_cap (400)
```
Each `Candidate`: `{type:'movie', tmdb_id, title, year, genre_ids, vote_average, vote_count, popularity, adult, poster, sources:Set, seeds:Set, trending:{tmdbWeekRank, tmdbDayRank, simklWatched, simklDrop}}`.

Steps:
1. S1: per seed `getRecommendations` + `getSimilar` (top 12 each), chunks of 5 like Genesis.
2. S2: `simklCache.ensureRecs` for the seeds' simkl ids → map to tmdb ids.
3. S3: ~8 discover queries built from `taste` top dims, **always merged with `envelope.discoverParams()`**.
4. S4: collections with positive affinity → `collectionParts` → unwatched.
5. S5: `trendingCache` (TMDB week/day) + `simklTrending.getList('movies')`. Stamp ranks onto `trending`.
6. S6: when `brief` is present, run the §6.2 suggestion prompt (cached, `kind='suggest'`) → `tmdb.resolveTitle(apiKey,'movie',title,year)`.
7. Merge by tmdb_id (union sources/seeds, keep the best ranks). Exclude `ctx.watchedIds.tmdb` and `ctx.dont`.
   Apply `envelope.prefilter`.
8. S7: exploration reserve (5%), as in Glass `candidates.js` G.
9. Cheap pre-score (§5) → keep the top `lookup_cap`.

`ctx.stats`: `seeds, raw, strong (post-merge), kept (post-truncate)` plus per-source counts in `ctx.stats.sources`.

## Traps
- S6 output is **untrusted**. The only fields taken are title and year, and resolution goes through TMDB search.
- Trending items not in any taste source still enter (they're S5), but ME-06's taste gate
  keeps off-taste blockbusters low. Don't pre-drop them here beyond the prefilter.
- Every fetcher is injectable (`fetchers.recs/similar/discover/collection/trending/simklRecs/chat/resolve`) for hermetic tests.

## Tests
Hermetic fixture run: correct source tagging, dedupe/union, watched + dont excluded,
prefilter applied, truncation to cap, S6 skipped when `brief` is null, a discover query
always carries the envelope params.

## Acceptance
Tests pass. A stubbed run makes ≤ the documented calls per source.
