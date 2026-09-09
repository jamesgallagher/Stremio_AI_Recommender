# CP-03 — Ratings on every previewed title (Watch Later IMDb enrich + AI rating passthrough)

**Layer:** backend (build enrich + shared cache + serve projection) · **Depends
on:** nothing hard; pairs with [CP-01](catalog-preview-portal.md)/[CP-02](catalog-preview-companion.md)
(which read `imdbRating` off the served meta) · **Behavioral change for users:** the
rating **number** becomes present/accurate on Watch Later and AI rows (posters
already show a rating via RPDB — unchanged).

> This card resolves CP-01's "ratings for Watch Later" ask. **Important reframing
> after reading the code:** the rating is NOT missing from posters — every profile
> ships a default RPDB key (`t0-free-rpdb`, [`settings.js:19`](../src/settings.js) /
> [`config.js:92`](../src/config.js)) and `applyRpdb` overlays the rating onto the
> poster **client-side by URL substitution** ([`addon.js:37-45`](../src/addon.js)).
> So we do **not** fetch or cache poster images. The only gap is the numeric
> `imdbRating` field on the served meta, which CP-01/CP-02 show as a badge.

---

## Why this card exists

CP-01/CP-02 show an IMDb-rating badge from `meta.imdbRating`. Two sources don't
populate that field well:

- **AI recommendations** — the pool **already stores** a maintained `imdb_rating`
  ("the number on the poster badge", [`recommendationStore.js:79-81`](../src/recommendationStore.js))
  with a refresh lifecycle (`refreshStaleRatings` v6.38: NULLs chased daily, known
  ratings monthly, [`recommendationStore.js:35-41`](../src/recommendationStore.js)) —
  but `serveRecommendations` **drops it from the served meta**
  ([`recommendationStore.js:603-610`](../src/recommendationStore.js) returns only
  `id/type/name/poster/releaseInfo/genres`). So the badge is blank despite the value
  existing.
- **Watch Later** — built via `tmdb.metaByTmdbId`, which sets `imdbRating` from TMDB
  `vote_average` ([`tmdb.js:55`](../src/services/tmdb.js)), not the true IMDb number.
  So its badge disagrees with the RPDB poster overlay (IMDb) and with the curated
  lists (which resolve real IMDb via MDBList, [`rebuild.js:307-341`](../src/rebuild.js)).
  The imdb-only fallback path has no rating at all ([`rebuild.js:282-284`](../src/rebuild.js)).

Net: cheap, targeted fixes reusing infra that already exists — not a poster proxy.

---

## Design

### 1. AI catalogs — project the already-cached rating (one line)

The pool row carries `imdb_rating` (and `vote_average` as fallback). Surface it in
the serve map — no fetch, no cache, the value is already maintained:

```js
// recommendationStore.js serveRecommendations map (~line 603)
return picked.map((r) => ({
  id: r.imdb_id, type, name: r.title,
  poster: r.poster || null,
  releaseInfo: r.year ? String(r.year) : null,
  genres: (r.genres || '').split(',').filter(Boolean),
  imdbRating: r.imdb_rating != null ? r.imdb_rating.toFixed(1)
            : (r.vote_average ? r.vote_average.toFixed(1) : null),   // NEW
}));
```

Because CP-01's `servedCatalog` reuses `serveRecommendations`, this also lights up the
addon-served AI metas (the badge/`imdbRating` a client sees) — consistent everywhere,
zero request-path cost.

### 2. Watch Later — enrich with true IMDb rating via a shared 2-week cache

A new **shared** rating cache (fact about a title, not a profile — same pattern as the
CSM cache, [`store.js:139-152`](../src/store.js)):

```jsonc
// data/cache/imdb-ratings.json  — { "tt0111161": { rating: 9.3, at: <ms> }, "tt…": { rating: null, at } }
```

- `store.loadImdbRatingCache()` / `saveImdbRatingCache()`; TTL **14 days**
  (`RATING_TTL_MS`, env-tunable). **NULLs are cached too** (a genuinely unrated title
  shouldn't be re-fetched every build) — same discipline the CSM cache uses.
- In `buildWatchlistCatalog` ([`rebuild.js:264-288`](../src/rebuild.js)), after
  collecting the titles: resolve each id against the cache; **batch-fetch the misses**
  in ONE call via `mdblist.mediaInfoBatch` + `parseImdbRating`
  ([`mdblist.js:189,213`](../src/services/mdblist.js)) — the exact helpers the curated
  lists already use — store results (including nulls) with `at = now`, then set
  `meta.imdbRating` to the resolved IMDb value (fall back to the existing TMDB
  `imdbRating` when MDBList has no key/number, so we never regress a populated badge).
- **This runs at BUILD, not serve.** Watch Later builds in the background
  (`rebuildProfile`), so the "one expensive [fetch], then cached, reused across
  profiles and for 2 weeks" the request described happens off the request path —
  preserving the addon's "no network in the request path" invariant
  ([`addon.js:1`](../src/addon.js)). The shared cache means a title on five profiles'
  watchlists is fetched once per fortnight, not five times a day.
- MDBList key absent → skip enrichment, keep the TMDB-derived rating (graceful; the
  RPDB poster overlay is unaffected either way).

### 3. No poster image caching (explicitly)

RPDB already renders the rating onto the poster and serves it from its own CDN,
fetched by the client via the substituted URL. Caching poster **images** on our server
would add bandwidth, disk, and a serve endpoint for **no rating benefit** (the rating
is already on the poster) and would move poster delivery onto our box. Rejected —
unless a concrete need appears (e.g. serving rating-posters to a profile that has
deliberately cleared its RPDB key); noted as a future option, not built here.

---

## Tasks

- [ ] `recommendationStore.js`: add `imdbRating` (imdb_rating → vote_average fallback)
      to the `serveRecommendations` map.
- [ ] `store.js`: `loadImdbRatingCache`/`saveImdbRatingCache` + `RATING_TTL_MS` (14d).
- [ ] `rebuild.js` `buildWatchlistCatalog`: resolve IMDb ratings through the shared
      cache (batch-fetch misses via `mediaInfoBatch`/`parseImdbRating`, cache nulls),
      set `meta.imdbRating` (TMDB value as fallback).
- [ ] Tests (below).

## Acceptance criteria

- **AI rows:** a served AI meta (addon + preview) carries `imdbRating` equal to the
  pool's `imdb_rating` (or the TMDB fallback when null). No extra network at serve.
- **Watch Later:** a title with a known MDBList IMDb rating shows that number; the
  value is written to the shared cache and a second profile's build with the same
  title does **not** re-fetch within 14 days; an unrated title caches `null` and
  isn't re-fetched each build; with no MDBList key, the TMDB-derived rating still
  shows (no regression, no crash).
- **Posters unchanged:** no new poster/image endpoint; RPDB URL substitution and the
  default key behave exactly as before.
- **Request path stays network-free:** enrichment happens only in the build, never in
  a catalog/serve request.

## Test notes

- `serveRecommendations` unit: `imdbRating` present from `imdb_rating`; falls back to
  `vote_average`; `null` when both absent.
- Rating-cache unit: TTL expiry at 14d; nulls cached and honoured; shared across
  profiles (second lookup is a hit, no fetch — assert `mediaInfoBatch` called once for
  two profiles sharing a title).
- `buildWatchlistCatalog`: stub `mediaInfoBatch` to return a rating → `meta.imdbRating`
  is the IMDb value; stub a miss/no-key → TMDB fallback retained; assert nothing
  fetches on a warm cache.
- Confirm no serve-path regression via the addon catalog smoke tests.

## Out of scope

- Caching poster **images** / a poster proxy (see §3) — deferred unless a keyless-RPDB
  need appears.
- Changing the AI pool's own rating-refresh cadence (`refreshStaleRatings`) — reused
  as-is.
- Rating-based sorting/filtering of Watch Later (it stays in Simkl order per WL-KW).
