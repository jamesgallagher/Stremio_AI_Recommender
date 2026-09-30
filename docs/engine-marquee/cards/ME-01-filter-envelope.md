# ME-01 — FilterEnvelope

**Depends on:** — · **Blocks:** ME-05, ME-06 · Spec: §3

## Deliverable
`src/engines/marquee/filters.js`: **pure**, no network, no DB.

```js
compileEnvelope(filters, { nowYear, genreMap }) -> {
  discoverParams(),                 // §3.1 → object of TMDB query params
  prefilter(listItem) -> {ok, reason},   // §3.2 on {year, vote_average, vote_count, genre_ids, adult}
  hardFilter(row) -> {ok, reason},       // §3.3 on {imdb_id, imdb_rating, vote_average, vote_count, year, genres[], availability, certAU, certUS}
  stats(),                          // {rating, recency, genre, votes, adult, unavailable, cert_unknown, cert_over, no_imdb}
}
certMinAge(country, cert) -> number | Infinity | null   // §3.4 table; null = unknown
strictestMinAge(certAU, certUS) -> number | Infinity | null
auCeilingFor(judgementAge) -> 'G'|'PG'|'M'|'MA 15+'|null
```

**Reuse:** `tmdb.voteFloor(filters,'movie')` and `rebuild.judgementAge(filters)`. Don't
re-derive them. Genre names come from `genreMap` (`tmdb.getGenreMap`).

## Traps
- The rating rule must be **byte-for-byte the `selectServe` rule**: `shown = imdb_rating > 0 ? imdb_rating : vote_average`;
  only reject when `min_rating > 0 && shown > 0 && shown < min_rating`. "Unknown rating is kept."
- Recency applies only when `max_age_years > 0` and `year` is known.
- The `Anime` pseudo-genre is excluded by name at the hard filter (not a TMDB id).
- **Kids:** unknown cert means **drop** (MD-3). This is intentionally stricter than
  serve's `passesAgeBand`.
- AU cert strings from TMDB include spaces (`"MA 15+"`, `"R 18+"`). Normalise whitespace
  and case before lookup.

## Tests (smoke.js)
1. **Parity matrix:** ~40 fixture rows × 6 filter configs. For every row where `hardFilter` is ok
   and not kids-dropped, `selectServe([row], filters)` also keeps it. (The envelope must never
   be looser than serve. It may be stricter only via cert/availability/vote floor.)
2. The cert table (§3.4), including stricter-of-both and whitespace variants.
3. Kids: unknown cert dropped; `PG` kept at age 10 (judgement 11 ≥ 8); `M` dropped at age 10; `M` kept at 14 (judgement 15).
4. `discoverParams` for adult/kids/recency/excluded-genre configs.

## Acceptance
All tests pass, and `npm test` stays green.
