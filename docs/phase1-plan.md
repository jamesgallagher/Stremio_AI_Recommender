# Phase 1 Implementation Plan — Inverted Recommender Pipeline

**Status:** Approved for build (no code yet). Companion to `DESIGN.md` and the
v3.0 "Personalised Recommender Pipeline" spec.
**Target release:** `beta v3.0.0` — published WITHOUT moving `:latest`
(`:latest` stays pinned at v2.6.1).

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Rating source | **IMDb** (via MDBList batch), per-profile configurable |
| 2 | Kids age gate | **Keep CSM** (MDBList `commonsense`) as the v1 gate; certification deferred |
| 3 | Ranking pool cap | **120** candidates sent to the LLM |
| 4 | Bench | **20** (store top 40, display 20, promote-on-watch) |
| 5 | Groq key | **Hard requirement** (2026-07-13): no key → AI catalogs do not run at all (incl. cold start); profile effectively disabled until a key is added |

## Scope

**In:** invert the two AI catalogs (movies, series) from *LLM-generates-titles →
code-filters* to *code-generates-candidates → LLM-ranks-by-ID*. Add a 20-item
bench with free promote-on-watch.

**Out (Phase 2):** decay / effective-score, trending micro-patches,
expiry→blacklist, watchlist-as-signal, completion/progress weighting, SQLite,
certification gating, band-rotation display order.

**Untouched:** extra catalogs, RPDB, auto-scrobble (Nuvio→Trakt), secret
encryption + locked-mode, Diagnose endpoint, serve path / SWR headers.

---

## 1. New pipeline (`buildCatalog` rewrite, per profile per media type)

1. **Enriched taste seed.** Last 20 unique watched from
   `watchedByType[type].recent`. Trakt watched items already carry
   `ids.tmdb`/`ids.imdb`, so **no title resolution** — enrich each by TMDB ID
   (details: `genres`, one-line `overview`). ~20 TMDB calls, cacheable.
2. **Candidate pool** (per-profile keys), merged + deduped by TMDB/IMDb ID:
   - TMDB **Discover** (existing `discoverPage`, extended) — filtered baseline.
   - TMDB **`/{type}/{id}/recommendations`** + **`/similar`** seeded from the
     top ~5 history titles — personalized long-tail candidates.
   - (optional) a curated **MDBList** list.
3. **IMDb-rating enrichment.** For each pool candidate, resolve `external_ids`
   (TMDB→imdb, needed for Stremio `tt` IDs anyway) then bulk-fetch IMDb ratings
   via MDBList `mediaInfoBatch` (~50/call). `rating_source: tmdb` skips this and
   gates on TMDB `vote_average` instead (zero extra calls).
4. **Deterministic hard filters** (all data already on the candidate):
   `rating >= rating_floor`, `vote_count >= vote_count_floor`, release date in
   recency window, `without_genres`.
5. **Exclusion subtraction by ID:** pool − watched (cross-type IMDb + per-type
   TMDB, reuse `exclusionSets`) − within-pool dupes.
6. **CSM age gate** for kids profiles — `applyCsmGate` unchanged (30-day cache).
7. **Pre-trim to 120** if larger: rank-trim by genre-overlap with history.
8. **Shuffle** the 120 (position-bias fix).
9. **One ranking LLM call** → strict JSON `[{id, score}]`, request top 40.
10. **Validate:** parseable, all IDs ∈ pool, no dupes, count ≥ 20 → else one
    retry → fallback model → else keep previous list (atomic-swap-on-success).
11. **Split & store:** map ranked IDs → candidate metas (held in memory keyed by
    ID). Top 20 → `displayed`, next 20 → `bench`. Attach logos, `cleanMetas`,
    atomic swap. `source: 'llm'`.

## 2. Bench & promote-on-watch (Phase 1 maintenance subset)

- Cache entry becomes `{ metas: <20 displayed>, bench: <20>, generated_at,
  source }`. **`metas` stays the displayed list**, so `addon.js` serves it
  unchanged.
- **Promote-on-watch:** the existing hourly watched-sync path already detects
  newly-watched items. Extend the prune step: remove watched IDs from `metas`,
  then shift the highest-scored `bench` items into `metas` to refill toward 20.
  Free — no LLM, no rebuild.
- Serve-time watched pruning stays as a safety net.
- Explicitly NOT included: decay, horse-trading, trending swaps, expiry. Bench
  is a static reserve refilled only by a full rebuild.

## 3. Rebuild triggers (Phase 1)

- **Primary:** taste-signal change — a new unique title enters the last-20 set
  (detected via Trakt `last_activities` delta). Full rebuild.
- **Backstop:** staleness fallback (default 7 days; keep configurable).
- Promote-on-watch covers the in-between so the list stays full at 20.
- All gated by the existing per-profile rebuild lock + backoff; profiles are
  staggered by the scheduler.

## 4. LLM ranking contract (`groq.js`)

- **Replace** `buildPrompt`/`getSuggestions` with `buildRankPrompt` +
  `rankCandidates`.
- **Input:** enriched taste (last-20 with genres/overview) + long-term genre
  summary (binge guard, cheap) + 120 **compact** candidates
  `{id, title, year, genres, rating}` (no overviews on candidates — budget).
- **Output:** `[{"id":"tt…","score":0-100}]`, top 40, Groq JSON mode.
- **Keep** the model fallback chain and the free-tier fallback logging
  (`⚠ FREE-TIER RATE LIMIT` / `⚠ served by BACKUP model`).
- Validation as step 10 above.

## 5. File-by-file changes

| File | Change |
|---|---|
| `src/services/groq.js` | Replace generation with `rankCandidates` (ranking, JSON mode, validation). Keep fallback chain + logging. |
| `src/services/tmdb.js` | Add `recommendations()`/`similar()`; extend `discoverPage` into a full pool fetch returning rich candidates. **Delete `resolveTitle`.** Keep `fetchIdsAndLogo`, `toMeta`. |
| `src/services/mdblist.js` | Reuse `mediaInfoBatch`/`parseImdbRating` for IMDb pool ratings. CSM path unchanged. |
| `src/services/trakt.js` | Extend `parseWatchedItems.recent` to carry `tmdb_id`/`imdb_id`. |
| `src/rebuild.js` | Rewrite `buildCatalog` to the flow above. **Delete** the round loop, `MAX_LLM_ROUNDS`, `askCount`, avoid-list wiring. Extend the watched-sync prune to promote from bench. Keep `syncWatched`, `applyCsmGate`, `exclusionSets`, `rebuildProfile`, `ensureFresh`, extra-catalog path. |
| `src/store.js` | `swapCatalog` stores `metas`+`bench`. Extend `pruneWatched`→ prune + backfill from bench. **Remove** `getSuggestedHistory`/`addSuggestedHistory`. |
| `src/config.js` | Add `filters.rating_source` (`imdb`\|`tmdb`, default `imdb`), `filters.vote_count_floor` (default 1000), `filters.pool_seed_count` (default 5). Migration for existing profiles. Encryption untouched. |
| `src/portal.js` + `public/index.html` | Add rating-source dropdown + vote-count-floor to the Filters section. Small. |
| `src/addon.js` | **Unchanged** — serves `cache[type].metas`. |
| `test/smoke.js` | Drop generation-prompt tests; add ranking-validation, pool-filter, exclusion-subtraction, and bench promote-on-watch tests. |

## 6. Config additions + migration

```
filters.rating_source: "imdb"      # imdb | tmdb
filters.vote_count_floor: 1000      # soft noise gate (NOT 5000 — that excluded quality)
filters.pool_seed_count: 5          # history titles used to seed similar/recommendations
```

`applyMigrations`: default the three fields when absent. No secret involved.

## 7. Budget check

Groq free tier `gpt-oss-120b`: 8K TPM / 200K TPD / 30 RPM / 131K context.
One ranking call ≈ 120×~20 + 20×~50 + instructions ≈ **~4K tokens** (< 8K TPM).
**2 calls / profile / rebuild** (vs up to 8 today). TMDB ~300 calls/rebuild
(lenient). MDBList ~12 calls/rebuild (1000/day cap). Comfortable for a family.

## 8. Cold start & failure handling

- **Cold start** (unique history < 3, or no rankable seed): serve the filtered
  pool ordered by IMDb rating/popularity, no LLM. Preserve current behavior.
- **LLM failure** after retry + fallback: keep the previous list (atomic swap
  only on a valid ≥20 result). Never serve empty.
- **Empty pool after subtraction** (over-constrained profile): log a warning
  (observability metric), keep previous list.

## 9. Deleted (the "wild" reduction)

Title resolution (`resolveTitle`), multi-round generation loop, per-round
`askCount`, the avoid-list history (`suggested` store + helpers). Net LOC down.

## 10. Testing

- **Smoke (pure functions):** pool hard-filter; exclusion subtraction by ID;
  ranking-response validation (IDs∈pool, dedupe, count, malformed→retry path);
  bench split (20/20); promote-on-watch (watched removed, bench shifts in).
- **Live harness** (like the Groq validation used in v2.6.x): run real profiles
  through pool-build + ranking, eyeball ranked output per taste profile before
  merge. Key never committed.

## 11. Rollout

- Branch `v3-phase1`.
- CI: add the beta tag pattern so `beta v3.0.0` publishes `:3.0.0-beta` (and
  `:beta`) but the `latest`-enable rule stays on the stable line — **`:latest`
  keeps pointing at v2.6.1**.
- Fresh list state on first rebuild; profile config (keys/filters) carries over
  via migration.

## 12. Build sequence

1. `tmdb.js`: pool builder (discover + recommendations + similar + external_ids
   + logos) returning rich candidates.
2. `mdblist.js` reuse: IMDb-rating batch enrichment helper.
3. `rebuild.js`: new `buildCatalog` (enrich → pool → filter → subtract → CSM →
   trim → shuffle → rank → split). Delete rounds/avoid-list.
4. `groq.js`: `rankCandidates` + validation, keep fallback/logging.
5. `store.js`: `metas`+`bench` shape; prune+backfill.
6. `config.js` + portal: new filter fields + migration + UI.
7. Rebuild triggers: taste-change detection + staleness backstop.
8. Tests (smoke + live harness).
9. CI beta-tag wiring; branch + `beta v3.0.0`.

## 13. To verify during build (not blockers)

- MDBList IMDb-rating batch coverage for TMDB-sourced pool items (imdb_id join).
- RESOLVED during build: `gpt-oss-120b` fails the 120-candidate ranking on the
  free tier (empty content / 400 json_validate / 413) — it burns the 8K-TPM
  budget on hidden reasoning. Ranking primary is now `llama-3.3-70b-versatile`
  (reliable, ~9s, good score spread); gpt-oss kept only as a fallback.
- TMDB `recommendations`/`similar` pool breadth for niche-taste profiles — tune
  `pool_seed_count` if too narrow.
