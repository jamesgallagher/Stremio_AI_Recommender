# ME-04 — Rating-weighted taste model + LLM taste brief

**Depends on:** ME-03 · **Blocks:** ME-05 · Spec: §4, §6.1

## Deliverable
`src/engines/marquee/taste.js`
- `buildEvents(profileId, cfg)`: calls Glass `events.buildEventList(profileId, 'movie', glassCfgLike)`,
  then **re-weights** watched events whose `tmdb_id` is in `marquee_ratings` using the §4 table
  (config `marquee.rating_weights`). Negatives are unchanged.
- `buildTaste(profileId, cfg)`: `glass/tasteModel.buildTasteModel(profileId, 'movie', cfg, { events })`.
  Before building, top up enrichment of watched movies with `glass/watchedEnrichment.enrichWatchedBatch`
  (paced, bounded) so dims aren't thin.
- `seedsFor(profileId, cfg)`: top `cfg.seed_cap` (40) watched movies by `ratingWeight × blendedWeight`,
  excluding ratings ≤4. Returns `[{tmdb_id, simkl_id, title, weight}]`.
- `tasteBrief(profileId, taste, {chat, chain, log})`: §6.1 prompt, cached in `marquee_llm_cache`
  (`kind='brief'`, key = history hash). Returns `null` when no local LLM (callers degrade).

Cache table (shared by ME-04/05/07):
```sql
marquee_llm_cache(profile_id, kind, key, value TEXT /*JSON*/, at INT, PRIMARY KEY(profile_id, kind, key))
```

## Traps
- Glass config shapes are reused, not mutated. Pass a Marquee config that includes the fields
  `tasteModel` reads (`half_life_days`, `horizon_blend`, `feedback`, `taste_dims`).
- The brief prompt must **not** mention age suitability. Age belongs to the shared gate.

## Tests
- A 9-rated watch outweighs an unrated one, and a 2-rated watch pushes that director negative.
- The brief cache hits when history is unchanged. A stubbed chat returning garbage gives `null` (no throw).

## Acceptance
Tests pass. With no custom LLM, `tasteBrief` returns `null` and makes no network call.
