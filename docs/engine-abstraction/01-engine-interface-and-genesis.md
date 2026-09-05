# SC-01 — Engine interface, registry & Genesis extraction

**Layer:** backend core · **Depends on:** none · **Blocks:** `02`, `03`, `06`
**Behavioral change for users:** none (Genesis produces byte-identical results).

> Read `00-overview.md` §2–4 first. This card builds the abstraction seam and
> proves it by making today's engine the first plug-in, with **no change to
> what any user sees**.

---

## Context primer (current state)

The entire recommendation engine lives in
[`src/recommendationStore.js`](../../src/recommendationStore.js). Today it is
monolithic: `buildRecommendations(profile)` seeds from watched history, fetches
TMDB per-title `/recommendations`, scores by recency-weighted **affinity**,
resolves tt-id/poster/genres, IMDb-enriches, and upserts a **both-types** pool.
`buildPool` = `buildRecommendations` + `ageGatePool`. Serve is `serveRecommendations`
→ `selectServe` (unchanged by this card).

Relevant functions today:
- `buildRecommendations` (lines ~393–533) — the monolith to split.
- `selectStrong`, `computeAffinity` — the Genesis-specific candidate logic.
- `upsertCandidates`, `purgeBelowVoteFloor`, `refreshStaleRatings`,
  `ageGatePool`, `setBuiltAt` — the shared tail (stay shared).
- Constants `SEED_CAP`, `HALF_LIFE_DAYS`, `PER_TITLE_CAP`, `STORE_CAP` — Genesis
  parameters; move with Genesis.

There is **no `src/engines/` directory yet.** This card creates it.

---

## Goal

1. Define the **Engine interface** + **NormalizedCandidate DTO** (contract from
   `00` §4) as code + JSDoc.
2. Create an **engine registry** (`src/engines/index.js`).
3. Extract today's logic into **`src/engines/genesis.js`** as the first engine,
   implementing `generate(profile, type, ctx, onProgress)` for **one type at a
   time**.
4. Create a **shared candidate pipeline** that takes any engine's output and does
   resolve → IMDb-enrich → upsert → purge (the current build tail, made
   engine-agnostic and per-type).
5. Keep `recommendationStore.buildRecommendations` working as a thin wrapper that
   calls Genesis for both types via the pipeline — **so existing tests and
   callers keep passing** (dispatch-by-config comes in `03`).

---

## Design

### 1. Files

```
src/engines/
  index.js        # registry: register(), get(id), list(), listForType(type), DEFAULT_ID
  types.js        # (optional) JSDoc typedefs for Engine + NormalizedCandidate
  genesis.js      # the current engine, extracted; exports the Engine descriptor
  pipeline.js     # shared candidate pipeline (resolve/enrich/upsert/purge), per type
```

`recommendationStore.js` keeps the **pool table + serve + decay + age gate + IMDb
refresh**. The engines depend on the store's low-level helpers (or the helpers
move into `pipeline.js` — see §5 "Boundaries").

### 2. Engine interface (`src/engines/types.js`, JSDoc only — no TS)

```js
/**
 * @typedef {Object} EngineRequirement
 * @property {boolean} ok
 * @property {string[]} missing   // e.g. ['TMDB key', 'Simkl connection']
 * @property {string} [note]
 *
 * @typedef {Object} EngineCapabilities
 * @property {boolean} providesRankScore   // must be true in v1
 * @property {boolean} preResolved         // true → candidates already carry imdb_id+poster+genres
 * @property {'affinity'|'preserve'} serveOrder  // v1: always 'affinity'
 * @property {boolean} unrestricted        // true = "all ages"/fully open, no age classification;
 *                                         // available ONLY to profiles with age_limit === 0 (I7)
 *
 * @typedef {Object} NormalizedCandidate   // see 00-overview §4.2 for the full table
 * @property {'movie'|'series'} type
 * @property {string} tmdb_id
 * @property {number} rankScore            // → stored in the `affinity` column
 * @property {string} [imdb_id]
 * @property {string} [title]
 * @property {number} [year]
 * @property {string} [poster]
 * @property {number[]} [genre_ids]
 * @property {string} [genres]             // CSV names, if the engine resolved them
 * @property {number} [vote_average]
 * @property {number} [vote_count]
 * @property {number} [popularity]
 * @property {boolean} [adult]
 * @property {string} [reason]             // → because_title
 * @property {number} [recCount]           // → rec_count
 *
 * @typedef {Object} Engine
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {('movie'|'series')[]} supportedTypes
 * @property {(profile:object)=>EngineRequirement} requirements
 * @property {EngineCapabilities} capabilities
 * @property {(profile:object, type:'movie'|'series', ctx:EngineContext,
 *            onProgress:(pct:number,label:string)=>void)=>Promise<NormalizedCandidate[]>} generate
 *
 * @typedef {Object} EngineContext
 * @property {string} tmdbKey
 * @property {string} mdblistKey
 * @property {object} settings   // settings.getSettings()
 * @property {object} filters    // profile.filters
 * @property {Console} log
 */
```

### 3. Registry (`src/engines/index.js`)

```js
// Register engines here. listForType(type) powers the per-type UI dropdowns:
// with one engine, both lists return [genesis] → single, locked option (req #3).
const genesis = require('./genesis');
const REGISTRY = new Map([[genesis.id, genesis]]);
const DEFAULT_ID = 'genesis';

function get(id)          { return REGISTRY.get(id) || null; }
function list()           { return [...REGISTRY.values()]; }
function listForType(t)   { return list().filter((e) => e.supportedTypes.includes(t)); }
function has(id)          { return REGISTRY.has(id); }

// availableFor: engines this profile may CHOOSE for `type` — listForType minus
// any `unrestricted` engine when the profile has an age limit (I7 / overview
// §5.5). Powers the dropdowns (portal + companion) so an "all ages"/open engine
// is never offered to an age-gated profile. Genesis is always in the result.
function availableFor(profile, type) {
  const limited = (profile?.filters?.age_limit || 0) > 0;
  return listForType(type).filter((e) => !(limited && e.capabilities.unrestricted));
}

// resolveFor: the effective engine for (profile,type). Falls back to Genesis if
// the stored id is unknown, unsupported for the type, OR an unrestricted engine
// on an age-limited profile (req #5 + I7 safety floor — never serve open content
// to a kids profile, even from a hand-edited profiles.json).
function resolveFor(profile, type) {
  const id = profile?.filters?.[`engine_${type}`];
  const e = get(id);
  if (!e || !e.supportedTypes.includes(type)) return genesis;
  if (e.capabilities.unrestricted && (profile?.filters?.age_limit || 0) > 0) return genesis;
  return e;
}
module.exports = { get, list, listForType, availableFor, has, resolveFor, DEFAULT_ID };
```

### 4. Genesis (`src/engines/genesis.js`)

Descriptor + a **per-type** `generate`. This is the current build logic, sliced
to one type. Pseudocode (lift from `buildRecommendations`, keep behavior):

```js
const SEED_CAP = { movie: 150, series: 100 };   // moved from recommendationStore
const HALF_LIFE_DAYS = 90, PER_TITLE_CAP = 5, STORE_CAP = 300;

async function generate(profile, type, ctx, onProgress) {
  const { tmdbKey, filters, log } = ctx;
  // 1. Seed: the SEED_CAP[type] most-recent watched titles OF THIS TYPE.
  const seeds = watchedStore.getWatched(profile.id, { type })
    .filter((w) => w.tmdb_id).slice(0, SEED_CAP[type])
    .sort(byWatchedAtDesc);
  if (!seeds.length) return [];
  // 2. TMDB per-seed recs → strongest few/title, gated by vote-floor + adult.
  //    (selectStrong + tmdb.voteFloor(filters, type)) — moves here.
  // 3. computeAffinity(seeds, recsBySeed) → candidates with rankScore=affinity,
  //    reason=because_title, recCount, genre_ids, vote_count, popularity, poster path.
  // 4. Exclude watched + dont_recommend (or let the pipeline do it — see §5).
  // 5. sort by rankScore, slice STORE_CAP, return NormalizedCandidate[] (type set).
  onProgress(100, `Genesis: ${out.length} ${type} candidate(s)`);
  return out; // NOT resolved/enriched — the pipeline does that
}

module.exports = {
  id: 'genesis',
  name: 'Genesis Engine',
  description: '…', // from 00-overview §6
  supportedTypes: ['movie', 'series'],
  capabilities: { providesRankScore: true, preResolved: false, serveOrder: 'affinity', unrestricted: false },
  requirements(profile) {
    const missing = [];
    if (!settings.keyFor(profile, 'tmdb_api_key')) missing.push('TMDB key (Server Config)');
    if (!profile.simkl_auth?.access_token)         missing.push('Simkl connection');
    return { ok: missing.length === 0, missing };
  },
  generate,
};
```

`rankScore` is exactly today's `affinity` — Genesis's output is unchanged; we
just renamed the contract field. `computeAffinity` may be reused as-is and its
`affinity` mapped to `rankScore` at the return boundary (or keep the key
`affinity` internally and let the pipeline read `c.rankScore ?? c.affinity`).

### 5. Shared pipeline (`src/engines/pipeline.js`)

Everything the monolith did **after** candidate generation, made per-type and
engine-agnostic:

```js
// runEngineBuild(profile, type, engine, ctx, onProgress):
//   1. cands = await engine.generate(profile, type, ctx, onProgress@0–40)
//   2. subtract watched + dont_recommend by (type,tmdb_id)          [I5]
//   3. if !engine.capabilities.preResolved: resolve each — tmdb.imdbFor (tt id),
//      poster URL, genre_ids→names, Anime tag. Drop candidates with no tt id.  (40–85)
//   4. IMDb-rating enrich via MDBList (the block currently in buildRecommendations) (85–95)
//   5. upsertCandidates(profile.id, servable, { ratingCheckedAt })     [I4]
//   6. purgeBelowVoteFloor(profile.id, filters)                        [I3]
//   7. refreshStaleRatings(profile.id, mdblistKey)  (heals orphans)
//   Returns { seeds, stored, purged, ratingsRefreshed } for logging.
```

- The **age gate is NOT here** — it runs once over the whole pool after both
  types are built (invariant I1). Keep it in `recommendationStore.ageGatePool`.
- `upsertCandidates` must accept `rankScore` → `affinity`. Either map in the
  pipeline before upsert, or teach `upsertCandidates` to read `c.rankScore ??
  c.affinity`. Prefer mapping in the pipeline so `upsertCandidates` stays dumb.

**Boundaries:** `pipeline.js` may `require('../recommendationStore')` for
`upsertCandidates`/`purgeBelowVoteFloor`/`refreshStaleRatings`, OR those move into
`pipeline.js` and `recommendationStore` re-exports them for back-compat. Pick one
and keep `recommendationStore`'s public exports intact (tests import them).

### 6. `recommendationStore.buildRecommendations` becomes a thin wrapper

To avoid touching callers/tests in this card, keep the function but reimplement:

```js
async function buildRecommendations(profile, log, onProgress) {
  const genesis = require('./engines/genesis');
  const pipeline = require('./engines/pipeline');
  const ctx = makeCtx(profile, log);
  if (!settings.getSettings()?.keys?.tmdb_api_key) return { skipped: true, reason: 'no TMDB key' };
  // Both types via Genesis (dispatch-by-config arrives in card 03).
  const m = await pipeline.runEngineBuild(profile, 'movie',  genesis, ctx, band(0,50));
  const s = await pipeline.runEngineBuild(profile, 'series', genesis, ctx, band(50,100));
  setBuiltAt(profile.id);
  return mergeResults(m, s); // same shape the current return provides
}
```

`buildPool` (build + ageGatePool) and `ensureBuilt`/`needsBuild` are unchanged.

---

## Tasks

- [ ] Create `src/engines/` with `index.js`, `genesis.js`, `pipeline.js`,
      `types.js`.
- [ ] Move `SEED_CAP`, `HALF_LIFE_DAYS`, `PER_TITLE_CAP`, `STORE_CAP`,
      `selectStrong`, and the affinity/seed logic into `genesis.js`.
- [ ] Implement the shared pipeline (resolve/enrich/upsert/purge/refresh) per type.
- [ ] Reimplement `buildRecommendations` as a two-type Genesis wrapper.
- [ ] Keep `recommendationStore`'s exported surface (`computeAffinity`,
      `selectStrong`, `upsertCandidates`, `selectServe`, …) importable — re-export
      from the new homes if moved, so `test/smoke.js` and
      `mobile/test/mobile.smoke.js` still resolve them.
- [ ] JSDoc the Engine + NormalizedCandidate typedefs.

## Acceptance criteria

- `npm test` passes unchanged (both smoke suites). If a test imports
  `recommendationStore.selectStrong`/`computeAffinity`, those still resolve.
- For a profile with existing watched history, a rebuild produces the **same pool
  rows** (same tmdb_ids, same affinity ordering) as before the refactor. Verify by
  diffing `GET /api/profiles/:id/recommend` output before/after on a test DB.
- `engines.listForType('movie')` and `listForType('series')` each return
  `[genesis]`.
- `engines.resolveFor(profile,'movie')` returns Genesis for any profile
  (including one whose `filters.engine` is still the old `'trakt'`).
- `engines.availableFor(profile,'movie')` returns `[genesis]` for both an adult
  and an age-limited profile (Genesis is `unrestricted:false`). With a registered
  `unrestricted:true` stub, `availableFor` **includes** it for an adult profile
  and **excludes** it for an age-limited one; `resolveFor` falls back to Genesis
  if that stub is selected on an age-limited profile (I7).
- No user-visible change: served catalogs identical.

## Test notes

- Add a unit test that a **fake engine** returning 3 hand-built
  `NormalizedCandidate`s flows through `runEngineBuild` and lands as 3 pool rows
  with the right column mapping (rankScore→affinity, reason→because_title). This
  is the first real proof the abstraction works and doubles as the `06`
  conformance fixture.
- Keep `computeAffinity`'s existing pure-function tests pointed at its new home.

## Out of scope (later cards)

- Reading `engine_movie`/`engine_series` from config to pick the engine (`03`).
- Any config field, migration, or UI (`02`, `04`, `05`).
- A second real engine (`06`).
