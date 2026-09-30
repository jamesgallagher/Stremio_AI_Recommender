# Marquee Engine — Technical Design Spec

**Version:** 0.1 · **Status:** DESIGN ONLY (no code, not registered)
**Kind:** a *candidate-producer* engine, `supportedTypes: ['movie']`
**Depends on:** [`../engine-abstraction/00-overview.md`](../engine-abstraction/00-overview.md)
(the seam), [`../engine-abstraction/CONFORMANCE.md`](../engine-abstraction/CONFORMANCE.md)
(definition of done), and the Glass data layers ([`../engine-glass/`](../engine-glass/)).

> **Source sign-off:** every data source below was proposed and approved by James on
> 2026-09-26: TMDB, Simkl (ratings, `users_recommendations`, trending CDN), MDBList and
> the local LLM. TVDB, OMDb and Trakt were researched and **rejected** (§2). Adding any
> other source needs a new sign-off.

---

## 1. Why a new engine: what it fixes

Four gaps in the current build/serve path, found by reading the v7.15.3 code:

| # | Gap | Where | Marquee's answer |
|---|---|---|---|
| G1 | **Filters only apply at serve.** Genesis/Glass store up to 300 titles without looking at the rating floor, recency window or excluded genres. `selectServe` removes non-matching titles afterwards, so strict filters leave a thin list. | `recommendationStore.selectServe` (~L586) | **FilterEnvelope** (§3): the same rules applied at the source, before the per-title lookup, and after it. Only titles that pass every filter are stored. |
| G2 | **The age gate doesn't see real movie classifications.** `ageGatePool` sends the LLM the title/year/one genre plus `age_classification`, which is only ever a MAL band (anime). The serve re-check `certMinAge` knows only `G/PG/PG-13/R/R+`. | `recommendationStore.ageGatePool` (~L331), `certMinAge` (~L531) | Kids pre-filter on **real AU/US certs** from TMDB `release_dates` (§3.3, MD-3), plus optional shared card **SH-01** to feed certs to the gate for every engine. |
| G3 | **Trending ≠ streamable.** TMDB/Simkl trending lists are full of films that are only in cinemas. | none (WL-AV logic exists only for Watch Later) | Reuse `tmdb.movieAvailability`: a `NOT_YET` title is never stored. |
| G4 | **The LLM only re-orders.** Glass sends ~120 titles for one list-wise re-rank. It never finds candidates and never scores each title for fit. | `engines/glass/rerank.js` | The LLM writes a taste brief, **suggests** candidates (S6), and **scores each shortlisted title for fit** in small cached batches (§6). |

---

## 2. Research: data sources

| Source | Verdict | Use |
|---|---|---|
| **TMDB** (key in Server Config; ~40 req/s, no daily cap; governor lane `tmdb`) | **Primary** | `/movie/{id}/recommendations`, `/movie/{id}/similar`, `/trending/movie/{day\|week}` (paged, ≤1000 pages), `/discover/movie` with server-side filters (`certification_country`, `certification.lte`, `primary_release_date.gte`, `vote_average.gte`, `vote_count.gte`, `with_genres`, `without_genres`, `with_keywords`, `with_people`, `sort_by`), `/collection/{id}`, `/search/movie` (via `tmdb.resolveTitle`). **One append call per title:** `credits,keywords,external_ids,release_dates` returns imdb id, deep taste dims, AU/US certification and home-release availability together, and TMDB counts it as one request. |
| **Simkl** (per-profile OAuth already wired; `simkl_get` ~8/s; suspension risk ⇒ must stay governed + cached) | **Primary** | Watch history (exists). **User ratings 1–10** (`GET /sync/ratings/movies`): the strongest explicit taste signal, and not used today. **`users_recommendations`** on `GET /movies/{id}`: collaborative "Simkl users also liked", independent of TMDB, returned by default on summary endpoints. **Trending CDN** `week_500.json` movies (exists, `simklTrending.js`): `watched` velocity + `drop_rate`. |
| **MDBList** (optional key; 1000/day; lane `mdblist`) | **Use** | The exact IMDb rating, so the envelope's rating check matches the serve floor. `mdblist.cachedImdbRatings` (14-day cache). |
| **Local LLM** (custom provider in `settings.llmChain`) | **Heavy use** | Taste brief, title suggestions, fit scoring, "because…" reasons. **Local only:** same rule as Glass rerank, so Groq quota is never spent on bulk work. |
| TVDB v4 | Rejected | Free under $50k/yr with attribution, or $12/yr subscriber keys. TV-centric, no recommendations or trending, nothing for movies that TMDB lacks. Revisit for a series engine. |
| OMDb | Rejected (optional later) | 1000/day. Its RT/Metacritic/`Rated` data overlaps MDBList + TMDB certs, so it isn't worth another key. |
| Trakt | Rejected | The project moved to Simkl. Trending/related are covered by TMDB + Simkl. |

**Unverified until ME-00:** the exact shapes of `/sync/ratings/movies` and
`users_recommendations`, and whether `certification.lte` drops uncertified titles.

---

## 3. Stage 0: FilterEnvelope (the core of the design)

A single **pure** module (`src/engines/marquee/filters.js`) compiled from
`profile.filters`. It is used in three places, from cheapest to strictest:

1. **At source:** TMDB discover params (§3.1).
2. **Cheap prefilter:** on list-payload fields before the per-title lookup (§3.2).
3. **Hard filter:** on fully looked-up data (§3.3).

It **only removes titles** (never adds), so it fits CONFORMANCE's "pre-filtering as an
optimization is fine". The shared age gate (I1) and serve filters (I2) remain the
guarantee. It **must never be looser** than `selectServe`: ME-01 proves parity
with a shared fixture matrix.

### 3.1 Source params (discover only)
| Filter | TMDB param |
|---|---|
| `max_age_years > 0` | `primary_release_date.gte = ${nowYear − max_age_years}-01-01` |
| `min_rating > 0` | `vote_average.gte = min_rating − 0.5` (loose. TMDB ≠ IMDb, so the hard filter decides) |
| vote floor | `vote_count.gte = tmdb.voteFloor(filters, 'movie')` |
| `excluded_genres` | `without_genres = ids` (via the genre map; "Anime" isn't a TMDB genre and is handled in the hard filter) |
| `age_limit > 0` | `certification_country=AU&certification.lte=<ceiling>` (ceiling from §3.4) |
| always | `include_adult=false`, `with_release_type=4\|5\|6` for home release (see ME-00 check) |

### 3.2 Cheap prefilter (list payload: `year`, `vote_average`, `vote_count`, `genre_ids`, `adult`)
Drop titles that are `adult`, below the vote floor, outside the recency window, in an
excluded genre, or clearly below the rating floor (`vote_average < min_rating − 1.0`,
a wide margin because the payload has no IMDb rating).

### 3.3 Hard filter (looked-up data + MDBList)
A title is stored only if **all** hold:
- `imdb_id` present (servable).
- **Rating:** `shown = imdb_rating > 0 ? imdb_rating : vote_average`. If `min_rating > 0`
  and `shown > 0`, then require `shown ≥ min_rating`. This is **exactly** the
  `selectServe` rule, including "unknown rating is kept".
- **Recency:** `!(max_age_years > 0 && year && year < nowYear − max_age_years)`.
- **Genres:** none of the full genre list (including the `Anime` tag) is in `excluded_genres`.
- **Vote floor:** `vote_count ≥ tmdb.voteFloor(filters, 'movie')`.
- **Streamable:** `tmdb.movieAvailability(release_dates) !== 'NOT_YET'`.
- **Kids** (`age_limit > 0`), per MD-3: `minAge = strictest(AU, US)` must be **known** and
  `≤ rebuild.judgementAge(filters)` (= `age_limit + 1`). A title with no classification is dropped.

### 3.4 Certification → minimum age
| AU (ACB) | min age | US (MPA) | min age |
|---|---|---|---|
| E, G | 0 | G | 0 |
| PG | 8 | PG | 8 |
| M | 15 | PG-13 | 13 |
| MA 15+ | 15 | R | 17 |
| R 18+, X 18+, RC | ∞ (never) | NC-17 | ∞ |

If both countries have a cert, use the **stricter** one. Other values (`NR`, empty,
unknown strings) count as unknown. AU `M` has no legal restriction, but ACB recommends it
for 15+, so it maps to 15: on a kids profile we err towards exclusion. The discover ceiling
for §3.1 is the highest AU cert whose min age ≤ `judgementAge`.

---

## 4. Stage 1: taste model

- **Base:** Glass `tasteModel.buildTasteModel(profileId, 'movie', cfg, { events })` and
  `events.buildEventList`, over the shared deep-metadata store (`glass/metaStore`). Dims:
  genres, keywords, directors, cast, collection, decade, language, runtime band.
- **New: Simkl ratings as event weights.** For rated watched titles, replace the plain
  `watched: +1` with:
  | Simkl rating | weight |
  |---|---|
  | 9–10 | +2.0 |
  | 7–8 | +1.2 |
  | 5–6 | +0.4 |
  | 1–4 | −1.2 |
  Negatives still apply: `dont_recommend` user −1.5, decayed −0.5. Recency decay uses
  Glass's three horizons (movie half-lives 21/120/540 days).
- **LLM taste brief** (§6.1): natural-language taste themes used by S6 and the fit scoring.

---

## 5. Stage 2: candidate sources

About 1,500 raw → dedupe → exclude watched/`dont_recommend` → cheap prefilter →
cheap pre-score → **top ~400** go to the per-title lookup (the resolve budget). Each
candidate keeps a `sources[]` list (for the consensus score and reasons) and a `seeds[]` list.

**Seeds:** the top ~40 watched movies by `rating_weight × blended recency`. Anything
rated ≤4 is never used as a seed.

| # | Source | Volume / guardrails |
|---|---|---|
| S1 | TMDB `/recommendations` + `/similar` per seed | top 12 of each per seed |
| S2 | Simkl `users_recommendations` per seed | 30-day cache per movie. ≤ 40 uncached GETs per build (`simkl_get`). Skipped silently on error. |
| S3 | TMDB discover by taste | ~8 queries × 2 pages, `sort_by=vote_average.desc` or `popularity.desc` alternating. Axes: top-3 genres, top-5 keywords (OR), top-3 directors / top-3 cast (`with_people`). §3.1 params always applied. |
| S4 | Franchise continuation | `/collection/{id}` for collections with positive affinity → **unwatched** entries only. |
| S5 | Trending | TMDB `trending/movie/week` pages 1–5 (100) + `day` pages 1–2 (40) + Simkl `week_500` movies. These ranks feed `trending_raw` (§7). Cached server-wide for 6 h (a new small table, like `simkl_trending`). |
| S6 | LLM suggestions | Prompt = taste brief + filter rules in words ("released ≥ YEAR", "suitable for age N", "not these genres") + 40 recent titles to avoid. Output: `[{title, year}]` × ~60 → `tmdb.resolveTitle`. Titles that don't resolve are dropped. **The LLM's own claims are never trusted:** every suggestion goes through the same envelope. |
| S7 | Exploration | High-quality trending/discover titles **outside** the top-6 genres, ~5% of output reserved (as in Glass G). |

**Cheap pre-score** (no network): `0.45·genreAffinity + 0.20·trending_raw + 0.15·(vote_average/10) + 0.20·min(1, #sources/3)`.

---

## 6. Local LLM usage

All calls go through `llm.chat(localChain, …)`, where `localChain = settings.llmChain().filter(p => p.type === 'custom')`.
Validation uses `llm.extractArray`. Background build only. Each call gets its own
timeout (default 60 s, env `MARQUEE_LLM_TIMEOUT_MS`). With **no local provider**,
S6 is skipped and `llm_fit` is removed from the weights, which are then rebalanced.

| # | Call | When | Cache key |
|---|---|---|---|
| 6.1 | **Taste brief:** input top ~60 movies (title, year, user rating, top genres). Output `{loves[], avoids[], moods[], eras[], standout_titles[]}`. | history/ratings changed | `hash(sorted (tmdb_id, rating, watched_at))` |
| 6.2 | **Suggestions** (S6), ~60 titles | brief changed or every 7 days | brief hash + filter hash |
| 6.3 | **Fit scoring:** top ~250 by deterministic score, batches of 20. Each item: `id, title, year, overview[:160], director, keywords[:5], cert`. Output `[{id, fit: 0–10, reason: ≤14 words}]`. | uncached candidates only | `(profile, tmdb_id, briefHash)`, TTL 14 d |

Safety rules (same as Glass rerank):
- Unknown or duplicate ids are ignored, and a missing item gets a neutral `fit = 5`.
- The LLM **never judges age** (I1 belongs to the shared gate).
- The LLM **never adds a title** that skips the envelope.
- A reason is display-only (`because_title`).

Rough cost at ≥30 tok/s: a batch of 20 is about 450 output tokens, so ~15 s. A cold build
is ~13 batches (~3–4 min). Steady state is usually 0–3 batches.

---

## 7. Stage 4: scoring

Every feature is in [0,1]. The weights are **Tier-1 defaults**, versioned as
`algorithm_version: 'marquee-m1'`. They're iterable, and Tier-2 admin overrides can change them.

```
rankScore = 0.28·taste_match
          + 0.20·llm_fit          (fit/10)
          + 0.20·trending_eff
          + 0.14·quality
          + 0.12·consensus
          + 0.06·freshness
          − penalty
```

| Feature | Definition |
|---|---|
| `taste_match` | Glass `scoring.tasteMatch(meta, taste, cfg)` over the rating-weighted taste model |
| `llm_fit` | §6.3 (removed and weights rebalanced when unavailable) |
| `trending_raw` | `max(tmdbWeek, tmdbDay + rising, simklMomentum)`. `tmdbX = 1 − ln(rank)/ln(N+1)`. `rising = +0.1` when in the day list but outside week top-50. `simklMomentum = glass/scoring.trendingMomentum(cand)`. |
| `trending_eff` | **`trending_raw × clamp(taste_match / 0.35, 0, 1)`** (MD-2: trending only lifts films that already fit) |
| `quality` | Bayesian average `(v·R + m·C)/(v + m)`, R = IMDb rating if known else TMDB, v = TMDB votes, m = 2000, C = 6.5, then `/10` |
| `consensus` | `min(1, ln(1 + distinctSources + 0.5·extraSeeds) / ln(8))`, counting S1/S2/S3/S4/S6 (not trending, to avoid double-counting) |
| `freshness` | Linear in year across the user's recency window (or 30 years when unlimited), floored at 0.2 |
| `penalty` | 0.05 × prior `decayed` count for the same collection; the franchise cap is in §8 |

`score_components = { features, weights, matched, sources, seeds, llm: {fit, reason}, trending: {tmdbWeekRank, tmdbDayRank, simklWatched} }`.

---

## 8. Stage 6: shaping the output

1. Sort by `rankScore` desc.
2. **Franchise cap:** at most 2 per `collection.id`. The excess isn't stored this build.
3. **Oversupply target:** at least `max(150, list_size × 6)` stored titles that pass the envelope,
   so the shared LLM age veto and serve-time genre balancing still fill `list_size`. On
   a shortfall, log `[marquee] shortfall: N/target — top blockers: rating X, recency Y, cert Z …`
   (counts per filter, collected by the envelope) so an over-strict filter is visible.
4. Return ≤ 300 with `preResolved: true` fields set: `imdb_id`, `poster` (full URL),
   `genres` (CSV names), `primary_genre`, `vote_average`, `vote_count`, `popularity`,
   `title`, `year`, `rankScore`, `reason`, `recCount = sources.length`,
   `scoreComponents`, `algorithmVersion`.

---

## 9. Descriptor

```js
{
  id: 'marquee',                     // frozen at ME-09
  name: 'Marquee Engine',
  description: "Movies picked from what you've watched and how you rated it, what people "
    + "like you enjoyed, and what's popular right now — only titles that match your "
    + 'filters and are already out to watch at home.',
  supportedTypes: ['movie'],
  capabilities: { providesRankScore: true, preResolved: true, serveOrder: 'affinity', unrestricted: false },
  requirements(profile) { /* TMDB key + Simkl connection; MDBList + local LLM optional */ },
  generate,
}
```
It ships **globally disabled** (SC-07), and series keep whatever engine the profile has.

---

## 10. Invariants (Marquee-specific, on top of I1–I7)

- **MI-1 Envelope never looser than serve.** Proved by the ME-01 parity matrix.
- **MI-2 Remove-only safety.** Kids cert filtering removes titles and never adds or
  whitelists them. The shared age gate still runs over everything stored.
- **MI-3 Graceful degradation.** If Simkl recs, MDBList, the LLM, or trending are missing,
  that feature is removed and weights are rebalanced. The build never fails because an
  optional source is down.
- **MI-4 Simkl etiquette.** All Simkl calls go through `governor.schedule('simkl_get')`,
  with per-build caps and caching. No write calls.
- **MI-5 Resolve budget.** At most ~400 lookups per build (steady state is mostly cache hits).

---

## 11. Open questions (non-blocking)
- **Q1:** Should Simkl ratings also feed Genesis/Glass? They're engine-owned for now.
- **Q2:** Once real distributions exist from `score_components`, tune the weights (Tier-2) and
  the trending gate threshold of 0.35.
- **Q3:** A series counterpart ("Marquee TV") would reuse ~70% of this. That's out of scope.
