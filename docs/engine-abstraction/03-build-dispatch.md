# SC-03 — Build dispatch by selected engine + rebuild-on-change

**Layer:** backend · **Depends on:** `01` (registry+pipeline), `02` (config)
**Blocks:** `06` · **Behavioral change for users:** none while Genesis is the only
registered engine; this is the seam that makes selection *real*.

> Read `00-overview.md` §2, §3, §5.4. Card `01` made the build call Genesis for
> both types through the shared pipeline. This card makes it call **the engine
> the profile selected for each type**, checks that engine's requirements, and
> rebuilds a type's slice when its engine changes.

---

## Context primer (current state after `01`)

- `recommendationStore.buildRecommendations(profile)` calls
  `pipeline.runEngineBuild(profile, type, genesis, …)` for `'movie'` then
  `'series'` (hardcoded Genesis).
- `buildPool` = `buildRecommendations` + `ageGatePool` (whole pool, once).
- `ensureBuilt(profile)` → `needsBuild(profile.id)` gates the background build.
  `needsBuild` today returns true when the **whole** pool is empty or watched
  history moved since `built_at` (`rec_state.built_at`, profile-wide).
- The build job runs via `jobs.enqueue(profile.id, 'recs', …)` — per-profile,
  serialized.

---

## Goal

1. Dispatch each type's build to `engines.resolveFor(profile, type)`.
2. Skip (and clearly annotate) a type whose engine's `requirements(profile)` are
   unmet — never crash, never silently produce an empty type with no reason.
3. When a profile's `engine_<type>` changes, **clear that type's pool slice and
   rebuild it** (§5.4 of the overview): the producer changed, so stale rows from
   the previous engine must not linger.

---

## Design

### 1. Per-type dispatch in `buildRecommendations`

```js
async function buildRecommendations(profile, log, onProgress) {
  const engines = require('./engines');
  const pipeline = require('./engines/pipeline');
  const ctx = makeCtx(profile, log);
  if (!ctx.tmdbKey) return { skipped: true, reason: 'no TMDB key in Server Config' };

  const results = {};
  const band = (lo, hi) => (p, l) => onProgress(lo + (hi - lo) * p / 100, l);
  const spans = { movie: [0, 50], series: [50, 100] };
  for (const type of ['movie', 'series']) {
    const engine = engines.resolveFor(profile, type);
    const req = engine.requirements(profile);
    if (!req.ok) {
      log.warn(`[rec] ${profile.name}/${type}: ${engine.name} unavailable — missing ${req.missing.join(', ')}`);
      results[type] = { skipped: true, engine: engine.id, missing: req.missing };
      continue;
    }
    log.log(`[rec] ${profile.name}/${type}: building with ${engine.name}`);
    results[type] = await pipeline.runEngineBuild(profile, type, engine, ctx, band(...spans[type]));
    results[type].engine = engine.id;
  }
  setBuiltAt(profile.id);
  return mergeResults(results); // keep the existing return shape; add per-type engine ids
}
```

`ageGatePool` still runs once after both types (in `buildPool`) — unchanged, I1.

**Important:** requirement-skip must **not** wipe an existing slice. If Series'
engine is temporarily unbuildable (e.g. Groq down for an LLM engine), keep the
last good Series rows serving rather than emptying the catalog. Only an **engine
change** (below) clears a slice.

### 2. Rebuild-on-engine-change

`config.updateProfile` is where the change is detected. Two clean options:

**Option A (recommended) — clear slice + signal, let the tick/serve rebuild.**
In `updateProfile`, after validating filters, if `engine_<type>` actually changed
value, delete that type's pool slice and mark the profile build-needed:

```js
// in updateProfile, after computing the new engine_<type> values:
for (const t of ['movie', 'series']) {
  if (before[`engine_${t}`] !== profile.filters[`engine_${t}`]) {
    engineChanged.push(t);
  }
}
// after mutateProfiles commits, back in the PUT handler / a hook:
for (const t of engineChanged) recommendationStore.clearType(profile.id, t);
```

- Add `recommendationStore.clearType(profileId, type)` — `DELETE FROM recommended
  WHERE profile_id=? AND type=?`. (Do **not** touch `dont_recommend`: a user's
  rejections/decays are engine-independent and should persist across an engine
  swap.)
- Make `needsBuild` type-aware, or add `needsBuildType(profileId, type)` returning
  true when that type's slice is empty. Simplest: `needsBuild` already returns
  true when the whole pool is empty; extend it to also return true when **either**
  type slice is empty AND the profile has watched history — so clearing one slice
  triggers a rebuild on the next `ensureBuilt` (tick or catalog open).

**Option B — synchronous rebuild.** Enqueue a `'recs'` job immediately on change.
More immediate but couples the config write to a minutes-long job. Prefer A
(consistent with "filters apply on next build/serve", and the SWR model).

> Where to put the trigger: `updateProfile` is in `config.js` which shouldn't
> depend on `recommendationStore` (cycle + layering). Do the slice-clear in the
> **callers** that already know they changed filters — `portal.js`
> `PUT /profiles/:id` and `handlers.js` `settingsPostHandler` — using the
> `before`/`after` engine values. Have `updateProfile` **return** which engine
> fields changed (or return the old+new filters) so callers can act. Keep the DB
> mutation out of `config.js`.

> **Capture `before`/`after` around the WHOLE `updateProfile`** so it also catches
> an **age-limit-driven revocation** (overview §5.5 point 3 / card `02`): raising
> `age_limit` while an `unrestricted` engine is selected rewrites that type to
> `'genesis'` *inside* `updateProfile`, which shows up as a changed
> `engine_<type>` in the before/after diff and therefore triggers the same
> `clearType` + rebuild path — no special-casing needed. `age_limit` is
> portal-only (never a companion field), so this transition originates only in
> `portal.js PUT /profiles/:id`. Serve is safe in the gap regardless: `resolveFor`
> (card `01`) already refuses an unrestricted engine for an age-limited profile
> and falls back to Genesis (I7).

### 3. Portal/companion save hooks

- `portal.js PUT /profiles/:id`: after `config.updateProfile`, for each changed
  `engine_<type>` call `recommendationStore.clearType` and kick
  `recommendationStore.ensureBuilt(profile)` (fire-and-forget, like the existing
  extras background build). Surface nothing blocking — the portal already polls
  `status`/`job`.
- `handlers.js settingsPostHandler`: same, so a companion engine change also
  clears + rebuilds. (The whitelist add was done in `02`.)

### 4. Manifest / serve

No manifest change — the two AI catalogs are fixed. Serve (`serveRecommendations`)
is unchanged: it reads whatever the current engine wrote. While a changed slice is
mid-rebuild, serve returns the "warming up" card exactly as it does for a cold
pool today (`addon.js` already handles empty slices).

---

## Tasks

- [ ] `buildRecommendations`: per-type `engines.resolveFor` dispatch + requirement
      skip (no slice wipe on skip).
- [ ] `recommendationStore.clearType(profileId, type)`.
- [ ] `needsBuild` (or `needsBuildType`) treats an empty type slice as
      build-needed.
- [ ] `config.updateProfile` reports changed engine fields to its callers.
- [ ] `portal.js` + `handlers.js`: on engine change → `clearType` + `ensureBuilt`.
- [ ] Per-type engine id included in build result/logs for the Advanced tab.

## Acceptance criteria

- With only Genesis registered, a full rebuild is **identical** to `01`'s output
  (both types built by Genesis).
- Simulate a **fake second engine** registered for tests: set
  `engine_series` to it, save → the Series slice is cleared and rebuilt by the
  fake engine; the Movie slice is untouched (still Genesis rows).
- Changing `engine_movie` back to `genesis` clears + rebuilds Movies only;
  `dont_recommend` rows survive the swap.
- A type whose engine has unmet requirements is skipped with a logged reason and
  its **existing** rows keep serving (not wiped).
- **Age-limit revocation (I7):** on a profile using an `unrestricted:true` stub
  for Movies, a portal save that raises `age_limit` above 0 rewrites
  `engine_movie` to `genesis`, clears the Movie slice, and rebuilds it with
  Genesis — with no extra revocation code beyond the before/after engine diff.
- `GET /api/profiles/:id/recommend` and the build log show which engine produced
  each type.

## Test notes

- Register a `fake` engine (the `01` conformance fixture) in a test-only registry
  hook, or expose `engines.__register(engine)` guarded to test env. Assert:
  dispatch picks it, `clearType` fires on change, `dont_recommend` persists.
- Assert requirement-skip path does not delete existing rows.

## Out of scope

- The dropdown UIs (`04`, `05`) — though this card's save hooks are what those
  UIs POST into.
- Any concrete second engine (`06`).
