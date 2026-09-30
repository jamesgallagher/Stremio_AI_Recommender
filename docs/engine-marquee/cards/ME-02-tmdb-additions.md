# ME-02 — TMDB service additions

**Depends on:** — · **Blocks:** ME-05, ME-06 · Spec: §2, §5

## Deliverable (in `src/services/tmdb.js`, all via the existing governed `get`)
| Function | Endpoint | Returns |
|---|---|---|
| `getSimilar(apiKey, tmdbId, {page})` | `movie/{id}/similar` | same item shape as `getRecommendations` |
| `trendingMovies(apiKey, window, pages)` | `trending/movie/{day\|week}` | `[{tmdb_id, rank, title, year, genre_ids, vote_average, vote_count, popularity, adult, poster}]` with a 1-based **rank** across pages |
| `discoverMovies(apiKey, params, {page})` | `discover/movie` | `getRecommendations` item shape |
| `collectionParts(apiKey, collectionId)` | `collection/{id}` | parts in the same item shape + `release_date` |

**Deep meta:** extend the `deepMeta` append to `credits,keywords,external_ids,release_dates`,
and `normalizeDeepMeta` gains three fields for movies:
- `certAU`, `certUS`: first non-empty `certification` in that country's `release_dates`
  (reuse the logic of `pickCertification`, split per country)
- `availability`: `movieAvailability(data.release_dates?.results)`

This is backward-compatible for Glass (extra fields are ignored). Because
`glass_metadata` caches permanently, ME-06 re-fetches rows missing `availability`
(see ME-06).

**Trending cache:** a new small table `marquee_trending (window TEXT, rank INT, tmdb_id TEXT, item TEXT, fetched_at INT)`
with 6 h TTL, the `ensureFresh` pattern from `simklTrending.js`, and graceful stale-serve on error.
It lives in `src/engines/marquee/trendingCache.js`.

## Tests
- `normalizeDeepMeta` with a fixture containing AU+US release_dates → certs + availability.
- Rank continuity across pages in `trendingMovies` (stubbed `get`).
- Trending cache: fresh → no fetch; stale + fetch error → serves stale.

## Acceptance
Existing Glass tests are unchanged and green. The new tests pass.
