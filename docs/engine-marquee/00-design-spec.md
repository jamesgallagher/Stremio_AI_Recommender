# Marquee Cinema — Technical Design Spec

> **Name (2 October 2026):** this engine is now called **Marquee Cinema** (movies only). Its id stays `marquee`, its settings stay under `settings.marquee`, and stored rows keep `marquee-m*` versions. The separate shows engine is **Marquee TV** (`docs/engine-marquee-tv/`).


**Version:** 0.2 · **Status:** BUILT (MVP) — registered, globally disabled
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

---

## 12. Live findings (ME-00)
Run by James on 2026-09-30 against the production container (v7.16.0-beta), one real
profile. 5 Simkl calls, all checks PASS. Per-title Simkl ids from the account are
replaced with "movie 1–3" (the repo is public).

### Raw findings (script output)

- **V1** (PASS): top-level object (keys: movies); 256 entries; entry keys: added_to_watchlist_at, last_watched_at, user_rated_at, user_rating, status, watched_episodes_count, total_episodes_count, not_aired_episodes_count, movie; movie keys: title, poster, year, ids; id path: movie.ids; ids: tmdb=present imdb=present simkl=present; rating field "user_rating"; rated-at "user_rated_at"
- **V1b** (PASS): activities.movies keys: all, rated_at, playback, plantowatch, completed, dropped, removed_from_list; movies ratings timestamp path: movies.rated_at
- **V2** (PASS): movie 1: present (default), length 12, first item tmdb id present; movie 2: present (default), length 12, first item tmdb id present; movie 3: present (default), length 11, first item tmdb id present
- **V3** (PASS): 20 results; 0 of them have NO AU certification — certification.lte DROPS uncertified titles
- **V4** (PASS): 20 results; 1 NOT_YET — cinema-only titles still present (1 NOT_YET)
- **V5** (PASS): week p1–p5: 20 items each; day p1–p2: 20 items each; every page carries id/genre_ids/vote_average/vote_count/adult/release_date
- **V6** (PASS): blocks in one request: credits, keywords, external_ids, release_dates; AU cert M, US cert R, availability AVAILABLE (tmdb 603)

### What this means for the build (architect's reading)

| # | Finding | Consequence |
|---|---|---|
| L1 | `GET /sync/ratings/movies` returns `{ movies: [...] }` with **every** movie on the account, not only rated ones. Unrated entries carry `user_rating: null` and `user_rated_at: null`. Ids are at `entry.movie.ids.{simkl, imdb, tmdb}`, and **`tmdb` is a string**. | ME-03 `parseRatings` must keep only entries whose `user_rating` is an integer 1–10. |
| L2 | `activities.movies.rated_at` exists, and is **`null`** on an account that has never rated a movie. | ME-03's activities gate compares the stored and current value **including `null`**. No stored sync row means "never synced": pull once, then gate. The 24 h fallback is only for when the key itself is absent. |
| L3 | The tested account has **no movie ratings** (`rated_at: null`). | The rating weights are a no-op until the viewer rates films on Simkl; every watched film keeps weight +1, exactly like Glass. This is the MI-3 degradation path, and it is the **normal** case today, not an edge case. |
| L4 | `users_recommendations` is present on `GET /movies/{id}` **by default** (no `extended` param), with 11–12 items. Each item is `{ title, year, poster, fanart, type, ids: { simkl, slug, imdb, tmdb, … } }`, with ids at `item.ids` and `tmdb` a string. | ME-03 `getMovieSummary` sends no extra params. S2 (ME-05) maps recs through `item.ids.tmdb`. |
| L5 | `certification.lte` with `certification_country=AU` returned no uncertified titles in 20. | Useful narrowing at source. The hard filter stays the kids guarantee (MD-3) regardless. |
| L6 | `with_release_type=4\|5\|6` still let 1 of 20 `NOT_YET` titles through. | The discover param is a hint, not a guarantee. The hard filter's `availability === 'NOT_YET'` check (§3.3) is required. |
| L7 | Trending pages are 20 items; week 5 pages = 100, day 2 pages = 40. | `weekN = 100`, `dayN = 40` for the trending formula (§7). |
| L8 | The movie append call returns all four blocks in one request, with AU and US certs. | Confirms §2's cost model and ME-02's deep-meta change. |

---

## 13. Build notes (P4 MVP)
- **Neutral fit below the cap.** Rows outside the top `llm_fit.candidate_cap` (250) get a
  neutral `llm_fit = 0.5` (fit 5) — never a penalty, so the feature set is uniform and the
  renormalized weights stay meaningful.
- **Fixed shortfall log format.** `shapeOutput` logs exactly
  `[marquee] <profile>: shortfall <n>/<target> — blockers: <k1> <v1>, <k2> <v2>, <k3> <v3>, <k4> <v4>`
  (the 4 largest non-zero envelope counters, descending; `blockers: none recorded` when none),
  so an operator can read the dominant blocker at a glance.
- **API-only Tier-2.** `settings.marquee` is wired through the settings/portal write path
  (replace-whole, like Glass) but there is NO UI surface yet — the admin edits it via
  `PUT /settings`.

## 14. Backtest results (ME-10)
Run with `node --experimental-sqlite scripts/bench-engines.js "<profile>" --json`. Marquee is
enabled for the family only if it beats Genesis on hit@20 for most profiles (James decides).
**Metrics only:** held-out titles are a person's watch history and never go into this public repo.

### Run 1 — 2026-09-30, one profile, holdout 10, algorithm `marquee-m1` (v7.16.4-beta)

| engine | hit@20 | recall@100 | meanRank | filterPass | trending@20 | stored | build (s) |
|---|---|---|---|---|---|---|---|
| genesis | 2/10 | 20.0% | 23.0 | 31.7% | n/a | 300 | 39.5 |
| glass | 1/10 | 0.0% | 121.5 | 33.2% | 90.0% | 229 | 45.3 |
| marquee (m1) | 0/10 | 10.0% | 72.0 | **100.0%** | 95.0% | 232 | 156.6 |

**Reading:**
- G1 is confirmed fixed: only ~⅓ of what Genesis/Glass store passes the profile's filters; every Marquee row does.
- Marquee m1's candidate recall was poor: only 1 of the 10 targets reached its pool at all.
- Several targets can't be served by ANY filter-respecting engine (a trailer-style short under the
  vote floor, films older than the recency window, possibly not-yet-streamable releases), so the
  real ceiling was well under 10. m1's bench didn't report this; m2's does (`hit@20r`).
- One profile × 10 titles is a small sample: a 1–2 hit difference is mostly noise.
- trending@20 is inflated as a measure: Simkl's list had 500 movies, so most popular titles carry the tag.

### Run 2 — 2026-09-30, one profile, holdout 30, algorithm `marquee-m2` (v7.16.5-beta)

| engine | hit@20 | hit@20r | recall@100 | meanRank | filterPass | trending@20 | stored | build (s) |
|---|---|---|---|---|---|---|---|---|
| genesis | 1/30 | 1/13 | 6.7% | 162.8 | 29.3% | n/a | 300 | 33.6 |
| glass | 1/30 | 1/13 | 23.3% | 52.3 | 39.3% | 80.0% | 211 | 43.6 |
| **marquee (m2)** | **3/30** | **3/13** | **33.3%** | 68.3 | **100.0%** | 40.0% | 236 | 165.2 |

**Reading:**
- m2 fixed candidate recall: 10 of the 13 reachable targets reached Marquee's pool (m1: 1 of 10).
  Its served hits were ranked #4, #8 and #42; five more reachable targets sat at #25–#91.
- **17 of 30 targets were unreachable under the profile's OWN filters**: 10 by the recency window,
  3 by the rating floor, 3 by the vote floor, 1 by an excluded genre. No engine can serve those.
  The profile's filters, not the engine, are now the biggest limit (a settings decision for James).
- trending@20 fell from 95% to 40%: the capped, taste-gated intake worked.
- Still one profile: run the bench on the other family profiles before enabling Marquee for them.

**V7 (Nuvio progress, 2026-09-30):** 1,000 progress rows returned (movies + episodes; probably the
backend's 1,000-row cap), 14 of them movies, all ≥ 90%, aged 3–55 days. Nuvio keeps rows for
finished films, and no abandoned film was in the window. Marquee pulls every 6 h and keeps what it
sees, so the abandoned signal builds up going forward.

## 15. m2 tuning (2026-09-30, after run 1)

`ALGORITHM_VERSION` `marquee-m1` → **`marquee-m2`**. What Genesis did better: it seeds from 150
recent watches and ranks purely by **how many of them point at a title** (recency-weighted).
Marquee m1's cheap pre-score (which picks the ~400 titles worth a lookup) ignored that agreement
and was led by broad genre affinity, while a 500-title Simkl trending feed crowded the budget.

| Change | m1 | m2 |
|---|---|---|
| Seeds | 40 | **100** |
| `/similar` per seed | 12 | **6** (noisier than `/recommendations`) |
| Simkl trending intake | all 500 | **top 100 by rank** (`trending.simkl_take`) |
| Pre-score | 0.45 genre + 0.20 trending + 0.15 quality + 0.20 sources | **0.35 seed agreement** + 0.30 genre + 0.15 trending × genre-fit gate + 0.10 quality + 0.10 sources (`prescore`) |
| Final weights | taste .28, llm_fit .20, trending .20, quality .14, consensus .12, freshness .06 | taste .24, **seed_affinity .20**, llm_fit .18, trending .16, quality .10, consensus .06, freshness .06 |

- `seed_affinity` = Σ (recency × rating) weight of every distinct seed whose S1/S2 list produced the
  title, normalised to the build's max. MD-2 still holds: trending stays taste-gated, now ~16%.
- Bug fixed: rows were stamped `algorithm_version = 'marquee-m1'` from a hard-coded fallback; they now
  carry the real constant.
- **Backtest diagnostics:** Marquee records where each title is lost (`ctx.marqueeTrace`:
  not generated / watched / prefilter:<reason> / truncated (pre-score rank) / lookup_failed /
  hard_filter:<reason> / franchise_cap / store_cap). The bench now reports, per held-out film, whether
  it is reachable under the profile's filters, each engine's rank, and Marquee's loss stage, plus
  `hit@20r` (hits among reachable targets). All of it is Tier-2 tunable via `settings.marquee`.
- **Intersecting recommendations** ("A says B, C, D, E; R says B, E, F → B and E count twice") is
  exactly `seed_affinity`: every candidate remembers which of your films produced it (TMDB
  recommendations/similar and Simkl "users also liked"), and each distinct seed adds its recency
  weight, so a film several recent watches point at outranks one only a single watch suggests.

### Engagement: finished = liked, abandoned = not (James, 2026-09-30)

This family doesn't rate films, so the Simkl-ratings path (ME-03/04) is a no-op in practice. The
real signal is completion:

| Watch outcome | Marquee treatment |
|---|---|
| Finished (Simkl "completed") | positive taste event (the existing watched base, +1) and eligible seed |
| Started, left **below 50%**, untouched **7+ days** | **negative** taste event (−1.0, recency-decayed); never recommended back; never a seed |
| Past 50% but not finished, or touched in the last 7 days | neutral (no event) |
| Abandoned, then finished later | finished wins |

- **Source:** Nuvio's watch progress (`sync_pull_watch_progress`, params `{ p_profile_id }`; RPC
  name, params and row shape taken from Nuvio's open-source client), read via the profile's
  existing scrobble credentials. Simkl has no progress for this family (§12:
  `movies.playback`/`dropped` are null).
- Stored in the engine-owned `marquee_engagement` table, pulled at most every 6 h, and **kept after
  Nuvio prunes its "continue watching" row**. **Marquee only** (James's decision): Genesis and Glass
  never read it.
- Config: `engagement: { enabled, abandon_below: 50, grace_days: 7, weight: -1.0, sync_hours: 6,
  resolve_cap: 30, enrich_cap: 30 }`, all Tier-2 tunable.
- To confirm retention live: `test/verify-marquee-live.js` check **V7** prints movie progress rows
  by bucket and age (counts only).
- Next: re-run the bench (ideally `--holdout 30` and every profile) and record run 2 here.

## 16. Calibrated serving

**Problem.** The serve path balances the served list by strict round-robin across primary genres, so the served genre mix ignores the person's actual taste mix — a genre they barely watch is still force-filled to one slot per round.
**Method (Steck, RecSys 2018).** The served genre mix is calibrated to the person's own taste: a greedy set-selection over the best-scored films, each step picking the remaining row that maximises `U = (1−λ)·Σ normScore − λ·KL(p ‖ q̃)`, `q̃ = (1−α)·q + α·p`, `q` the fractional genre mix of the set (a k-genre film counts 1/k to each genre).
**Quality window.** Only the top `window_factor × list_size` filter-passing rows (by score) are candidates; rows outside the window are appended after the calibrated part in score order, so a liked genre with no strong candidate is under-filled — never a weak filler.
**Taste target.** Computed at Marquee build time from the watched films (same signals as the taste model: recency blend, rating weight excluding negative 1–4, Loved(10) decay floor, ignored excluded; genres from deep meta else `primary_genre`) and stored per profile/type. Excluded genres are removed at serve time and the rest renormalised; serving stays instant, local and network-free.
**Wildcard (discovery) slot.** Off by default (`wildcard_slots: 0`). When ≥1, the highest-scored filter-passing row among the top `2W` whose genres all have target share < `wildcard_max_share` and is not already in the first `list_size` positions is placed at `wildcard_position` (6th).
**Safe fallback.** No stored target, engine-id mismatch, empty target, `strategy:'round_robin'`, or any calibration exception → the existing `balanceByGenre` (logged once per serve, ids only); serving must never fail because of calibration. Genesis and Glass keep round-robin.
**Defaults** (`DEFAULTS.serve`, Tier-2 overridable via `settings.marquee.serve`): `strategy:'calibrated'`, `lambda:0.5`, `window_factor:3`, `kl_alpha:0.01`, `wildcard_slots:0`, `wildcard_max_share:0.05`, `wildcard_position:6`.
**Bench.** `scripts/bench-engines.js` reports a second table comparing `round_robin`, `calibrated` and `pure_score` on the same stored rows + target (hit@20, hit@20r, KL, top20, meanRank, worstRank, wildcard); also under `engines.marquee.serveStrategies` in `--json`.

## 17. m4 — genre-fair agreement

**Problem.** `seed_affinity` and `consensus` are normalised by ONE global maximum, which is always a big franchise "hub" film; genres the person loves less cap out far below it (Comedy is 21% of the taste mix but was served at ≤9%).
**Fix.** Blend the global normalisation with a within-genre one: `value = (1−β)·globalNorm + β·genreNorm`, β = `agreement.genre_blend` (default 0.5). `genreNorm` is the same quantity normalised by the maximum within the candidate's genre group.
**Genre group.** The candidate's PRIMARY genre (first genre name, `'Other'` if none). Pre-score stage: from the list-payload genres; final-score stage: from deep meta. Small-group guard: a group with fewer than `agreement.min_genre_size` (5) candidates uses global normalisation only.
**Consensus form.** `consensus = (1−β)·raw + β·genreNorm(raw)`, `genreNorm = min(1, raw/groupMax)` when the group is large enough, else `raw` — so β=0 reproduces m3 exactly (m3 never normalised consensus).
**Scope.** Only `seed_affinity` and `consensus` change, in BOTH the pre-score and the final score; all other features, weights, filters, serving and calibration are unchanged. `genre_blend: 0` reproduces m3 exactly — every pre-score, feature, final score, ranking and stored row (tested against a frozen fixture).
**Version.** `ALGORITHM_VERSION = marquee-m4`; `pruneSupersededVersions` cleans the old m3 rows on the next build.
**Bench A/B.** `scripts/bench-engines.js --marquee-config '<json>'` merges JSON sections into the SNAPSHOT's `settings.json` (`settings.marquee[section] = { ...existing, ...override }`); the live settings file is never written (the merge refuses any path outside the temp snapshot dir). The header prints the override; `--json` records `marqueeConfigOverride`.
