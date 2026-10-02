# Marquee TV — Technical Design Spec

> **Name:** **Marquee TV** — a separate engine for shows (`type: 'series'`). It is
> **not** an extension of Marquee Cinema (movies). Cinema keeps its id `marquee`,
> its tuning and its version line untouched. Marquee TV's id is `marquee-tv`,
> version line `marquee-tv-t1`…
>
> **What is built now (TV-1, v7.29.0-beta):** the data foundation only — the
> per-show progress store (`series_progress`), the pure engagement ladder
> (`src/seriesEngagement.js`), and the series backtest (`bench-engines.js
> --type series`). No engine, no UI, no serving change. Everything else below
> is the approved design for the later cards (TV-2 engine core, TV-3
> intelligence, AN-2 anime).

**Version:** 0.1 (TV-1) · **Status:** TV-1 BUILT (foundation) — no engine registered yet
**Kind:** a *candidate-producer* engine, `supportedTypes: ['series']` (TV-2)
**Depends on:** [`../engine-abstraction/00-overview.md`](../engine-abstraction/00-overview.md)
(the seam), [`../engine-abstraction/CONFORMANCE.md`](../engine-abstraction/CONFORMANCE.md)
(definition of done), the Marquee Cinema spec ([`../engine-marquee/00-design-spec.md`](../engine-marquee/00-design-spec.md))
for the shared infrastructure, and the plan ([`temp/marquee-tv-plan.md`](../../temp/marquee-tv-plan.md)).

> **Source sign-off:** the data sources below (Simkl, TMDB, AniList, MAL, MDBList,
> the local LLM) were proposed and approved by James on 2 October 2026. TVDB and
> TVmaze were researched and **rejected** (§2). Adding any other source needs a new sign-off.

---

## 1. Why a separate engine: what it fixes

Forcing shows into Marquee Cinema would put `if (type === 'series')` into almost every
stage and would couple TV experiments to the live Cinema version, config and backtest.
The differences (plan §2):

| # | Film | TV | What it means for the engine |
|---|---|---|---|
| D1 | Watched = one bit, plus an "abandoned" flag | **A relationship**: sampled → engaged → committed → finished/caught up → waiting for a new season | History becomes a graded engagement score per show (§3), not a +1 |
| D2 | ~2 hours at stake | **10–200 hours at stake** | A bad recommendation costs more, so commitment fit matters: length, status, format, runtime |
| D3 | Release year fixes "how old" | A 2005 show still airing in 2026 isn't old; one that ended in 1990 is | Recency by **last air date** (Q3) |
| D4 | TMDB movie genres are fine | TMDB TV genres are coarse and merged; no Horror, Thriller or Romance | Genres from Simkl first, with TMDB keywords as fallback; exclusions mapped across both |
| D5 | Format barely varies | **Format splits audiences**: scripted vs reality vs documentary vs talk; sitcom (22 min) vs drama (50 min); limited vs open-ended | Format and runtime band become taste dimensions plus a gate (Q4) |
| D6 | Franchise = collection | Franchise = creator/showrunner, network identity (HBO, FX, Apple TV+), spin-offs | A creator source replaces the collection source; network becomes a taste dimension |
| D7 | Freshness = release year | **Airing now** matters: new seasons, new shows this season | An "airing / new season" feature and source; possibly its own row (Q7) |
| D8 | Quality = IMDb Bayesian | Ratings inflate for long shows; **retention** is the better signal | Quality blends IMDb with Simkl `droprate` |
| D9 | Exclude watched | Exclude anything **started**, including samplers | Unchanged, but samplers must not seed |
| D10 | Lots of history (hundreds of films) | Few shows (11–103 per profile; only 11–44 with real timestamps) | Collaborative sources matter more than content-only taste models; the backtest needs a smaller holdout |

**Shared library** (extracted from Marquee Cinema, behaviour-identical, proven by
Cinema's existing tests and an identity fixture as in m4): the local-LLM
brief/fit/suggest plumbing and cache, the trending cache access, the Simkl summary
cache (generalised from movies to `tv` and `anime`), Bayesian quality, trending-rank
maths, the genre-fair normaliser, calibrated serving (already shared).

**Not shared:** taste dimensions, the engagement ladder, sources, filters, scoring
weights, version line, Tier-2 config, backtest mode.

---

## 2. Data sources (verified live, 2 October 2026)

| Source | What it gives for TV | Verdict |
|---|---|---|
| **Simkl** `/tv/{id}?extended=full` | `users_recommendations`, `genres` with Horror/Thriller, **`droprate`**, status, runtime, network, certification | **Primary**: collaborative signal, real genres, a retention-quality signal. Governed (`simkl_get`), cached 30 days like the film summaries. |
| **Simkl** all-items (history) | `watched_episodes_count`, `total_episodes_count`, `not_aired_episodes_count`, `last_watched_at`, per-episode `watched_at` | **Primary history**: the engagement ladder (§3). |
| **Simkl** trending CDN | `tv` 500 and `anime` 491 items, already cached server-wide | Trending source, free. |
| **TMDB** `/tv/{id}` + append | `status` (Returning / Ended / Canceled), `type` (Scripted / Reality / …), seasons, episodes, `last_episode_to_air`, networks, `created_by`, keywords, **AU content rating** | **Structure + filters**, one call per show. |
| **TMDB** `discover/tv` | `with_type`, `with_status`, `air_date.gte`, `with_networks`, `with_genres`, `with_keywords`, language, vote floors | Taste-driven discovery + "airing now". |
| **TMDB** `/tv/{id}/recommendations`, `/similar` | Noisy | Secondary, low weight. |
| **AniList** GraphQL (reachable, no key) | Format, status, score, popularity, studios, **ranked tags**, relations, **community-voted recommendations** | **Primary for anime** (AN-2). |
| **Simkl** `/anime/{id}` | `users_recommendations`, `relations`, `similar`, studios, `anime_type`, `mapped_tvdb_seasons`, droprate | Anime collaborative + id mapping. |
| **MAL** (Jikan) + Fribb anime-lists | Already wired: age bands + id mapping (MAL ↔ TMDB ↔ IMDb) | Reuse. |
| **TVmaze** | Good TV genres and types, but **times out from the container** | Rejected for now; Simkl genres cover it. |
| **TVDB** v4 | Paid or attribution; nothing Simkl + TMDB lack | Rejected (as in the Marquee spec §2). |

**Household evidence (plan §1.1):** 11–103 series per profile; per-episode timestamps
exist but **most are bulk-marked** (identical or < 5 min apart). Only a minority of
shows have a real viewing pattern. **How far someone got is trustworthy for every show;
viewing speed is only trustworthy for a minority.** Imports and "mark season watched"
clicks stamp whole seasons with one time. This is the reason for the bulk-stamp rule
(V4, §3) and the `first_real_at` / `real_stamps` / `eps_per_week` columns (§4).

---

## 3. The engagement ladder (per show, from Simkl history)

`aired = total_episodes_count − not_aired_episodes_count`; `w = watched_episodes_count`.
Implemented in `src/seriesEngagement.js` (pure, engine-agnostic — V3).

| Rung | Rule (first match wins; thresholds Tier-1, tunable) | Taste weight | Seed? |
|---|---|---|---|
| **Finished / caught up** | `status = completed` or `w ≥ aired` | **+2.0** | Yes (strongest) |
| **Committed** | `w ≥ 60%` of aired, or ≥ `committed_any_eps` (24) | +1.5 | Yes |
| **Engaged** | `w ≥ engaged_min_eps` (6) | +1.0 | Yes |
| **Tried** | 3–5 eps | +0.3 | No |
| **Sampled and left** | `w ≤ 2`, untouched ≥ `sampled_idle_days` (60), more episodes aired | **0 (neutral)** | No |
| **Sampling now** | `w ≤ 2`, touched < 60 days ago | +0.3 (too early to judge) | No |

**Modifiers:**
- **Recency:** half-life on `last_watched_at`, longer than for films (TV taste drifts
  slowly; proposed 180 days).
- **Active now** (watched within 30 days): × 1.3. The strongest *current* signal.
- **Binge bonus:** +0.3 for ≥ 5 eps/week sustained, computed **only from real
  timestamps** (`eps_per_week` from `real_stamps`). Shows that are mostly bulk-marked
  get no speed signal at all, never a penalty (V4).
- **Bulk-marked shows** still count by how far they got. Their recency uses
  `last_watched_at`, and if that is an import time, the show is treated as old.
- **Ratings** (if anyone ever rates a show, via the Ratings trainer): override the rung
  weight using the same rating table as films (Q9). A 10/10 is "Loved".
- **Dropped mid-way** (≥ 6 eps, untouched ≥ 180 days, more aired): stays "Engaged".
  Fatigue isn't dislike.

**Value:** `value = weight × recency × (activeNow ? active_factor : 1) + binge`, where
`weight` is the rung weight, or the rating weight when the show is rated.

**The ladder is pure and engine-agnostic (V3):** `rungOf(row, cfg, now)`,
`ladder(row, { now, rating, cfg })` and `ladderFor(profileId, { now, kind, cfg })`
(the only DB-reading helper — it reads `getSeriesProgress` and joins
`taste_ratings` type `series` by `tmdb_id`). The engine's Tier-2 config may override
`cfg`; the rung weights and the film rating table are fixed.

---

## 4. Per-show progress store (TV-1)

`watchedStore` holds two tables:

**`series_progress`** — one row per `(profile_id, simkl_id)`:

| Column | Meaning |
|---|---|
| `kind` | `show` \| `anime` (kept distinct in the store) |
| `imdb_id`, `tmdb_id` | ids from Simkl all-items |
| `title`, `year`, `status` | show identity + Simkl status |
| `watched_eps`, `total_eps`, `not_aired_eps` | the ladder's inputs |
| `last_watched_at`, `first_watched_at` | Simkl timestamps (bulk or real) |
| `first_real_at`, `last_real_at` | the first/last **real** (non-bulk) episode stamp |
| `stamps`, `real_stamps` | total episode stamps and the real (non-bulk) count |
| `eps_per_week` | `real_stamps / max(1, (last_real_at − first_real_at)/7 days)` when `real_stamps ≥ 4`, else `null` |

**`series_progress_sync`** — one row per `profile_id` (`backfilled_at`), the one-time
backfill marker (V2: no new Simkl requests in steady state; the backfill runs once).

**`parseSeriesProgress(item, section)`** (`src/services/simkl.js`, pure) parses one Simkl
all-items entry (shows/anime) into a progress row, classifying bulk stamps:

- **Bulk rule:** `BULK_GAP_MS = 300000` (5 min). A stamp is **bulk** if its gap to the
  previous OR next sorted stamp is < 300000 ms. Identical stamps are bulk. Exactly
  300000 ms is **real**.
- `real_stamps` counts the real (non-bulk) stamps; `first_real_at` / `last_real_at` are
  the first/last real stamp. `eps_per_week` uses real stamps only (V4).

**Sync wiring:** `syncFromSimkl` backfills `series_progress` once per profile (gated by
`series_progress_sync`), so steady-state syncs make **no** Simkl requests for series
(V2). `getSeriesProgress(profileId, { kind })` reads the rows (optional kind filter);
`upsertSeriesProgress` replaces all columns per `(profile_id, simkl_id)`.

---

## 5. TV taste dimensions (TV-2)

| Dimension | Source | Note |
|---|---|---|
| Genres | Simkl genres, falling back to TMDB TV genres + mapped keywords | Fixes Horror/Thriller/Romance |
| Keywords | TMDB | As in Cinema |
| Creators / showrunners | TMDB `created_by` | The TV "director" |
| Networks / streamers | TMDB `networks` | HBO, FX, Apple TV+ identity is a strong signal for TV |
| Format | TMDB `type` + runtime band (≤ 30 / 31–50 / > 50 min) + limited vs open-ended | Sitcom ≠ prestige drama ≠ reality |
| Commitment comfort | The profile's distribution of total episodes over Engaged-or-better shows | Some viewers happily do 200 eps of a sitcom, others want 8-episode series |
| Era | First and last air years | Feeds the recency rule |
| Origin / language | TMDB `origin_country`, `original_language` | UK vs US vs Korean drama |
| Cast | TMDB top 3 | Low weight |

---

## 6. Candidate sources (TV-2)

| # | Source | Notes |
|---|---|---|
| T1 | **Simkl `users_recommendations`** per seed show | Primary collaborative. 30-day cache; capped uncached GETs per build (as with films) |
| T2 | TMDB `/recommendations` + `/similar` per seed | Low weight (noisy) |
| T3 | TMDB `discover/tv` by taste | Top genres/keywords/**networks**/creators, filtered by format + language + filters |
| T4 | Creator continuation | Other shows by creators of Engaged-or-better shows (TMDB person TV credits) |
| T5 | Trending | Simkl `tv` week list (cached) + TMDB `trending/tv` |
| T6 | **Airing now** | `discover/tv` with `air_date.gte = now − 60 days`, taste-filtered (new shows + new seasons) |
| T7 | LLM suggestions (local) | From the TV taste brief; every title verified through the filters |
| T8 | Exploration | A small reserve outside the top genres (as in Cinema) |

**Seeds:** the Engaged-or-better shows (rung `engaged`/`committed`/`finished`),
engagement-weighted. Samplers never seed (D9).

---

## 7. Filters (TV-2)

- **Excluded genres mapped across taxonomies**, e.g. Horror = Simkl Horror ∪ TMDB
  keywords {horror, slasher, supernatural horror, zombie}.
- **Recency by last air date** (Q3): a show qualifies if it was still airing in or after
  the chosen decade.
- **Rating floor** on IMDb (MDBList, the same as the serve floor); **vote floor** per type.
- **Kids:** real **AU/US TV ratings** from TMDB `content_ratings` (G / PG / M / MA 15+ /
  R 18+; TV-Y7 / TV-PG / TV-14 / TV-MA), feeding the shared age gate. TV-14 allows
  TV-Y, TV-Y7, P, C, TV-G, TV-PG, G, PG, TV-14, M and blocks TV-MA, MA 15+, R, R 18+,
  adult (decided 2 October; see `tv14-age-tier-plan.md`). A show without AU/US ratings
  goes through Simkl → MDBList (cert, Common Sense) → TMDB GB/IE/NZ/CA → the LLM.
  **Anime is excluded** from Marquee TV by several detectors.
- **Format gate** (Q4): formats with no history (e.g. Reality, Talk, News) are excluded.
- At least one aired episode; an IMDb `tt` id (needed for streams).

---

## 8. Scoring (TV-2, version `marquee-tv-t1`)

```
rankScore = w1·taste_match        (TV taste model over the engagement-weighted history)
          + w2·collab             (Simkl users_recs agreement across seeds, engagement-weighted;
                                   genre-fair normalised, as in m4)
          + w3·quality            (IMDb Bayesian blended with (1 − droprate))
          + w4·commitment_fit     (length / runtime / format vs the profile's comfort)
          + w5·airing             (aired in the last 60 days; new season)
          + w6·trending_eff       (trending, gated by taste, as in Cinema)
          + w7·llm_fit            (phase 3)
          − penalty               (cancelled after one season −0.05 (Q6); already-decayed creator)
```

**Serving:** reuse calibrated serving unchanged. The target is the genre mix of the
profile's Engaged-or-better shows (Simkl genres), so the served mix follows real TV taste.

---

## 9. Evaluation: a TV backtest (TV-1)

`bench-engines.js --type series --holdout 10`.

- **Holdout:** the 10 most recently *started* shows that reached at least Engaged, using
  **real (non-bulk) first-episode timestamps only** (`first_real_at`). Bulk-imported
  shows carry their import time, so ordering them by time is meaningless. Implemented
  by `bench.pickSeriesTargets`: kind `show`, `first_real_at != null`, `tmdb_id != null`,
  rung ∈ {engaged, committed, finished}, sorted by `first_real_at` DESC, take `holdout`.
  Fewer than `holdout + 10` qualifying shows → "not enough series history".
- **Build:** from history minus those shows (`bench.removeSeriesHoldout` clears the held-out
  `series_progress` rows, the series recommended pool, and the series taste ratings +
  ignores, so the holdout cannot leak into the build).
- **Metrics:** hit@20, recall@100, Engaged-hit@20 (did we find shows they *stuck with*,
  not just started — the holdout is all Engaged+, so hit@20 measures this), served KL
  vs target, format purity (share of the served list in formats with history).
- **Baseline:** Genesis on the same holdout, run before any build card. Siobhan
  (11 real-pattern shows) and Ciara are thin, so report per profile, and treat
  differences of one or two hits as noise.
- **Anime:** the same method on Ciara, holdout 5 (AN-2).

The bench drives the shared pipeline with `type: 'series'` (`rs.clearType`,
`pipeline.runEngineBuild`, `rs.getRecommended`), and skips the Marquee serve-strategy
comparison (a movie-only concept). The movie bench path is unchanged (V6).

---

## 10. Phasing (cards)

| Phase | Scope | Exit check |
|---|---|---|
| **TV-0 spike** | Measure coverage on candidate shows: Simkl summary hit rate (genres, droprate, users_recs), TMDB AU-rating coverage, keyword coverage for the Horror/Thriller/Romance mapping, Fribb coverage of Ciara's history. Plus the **Genesis TV baseline** backtest. | Numbers in the spec; thresholds set |
| **TV-1 foundation** | Per-show progress store (watched/aired/status/last watched/bulk flag, from extended all-items, activities-gated) + the engagement ladder (pure, tested) + `shows` vs `anime` kept distinct in the watched store + the series backtest (`--type series`) | Ladder matches hand-labelled shows for 3 profiles |
| **TV-R ratings for shows** | Show-level ratings (never per episode) in the portal Ratings tab + companion; Simkl show ratings sync; a rating overrides the ladder weight | Rate/unrate round-trips to Simkl; ladder uses it |
| **TV-2 engine core** | `marquee-tv`: filters, taste model, sources T1–T6, scoring without LLM, shared library extraction (Cinema identity-tested), registered **dark**, bench `--type series` | Backtest vs Genesis on James/Siobhan/Andrew; Cinema unchanged |
| **TV-3 intelligence** | LLM brief / suggestions / fit for TV, calibrated serving target from Engaged+ shows, portal/companion naming (Marquee Cinema / Marquee TV) | Backtest + live genre and format mix |
| **AN-2 Marquee Anime** | AniList/Simkl sources, tag taste model, season roll-up, MAL ages | Anime backtest on Ciara; age-band checks for Conor/Ciara |

---

## 11. Invariants (Marquee TV-specific)

- **V1 No behaviour change anywhere users can see.** TV-1 adds tables and pure
  functions; the movie build/serve path is untouched.
- **V2 No new Simkl requests in steady state.** The series backfill runs once per
  profile (gated by `series_progress_sync`); steady-state syncs make no Simkl requests
  for series.
- **V3 The ladder is pure and engine-agnostic.** `rungOf` / `ladder` / `ladderFor`
  take no network and no engine; only `ladderFor` reads the DB.
- **V4 Bulk stamps never drive speed/active.** `eps_per_week` uses real stamps only;
  recency uses `last_watched_at` (an import time reads as old, never a penalty).
- **V5 Ratings per show, never per episode.** A show rating overrides its rung weight
  (Q9); there is no per-episode rating.
- **V6 Movie bench unchanged.** `--type series` is additive; the movie bench path
  (`pickTargets`, `removeHoldout`, the serve-strategy comparison) is untouched.
- **V7 Hermetic tests.** The ladder and the series backtest are tested against a temp
  DB with a stub engine, no network.

---

## 12. TV-1 build notes (v7.29.0-beta)

- **`src/services/simkl.js`** — `parseSeriesProgress(item, section)` (pure): parses one
  Simkl all-items entry into a progress row with the bulk-stamp classification.
- **`src/watchedStore.js`** — `series_progress` + `series_progress_sync` tables;
  `upsertSeriesProgress`, `getSeriesProgress`, `getSeriesProgressSync`,
  `setSeriesProgressSync`; `syncFromSimkl` backfills once per profile.
- **`src/seriesEngagement.js`** (new) — the pure engagement ladder: `DEFAULTS`,
  `RUNG_WEIGHTS`, `RUNG_SEED`, `RATING_WEIGHTS`, `ratingWeight`, `rungOf`, `ladder`,
  `ladderFor`.
- **`src/bench/engineBench.js`** — `pickSeriesTargets`, `removeSeriesHoldout`, and
  `runBench`'s `type` param (default `movie`); the series holdout and leakage check;
  the engine loop driven by `type`; the serve-strategy comparison movie-only.
- **`scripts/bench-engines.js`** — `--type movie|series` flag; a series run defaults to
  the Genesis baseline engine unless `--engines` is given.
- **`scripts/series-ladder.js`** (new) — a read-only debug script: prints the engagement
  ladder for every show in a profile's `series_progress`.
- **Tests:** `test/smoke.js` P1–P5 (ladder + parse, pure) and `test/integration.js`
  I1–I5 (store/sync/backfill + `ladderFor`) and B1–B4 (series backtest).
