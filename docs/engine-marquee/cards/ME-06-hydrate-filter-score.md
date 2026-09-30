# ME-06 — Metadata lookup, hard filter, deterministic scoring

**Depends on:** ME-05 (and ME-01, ME-02) · **Blocks:** ME-07, ME-08 · Spec: §3.3, §7

## Deliverable
`src/engines/marquee/scoring.js`
1. **Lookup:** `glass/metaStore.enrich(tmdbKey,'movie',id)` per candidate (chunks of 8). If a cached
   meta is missing `availability`/`certAU`/`certUS` (pre-ME-02 rows), force a refetch. If
   `availability` is `NOT_YET` and older than 7 days, refetch (the title may have gone to home release).
2. **IMDb ratings:** when an MDBList key is set, `mdblist.cachedImdbRatings(key,'movie',imdbIds)` → attach `imdb_rating`.
   This is only for the envelope and quality. The pipeline still owns the stored `imdb_rating` (I4).
3. **Hard filter:** `envelope.hardFilter(row)`, and keep `envelope.stats()` for ME-08 logging.
4. **Features + weights** exactly as §7. `taste_match` reuses `glass/scoring.tasteMatch`,
   `simklMomentum` reuses `glass/scoring.trendingMomentum`. The `trending_eff` taste gate uses
   `cfg.trending_gate` (0.35).
5. Weights are renormalised over **available** features. `llm_fit` is always absent here
   (ME-07 folds it in).
6. Fill the preResolved fields (§8.4). `algorithm_version = cfg.ALGORITHM_VERSION` ('marquee-m1').

## Traps
- **Never write `imdb_rating` onto the returned candidate.** It must not reach the pool from
  the engine (I4). Keep it in `score_components.inputs` only.
- The `poster` in metaStore is already a full URL. Don't double-prefix it.
- `genres` returned as a CSV **string** (pipeline/upsert contract). `primary_genre` = first genre.

## Tests
- Trending gate: `taste_match=0` gives `trending_eff=0`, and `taste_match≥0.35` gives the full `trending_raw`.
- Bayesian quality: few votes pull towards C.
- Renormalisation with missing features sums to 1.
- A `NOT_YET` title is dropped, and a kids-profile unknown-cert title is dropped.
- A returned candidate has no `imdb_rating` key.

## Acceptance
Tests pass. The output is sorted by `rankScore` desc and every row passes `hardFilter`.
