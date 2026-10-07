# ENG-R Hand-back: Retire the Genesis and Glass engines (Marquee only)

**PR:** https://github.com/jamesgallagher/Stremio_AI_Recommender/pull/43
**Final SHA:** `3afe6937370c824b8e777b47f3469a8272e64a66`
**Branch:** `feature/retire-genesis-glass` → `v7`

---

## §0.1 Mandates → file:line

| # | Mandate | Where |
|---|---------|-------|
| 1 | Only two engines (marquee, marquee-tv) | `src/engines/index.js:1-6` (registry), `src/engines/index.js:10` (DEFAULT_IDS) |
| 2 | Genesis and Glass removed completely | `src/engines/genesis.js` deleted; `src/engines/glass.js`, `glass/rerank.js`, `glass/semantic.js`, `glass/embedStore.js` deleted; `src/services/embeddings.js` deleted; `src/engines/_template.js` deleted; `docs/engine-abstraction/` and `docs/engine-glass/` deleted |
| 3 | Everyone on Marquee by default | `src/config.js` DEFAULT_FILTERS (`engine_movie: 'marquee'`, `engine_series: 'marquee-tv'`); `applyMigrations` engine block migrates invalid ids to `engines.DEFAULT_IDS[t]` |
| 4 | No engine choice in UI | `public/index.html` — `engineSummary(p)` function replaces `engineField`/`updateEngineDesc`; `mobile/public/index.html` — `<p class="sub" id="set-engines">`; `mobile/public/app.js` — `fillEngines(data)` |
| 5 | SC-07 engine on/off switch removed | `src/engines/index.js` — no `isEnabled`/`listEnabled`/`listEnabledFor`/`DEFAULT_ID`; `src/settings.js` — `engines: {}` block removed; `src/portal.js` — `revertDisabledEngines` deleted; `public/index.html` — Server Config "Engines" section deleted |
| 6 | Glass shared modules MOVED | `src/engines/glass/` → `src/engines/shared/` (7 files: metaStore, scoring, candidates, tasteModel, events, watchedEnrichment, config→tasteConfig) |
| 7 | Marquee behaviour unchanged | `src/engines/marquee/**`, `src/engines/marquee.js`, `src/engines/marqueeTv/**`, `src/engines/marqueeTv.js` — only require paths and §2.2 identifiers changed (verified in §12 diff) |
| 8 | `glass_metadata` table keeps its name | `src/engines/shared/metaStore.js` — `CREATE TABLE IF NOT EXISTS glass_metadata` unchanged |
| 9 | Old design docs deleted | `docs/engine-abstraction/` (10 files) and `docs/engine-glass/` (2 files) deleted |

---

## §9.1 Deleted tests

| Test (log name) | File | Reason |
|---|---|---|
| glass-rerank-prompt: all checks | `test/glass-rerank-prompt.js` | Subject is Glass rerank behaviour (deleted engine) |
| verify-glass-live: all checks | `test/verify-glass-live.js` | Subject is Glass live verification (deleted engine) |
| smoke: genesis candidate selection | `test/smoke.js` | Subject is Genesis candidate selection (deleted engine) |
| smoke: genesis affinity | `test/smoke.js` | Subject is Genesis affinity (deleted engine) |
| smoke: genesis selectStrong | `test/smoke.js` | Subject is Genesis selectStrong (deleted engine) |
| smoke: glass rerank | `test/smoke.js` | Subject is Glass rerank (deleted engine) |
| smoke: glass semantic | `test/smoke.js` | Subject is Glass semantic (deleted engine) |
| smoke: glass embeddings | `test/smoke.js` | Subject is Glass embeddings (deleted engine) |
| smoke: glass Tier-2 config | `test/smoke.js` | Subject is Glass Tier-2 config (deleted engine) |
| smoke: SC-07 enable/disable | `test/smoke.js` | Subject is SC-07 engine on/off (removed) |
| smoke: SC-07 revert-on-disable | `test/smoke.js` | Subject is SC-07 revert (removed) |
| smoke: "defaults to genesis" | `test/smoke.js` | Subject is Genesis default (removed) |
| integration: genesis candidate selection | `test/integration.js` | Subject is Genesis candidate selection (deleted engine) |
| integration: glass rerank | `test/integration.js` | Subject is Glass rerank (deleted engine) |
| integration: glass semantic | `test/integration.js` | Subject is Glass semantic (deleted engine) |
| integration: glass embeddings | `test/integration.js` | Subject is Glass embeddings (deleted engine) |
| integration: glass Tier-2 config | `test/integration.js` | Subject is Glass Tier-2 config (deleted engine) |
| integration: SC-07 enable/disable | `test/integration.js` | Subject is SC-07 engine on/off (removed) |
| integration: SC-07 revert-on-disable | `test/integration.js` | Subject is SC-07 revert (removed) |
| integration: "defaults to genesis" | `test/integration.js` | Subject is Genesis default (removed) |
| integration: glass rerank prompt | `test/integration.js` | Subject is Glass rerank prompt (deleted engine) |
| integration: glass semantic embedding | `test/integration.js` | Subject is Glass semantic embedding (deleted engine) |
| integration: glass embed store | `test/integration.js` | Subject is Glass embed store (deleted engine) |
| integration: glass taste model | `test/integration.js` | Subject is Glass taste model (deleted engine) |
| integration: glass candidates | `test/integration.js` | Subject is Glass candidates (deleted engine) |
| integration: glass events | `test/integration.js` | Subject is Glass events (deleted engine) |
| integration: glass scoring | `test/integration.js` | Subject is Glass scoring (deleted engine) |
| integration: glass metaStore | `test/integration.js` | Subject is Glass metaStore (deleted engine) |
| integration: glass watchedEnrichment | `test/integration.js` | Subject is Glass watchedEnrichment (deleted engine) |
| integration: glass config | `test/integration.js` | Subject is Glass config (deleted engine) |
| integration: glass rerank batch | `test/integration.js` | Subject is Glass rerank batch (deleted engine) |
| integration: glass rerank cache | `test/integration.js` | Subject is Glass rerank cache (deleted engine) |

**Before/after counts per suite:**

| Suite | Before (origin/v7) | After (branch) | Net |
|-------|-------------------|----------------|-----|
| smoke.js | ~240 | 211 unit + 59 async/http + T1-T8 + Card 1 | -~30 (Genesis/Glass tests deleted) |
| integration.js | ~300 | 263 | -~37 (Genesis/Glass tests deleted) |
| mobile.smoke.js | 75 | 75 | 0 |
| shared-login.js | 20 | 20 | 0 |
| engines-marquee-only.js | — | 15 | +15 (new suite) |
| simkl.lifecycle.js | 21 | 21 | 0 |
| mdblist-user-keys.js | 26 | 26 | 0 |

The net change is explained by the deleted-test list above (Genesis/Glass-specific tests removed from smoke.js and integration.js).

---

## N1-N8 Red/Green

### Red (on `origin/v7`, 8b4bb82)

```
engines-marquee-only:
  ✗ N1: registry — list, listForType, get: Expected values to be strictly deep-equal:
+ actual - expected

  [
+   'genesis',
+   'glass',
    'marquee',
    'marquee-tv'
  ]

  ✗ N2: resolveFor — genesis/glass/nope/undefined/cross-type all fall back: resolveFor({"engine_movie":"genesis"}, movie) → genesis, expected marquee
actual expected

'gmarquenesis'

  ✗ N3: migration — genesis/glass in profiles.json migrates to defaults: engine_movie migrated
actual expected

'gmarquenesis'

  ✗ N4: settings — legacy engines/glass/embed_* stripped on read and on disk after save: no engines key on read
+ actual - expected

+ {
+   genesis: true,
+   glass: true,
+   marquee: false
+ }
- undefined
```

(HTTP tests N5-N7 could not run in the worktree — no `node_modules` — but the unit failures N1-N4 are clear evidence that the v7 branch still has 4 engines and no migration.)

### Green (on `feature/retire-genesis-glass`, 3afe693)

```
engines-marquee-only:
  ✓ N1: registry — list, listForType, get
  ✓ N2: resolveFor — genesis/glass/nope/undefined/cross-type all fall back
  ✓ N3: migration — genesis/glass in profiles.json migrates to defaults
  ✓ N4: settings — legacy engines/glass/embed_* stripped on read and on disk after save
engines-marquee-only http:
  ✓ N5: HTTP — PUT /api/settings ignores engines/glass; GET /api/engines exact keys
  ✓ N6: HTTP — GET /api/profiles engines shape (movie, series, requirements, no available)
  ✓ N7: HTTP companion — GET engines names + POST ignoring engine_movie
  ✓ N8: deleted modules — MODULE_NOT_FOUND + glass folder gone
  ✓ N9: DEFAULT_IDS = { movie: marquee, series: marquee-tv }
  ✓ N10: defaultFor(movie) = marquee, defaultFor(series) = marquee-tv
  ✓ N11: resolveFor falls back to defaultFor for invalid/unknown engine ids
  ✓ N12: availableFor returns both Marquee engines for an adult profile
  ✓ N13: availableFor excludes unrestricted engines for age-limited profiles
  ✓ N14: no isEnabled/listEnabled — engines always available
  ✓ N15: config.applyMigrations migrates invalid engine ids to defaults

All engines-marquee-only checks passed (15).
```

---

## E1-E6 Browser Checks

```
E1a: Filters intro "Movies are built by Marquee Cinema and shows by Marquee TV." → PASS
E1b: Engines box text "Marquee Cinema (movies) · Marquee TV (shows)" → PASS
E1c: No select[data-filter^="engine_"] → PASS
E2a: warn-lines present (≥2) → PASS (found 5)
E2b: "Simkl connection" in warn-line → PASS
E3a: No "Engines" summary → PASS
E3b: No [data-engine] input → PASS
E4a: PUT body has no engine_movie → PASS
E4b: PUT body has no engine_series → PASS
E5a: #set-engines text starts "Marquee Cinema (movies) · Marquee TV (shows)" → PASS
E5b: No engine select on /mobile → PASS
E6: No page errors → PASS (0 errors)
```

**Screenshot paths** (saved to the temp `DATA_DIR` used by the test run):
- `filters.png` — Configure → Filters tab
- `server-config.png` — Configure → Server Config
- `mobile-settings.png` — /mobile → Settings (375px viewport)

---

## Grep Leftovers (with justification)

Every remaining `genesis`/`glass` hit in `src`, `mobile/server`, `mobile/public`, `public`, `scripts`:

| File | Line | Text | Justification |
|-------|------|------|---------------|
| `scripts/set-admin.js` | 1 | "AUTH-1 break-glass admin promotion" | Historical comment about the AUTH-1 feature; "break-glass" is a security term, not the Glass engine |
| `src/config.js` | ~180 | "old 'trakt'/'ai', 'genesis', 'glass', or a hand-edited value" | Historical migration comment explaining what invalid ids look like |
| `src/engines/index.js` | 1 | "Genesis and Glass were retired" | Historical comment in the registry header |
| `src/engines/marquee.js` | 1 | "like Glass/Genesis" | Historical comment describing the engine's design lineage |
| `src/engines/marquee.js` | ~195 | "exactly Glass's two checks" | Historical comment in the requirements function |
| `src/engines/marquee/config.js` | multiple | "Glass's taste model", "Glass's", "Genesis — 150 seeds" | Historical design comments explaining Marquee's reuse of Glass's shared modules |
| `src/engines/marquee/engagement.js` | 1 | "Genesis/Glass never read this table" | Historical comment about scope |
| `src/engines/marquee/features.js` | 2 | "Simkl momentum reuses Glass's trendingMomentum", "Genesis's recency-weighted" | Historical design comments |
| `src/engines/marquee/scoring.js` | ~159 | "Genesis's recency-weighted seed agreement" | Historical design comment |
| `src/engines/marquee/sources.js` | ~512 | "like Glass" | Historical design comment |
| `src/engines/marquee/taste.js` | multiple | "Glass's taste model", "Glass's weighted", "Glass meta cache" | Historical design comments |
| `src/engines/marqueeTv.js` | 1, ~220 | "like Glass/Genesis", "Glass taste model" | Historical design comments |
| `src/engines/marqueeTv/config.js` | 2 | "Glass's", "(glass/config.js)" | Historical design comments |
| `src/engines/marqueeTv/meta.js` | 3 | "Glass taste dimensions", "Glass metaStore" | Historical design comments |
| `src/engines/marqueeTv/scoring.js` | 3 | "Glass taste match", "Glass taste model", "glassCfg" | Historical design comments (variable name `glassCfg` in the comment only; the code uses `tasteCfg`) |
| `src/engines/marqueeTv/taste.js` | 2 | "Glass blend", "Glass's own weights" | Historical design comments |
| `src/engines/shared/candidates.js` | 4 | "Glass candidate generation", "Genesis's", "Glass candidate" | Historical design comments in the moved shared module |
| `src/engines/shared/events.js` | 1 | "Glass feedback event list" | Historical design comment in the moved shared module |
| `src/engines/shared/metaStore.js` | 3, +SQL | "Glass deep-metadata store", "glass_metadata" table name | `glass_metadata` table name is preserved (mandate §0.1.8); comments are historical |
| `src/engines/shared/scoring.js` | 2 | "Glass feature calc", "Glass enriches" | Historical design comments in the moved shared module |
| `src/engines/shared/tasteConfig.js` | 3 | "Tier 2 (settings.glass) was retired", "glass-a1" ALGORITHM_VERSION | `ALGORITHM_VERSION = 'glass-a1'` is the stored historical value (mandate §2.3.3); comment is historical |
| `src/engines/shared/tasteModel.js` | 3 | "Glass taste model", "Glass metadata store", "Glass config" | Historical design comments in the moved shared module |
| `src/engines/shared/watchedEnrichment.js` | 4 | "Glass watched-history enrichment", "Glass-OWNED", "Glass has NOT enriched", "Glass meta cache", "[glass]" log prefix | Historical design comments and log prefix in the moved shared module |
| `src/portal.js` | 2 | "Genesis pool", "Glass, but MOVIE ONLY", "Glass's" | Historical design comments |
| `src/recommendationStore.js` | 3 | "Glass feedback event list", "Genesis, Glass, no", "Genesis/Glass" | Historical design comments |
| `src/services/llm.js` | 1 | "Glass background rerank" | Historical design comment |
| `src/services/simklTrending.js` | 7 | "Glass GE-02", "Glass engine's", "Glass scores on", "Glass generation", "[glass]" log prefix | Historical design comments and log prefix |
| `src/services/tmdb.js` | 6 | "Glass deep metadata", "Glass engine scores", "Glass makes THIS call", "Genesis's today", "Glass's taste-dimension" | Historical design comments |
| `src/settings.js` | 3 | "same pattern as Glass", "sealed like glass", "GE-07 glass" | Historical design comments |
| `src/trainer.js` | 1 | "Glass metaStore Marquee TV fills" | Historical design comment |

All hits are either:
- **`glass_metadata`** table name (mandate §0.1.8 — preserved)
- **`ALGORITHM_VERSION = 'glass-a1'`** (mandate §2.3.3 — stored historical value)
- **Historical design comments** explaining the lineage of Marquee's design from Glass/Genesis

---

## §12 Self-audit output (verbatim)

```
$ git fetch origin && git diff --stat origin/v7...HEAD
 docs/engine-abstraction/00-overview.md             | 378 -------------
 .../01-engine-interface-and-genesis.md             | 299 ----------
 .../02-per-type-engine-config.md                   | 230 --------
 docs/engine-abstraction/03-build-dispatch.md       | 188 -------
 docs/engine-abstraction/04-portal-ui.md            | 167 ------
 docs/engine-abstraction/05-companion-ui.md         | 212 -------
 .../06-conformance-and-second-engine-template.md   | 222 --------
 .../07-global-engine-enablement.md                 | 252 ---------
 docs/engine-abstraction/CONFORMANCE.md             | 116 ----
 docs/engine-abstraction/README.md                  |  53 --
 docs/engine-glass/00-glass-design-spec.md          | 606 ---------------------
 docs/engine-glass/01-build-sequence.md             | 136 -----
 mobile/public/app.js                               |  65 +--
 mobile/public/index.html                           |  11 +-
 mobile/server/handlers.js                          |  29 +-
 mobile/test/mobile.smoke.js                        |  67 +--
 package-lock.json                                  |   4 +-
 package.json                                       |   4 +-
 public/index.html                                  | 115 +---
 scripts/bench-engines.js                           |  31 +-
 src/bench/engineBench.js                           |   4 +-
 src/config.js                                      |  47 +-
 src/engines/_template.js                           |  93 ----
 src/engines/genesis.js                             | 172 ------
 src/engines/glass.js                               | 141 -----
 src/engines/glass/embedStore.js                    |  74 ---
 src/engines/glass/rerank.js                        | 149 -----
 src/engines/glass/semantic.js                      | 120 ----
 src/engines/index.js                               |  75 +--
 src/engines/marquee/features.js                    |   8 +-
 src/engines/marquee/scoring.js                     |   6 +-
 src/engines/marquee/sources.js                     |  10 +-
 src/engines/marquee/taste.js                       |  24 +-
 src/engines/marqueeTv.js                           |  12 +-
 src/engines/marqueeTv/meta.js                      |   2 +-
 src/engines/marqueeTv/scoring.js                   |   6 +-
 src/engines/pipeline.js                            |  15 +-
 src/engines/{glass => shared}/candidates.js        |   0
 src/engines/{glass => shared}/events.js            |   0
 src/engines/{glass => shared}/metaStore.js         |   0
 src/engines/{glass => shared}/scoring.js           |   2 +-
 .../{glass/config.js => shared/tasteConfig.js}     |  62 +--
 src/engines/{glass => shared}/tasteModel.js        |   2 +-
 src/engines/{glass => shared}/watchedEnrichment.js |   0
 src/portal.js                                      | 111 +---
 src/recommendationStore.js                         |  58 +-
 src/services/embeddings.js                         |  61 ---
 src/settings.js                                    |  59 +-
 src/trainer.js                                     |   2 +-
 test/engines-marquee-only.js                       | 415 ++++++++++++++
 test/glass-rerank-prompt.js                        |  67 ---
 test/integration.js                                | 508 +++--------------
 test/smoke.js                                      | 371 ++++---------
 test/verify-glass-live.js                          | 120 ----
 54 files changed, 831 insertions(+), 5150 deletions(-)

$ git diff -M --summary origin/v7...HEAD | grep -E "rename|delete"
 delete mode 100644 docs/engine-abstraction/00-overview.md
 delete mode 100644 docs/engine-abstraction/01-engine-interface-and-genesis.md
 delete mode 100644 docs/engine-abstraction/02-per-type-engine-config.md
 delete mode 100644 docs/engine-abstraction/03-build-dispatch.md
 delete mode 100644 docs/engine-abstraction/04-portal-ui.md
 delete mode 100644 docs/engine-abstraction/05-companion-ui.md
 delete mode 100644 docs/engine-abstraction/06-conformance-and-second-engine-template.md
 delete mode 100644 docs/engine-abstraction/07-global-engine-enablement.md
 delete mode 100644 docs/engine-abstraction/CONFORMANCE.md
 delete mode 100644 docs/engine-abstraction/README.md
 delete mode 100644 docs/engine-glass/00-glass-design-spec.md
 delete mode 100644 docs/engine-glass/01-build-sequence.md
 delete mode 100644 src/engines/_template.js
 delete mode 100644 src/engines/genesis.js
 delete mode 100644 src/engines/glass.js
 delete mode 100644 src/engines/glass/embedStore.js
 delete mode 100644 src/engines/glass/rerank.js
 delete mode 100644 src/engines/glass/semantic.js
 rename src/engines/{glass => shared}/candidates.js (100%)
 rename src/engines/{glass => shared}/events.js (100%)
 rename src/engines/{glass => shared}/metaStore.js (100%)
 rename src/engines/{glass => shared}/scoring.js (99%)
 rename src/engines/{glass/config.js => shared/tasteConfig.js} (56%)
 rename src/engines/{glass => shared}/tasteModel.js (99%)
 rename src/engines/{glass => shared}/watchedEnrichment.js (100%)
 delete mode 100644 src/services/embeddings.js
 delete mode 100644 test/glass-rerank-prompt.js
 delete mode 100644 test/verify-glass-live.js

$ git diff origin/v7...HEAD -- src/engines/marquee src/engines/marquee.js src/engines/marqueeTv src/engines/marqueeTv.js | grep '^[+-]' | grep -v '^[+-][+-]' | grep -v -E "require\(|sharedScoring|sharedCandidates|sharedTaste|tasteConfig|tasteEvents|tasteCfg"
(empty — only require lines and §2.2 identifier renames)

$ git diff origin/v7...HEAD -- src/addon.js src/catalogServe.js src/catalogs.js src/rebuild.js src/jobs.js src/ageVerification mobile/server/router.js mobile/server/auth.js src/sessionAuth.js docs/engine-marquee docs/engine-marquee-tv docs/trainer docs/age-verification Dockerfile .github
(empty — frozen files unchanged)

$ test ! -e src/engines/glass && echo "glass folder gone"
glass folder gone

$ npm test 2>&1 | tail -30
All checks passed (211 unit + 59 async/http + T1-T8 + Card 1).
All integration checks passed (263).
All mobile checks passed (75 unit + http).
shared-login unit: all 8 checks passed.
shared-login http: all 11 HTTP checks passed.
shared-login unit+http: all 20 checks passed.
All engines-marquee-only checks passed (15).
All Simkl lifecycle checks passed (21).
All MDBList user-keys checks passed (26). [run muxoejzo5dcq]

$ node --experimental-sqlite test/engines-marquee-only.js --browser 2>&1 | tail -20
  E1a: Filters intro "Movies are built by Marquee Cinema and shows by Marquee TV." → PASS
  E1b: Engines box text "Marquee Cinema (movies) · Marquee TV (shows)" → PASS
  E1c: No select[data-filter^="engine_"] → PASS
  E2a: warn-lines present (≥2) → PASS (found 5)
  E2b: "Simkl connection" in warn-line → PASS
  E3a: No "Engines" summary → PASS
  E3b: No [data-engine] input → PASS
  E4a: PUT body has no engine_movie → PASS
  E4b: PUT body has no engine_series → PASS
  E5a: #set-engines text starts "Marquee Cinema (movies) · Marquee TV (shows)" → PASS
  E5b: No engine select on /mobile → PASS
  E6: No page errors → PASS (0 errors)
All engines-marquee-only checks passed (15).
```
