# Glass Engine — Technical Design Spec

**Version:** 0.1 (working draft — iterate freely)
**Status:** DESIGN ONLY. No code. Not registered. Not a source sign-off.
**Kind:** A *candidate-producer* engine behind the existing engine abstraction.
**Depends on:** [`../engine-abstraction/00-overview.md`](../engine-abstraction/00-overview.md)
(the seam), [`../engine-abstraction/CONFORMANCE.md`](../engine-abstraction/CONFORMANCE.md)
(the definition of done), [`src/engines/_template.js`](../../src/engines/_template.js).

> ⚠ **Source-choice gate (standing rule).** Glass, as submitted, silently assumes
> several *new data sources* — TMDB trending/popular/discover, an embedding model +
> vector store, a popularity time-series. Every one of those is **James's call, not
> the implementer's** (catalog/source choices are surfaced as options and confirmed,
> never chosen unilaterally). This doc **names** each such dependency as a decision
> (`GD-n`) and does **not** pre-commit any of them. See §6.

---

## 0. What this document is

The submitted "Movie Recommendation Engine" spec (v1.0) is a strong, well-thought
recommendation design. But it was written as a **standalone service that owns its
whole pipeline** — profile loading, hard filtering, watched exclusion, age
restriction, diversity, catalogue selection, caching, and a serve endpoint.

This repo **already owns most of that**, in a *shared* layer that every engine is
**contractually forbidden from re-implementing** (invariants I1–I7,
`CONFORMANCE.md`). The abstraction seam — decided and shipped in the
engine-abstraction work — is the **pool row**: an engine is given `(profile, type)`
and returns `NormalizedCandidate[]`; the shared pipeline resolves, enriches,
age-gates, de-dupes-against-watched, stores, and the shared serve path filters,
genre-balances, sizes and emits the catalogue.

So "recreate this into a working design spec" is, in practice, a **re-scoping**:
keep everything valuable in the submitted spec, but sort each idea into one of four
buckets and design Glass to live only in the bucket that is actually the engine's
job. That sorting is §3 (the spine of this doc). §1–§2 answer the four review
questions. §4–§9 are the re-scoped spec proper.

---

## 1. Review — the four questions, briefly

**1. Improvements you see (genuinely good ideas worth keeping).**
- **Split taste into LONG / MEDIUM / RECENT** with an explicit **recency half-life**
  (`0.5 ^ days/half_life`). Genesis already recency-weights (half-life 90d) but keeps
  a *single* blended signal; separating "current mood" from "established taste" is a
  real upgrade and is engine-internal (safe to add).
- **Trending momentum treated separately from raw popularity** ("people are watching
  this *right now*" ≠ "this is a big title"). Correct distinction.
- **Score-component retention** (store the breakdown, not just the final number) —
  essential for debugging/tuning/A-B/ML. This is a genuine *gap* today (the pool
  stores only `affinity`). Worth a small shared schema addition (§5.1).
- **Configurable, externalised, versioned scoring** (`algorithm_version`) so historical
  rows stay interpretable across weight changes. Cheap, high-value.
- **Explicit exploration reserve** and **behavioural-signal weighting** (a 9/10 rating
  ≠ a 5% start). Both fit inside `generate()`.
- **Graceful degradation as a first-class rule** ("the AI layer is an enhancement, not
  a dependency"). This already matches the codebase's LLM-chain philosophy and I-set;
  keep it.
- **A staged Phase 1→5 rollout.** The shape is right; §8 re-maps it onto the seam.

**2. Problems you see (blocking, in priority order).**
- **P1 — Boundary violation (the big one).** ~60% of the submitted pipeline
  (hard filtering, watched exclusion, age/porn, diversity/MMR, catalogue selection,
  the runtime endpoint, caching, the feedback/impression tracking) **duplicates the
  shared layer** and would **violate I1–I7 and fail the conformance gate**. An engine
  that re-owns the age gate or watched-exclusion is *non-conformant by definition* and,
  worse, could weaken a kids profile. Fix: Glass produces candidates + `rankScore` only
  (§3, §4).
- **P2 — Internal size contradictions.** §1 says master pool **200–400**, §36 says
  **100–200**, §37 says input **200–400** → output 20–40. These can't all hold. And in
  this repo the "final 20–40" is **not an engine number at all** — it's the shared
  serve-time `list_size` (clamped 5–50, default 20). Reconciled in §4.7.
- **P3 — Candidate volume vs. resolve cost.** "5,000–10,000 candidates" collides with
  the pipeline, which does **one TMDB `imdbFor` call per candidate** to resolve a tt-id
  (Genesis stores ≤300/type and only resolves the *kept* set). 5–10k → 5–10k network
  calls **per profile per build**. Glass may *consider* a wide set internally, but must
  **score-and-truncate to a resolve-affordable slice (≈ a few hundred/type) before
  returning** (§4.2, Glass-invariant GI-1).
- **P4 — The IMDb-in-scoring ordering bug.** §23–24 score `quality` from IMDb, but in
  this codebase IMDb ratings are enriched by the **pipeline, after `generate()`**, and
  engines must never write `imdb_rating` (I4). So Glass literally cannot read a finalised
  IMDb rating while scoring. Fix: Glass scores quality on **TMDB `vote_average`** (present
  at generate time); the IMDb number stays a shared serve-floor + display concern (§4.3).
- **P5 — Unowned new subsystems presented as if they exist.** Embeddings (model + vector
  store), trending/popular/discover endpoints, and a popularity time-series are all
  **net-new** and **source decisions** (§6). None can be silently assumed.
- **P6 — Age/porn handled twice.** The spec gives Glass `viewer_age`, `content_rating`
  and a porn filter. Age classification + the NSFW blacklist are **shared and absolute**
  (I1/I7). Glass must **not** own them; it may be *age-aware in generation* as a
  complement (e.g. an LLM proposing age-appropriate titles), never as the authority.

**3. What I'd change to make it better (headline recommendations).**
- **R1 — Re-scope Glass to a candidate producer** against `CONFORMANCE.md`. Everything
  in §3's SHARED column is deleted from Glass's remit.
- **R2 — Ship it in thin, independently-valuable layers**, each behind
  `requirements()` + the global-disable gate, degrading gracefully: (a) taste-v2 +
  broadened candidates + configurable weighted scoring; (b) semantic embeddings; (c)
  LLM rerank + explanations; (d) score-component store + feedback wiring; (e) learned
  ranking. This mirrors the submitted Phase 1–5 but on the seam (§8).
- **R3 — Reuse the existing LLM chain** (`settings.llmChain`: custom-local → Groq →
  Groq). "Local Qwen" = the **custom** provider; do not hardcode Qwen or a second LLM
  path. Timeout + fall-through already exist (`services/llm.js`).
- **R4 — Add exactly one shared enhancement now: a score-components store** (§5.1) so
  tuning/analytics/ML have data from day one. Keep it engine-agnostic (Genesis can fill
  it too).
- **R5 — Keep Glass `unrestricted: false`** (age-gated, safe for any profile via the
  shared gate). An "all ages / open" Glass is a separate, later, explicitly-hardened
  decision (overview §8 Q1); not in this spec.
- **R6 — Decide the config surface deliberately** (global admin vs per-profile vs
  companion-editable) — half-lives and weight vectors are build-affecting (§7, GD-6).

**4. Movies & Shows without affecting one or the other — YES, already guaranteed.**
The seam is **per-`(profile, type)`** end to end: per-type `generate`, per-type
dispatch (SC-03), per-type pool slices, per-type `clearType`, per-type engine
selection (`engine_movie`/`engine_series`), per-type seed caps, vote floors,
movies-only recency, and serve-time genre balance. Glass declares
`supportedTypes: ['movie','series']` and writes a **type-parameterised** `generate`;
nothing on the movie side can touch the series side. The real work is discipline, not
plumbing — every source query and the taste model must be **type-scoped**, and a few
curves want **per-type tuning** (a film "completes"; a show runs for years). Full
treatment in §9.

---

## 2. The seam, in one picture (where Glass is allowed to live)

```
        ┌──────────────── GLASS (this spec) ────────────────┐   ┌──────── SHARED (exists; DO NOT re-own) ────────┐
 watch  │  build taste model (L/M/R + half-life)            │   │  pipeline: normalize → subtract watched/dont    │
 history│  → generate candidates (strategies A–G)           │   │   → resolve tt/poster/genres → IMDb enrich      │
 (Simkl)│  → feature calc → weighted base score (rankScore) │   │   → upsert pool → purge vote-floor        [I3–I5]│
   ────► │  → (opt) semantic rerank → (opt) LLM rerank       │──►│  ageGatePool: NSFW + anime band + LLM ACB   [I1] │
        │  → score-and-truncate to resolve budget    [GI-1] │   │  serve: rating floor, excluded genres, recency, │
        │  return NormalizedCandidate[] (+ rankScore,       │   │   age-band recheck, genre BALANCE, list_size,   │
        │            optional score_components)              │   │   impressions/decay, Stremio metas         [I2] │
        └────────────────────────────────────────────────────┘   └──────────────────────────────────────────────┘
             ▲ per (profile,type); swappable per type                 ▲ identical for every engine — the invariants
```

Glass **never**: hard-filters for the user, excludes watched titles as *the*
guarantee, age-gates, balances genres for the final list, chooses the catalogue size,
serves a request, or writes `imdb_rating` / `age_classification` / impression columns.
It *may* pre-filter (watched/porn) as an optimisation — the shared layer re-guarantees
it — exactly as Genesis does.

---

## 3. The spine — every submitted §, sorted into four buckets

**Legend.** **SHARED** = already exists, Glass must not re-implement (delete from remit).
**ENGINE** = genuinely Glass's job, inside `generate()`. **NEW-SHARED** = a real gap;
a small engine-agnostic addition (its own card). **DECIDE** = needs James's sign-off
(source/infra/config; §6).

| Submitted § | Topic | Bucket | Where it actually lives / note |
|---|---|---|---|
| 1, 36, 37 | Master pool + user catalogue sizes | SHARED + reconcile | "Final 20–40" = serve `list_size` (5–50, default 20). "Master pool" = stored slice (Genesis: `STORE_CAP` 300/type). §4.7 |
| 6 | Profile loading | SHARED | `config`/`profiles.json`; Glass reads `ctx`/`profile`, never loads |
| 7, 8, 9, 10 | Taste model, L/M/R, half-life, behavioural signals | **ENGINE** | Core of Glass (§4.1). Genesis has a single-signal version |
| 11 | Candidate generation strategies A–G | **ENGINE** + **DECIDE** | Logic is Glass; strategies C/D/E/F need new TMDB source surface (GD-1) |
| 12 | Candidate dedup (+ source buckets) | **ENGINE** | Inside generate; keep `sources[]` for explanations |
| 13, 14 | Hard filtering (watched/genre/rating/year/age/porn) | SHARED | serve `selectServe` + `ageGatePool` + I3/I5. Glass may pre-filter only |
| 15 | Exact watch exclusion (multi-level) | SHARED (I5) | Build + pipeline + serve already enforce; Glass pre-excludes as optimisation |
| 16 | Franchise handling (title≠franchise) | **ENGINE** (optional) | A small rank bonus/penalty in scoring; watched-title exclusion is shared |
| 17 | Feature calculation (normalised 0–1) | **ENGINE** | §4.2 |
| 18 | Taste match (weighted components) | **ENGINE** | §4.2 |
| 19 | Semantic similarity (embeddings) | **ENGINE** + **NEW-SHARED** + **DECIDE** | Deferred behind LLM rerank (GD-2); optional/evidence-gated local subsystem (§8-C, §5.2) |
| 20 | Popularity (log-damped) | **ENGINE** | TMDB `popularity` available at generate time |
| 21 | Trending momentum (Δ popularity) | **ENGINE** + **DECIDE** | No popularity time-series exists → use TMDB *trending* endpoint as the source (GD-1) or build snapshots (GD-3) |
| 22 | Movie release recency | **ENGINE** | From `year`/release date at generate time |
| 23, 24, 25 | Quality + weighted final score + per-profile weights | **ENGINE** (fix P4) | Score `quality` on TMDB `vote_average`, **not** IMDb; weights configurable (§4.3, GD-6) |
| 26 | Retain score components | **NEW-SHARED** | Score-components store (§5.1). Glass emits them; store persists them |
| 27 | Initial ranking funnel | **ENGINE** | Respecting GI-1 (truncate before resolve) |
| 28, 29, 30 | LLM rerank + constraints + failure handling | **ENGINE** (reuse chain) | `settings.llmChain`; optional; timeout→deterministic fallback (§4.4) |
| 31, 32, 33 | Diversity / MMR / genre quotas | SHARED | serve `balanceByGenre` (round-robin, floor-not-force-fill — already "no rigid quotas") |
| 34 | Exploration reserve | **ENGINE** | Inject exploration candidates in generate; they pass the shared gate/filters |
| 35 | Named recommendation pools | **ENGINE** | Internal `sources[]` buckets; not new storage |
| 38 | Catalogue size configurable (not hard-coded) | SHARED | `list_size` already 5–50 continuous |
| 39 | Explanations (structured → natural language) | **ENGINE** (+ LLM) | `reason`→`because_title` exists; richer reasons need the components store (§5.1) |
| 40, 41, 44 | Cache / precompute / lightweight runtime request | SHARED | The build/serve split *is* this. Serve is local-only already |
| 42, 43 | Background processing + invalidation | SHARED (mostly) | `needsBuild`, jobs, `clearType`-on-engine-change (SC-03). Glass-tuning changes → build-affecting (§7) |
| 45 | Data freshness per feature | SHARED + **DECIDE** | Ratings/anime/decay cadences exist; embeddings/trending cadence is new (GD-4) |
| 46 | Observability / generation trace | Partly SHARED, **NEW-SHARED** for component stats | Build logs + Advanced tab exist; add per-strategy + filter-stats counters |
| 47, 48 | Recommendation event tracking + feedback loop | SHARED + **NEW-SHARED** | Impressions/decay/`engaged_at`/Simkl scrobble/mark-watched exist; a fuller event stream is an additive layer (§8-D) |
| 49 | Learned ranking (LightGBM/XGBoost) | **ENGINE** (future) | Produces `rankScore`; needs the components store + feedback first (§8-E) |
| 50 | Versioned scoring | **ENGINE** + **NEW-SHARED** | `algorithm_version` on stored rows/components |
| 51, 52 | Configuration-driven + graceful degradation | **ENGINE** + config | §7; degradation via `requirements()` + try/skip |
| 53 | Phased implementation | Re-mapped | §8 |
| 54, 55, 56, 57 | Reference algorithm / architecture / principles / end-state | Re-scoped | Glass's `generate()` is the *inner* funnel; the outer funnel is shared |

**Reading of the table:** the submitted spec's biggest sections (13–16, 31–33, 40–44)
are **already built and must be left alone**. Glass's real surface is a compact set:
taste-v2, broadened candidate generation, feature/score math, optional semantic +
LLM layers, exploration injection, and the emission of `rankScore` (+ components).

---

## 4. Glass, scoped — the `generate(profile, type, ctx, onProgress)` design

Signature and contract are fixed by the abstraction (`_template.js` / `types.js`).
Everything below runs **only in the background build**, never on the serve path.

### 4.1 Taste model (per type) — submitted §7–§10
Built from `watchedStore.getWatched(profile.id, { type })` (type-scoped, like Genesis).

- **Three horizons** from one watch list via decayed weights, not three queries:
  `w = 0.5 ^ (days_since_watched / H)`. Keep three half-lives — `H_recent` (short,
  "mood"), `H_medium`, `H_long` (long, "established"). Combine as
  `taste = α·long + β·medium + γ·recent` (weights configurable; §7).
  *Rationale:* reacts to a current binge without overwriting long-term taste — the
  submitted spec's key insight, achievable without a schema.
- **Affinity dimensions** (0–1 normalised): genres, keywords, directors, actors,
  decades, runtime bands, languages/countries, franchises. **Availability caveat:**
  Genesis today only has what TMDB `/recommendations` returns per title (genre_ids,
  vote_*, popularity, poster). Directors/actors/keywords require **extra TMDB
  credit/keyword calls per seed** — a cost decision (GD-5); start with genres +
  keywords + decade + runtime and add cast/crew if the cost is justified.
- **Behavioural signals** (submitted §10): today the only durable signals are
  *watched* (Simkl) and the negative *`dont_recommend`* (rejected/decayed). Rating /
  completion / like-dislike weighting depends on the feedback layer (§8-D). Design the
  taste-model input as a **weighted event list** so richer signals slot in later
  without a rewrite; ship with watched=+1, `dont_recommend`=strong-negative.

### 4.2 Candidate generation + feature calc — submitted §11–§12, §17–§22
Strategies, each contributing a **configurable count**, de-duped by `tmdb_id` with a
retained `sources[]`:
- **A Taste similarity / B Because-you-liked** — TMDB `/recommendations` per strong
  seed. *Available today* (Genesis's mechanism).
- **C Recent releases · D Trending · E Popular · F Hidden gems** — from the **Simkl
  trending cache** (§5.3, GD-1): filter the combined `week_500` lists by the profile's
  top-genre affinities; `watched`/`drop_rate` give velocity+momentum and inline
  `ratings` give quality, all with no extra calls. TMDB `/discover` stays an *optional*
  add for pure-recency or hidden-gem queries Simkl can't express (not required for v1).
- **G Exploration** — "outside taste but plausible + high quality," drawn from top
  trending (depends on D). Injected here; passes the shared filters/gate unchanged.

**Features** (all normalised 0–1, all computable at generate time from TMDB payloads
+ the taste model): `taste_match`, `popularity = log(1+pop)` then normalised,
`quality = f(vote_average)` (**not IMDb**, P4/§4.3), `release_recency`,
`novelty`, `exploration`, `trending_momentum` (Simkl `drop_rate`/`watched`, §5.3), and
— if the embeddings phase is built (§8-C) — `semantic_similarity`.

> **GI-1 (Glass invariant — performance).** However wide the internal candidate set,
> `generate()` MUST **score and truncate to a resolve-affordable slice** (a
> configurable `resolve_cap`, default ≈ `STORE_CAP` = 300/type) **before returning**,
> because the pipeline does one network resolve per returned candidate. The submitted
> "5,000–10,000" is a *pre-scoring* number that must collapse before the return.

### 4.3 Base scoring → `rankScore` — submitted §23–§26
Configurable weighted sum over the normalised features → a single comparable
`rankScore` (higher = stronger), stored in the `affinity` column (I6). Starting
weights per the submitted §24, **with `quality` sourced from `vote_average`**. Every
weight externally configurable (§7); stamp `algorithm_version`. Emit the per-feature
breakdown as `score_components` for the store in §5.1.

### 4.4 Semantic layers — LLM rerank first, embeddings later (GD-2 resolved) — submitted §19, §28–§30
The profile's **free local LLM is the primary semantic layer** and is promoted ahead of
vector embeddings. Rationale (GD-2, James 2026-09-10): the local model is a *chat* model
— its natural fit is reasoning/reranking, not producing vectors — and it costs nothing,
has **no API limits**, and adds **no new subsystem**. Vector embeddings (a *separate*
embedding model + a vector store) are deferred to an optional, evidence-gated phase.
- **LLM semantic rerank (§8-B, promoted — the primary semantic layer):** send the **top
  ≈100–300** candidates (never thousands) + a condensed taste summary to
  `llm.chat(settings.llmChain(), …)` — the **custom local provider is "Qwen"**; no new
  LLM path. It returns a reordering + the "because…" reasons (→ §5.1 / §39). Constraints
  (submitted §29) are already guaranteed *structurally*: the LLM output only re-weights
  `rankScore`; it cannot reintroduce watched titles, bypass the age gate, or invent
  metadata, because those are enforced downstream by the shared pipeline/gate/serve, not
  by the LLM. **Prefer the local endpoint and degrade to deterministic order** on
  timeout/malformed/unavailable (existing chain behaviour) rather than spilling a rerank
  pass to cloud/Groq quota. Runs in the **build**, never at serve.
- **Vector embeddings (§8-C, deferred / optional / evidence-gated):** cosine similarity
  between a per-`(profile,type)` taste vector and candidate vectors, folded in as the
  `semantic_similarity` feature. Requires the embeddings subsystem (**GD-2**, §5.2).
  Built **only if** the score-components data (after the LLM-rerank phase) shows a gap it
  would fill; if built, host the embedding model on the **same local box** (free, no
  limits) or in-process. Absent → feature omitted, weights renormalise (submitted §52).

### 4.5 Diversity — submitted §31–§33 → **SHARED, do not re-own**
The shared serve `balanceByGenre` already does exactly what §33 asks: round-robin
across `primary_genre` buckets, strongest-first, **never force-filling** a genre the
user rarely watches (floor-not-ceiling — it matches "do not force content… rounding
is floor"). MMR at engine time would fight the serve-time balance and is unnecessary.
Glass just needs to populate `primary_genre`/`genres` (via the pipeline resolve) and a
good `rankScore`. *If* a future need for semantic-MMR appears, it is a **serve-path**
change (a shared card), not a Glass feature.

### 4.6 Exploration reserve — submitted §34 → ENGINE
Reserve a configurable 3–10% of the returned slice for exploration candidates
(strategy G). They still pass every shared hard filter + the age gate (submitted §34
agrees). This is the one "diversity-ish" thing that *is* an engine concern, because it
is about *what enters the pool*, not how the final list is ordered.

### 4.7 Output sizes — reconciling submitted §1/§36/§37 with reality
- **`generate()` returns** ≤ `resolve_cap` (≈300/type) NormalizedCandidates. That is
  "the master pool" for Glass. There is no separate 100–200 vs 200–400 number to pick;
  it's one configurable cap (GI-1).
- **The user catalogue (20–40)** is **not produced by Glass**. It is the shared serve
  path applying `list_size` (5–50) to the stored, filtered, genre-balanced pool.
  Delete catalogue selection from Glass's remit entirely.

### 4.8 NormalizedCandidate — what Glass fills
Required: `type`, `tmdb_id`, `rankScore`. Recommended passthroughs (pipeline uses
them): `genre_ids` (or `genres` + `primary_genre` if `preResolved`), `vote_average`,
`vote_count`, `popularity`, `poster`, `title`, `year`, `reason` (→ `because_title`),
`recCount`. **New (optional):** `score_components` (→ §5.1). **Never set:**
`imdb_rating`, `age_classification`, impression/decay columns (I4).
`capabilities.preResolved: false` (let the pipeline resolve tt-id/poster/genres),
unless a source already carries a verified tt-id.

### 4.9 Engine descriptor (GD-8 — resolved 2026-09-10)
The public identity + frozen slug (shown verbatim in the portal/companion selectors):

```js
{
  id: 'glass',                 // FROZEN slug — persisted in profiles; never reuse/rename
  name: 'Glass Engine',        // parallels 'Genesis Engine'
  supportedTypes: ['movie', 'series'],   // both (series = tv ∪ anime, §5.3)
  // capabilities: unrestricted:false (GD-7), providesRankScore:true,
  //               serveOrder:'affinity'; preResolved per §4.8 / §5.5.
  description: /* family-friendly, verbatim in both UIs */
    "Blends your Simkl watch history with what's popular right now. It learns the "
    + "genres, directors, franchises and eras you gravitate to — counting what you've "
    + "watched recently more heavily — then mixes in titles trending this week that fit "
    + "those tastes. A local AI re-ranks the shortlist and explains why each title is "
    + "there. Genre-balanced, and it never shows something you've already watched.",
}
```
Dropdown tagline (short helper, like Genesis's): *"Trending picks matched to your taste,
re-ranked by a local AI."* Copy is iterable; `id` is not.

---

## 5. New SHARED capabilities Glass needs (engine-agnostic; each its own card)

### 5.1 Score-components store — submitted §26, §39, §50 (recommended: build first)
The pool stores only `affinity` today. To tune, explain, A/B and later train, persist
the **breakdown + version** per stored candidate. Two options:
- **(a) JSON column** `score_components` on `recommended` (+ `algorithm_version`,
  `engine_id`). Simplest; adequate for debugging/explanations.
- **(b) Side table** `rec_score_components(profile_id, type, tmdb_id, generation_id,
  components_json, algorithm_version, engine_id, created_at)` keyed to a
  `generation_id`. Better for analytics/ML history; more moving parts.
Recommendation: **(a) now**, migrate to **(b)** when §8-E (learned ranking) is real.
Engine-agnostic: Genesis can populate it too (it already has `affinity` + `rec_count`
+ `because_title`). This is the *only* shared change worth doing up front.

### 5.2 Embeddings subsystem — submitted §19 (GD-2 resolved: **deferred / optional / local-only**; §8-C)
**Deferred behind the LLM-rerank layer** (§4.4) and gated on evidence. If it is later
built, the shape is fixed to stay within James's "no API limits" constraint:
- **Model — local only.** Either a dedicated embedding model on the **same local LLM box**
  (add an `embed()` transport beside `llm.chat` hitting `/embeddings`; note it's a
  *separate* model from the chat "Qwen") **or** an in-process model (transformers.js,
  e.g. `bge-small`/`all-MiniLM`). No cloud embeddings (rate + $/token, against GD-2).
- **Store — Float32 BLOBs + brute-force cosine.** At build scale (a few hundred candidates
  vs one taste vector) an ANN index is unnecessary — no `sqlite-vec`, no external store.
  Vectors live in a **Glass-owned table**, embedded once per title and cached (static).
- **Watch-outs when built:** a "mushy centroid" for eclectic histories (mitigate with a
  few taste clusters / recency weighting); uncertain lift over GD-5 keywords (exactly why
  it's measured-then-kept). Optional layer; Glass degrades without it.

### 5.3 Trending source, cache & cadence — submitted §21 (GD-1, resolved direction: **Simkl**)

**Source (GD-1).** Simkl's public trending CDN (`data.simkl.in/discover/trending/…`)
is the breadth + velocity source; TMDB does resolution, deep-metadata enrichment
(GD-5) and the taste-similarity core. Verified live 2026-09-10:
- Public static JSON (client_id/app params only — **no user OAuth**), so it is fetched
  **once, server-wide, and cached** — it never touches a profile's authed Simkl budget
  and does not need the user's Simkl connection.
- Every item (movies, tv **and anime**) carries `ids.{tmdb,imdb,simkl_id,…}` — anime
  additionally `mal/anidb/anilist` — so candidates resolve cleanly into the TMDB-keyed
  pool, and anime keeps the ids the shared anime age-band needs (`animeMap`/MAL).
- Rich per-item metadata usable in scoring with **zero extra calls**: `genres`,
  `ratings` (imdb/simkl/mal, each rating+votes), `release_date`, `runtime`, `country`,
  `original_language`, `watched` (24h viewers = velocity), `drop_rate` (momentum
  direction), `rank`.

**Three-way cache, mapped to two engine types.** Keep the cache in Simkl's native
split — **movies / tv / anime** — refreshed from the CDN. Candidate generation maps it
to the engine's two types: the **movie** slice draws from *movies*; the **series** slice
**unions *tv + anime*** (mirroring `simkl.js`'s existing shows+anime merge, and letting
anime keep its own age band). The engine stays movie/series; the source layer stays
3-way. (Decided with James 2026-09-10.)

**Combined file + cadence.** Use the **combined** `…/{interval}_500.json`
(`{movies, tv, anime}` in one response) — one server-wide round-trip per refresh.
`_500` gives enough depth for **client-side genre filtering** (there is *no* genre query
param — filter each list by the profile's top-genre affinities). Match cache TTL to
Simkl's regeneration, per the published cadence:

| File | Content window | Simkl regenerates | Glass cache TTL | Use |
|---|---|---|---|---|
| `today_500` | last 24h | hourly | — (skip) | not needed — per-item `watched` already carries 24h velocity |
| `week_500` | last 7 days | **daily** | ~24h | **primary trending signal** |
| `month_500` | last 30 days | daily | ~24h | optional — sustained "popular lately" |
| `dvd/releases` | new home releases (movies) | daily | ~24h | optional — movie "new to own/rent" recency |

**Cadence correction to the first sketch:** pull the combined **`week_500` daily, not
weekly** — the week file is *regenerated daily*, so a weekly cache serves up to 6-day-
stale data for no saving (it is one cached fetch/day for the whole server). The
`today`/hourly file is unnecessary because every item already exposes `watched` (24h) +
`drop_rate`. **Momentum (§21) comes straight from the file → GD-3 (a popularity
time-series) is not needed.**

**Metadata-first weighting (James's steer).** Most of Glass's weight comes from metadata
intersects, in two tiers:
- **Free, in-file (no TMDB call):** genre affinity, decade (`release_date`),
  language/country affinity, quality (`ratings.imdb` — also resolves P4's quality-source
  cleanly), velocity (`watched`, log-damped), momentum (`drop_rate`), vote confidence.
- **Enrichment tier (needs GD-5, per candidate):** director, franchise/collection, lead
  actors, keywords — the deep "why this resonates" intersects. **GD-1 and GD-5 are
  coupled:** without GD-5 this degrades to "trending filtered by genre + ratings"; with
  it, a trending title ranks because it shares an auteur/franchise/lead/decade with
  something the profile loved. The same GD-5 enrichment must also run over the **watched
  history**, or the taste model has no director/franchise/actor affinities to intersect
  against.

### 5.4 Feedback event stream — submitted §47–§48 (§8-D)
Today's durable feedback: impressions + streak/decay, `engaged_at` (meta-open), Simkl
scrobble (→ watched), mark-watched, `dont_recommend`. A richer stream
(displayed/clicked/played/completed/rated/liked) is **additive**; wire the taste model
(§4.1 weighted events) and the components store to it. Map to what exists **before**
inventing new events.

### 5.5 Metadata enrichment (GD-5 — resolved: **TMDB**, no authed Simkl API)

**Decision (James, 2026-09-10): TMDB for all deep metadata; zero authed Simkl API calls.**
Two tiers, neither touching Simkl's rate-limited `api.simkl.com`:
- **Tier 1 — free, already cached.** genre / decade / language / country / `ratings` /
  `watched` / `drop_rate` come from the Simkl **CDN** file already pulled for GD-1 (one
  server-wide fetch/day, a static file — *not* the authed 10-GET/s API). No extra call.
- **Tier 2 — TMDB `append_to_response`.** director, franchise/collection, lead cast,
  keywords via a single `GET {movie|tv}/{id}?append_to_response=credits,keywords,external_ids`.

**Why it's affordable (the key finding).** The pipeline already pays one TMDB call per
candidate — `imdbFor` → `/external_ids` — which returns only the imdb_id and discards the
rest ([tmdb.js:337](../../src/services/tmdb.js:337)). Upgrading that to the append call
(the pattern `fullMeta` already uses, [tmdb.js:278](../../src/services/tmdb.js:278))
returns imdb_id **plus** credits+keywords+collection+genres+poster in **one request**
(TMDB counts append as one). Glass makes that call inside `generate()` (rankScore needs
the intersects before the return), scores, and returns the candidate **`preResolved`** —
so the pipeline **skips** its own `imdbFor`. Candidate-side cost ≈ **Genesis's today**;
Glass-only, so Genesis/other engines are untouched. Every TMDB call stays governor-paced
(`governor.schedule('tmdb')`) inside TMDB's generous ceiling.

**Watched-history enrichment.** Same one call per watched title, **cached permanently**
(static metadata). Steady state = one call per newly-watched title at ingest; the only
real cost is a **one-time, governor-paced backfill** of an existing library (a background
job). Stored in a **Glass-owned table**, not the shared watched store (keeps the shared
contract untouched).

**Starter scoring dimensions + disciplines** (widen later via config — the data's all in
the one response, so expanding is free): **director · franchise/collection · top-3 lead
cast · decade · keywords (min shared-count floor)**, plus the tier-1 free fields.
Intersects are **bonuses on a genre/velocity base**, never the base (they're sparse — most
candidates share no director with your history); cap cast at the leads; floor keywords.
Movie/series asymmetry: `belongs_to_collection` (franchise) is **movie-only** — series
proxies "franchise" via `created_by` (showrunner) + `network`.

**Payoff:** the matched dimensions become `score_components` + human explanations
(§5.1 / §39): "because you've watched other films by this director / in this franchise."

---

## 6. Decisions requiring James's sign-off (source / infra / policy)

None of these are chosen here. Each is an option to confirm.

| ID | Decision | Options / note | Recommendation |
|---|---|---|---|
| **GD-1** | Trending/velocity **source** for strategies C–G + momentum | **Simkl trending CDN** (public, cached, carries tmdb+imdb+genres+`watched`+`drop_rate`) vs TMDB `/trending` vs MDBList lists | **DIRECTION SET (2026-09-10): Simkl combined `week_500`, refreshed daily, 3-way cache (movies/tv/anime), series = tv∪anime.** Collapses GD-3; couples to GD-5. (§5.3) |
| **GD-2** | Semantic layer — LLM rerank vs vector embeddings | free **local chat LLM** (rerank) vs a *new* local embedding model + vector store | **DIRECTION SET (2026-09-10): LLM rerank first (Phase B), using the free local LLM — no new subsystem, no API limits.** Vector embeddings **deferred/optional/evidence-gated** (Phase C); if built, local model + Float32 BLOB + brute-force cosine. (§4.4, §5.2) |
| **GD-3** | Popularity **time-series** for momentum | new snapshot table + scheduler | **CLOSED — not needed.** Simkl `drop_rate`/`watched` supply momentum in-file (§5.3) |
| **GD-4** | Freshness cadence for new features (embeddings, trending) | see §5.3 cadence table for trending; embeddings on-metadata-change | Trending cadence set (§5.3, daily); embeddings cadence set when GD-2 lands |
| **GD-5** | Deep metadata (cast/crew/keywords/collection) for taste dims — history **and** candidates | **TMDB** `append_to_response` vs authed Simkl API vs skip | **DIRECTION SET (2026-09-10): TMDB, Option 2.** Rides the resolve call already paid (≈neutral cost); one-time cached history backfill; Glass-owned store; **no authed Simkl API**. (§5.5) |
| **GD-6** | **Config surface + scope** for half-lives/weights | global admin only · full per-profile · tiered | **DIRECTION SET (2026-09-10): tiered.** Tier 1 versioned defaults + Tier 2 global `settings.glass` (admin) for **v1**; Tier 3 = 1-2 friendly per-profile sliders (recency/exploration) **deferred**. All knobs build-affecting → clearType+rebuild. (§7) |
| **GD-7** | Glass **`unrestricted`** flag | `false` (age-gated, safe for kids) vs a separate open engine | **DIRECTION SET (2026-09-10): `false`.** Age-gated, universal (kids included), consistent with Genesis; NSFW blacklist absolute regardless; open/NSFW engine stays out of scope (overview §8 Q1). |
| **GD-8** | Glass **name/id/description** + `supportedTypes` | id persisted forever; user-facing copy | **DIRECTION SET (2026-09-10): `id:'glass'` (frozen), name "Glass Engine", `['movie','series']`, family-friendly description + tagline.** Copy iterable, id not. (§4.9) |

---

## 7. Configuration model

Glass params (half-lives `H_recent/medium/long`, horizon blend `α/β/γ`, feature
weights, per-strategy counts, `exploration_pct`, `resolve_cap`, `algorithm_version`)
are **externalised, versioned config**, not code constants (submitted §51).

**Placement (GD-6 — RESOLVED 2026-09-10): tiered; v1 is global-only, per-profile sliders
deferred.** The engine-abstraction chose flat per-profile `filters` for engine *selection*
(`engine_movie`/`engine_series`), with the companion editing only a whitelisted subset and
`age_limit` portal-only. Glass tuning is layered over that as three tiers:

- **Tier 1 — versioned engine defaults.** The full weight vector, per-strategy counts and
  caps, externalised as config (not code constants) and stamped with `algorithm_version`
  (§5.1) so stored rows stay interpretable across changes. This *is* "the algorithm."
- **Tier 2 — global admin override (`settings.glass`, Server Config, admin-only)** —
  alongside `settings.engines`/`settings.llm`. The "backend control panel." **v1 ships
  Tiers 1+2 only.** A change here enqueues rebuilds across all Glass profiles through the
  existing per-profile job queue — deliberately heavyweight, because it is an algorithm
  change, not a preference.
- **Tier 3 — 1-2 friendly per-profile sliders, DEFERRED to a later phase.** Only a
  **recency** slider ("how much should what you've watched *recently* matter?" → half-life/
  blend) and optionally an **exploration** slider ("how adventurous?" → `exploration_pct`),
  as flat `filters.glass_*` fields, companion-whitelisted, each wired **build-affecting**.
  This honours the submitted spec's "tune the half-life on the companion + backend" intent
  — but as 1-2 calibrated sliders once we know which knobs matter, never the raw vector.
  Rationale for deferring: we don't yet have proven defaults, so tune centrally (Tier 2 +
  the components store) first; expose per-profile knobs only once the engine is calibrated.

**Build-affecting (applies to every tier).** Every Glass knob changes the **stored
`rankScore` ordering**, so — exactly like changing the selected engine — a change must
**clear that type's slice and rebuild** (SC-03 `clearType` + `needsBuild`; the "clear +
rebuild on next `ensureBuilt`" model naturally debounces a slider drag). Serve-time-only
filters (rating floor, list size, genres) are unaffected and keep applying live. Keep the
per-profile (Tier 3) set deliberately tiny for exactly this reason; the heavy vector stays
admin-global (Tier 2).

---

## 8. Phased delivery (re-mapped onto the seam; mirrors submitted §53)

Each phase is independently shippable, behind `requirements()` + the global-disable
gate, and **degrades gracefully** if its optional inputs are missing. Glass stays
**dark** (registered + globally disabled) until the admin enables it — so every phase
is a user-visible no-op until then (overview §7 safety property).

- **Phase A — Deterministic Glass (no LLM, no embeddings).** Taste-v2 (§4.1),
  broadened candidates (§4.2, needs **GD-1**), configurable weighted scoring (§4.3),
  exploration injection (§4.6), GI-1 truncation. Ship the **score-components store**
  (§5.1) with it. *This is a fully working, conformant second engine.* ⇐ start here.
- **Phase B — LLM semantic rerank + explanations** *(promoted ahead of embeddings, GD-2)*.
  Reuse `settings.llmChain` (§4.4) — the **free local LLM**, no new subsystem, no API
  limits; optional; prefer-local, timeout→deterministic. Emits the reorder + "because…"
  reasons from the stored components. This is Glass's primary semantic layer.
- **Phase C — Vector embeddings** *(optional / evidence-gated, GD-2; §5.2)*. Build the
  local embeddings subsystem → `semantic_similarity` feature **only if** the
  components data from Phase B shows a gap it would fill. Measure lift vs A/B.
- **Phase D — Feedback wiring.** Map existing signals (§5.4) into the taste-model event
  list; add richer events only if they earn their keep.
- **Phase E — Learned ranking.** Once the prior phases have accumulated component + outcome data,
  train an LTR model that *emits `rankScore`* (drop-in; no pipeline change). A/B against
  deterministic Glass and Genesis.

**Conformance gate applies at every phase**: run Glass against `CONFORMANCE.md` before
it is registered/enabled, using the `fake`/`fake-open` harness pattern and a real
age-limited profile to prove I1 safety holds over a Glass-sourced pool.

---

## 9. Movies & Shows — full separation treatment (review Q4)

**Guaranteed by construction.** The seam is per-`(profile, type)`; a profile can run
Glass for Movies and Genesis for Series (or vice versa) with fully isolated slices.
Concretely, Glass must keep these **type-scoped**:

1. **Taste model** — seed only from `getWatched(profile.id, { type })`. A cross-type
   blend (movie taste informing show recs) would be a *deliberate opt-in*, never the
   default.
2. **Every source query** (recommendations, trending, popular, discover, embeddings)
   issued per type. TMDB's endpoints are already type-split (`movie`/`tv`).
3. **Per-type tuning** — the codebase already carries per-type asymmetry (`SEED_CAP`
   {movie:150, series:100}, per-type vote floor, movies-only recency). Glass should
   likewise allow per-type half-lives/weights: a **film "completes"** in one sitting
   while a **show runs for years**, so recency and completion semantics legitimately
   differ. Runtime bands differ (90–150 min vs 22–60 min/episode).
4. **Anime** shares the `series` type and has its **own age band** in the shared gate
   (`applyAnimeGate`). Glass series candidates flow through it unchanged — no Glass
   work, but a reason Glass must not try to own age (P6/I1).
5. **`clearType`/rebuild** already fires per type on engine change (SC-03), so swapping
   Glass in for one type never disturbs the other's stored rows or `dont_recommend`.

**One-liner:** supporting both types is `supportedTypes: ['movie','series']` + a
type-parameterised `generate()`; supporting only one is trimming that array. The
abstraction was built for exactly this.

---

## 10. Open questions / iteration hooks

- **Q-A.** Confirm the source decisions **GD-1** (trending/popular/discover) and
  **GD-7** (`unrestricted:false`) — these unblock Phase A.
- **Q-B.** Score-components store shape (§5.1 (a) vs (b)) — recommend (a) now.
- **Q-C.** Config scope **GD-6** — recommend global Server Config first.
- **Q-D.** Is a **cross-type taste blend** ever wanted (movies informing shows)? Default
  no; call it explicitly if yes.
- **Q-E.** Taste-dimension depth **GD-5** — how many extra TMDB calls/seed are we
  willing to spend for cast/crew/keyword affinity?
- **Q-F.** Do we want Glass to *replace* Genesis for a profile, or primarily to be
  **A/B-compared** against it (per-type selection makes side-by-side trivial)?

---

## Appendix — invariant compliance map (against `CONFORMANCE.md`)

| Invariant | Glass obligation |
|---|---|
| **I1** age gate | Never self-vet age; may be age-*aware* in generation as a complement. Prove safety over a Glass-sourced kids pool in tests |
| **I2** serve-time prefs | Do nothing; serve applies rating floor/genres/recency/list_size |
| **I3** vote-floor storage gate | May pre-filter sub-floor titles (optimisation); pipeline guarantees it |
| **I4** pool schema is the contract | Fill required columns; never write `imdb_rating`/`age_classification`/impression columns. `quality` scored on `vote_average`, not IMDb (P4) |
| **I5** watched/`dont_recommend` excluded | Pre-exclude via `ctx.watchedIds`/`ctx.dont` (optimisation); pipeline re-subtracts |
| **I6** `affinity` ordering column | Populate `rankScore` (higher=stronger) always |
| **I7** unrestricted gating | Ship `unrestricted: false` (GD-7); NSFW blacklist stays absolute regardless |
| **GI-1** (new, Glass-local) | Score-and-truncate to `resolve_cap` before returning (performance) |
