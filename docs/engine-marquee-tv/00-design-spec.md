# Marquee TV (and Anime): research and options

**Status:** planning. No cards yet. · **Date:** 2 October 2026 · **Context:** Marquee (now "Marquee Cinema") is live for movies at m4; every profile's series still come from Genesis.

All figures below were measured on the live install on 2 October 2026, using read-only Simkl GETs and the live pools.

---

## 0. Recommendation in one page

1. **Build Marquee TV as a separate engine.** Don't extend Marquee Cinema.
   - Nearly every stage works differently for shows: the history signal, the genre list, the filters, the sources, the scoring and the backtest.
   - What does carry over is infrastructure, and it can be shared as a library: the pipeline, calibrated serving, the age gate, the local-LLM brief/fit plumbing, the trending caches and the Simkl summary cache.
   - Marquee Cinema keeps its id (`marquee`), its tuning and its version line untouched.
2. **The heart of Marquee TV is an engagement ladder, not ratings.**
   - For a film, "watched" is one bit. For a show, how far someone got (episodes watched vs aired), and whether they finished or caught up, is a graded signal we already have for every show. Nobody in the household rates shows or uses dropped/on hold.
   - Today Genesis seeds from a 1-episode sample exactly as strongly as from a show binged to the end. That's the biggest single flaw.
3. **Simkl is the primary TV source; TMDB comes second.**
   - Simkl's per-show "users also liked", richer genres (Horror, Thriller and Romance exist) and community drop rate beat TMDB's TV recommendations, which are noticeably noisy.
   - TMDB supplies structure: status, type/format, seasons, networks, the AU rating and air dates.
4. **Anime gets its own lane and its own catalog. Your instinct is right.**
   - It has different sources (AniList and MAL), different taste dimensions (ranked tags, studios, demographics), a different season structure (each season is a separate entry) and a different age system (MAL).
   - In Stremio/Nuvio it must stay type `series` with `tt` ids, in a separate catalog ("Anime for you"). It must not become a custom type, or streams and metadata break.
   - It's built after TV, as a light sibling engine that reuses the TV engagement ladder.
5. **Phase it:** a data-foundation card first (the engagement ladder and per-show progress), then the TV engine core (no LLM), then LLM and calibration, then anime. Every phase gets a TV-specific backtest.

---

## 1. What we have today (evidence)

### 1.1 Household TV data (Simkl, live)

| Profile | Series (anime) | 1–2 eps | 3–5 | 6–12 | 13+ partial | Completed / caught up | "Watching" but untouched > 6 months |
|---|---|---|---|---|---|---|---|
| James | 103 (2) | 15 | 14 | 21 | 26 | 27 | 60 |
| Siobhan | 75 (4) | 14 | 6 | 9 | 9 | 37 | 33 |
| Andrew | 42 (3) | **37** | 2 | 2 | 0 | 1 | 19 |
| Ciara | 17 (**13**) | 3 | 4 | 5 | 0 | 5 | 0 |
| Conor | 10 (2) | – | – | – | – | – | – |
| Mom | 11 (0) | – | – | – | – | – | – |

- **Nobody uses `dropped` or `hold`; everything sits in `watching`.** Example: James, *Perfect Strangers*, 1 of 150 episodes, filed as "watching". Status therefore tells us nothing. Episode progress has to be inferred.
- **No show ratings found** (the ratings call returned none for shows or anime). Same as films: this family doesn't rate.
- **Per-episode timestamps exist** (`extended=full&episode_watched_at=yes`), but **most are bulk-marked**:

| Profile | Episode stamps | Bulk-marked (identical or < 5 min apart) | Shows with a real viewing pattern | Median eps/week (p90) |
|---|---|---|---|---|
| James | 2,689 | **59%** | 44 | 1.2 (5.3) |
| Siobhan | 1,706 | **83%** | 11 | 2.8 (7.0) |
| Andrew | 66 | 0% | 3 | 3.1 (7.0) |
| Ciara | 75 | 29% | 6 | 5.0 (9.0) |

  ⇒ **How far someone got is trustworthy for every show; viewing speed is only trustworthy for a minority.** Imports and "mark season watched" clicks stamp whole seasons with one time.

### 1.2 What Genesis serves for series today (live)

| Problem | Evidence |
|---|---|
| A 1-episode sample counts as strongly as a show binged to the end | Seeds are the 100 most recent series, equally weighted. Andrew's 42 shows are 37 samplers, so his pool is built mostly from shows he tried once. |
| The decade filter is movies-only | James and Mom are served *21 Jump Street* (1987); Ciara gets *The Bionic Woman* (1976). |
| Genre exclusions don't work for TV | TMDB's TV genres have **no Horror, Thriller, Romance or Fantasy** (16 genres: Action & Adventure, Animation, Comedy, Crime, Documentary, Drama, Family, Kids, Mystery, News, Reality, Sci-Fi & Fantasy, Soap, Talk, War & Politics, Western). Siobhan excludes Horror yet is served *Slasher* and *The Strain*. |
| Formats are mixed | Scripted dramas sit next to reality shows: *RuPaul's Drag Race* (James), *MasterChef* (Siobhan), *The Amazing Race* (Andrew). |
| Anime is mixed in | Ciara: 44 of 88 pool titles are anime, 6 of 25 served. Conor: 8 anime in pool, 4 of 30 served. |
| TMDB TV recommendations are noisy | *Severance* → *Emergence*, *Mr. Mercedes*, *The Institute*, *The Capture*, *Rabbit Hole*… |

### 1.3 Sources: verified live

| Source | What it gives for TV | Verdict |
|---|---|---|
| **Simkl** `/tv/{id}?extended=full` | `users_recommendations` (12 for *Perfect Strangers*: *Webster*, *Punky Brewster*: sensible), `genres` with Horror/Thriller (*The Strain*: Drama, Fantasy, Horror, Thriller), **`droprate`** (*The Strain* 6.9%, *Severance* 2.6%), status, runtime, network, certification | **Primary**: collaborative signal, real genres, a retention-quality signal. Governed (`simkl_get`), cached 30 days like the film summaries. Coverage gap: the IMDb lookup for *Slasher* returned nothing, so a fallback is needed. |
| **Simkl** all-items (history) | `watched_episodes_count`, `total_episodes_count`, `not_aired_episodes_count`, `last_watched_at`, `next_to_watch`, per-episode `watched_at` | **Primary history**: the engagement ladder (§3). |
| **Simkl trending CDN** | `tv` 500 and `anime` 491 items, **already cached server-wide** | Trending source, free. |
| **TMDB** `/tv/{id}` + append | `status` (Returning / Ended / Canceled), `type` (Scripted / Reality / Documentary / Miniseries / Talk Show / News), seasons, episodes, `last_episode_to_air`, `next_episode_to_air`, networks, `created_by`, keywords, **AU content rating** (*Severance* MA 15+), AU providers | **Structure + filters**, one call per show. |
| **TMDB** `discover/tv` | `with_type`, `with_status`, `air_date.gte`, `with_networks`, `with_genres`, `with_keywords`, language, vote floors (1,123 scripted returning shows aired since June) | Taste-driven discovery + "airing now". |
| **TMDB** `/tv/{id}/recommendations`, `/similar` | Noisy (above) | Secondary, low weight. |
| **AniList** GraphQL (reachable from the container, no key) | Format, status, score, popularity, studios, **ranked tags** (*Attack on Titan*: Kaiju 93, Revenge 93, Tragedy 89…), relations (sequel / prequel / adaptation), **community-voted recommendations** | **Primary for anime.** |
| **Simkl** `/anime/{id}` | `users_recommendations` (21 for *AoT*), `relations` (12), `similar`, studios, `anime_type`, `mapped_tvdb_seasons`, droprate | Anime collaborative + id mapping. |
| MAL (Jikan) + Fribb anime-lists | Already wired: age bands + id mapping (MAL ↔ TMDB ↔ IMDb) | Reuse. |
| TVmaze | Good TV genres and types, but **times out from the container** (works from Windows) | Rejected for now; Simkl genres cover it. |
| TVDB v4 | Paid or attribution; nothing Simkl + TMDB lack | Rejected (as in the Marquee spec §2). |

---

## 2. How TV differs from film (why one engine doesn't fit)

| # | Film | TV | What it means for the engine |
|---|---|---|---|
| D1 | Watched = one bit, plus an "abandoned" flag (Nuvio progress) | **A relationship**: sampled → engaged → committed → finished/caught up → waiting for a new season | History becomes a graded engagement score per show (§3), not a +1 |
| D2 | ~2 hours at stake | **10–200 hours at stake** | A bad recommendation costs more, so commitment fit matters: length, status, format, runtime |
| D3 | Release year fixes "how old" | A 2005 show still airing in 2026 isn't old; one that ended in 1990 is | Recency by **last air date** (decision Q3) |
| D4 | TMDB movie genres are fine | TMDB TV genres are coarse and merged; no Horror, Thriller or Romance | Genres from Simkl first, with TMDB keywords as fallback; exclusions mapped across both |
| D5 | Format barely varies | **Format splits audiences**: scripted vs reality vs documentary vs talk; sitcom (22 min) vs drama (50 min); limited series vs open-ended | Format and runtime band become taste dimensions plus a gate (Q4) |
| D6 | Franchise = collection | Franchise = creator/showrunner, network identity (HBO, FX, Apple TV+), spin-offs | A creator source replaces the collection source; network becomes a taste dimension |
| D7 | Freshness = release year | **Airing now** matters: new seasons, new shows this season | An "airing / new season" feature and source; possibly its own row (Q7) |
| D8 | Quality = IMDb Bayesian | Ratings inflate for long shows; **retention** is the better signal | Quality blends IMDb with Simkl `droprate` |
| D9 | Exclude watched | Exclude anything **started**, including samplers (already true: `watching` is synced) | Unchanged, but samplers must not seed |
| D10 | Lots of history (hundreds of films) | Few shows (11–103 per profile; only 11–44 with real timestamps) | Collaborative sources matter more than content-only taste models; the backtest needs a smaller holdout |

Forcing these into Marquee would put `if (type === 'series')` into almost every stage. It would also tie TV experiments to Cinema's version line, Tier-2 config and backtest, while Cinema is live and still being tuned.

---

## 3. The criteria: what feeds Marquee TV

### 3.1 The engagement ladder (per show, from Simkl history)

`aired = total_episodes_count − not_aired_episodes_count`; `w = watched_episodes_count`.

| Rung | Rule (first match wins; thresholds Tier-1, tunable) | Taste weight | Seed? |
|---|---|---|---|
| **Finished / caught up** | `status = completed` or `w ≥ aired` | **+2.0** | Yes (strongest) |
| **Committed** | `w ≥ 60%` of aired, or ≥ 2 full seasons | +1.5 | Yes |
| **Engaged** | `w ≥ 6`, or ≥ 1 full season (limited series: ≥ 50%) | +1.0 | Yes |
| **Tried** | 3–5 eps | +0.3 | No |
| **Sampled and left** | `w ≤ 2`, untouched ≥ 60 days, more episodes aired | **0 (neutral)**, recommended (Q2) | No |
| **Sampling now** | `w ≤ 2`, touched < 60 days ago | +0.3 (too early to judge) | No |

**Modifiers:**
- **Recency:** half-life on `last_watched_at`, longer than for films (TV taste drifts slowly; proposed 180 days).
- **Active now** (watched within 30 days): × 1.3. This is the strongest *current* signal.
- **Binge bonus:** +0.3 for ≥ 5 eps/week sustained, computed **only from real timestamps**. Shows that are mostly bulk-marked get no speed signal at all, never a penalty.
- **Bulk-marked shows** still count by how far they got. Their recency uses `last_watched_at`, and if that is an import time, the show is treated as old.
- **Ratings** (if anyone ever rates a show, via the Ratings trainer): override the rung weight using the same rating table as films. A 10/10 is "Loved".
- **Dropped mid-way** (≥ 6 eps, untouched ≥ 180 days, more aired): stays "Engaged". Fatigue isn't dislike.

This mirrors your film rules: abandoned = neutral and never recommended back; finishing is the positive.

### 3.2 TV taste dimensions

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

### 3.3 Candidate sources

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

### 3.4 Filters (at source and after lookup, as Cinema's)

- **Excluded genres mapped across taxonomies**, e.g. Horror = Simkl Horror ∪ TMDB keywords {horror, slasher, supernatural horror, zombie}.
- **Recency by last air date** (Q3): a show qualifies if it was still airing in or after the chosen decade.
- **Rating floor** on IMDb (MDBList, the same as the serve floor); **vote floor** per type.
- **Kids:** real **AU/US TV ratings** from TMDB `content_ratings` (G / PG / M / MA 15+ / R 18+; TV-Y7 / TV-PG / TV-14 / TV-MA), feeding the shared age gate. This is the TV version of Cinema's G2 fix.
- **Age tiers, incl. TV-14 (decided 2 October):** see `tv14-age-tier-plan.md`. TV-14 allows TV-Y, TV-Y7, P, C, TV-G, TV-PG, G, PG, TV-14, M and blocks TV-MA, MA 15+, R, R 18+, adult. A show without AU/US ratings goes through Simkl → MDBList (cert, Common Sense) → TMDB GB/IE/NZ/CA → the LLM. **Anime is excluded** from Marquee TV by several detectors.
- **Format gate** (Q4): formats with no history (e.g. Reality, Talk, News) are excluded.
- **Anime goes to the anime lane** (§5); Kids/Soap/Talk per the profile's exclusions.
- At least one aired episode; an IMDb `tt` id (needed for streams).

### 3.5 Scoring (Tier-1 sketch, version `marquee-tv-t1`)

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

**Serving:** reuse calibrated serving unchanged. The target is the genre mix of the profile's Engaged-or-better shows (Simkl genres), so the served mix follows real TV taste.

---

## 4. Engine options considered

| Option | What | For | Against | Verdict |
|---|---|---|---|---|
| **A. Extend Marquee to `series`** | One engine, type switch | One codebase; shared tuning knobs | Most stages differ (§2); couples TV experiments to the live Cinema version, config and backtest; a long tail of type branches | **No** |
| **B. Separate Marquee TV + shared library** | `marquee-tv` engine (series only); extract what truly generalises | Clean versioning (`marquee-tv-t1`…), its own Tier-2 config and backtest; Cinema untouched; reuses the proven infrastructure | Some extraction work; two engines to maintain | **Recommended** |
| C. Patch Genesis for TV | Engagement-weighted seeds, Simkl users_recs, filter fixes | Cheap; immediate win for everyone | Genesis is to be deprecated; it would rebuild Marquee's pieces inside the old engine | Only as an optional stop-gap (§7, TV-1b) |
| D. LLM-first | The local LLM proposes shows from a brief; TMDB verifies them | Captures "vibe" | Hallucination, knowledge cutoff misses new shows, slow | Used as source T7 and the fit score only |
| E. Embeddings / semantic | Overview embeddings (Glass's approach) | Good for mood/format similarity | Glass is being deprecated; little history to train on | Later, if the backtest shows a taste gap |

**Shared library** (extracted from Marquee Cinema, behaviour-identical, proven by Cinema's existing tests and an identity fixture as in m4): the local-LLM brief/fit/suggest plumbing and cache, the trending cache access, the Simkl summary cache (generalised from movies to `tv` and `anime`), Bayesian quality, trending-rank maths, the genre-fair normaliser, calibrated serving (already shared).

**Not shared:** taste dimensions, the engagement ladder, sources, filters, scoring weights, version line, Tier-2 config, backtest mode.

Naming: rename only the **display name** "Marquee Engine" → **"Marquee Cinema"**. Keep the id `marquee` (no profile migration). The new engine is id `marquee-tv`, "Marquee TV".

---

## 5. Anime

### 5.1 Evidence

- Only **Ciara** is a real anime viewer (13 of her 17 series). Others have 1–4 anime titles, mostly samplers.
- Anime needs different machinery:
  - AniList's community-voted recommendations and ranked tags are far richer than TMDB.
  - Studios matter.
  - Demographics (shounen / shoujo / seinen) matter.
  - Ages come from MAL bands (already wired), not TV ratings.
  - Each anime season is a **separate entry** on AniList/MAL but **one show** on TMDB/IMDb. Candidates must be rolled up to the TMDB/IMDb show via Fribb (already wired), or we'd recommend "season 2" of a show she's already in.
- Mixed into TV, anime distorts the TV taste model and the calibration target (Animation share). It also needs the `Anime` exclusion hack that most profiles already carry.

### 5.2 Options

| Option | For | Against | Verdict |
|---|---|---|---|
| Keep mixed in TV | No new catalog | Distorts TV taste and calibration; anime-specific sources unused; most profiles exclude it anyway | No |
| Separate catalog, same TV engine with an anime "mode" | One engine | Forces AniList sources, tags and roll-up into the TV engine; the same coupling problem as A | No |
| **Separate lane: "Marquee Anime" engine + "Anime for you" catalog** | Right sources and age system; the TV engine stays clean; per-profile on/off | One more (small) engine | **Recommended**, built after TV and reusing the TV engagement ladder |
| A custom Stremio type `anime` | Its own tab in Discover | Stream addons and Cinemeta answer `movie`/`series` with `tt` ids; a custom type risks no streams or metadata in Nuvio | **No.** Use type `series` + catalog id `ai-recs-anime` |

### 5.3 The anime lane, sketched

- **History:** the Simkl `anime` section (already synced), separated from `shows` (today both collapse into `series`).
- **Sources:**
  - AniList recommendations (vote-weighted) per seed;
  - Simkl `/anime/{id}` `users_recommendations`;
  - Simkl anime trending (491, cached);
  - AniList seasonal charts ("airing this season");
  - tag-driven AniList search.
- **Taste:** ranked tags, studios, format (TV / ONA / Movie), demographic, era.
- **Ages:** MAL bands (existing `mal.js`), applied before storing.
- **Ids:** Fribb maps MAL/AniList → TMDB tv + IMDb. Roll up seasons to the show, and drop anything without a `tt`.
- **Profile setting "Anime":** *Own catalog* / *Off*.
  - With its own catalog, the TV lane excludes anime automatically. The manual "Anime" genre exclusion becomes unnecessary (migrate it).
- **Anime films:** stay with Marquee Cinema (per-profile Anime exclusion as today). Out of scope for v1 (Q5).

---

## 6. Evaluation: a TV backtest

- `bench-engines.js --type series --holdout 10`.
- **Holdout:** the 10 most recently *started* shows that reached at least Engaged, using **real (non-bulk) first-episode timestamps only**. Bulk-imported shows carry their import time, so ordering them by time is meaningless.
- **Build:** from history minus those shows (their episodes removed).
- **Metrics:** hit@20, recall@100, Engaged-hit@20 (did we find shows they *stuck with*, not just started), served KL vs target, format purity (share of the served list in formats with history).
- **Baseline:** Genesis on the same holdout, run before any build card. Siobhan (11 real-pattern shows) and Ciara are thin, so report per profile, and treat differences of one or two hits as noise.
- **Anime:** the same method on Ciara, holdout 5.

---

## 7. Phasing (cards for Bob; spikes by Claude)

| Phase | Who | Scope | Exit check |
|---|---|---|---|
| **TV-0 spike** | Claude | Measure coverage on candidate shows: Simkl summary hit rate (genres, droprate, users_recs), TMDB AU-rating coverage, keyword coverage for the Horror/Thriller/Romance mapping, Fribb coverage of Ciara's history. Plus the **Genesis TV baseline** backtest. | Numbers in the spec; thresholds set |
| **TV-1 foundation** | Bob | Per-show progress store (watched/aired/status/last watched/bulk flag, from extended all-items, activities-gated) + the engagement ladder (pure, tested) + `shows` vs `anime` kept distinct in the watched store | Ladder matches hand-labelled shows for 3 profiles |
| ~~TV-1b~~ | — | Dropped (Q8): Genesis stays unchanged while Marquee TV is built | — |
| **TV-R ratings for shows** | Bob | Show-level ratings (never per episode) in the portal Ratings tab + companion; Simkl show ratings sync; a rating overrides the ladder weight | Rate/unrate round-trips to Simkl; ladder uses it |
| **TV-2 engine core** | Bob | `marquee-tv`: filters, taste model, sources T1–T6, scoring without LLM, shared library extraction (Cinema identity-tested), registered **dark**, bench `--type series` | Backtest vs Genesis on James/Siobhan/Andrew; Cinema unchanged |
| **TV-3 intelligence** | Bob | LLM brief / suggestions / fit for TV, calibrated serving target from Engaged+ shows, portal/companion naming (Marquee Cinema / Marquee TV) | Backtest + live genre and format mix |
| TV-4 (optional) | Bob | "New & returning for you" row (airing-now shows matched to taste) | Your call (Q7) |
| **AN-1 anime lane** | Bob | `ai-recs-anime` catalog + per-profile Anime setting + TV-lane exclusion + migrating the manual "Anime" exclusions | Ciara sees two rows; nobody else changes |
| **AN-2 Marquee Anime** | Bob | AniList/Simkl sources, tag taste model, season roll-up, MAL ages | Anime backtest on Ciara; age-band checks for Conor/Ciara |

Every card gets the usual guardrails: scope fence, identity proof for anything shared, hermetic tests, hand-back report.

---

## 8. Decisions (James, 2 October 2026): DECIDED

| # | Decision |
|---|---|
| Q1 | **Separate engine** `marquee-tv` (option B) |
| Q2 | Sampled-and-left shows are **neutral** (never a seed, never recommended back) |
| Q3 | TV recency filter by **last air date** |
| Q4 | Formats with no history are **hard-excluded** (portal override) |
| Q5 | Anime gets **its own catalog**, enabled/disabled per profile in **both** the portal Config and the Mobile Companion config |
| Q6 | **Mild penalty** for shows cancelled after one season |
| Q7 | "New & returning for you" row: **later** |
| Q8 | **No Genesis stop-gap.** Genesis keeps serving series, unchanged, until a profile is switched to Marquee TV (the new engine ships dark and is chosen per profile, as Marquee was) |
| Q9 | **Ratings for shows are needed and feed the score, rated per SHOW, never per episode.** A show rating overrides its engagement-ladder weight (the film rating table; 10 = Loved). Synced to Simkl `/sync/ratings` as a show rating. |

Consequences for the phasing (§7): TV-1b is dropped; a **TV-R card** (Ratings for shows: the Ratings tab and companion list get a Shows view, with each row showing progress such as "12 / 24 eps") follows TV-1, because its rows need the per-show progress store.

### Original questions (for the record)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Separate engine (B) or extend Marquee (A)? | **B** |
| Q2 | "Sampled and left" shows (≤ 2 eps, untouched 60 days): neutral or a mild negative? | **Neutral** (consistent with abandoned films); never a seed, never recommended back |
| Q3 | TV recency filter by first or last air date? | **Last air date** (a show airing in or after the decade qualifies) |
| Q4 | Formats with no history (Reality, Talk, Documentary…): hard-exclude or just down-weight? | **Hard-exclude** per profile, with a portal override |
| Q5 | Anime: own catalog for which profiles? Anime films in scope? | Own catalog **on for Ciara** (Conor: your call, he has 2 anime titles); others off. Films **out** of v1 |
| Q6 | Penalise shows cancelled after one season? | Yes, mildly (−0.05) |
| Q7 | Add a "New & returning for you" row (TV-4)? | Later, after TV-3 proves itself |
| Q8 | Do TV-1b (the Genesis stop-gap) while Marquee TV is built? | Only if Marquee TV is weeks away; otherwise skip |
| Q9 | Extend the Ratings trainer to shows? | Later. The engagement ladder carries most of the signal; ratings then refine it |

## 9a. TV-0 spike results (2 October 2026)

**Sample:** 126 shows from the live Genesis series pools (James, Siobhan, Andrew, Mom; non-anime), plus watched shows as seeds.

| Check | Result |
|---|---|
| Simkl found by IMDb id | **100%** (126/126) |
| Simkl genres / droprate / `users_recommendations` present | **100% / 100% / 100%**; mean 11.7 recommendations per show, **all** carrying an IMDb id |
| Simkl genres TMDB lacks (count of shows) | Thriller 54, Action 35, Adventure 23, Science-Fiction 16, Suspense 14, Horror 14, Fantasy 13, Romance 12, Mini-Series 12, Children 7 |
| Horror mapping | Simkl Horror 14; TMDB horror-ish keyword on 13 of them; 4 keyword-only |
| TMDB AU rating / US rating / any AU-US-GB | 75% / 98% / 98% |
| TMDB keywords / networks / runtime | 100% / 100% / 100% |
| TMDB type of the pool sample | Scripted 109, Miniseries 11, Documentary 3, Reality 3 |
| TMDB status of the pool sample | Ended 80, Canceled 23, Returning 23 (Genesis lists lean old and finished) |
| Seeds at Engaged or better (≥ 6 eps or completed) | James 74/103, Siobhan 54/75, **Andrew 2/42**, Ciara 10/17; `users_recommendations` on 100% of sampled seeds (~11–12 each) |
| Anime id map (Fribb) for Ciara's history | 11/13 mapped, with IMDb + AniList ids |
| Incremental (`date_from`) pull | Returns a changed show **with its full episode list** (verified on *Law & Order: SVU*) |

**What this settles:**
- Simkl is a safe primary for TV (genres, drop rate, collaborative recommendations).
- Exclusions use Simkl genres with a TMDB-keyword fallback.
- Kids filtering uses AU, then US ratings (98% coverage together).
- Andrew is a cold start for TV, so Marquee TV must work from trending + airing + discover when seeds are few.

## 9. Risks / open points

- **Simkl summary coverage** (*Slasher* found nothing by IMDb id): the TV-0 spike measures it; TMDB is the fallback for genres and recommendations.
- **The Simkl request budget:** TV summaries add governed GETs per build. They need the same caps and 30-day cache as films.
- **Andrew's history** is 37 samplers out of 42. Marquee TV will have very few seeds for him, so it must fall back to trending + airing-now + discover by the little taste it has. That's a good robustness test.
- **Small numbers everywhere:** the backtests will be noisy. Judge by eye on the live lists alongside the numbers, as with m4.
- **Bulk timestamps:** the ladder must never read viewing speed or recency from a bulk stamp. That needs a unit test with real export shapes.
## 10. TV-1 build notes

TV-1 (v7.29.0-beta) builds the data foundation only — the per-show progress store, the pure engagement ladder, and the series backtest. No engine, no UI, no serving change.

- **`src/services/simkl.js`** — `parseSeriesProgress(item, section)` (pure): parses one Simkl all-items entry (shows/anime) into a progress row with the bulk-stamp classification (`BULK_GAP_MS = 300000`); `parseSeriesProgressItems` maps a section.
- **`src/watchedStore.js`** — the `series_progress` (per `(profile_id, simkl_id)`) and `series_progress_sync` tables; `upsertSeriesProgress`, `getSeriesProgress`, `getSeriesProgressSync`, `setSeriesProgressSync`; `syncFromSimkl` backfills once per profile (V2).
- **`src/seriesEngagement.js`** (new) — the pure engagement ladder: `DEFAULTS` (nested `weights` + `rating_weights`, overridable via cfg — V3), `RUNG_WEIGHTS`, `RATING_WEIGHTS`, `ratingWeight`, `rungOf`, `ladder`, and `ladderFor` (the only DB-reading helper — reads `getSeriesProgress` and joins `taste_ratings` type `series` by `tmdb_id`).
- **`src/bench/engineBench.js`** — `pickSeriesTargets`, `removeSeriesHoldout`, and `runBench`'s `type` param (default `movie`); the series holdout and the leakage check (series progress rows **and** the watched id sets); the engine loop driven by `type`; the reachability and serve-strategy sections are movie-only (not run, and not printed, for series).
- **`scripts/bench-engines.js`** — `--type movie|series` flag; a series run defaults to the Genesis baseline engine unless `--engines` is given.
- **`scripts/series-ladder.js`** (new) — a read-only debug script: prints the engagement ladder for every show in a profile's `series_progress` (rung, weight, recency, active-now, binge, seed eligibility, value, plus the raw progress and a per-rung count summary).
- **Tests:** `test/smoke.js` P1–P6 (ladder + parse, pure) and `test/integration.js` I1–I5 (store/sync/backfill + `ladderFor`), B1–B4 (series backtest) and S1–S2 (holdout leaves watched/pending_watched/dont_recommend; reachability movie-only).

## 11. TV-2 build notes

TV-2 (v7.30.0-beta) builds the Marquee TV engine core — the orchestrator, the TV meta + Simkl show-recs caches, the pure filters/taste/sources/scoring, and the registry registration. No LLM yet (TV-3). It ships **GLOBALLY DISABLED**: registered but off via the `engines.isEnabled` default, so nothing users can see changes until an admin enables it (M1).

- **`src/engines/marqueeTv.js`** (new) — the descriptor (`id 'marquee-tv'`, series-only, `preResolved`) + the `generate` orchestrator: ladder → taste model + seeds → gather T1/T2/T3/T5/T6 → merge pool → subtract watched/dont → pre-score + cut → TV meta + IMDb ratings → hard filter → score → emit pre-resolved candidates. Every network call goes through the `ctx.marqueeTvFetchers` seam (M6).
- **`src/engines/marqueeTv/config.js`** (new) — `ALGORITHM_VERSION 'marquee-tv-t1'`, the §3 DEFAULTS, and `resolveConfig`.
- **`src/engines/marqueeTv/{meta,simklRecs,filters,taste,sources,scoring}.js`** (new) — the TV meta cache (§5.1–5.2), the Simkl show-recs cache (§5.3), the pure filters (§4.1–4.4), the taste/seeds (§4.5), the sources + pre-score (§4.6/§5.4), and the scoring (§4.7).
- **`src/engines/index.js`** — `marquee-tv` added to the REGISTRY (one line + require); non-Genesis engines default OFF, so it is dark until an admin enables it (M1).
- **`src/services/tmdb.js`** (additive) — `discoverTv` (`GET discover/tv`) + `tvDetailsFull` (append `credits,keywords,external_ids,content_ratings`).
- **`src/bench/engineBench.js`, `scripts/bench-engines.js`** — the series bench runs `marquee-tv` alongside Genesis (E2); the series report file name (C3); `removeSeriesHoldout` also clears `pending_watched` by IMDb id (C5).
- **Tests:** `test/smoke.js` F1–F9 (pure); `test/integration.js` N1–N3 (adapters, fetch-level), E1 (orchestrator end-to-end + registry dark), E2 (series bench runs both engines).

## 12. TV-3 build notes

TV-3 (v7.32.0-beta) adds the local-LLM layer (taste brief, suggestions T7, fit score), calibrated serving for series, and the three TV-2 leftovers (L1 raw-name genre affinity, L2 per-build Simkl cap, L3 served order). It ships on the same globally-disabled engine (M1) — no user-visible change until an admin enables it.

- **`src/engines/marqueeTv/llm.js`** (new) — `tvBrief` (§3.1, kind `tv_brief`), `tvSuggest` (§3.2, kind `tv_suggest`), `tvFit` (§3.3, kind `tv_fit`), the TV prompts, and the verbatim copies of Cinema's `parseBrief` / `parseSuggestions` (N2). Local LLM only (N3); graceful degradation — no chain / a failed brief / a failed batch never fails the build, and a failure is never cached (N4).
- **`src/engines/marqueeTv.js`** — wires the brief (step 5), T7 (step 6), the fit fold (step 12), the calibrated serve target (step 15), and the §7 summary-line LLM tail; the descriptor gains `serveOrder 'calibrated'` + `serveOptions`.
- **`src/engines/marqueeTv/config.js`** — the §6 `DEFAULTS` sections (`llm_timeout_ms`, `brief`, `suggest`, `llm_fit`, `serve`); `ALGORITHM_VERSION 'marquee-tv-t2'`.
- **`src/engines/marqueeTv/sources.js`** — the T7 group plumbing (the `llm` group, llm-first lookup cut), L1 (`listGenreNames` raw names), L2 (batched T1 fetcher).
- **`src/engines/marqueeTv/scoring.js`** — unchanged (the fit fold reads `scoreComponents.features` / `penalty` directly; no change needed).
- **N5 (I1):** no prompt mentions age, suitability, children, classification or ratings boards — the prompts pass `/age|suitab|child|kid|classif|rated (G|PG|M)/i`.
- **Tests:** `test/integration.js` L1, L2 (leftovers), S1, S2 (calibrated serving), B1 (brief), B2 (suggestions), B3 (fit), B4 (degradation identity), E1 (end-to-end order + summary line + serve target).
