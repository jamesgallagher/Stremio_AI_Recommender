# SC-02 — Per-type engine config: data model, migration, validation, API

**Layer:** backend / config · **Depends on:** `01` (registry) · **Blocks:** `03`, `04`, `05`
**Behavioral change for users:** none (defaults to Genesis everywhere).

> Read `00-overview.md` §5. This card adds the **stored per-type engine choice**
> and exposes the available engines to both UIs. It does not yet make the build
> honor the choice (that's `03`) — but after this card the value round-trips
> through save/load and the API advertises the engine list.

---

## Context primer (current state)

- [`src/config.js`](../../src/config.js) owns per-profile config.
  - `DEFAULT_FILTERS` (lines ~23–48) currently ends with a **vestigial**
    `engine: 'trakt'` and `const ENGINES = ['trakt', 'ai']` (lines ~47–49). The
    old Trakt/AI engine concept is dead (see `docs/v6-features.md` "What dies in
    v6" and the "vestigial engine/rating_source" cleanup note).
  - `applyMigrations(p)` (lines ~109–149) is where fields are added/retired. The
    `rating_source` retirement (line ~127, `delete p.filters.rating_source`) is
    the exact pattern to copy.
  - `updateProfile` (lines ~233–288) validates/clamps each filter field. The
    current `engine` clamp is line ~249:
    `if (f.engine !== undefined) profile.filters.engine = ENGINES.includes(f.engine) ? f.engine : 'trakt';`
- [`src/portal.js`](../../src/portal.js) `publicProfile` (lines ~56–115) returns
  `filters: p.filters` verbatim to the portal, and there's a `GET /genres` +
  `GET /catalogs` pattern for static option lists.

---

## Goal

1. Replace the vestigial scalar `engine` with **`engine_movie`** and
   **`engine_series`**, both defaulting to `'genesis'`.
2. Migrate existing profiles (drop `engine`, add the two, coerce unknowns).
3. Validate writes against the **registry** (`01`), falling back to `'genesis'`.
4. Expose the **available engines** (id, name, description, supportedTypes,
   per-profile `requirements`) so `04`/`05` can render dropdowns + descriptions +
   warnings.

---

## Design

### 1. `DEFAULT_FILTERS` (config.js)

Remove `engine: 'trakt'`; add:

```js
// Which engine builds each catalog's candidates (see docs/engine-abstraction).
// Per-type so Movies and Series can differ. Defaults to Genesis (the original
// TMDB-affinity engine); unknown ids fall back to Genesis at read + write.
engine_movie:  'genesis',
engine_series: 'genesis',
```

Delete `const ENGINES = ['trakt', 'ai']`. The valid-id source of truth is now the
**registry** (`require('./engines')`), not a hardcoded array — avoids drift.

> Import note: `config.js` requiring `./engines` which requires `genesis` which
> requires `settings`/`watchedStore`/`tmdb` — check for require cycles. If a cycle
> appears, have config use a **lazy** `require('./engines')` inside the functions
> that need it (like `recommendationStore` already lazy-requires `rebuild`), or
> add a tiny `engines/registry-lite` that only lists ids/metadata with no heavy
> deps. Prefer lazy-require.

### 2. Migration (`applyMigrations`)

```js
const engines = require('./engines'); // lazy if a cycle appears
// Retire the dead single-engine field (Trakt/AI concept, gone since v6).
if (p.filters.engine !== undefined) delete p.filters.engine;
// Per-type engine selection. Default to Genesis; coerce any unknown/unsupported
// id (incl. the old 'trakt'/'ai') to Genesis so a stale value can't disable a type.
for (const t of ['movie', 'series']) {
  const f = `engine_${t}`;
  const cur = p.filters[f];
  const e = engines.get(cur);
  p.filters[f] = (e && e.supportedTypes.includes(t)) ? cur : 'genesis';
}
```

Idempotent (safe to run every load, like the other migrations).

### 3. Validation (`updateProfile`)

Replace the old `engine` clamp with per-type clamps that consult the registry
**and the profile's age limit** (I7 / overview §5.5). Validate against the
*effective* age limit — the value after this same patch is applied, since a patch
can change `age_limit` and `engine_<type>` together:

```js
// compute the effective age limit for this write (patch may raise/lower it)
const effLimit = (patch.filters && patch.filters.age_limit !== undefined)
  ? Math.max(0, parseInt(patch.filters.age_limit, 10) || 0)
  : (profile.filters.age_limit || 0);

for (const t of ['movie', 'series']) {
  const f = `engine_${t}`;
  if (patch.filters[f] !== undefined) {
    const e = engines.get(String(patch.filters[f]));
    const okType = e && e.supportedTypes.includes(t);
    const okAge  = e && !(e.capabilities.unrestricted && effLimit > 0); // I7
    profile.filters[f] = (okType && okAge) ? e.id : 'genesis';
  }
}

// Safety re-validation: raising the age limit must REVOKE an already-stored
// unrestricted engine even if engine_<type> isn't in this patch (overview §5.5,
// point 3). Run after age_limit is applied.
if (effLimit > 0) {
  for (const t of ['movie', 'series']) {
    const cur = engines.get(profile.filters[`engine_${t}`]);
    if (cur && cur.capabilities.unrestricted) profile.filters[`engine_${t}`] = 'genesis';
  }
}
```

A crafted body asking for an unknown, type-unsupported, or age-inappropriate
engine silently lands on Genesis — never an error, never a disabled type, never
open content on a kids profile (safety over strictness). *(The slice-clear +
rebuild that must accompany a revocation lives in card `03`; this card only makes
the stored value safe.)*

### 4. API — advertise the engine catalog

Add a static endpoint in `portal.js` (mirrors `GET /genres`):

```js
// GET /api/engines — the registry, for the portal's per-type dropdowns.
router.get('/engines', (req, res) => {
  res.json({
    engines: require('../engines').list().map((e) => ({
      id: e.id, name: e.name, description: e.description,
      supported_types: e.supportedTypes, capabilities: e.capabilities,
    })),
    default: require('../engines').DEFAULT_ID,
  });
});
```

Per-profile **requirement** status (is the chosen engine usable for this
profile?) is profile-specific, so surface it in `publicProfile` rather than the
static list. Add to the object returned by `publicProfile(p, req)`:

```js
const eng = require('../engines');
engines: {
  movie:  p.filters.engine_movie  || 'genesis',
  series: p.filters.engine_series || 'genesis',
  // Ids the portal may OFFER per type for THIS profile — age-filtered (I7): an
  // unrestricted engine is absent here when the profile has an age limit, so the
  // dropdown simply never shows it. (Portal is an admin surface and may also
  // show age limit, but sourcing the list from availableFor keeps one rule.)
  available: {
    movie:  eng.availableFor(p, 'movie').map((e) => e.id),
    series: eng.availableFor(p, 'series').map((e) => e.id),
  },
  // per (type→engine) requirement, so the UI can warn "needs Simkl"/"needs Groq"
  requirements: {
    movie:  eng.resolveFor(p, 'movie').requirements(p),
    series: eng.resolveFor(p, 'series').requirements(p),
  },
},
```

(`filters` is already returned verbatim, so `engine_movie`/`engine_series` also
arrive inside `filters`; the `engines` block is the convenience shape + the
requirement check. Pick whichever `04` finds easier — provide both, they're cheap.)

### 5. Companion whitelist

Add the two fields to `COMPANION_FILTERS` in
[`mobile/server/handlers.js`](../../mobile/server/handlers.js) line ~20:

```js
const COMPANION_FILTERS = ['min_rating', 'vote_count_floor', 'max_age_years',
  'excluded_genres', 'list_size', 'title_decay_enabled', 'title_decay_days',
  'engine_movie', 'engine_series'];
```

This lets the companion **read and write** the engine choice through the existing
strict whitelist (still no `age_limit` exposure). The companion settings payload
also needs the engine list — see `05`. (Do the whitelist add here so `03`'s
rebuild-on-change fires for companion saves too; the mobile UI itself is `05`.)

---

## Tasks

- [ ] `config.js`: drop `engine`/`ENGINES`; add `engine_movie`/`engine_series`
      defaults; migrate; validate against the registry.
- [ ] `portal.js`: add `GET /api/engines`; extend `publicProfile` with the
      `engines` block (selection + per-type requirements).
- [ ] `handlers.js`: add both fields to `COMPANION_FILTERS`.
- [ ] Confirm no require cycle config↔engines (lazy-require if needed).

## Acceptance criteria

- Loading an **old** profile (with `filters.engine === 'trakt'`) yields
  `engine_movie === 'genesis'`, `engine_series === 'genesis'`, and no `engine`
  key remains after the next save.
- `PUT /api/profiles/:id` with `filters:{engine_movie:'genesis'}` persists;
  with `filters:{engine_movie:'bogus'}` persists as `'genesis'`.
- `GET /api/engines` returns exactly one engine (`genesis`) with its description
  and `supported_types:['movie','series']`.
- `GET /api/profiles/:id` includes `engines.movie/series` and
  `engines.requirements.movie/series` (`ok:true` when TMDB+Simkl present).
- A companion `POST /mobile/api/settings` with `engine_series:'genesis'` is
  accepted; with `age_limit:5` still drops `age_limit` (whitelist intact).
- **Age gating (I7):** with a registered `unrestricted:true` stub — selecting it
  on an adult profile (`age_limit:0`) persists; selecting it on a profile with
  `age_limit>0` coerces to `'genesis'`; and a patch that raises `age_limit` above
  0 on a profile currently holding the stub rewrites that type to `'genesis'`.
  `GET /api/profiles/:id`'s `engines.available.{movie,series}` omit the stub for an
  age-limited profile and include it for an adult one.

## Test notes

- Extend the config migration test: seed a profile JSON with the legacy `engine`
  field and assert the post-migration shape.
- Add a `updateProfile` clamp test for unknown/valid engine ids per type.
- `mobile.smoke.js`: assert `COMPANION_FILTERS` includes the two engine fields
  and that `settingsPostHandler` forwards them but never `age_limit`.

## Out of scope

- Making the build honor the selection (`03`).
- Rendering the dropdowns (`04` portal, `05` mobile).
