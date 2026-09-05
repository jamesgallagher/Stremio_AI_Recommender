# Engine Abstraction — Overview & North Star

**Status:** DESIGN ONLY, no code. This is the anchor document for the
multi-engine recommendation architecture. Every scope card (`01`–`06`) references
the contract and invariants defined here.

**Target line:** a **new `v7.0.0-beta` line** (D3, confirmed). The current v6
build **graduates to the stable `main` line** — it *is* Genesis Engine — and the
`-beta` tag now tracks this engine-abstraction work on a fresh v7 branch. The
work is sequenced so it can ship in stages behind a single latent capability
(registry with one engine) before any second engine exists. *(Branch/tag/merge
strategy is recorded in §9; no git actions are part of these design cards.)*

---

## 1. Goal (what James asked for)

Make the recommender support **pluggable recommendation engines**:

1. **Output abstraction.** Whatever an engine does internally, the rest of the
   app consumes a single engine-agnostic output. Downstream code (Stremio serve,
   portal, companion) must not know or care which engine produced a list.
2. **Configurable engine choice** in the **main config (portal)** *and* the
   **companion app (`/mobile`)**.
3. **Single-engine → single option.** When only one engine exists (today), the
   selector shows exactly that one option and is effectively locked.
4. **Per-type selection.** A profile can run one engine for **Movies** and a
   different engine for **Series**.
5. **Default everything to the current engine.**
6. The current engine is named **"Genesis Engine"**, with a user-facing
   description of how it chooses titles.

---

## 2. The key architectural insight — where the abstraction seam sits

The app already has a clean **build / serve split** (`src/recommendationStore.js`):

- **BUILD** (background, queued): produce candidates and write them into the
  shared `recommended` pool table (`(profile_id, type, tmdb_id)` primary key).
- **SERVE** (request path, cheap, no network): read the pool, apply serve-time
  user preferences (rating floor, excluded genres, movies-only recency, list
  size, age-band re-check), genre-balance, record impressions, emit Stremio
  metas.

**Everything downstream of the pool is already engine-agnostic** — serve
filters, genre-balance, the decay lifecycle, impression tracking, the age-band
re-check, watched-pruning, RPDB poster swap, the Stremio meta shape, and the
Mobile Companion DTO all read the pool and do not care how a row got there.

**Therefore the abstraction boundary is the pool row.** An engine is a
**candidate producer**: given `(profile, type)`, it returns normalized
candidates; a shared pipeline resolves/enriches/age-gates them and writes the
pool. This satisfies requirement #1 exactly — *the output (a canonical pool row)
is identical regardless of engine.*

```
                        ┌───────────────────────────── shared, engine-agnostic ─────────────────────────────┐
 Simkl / other source   │  Engine.generate()        Shared candidate pipeline           recommended pool     │   Serve path (unchanged)
 ─────────────────────► │  → NormalizedCandidate[] → resolve tt/poster/genres →       (canonical rows,       │ → selectServe → genre-balance
      (engine-specific)  │      (per profile,type)     IMDb enrich → upsert →          type-sliced)           │ → impressions → Stremio metas
                        │                              purge vote-floor → age-gate                            │ → /mobile DTO
                        └────────────────────────────────────────────────────────────────────────────────────┘
        ▲ SWAPPABLE PER TYPE                                                              ▲ INVARIANT: same for all engines
```

### Why "candidate producer", not "full serve producer"
A more permissive boundary (an engine emits final served metas) was rejected for
v1: it would force every engine to re-implement rating/genre/recency filtering,
genre-balance, decay, impressions, the age-band re-check and watched-pruning —
duplicating the exact machinery that already works and that must behave
**identically** for child-safety reasons. Keeping those shared makes the
invariants (below) hold for free. A future engine that genuinely needs different
serve semantics uses the **capabilities** escape hatch (§4.3), not a fork of the
serve path.

---

## 3. Invariants (must hold for every engine, present and future)

These are non-negotiable and are enforced by the **shared** pipeline/serve, never
by an engine:

- **I1 — Safety is engine-independent.** The age gate (`ageGatePool`: NSFW
  blacklist + anime MAL band + LLM ACB pass) runs over the whole pool after
  build, regardless of which engine produced which slice. Choosing an engine can
  never weaken a kids profile.
- **I2 — Serve-time preferences are engine-independent.** Rating floor, excluded
  genres, movies-only recency, list size, and the age-band re-check apply to the
  pool at serve time no matter the engine.
- **I3 — Vote-count floor is a storage gate for all engines.** Sub-floor titles
  are never stored (`purgeBelowVoteFloor` runs in the shared pipeline; engines
  may additionally pre-filter as an optimization, as Genesis does).
- **I4 — The pool schema is the single output contract.** Engines fill the
  required subset of columns; the pipeline owns the rest (imdb_rating,
  age_classification, impression/decay columns, created_at).
- **I5 — Watched titles and `dont_recommend` are excluded for all engines**
  (shared, at build and serve).
- **I6 — Ordering column is `affinity`.** Serve orders and genre-balances by the
  `affinity` column. Every engine MUST populate it with a comparable rank score
  (higher = stronger), even if its internal notion of rank isn't "affinity".
- **I7 — Unrestricted engines are age-selection-gated (D1).** An engine may
  declare `capabilities.unrestricted: true` — "all ages" / fully open, applying
  **no** age classification. Such an engine is available **only to profiles with
  `age_limit === 0`**: it is never listed, selectable, resolved, or served for a
  profile with any age limit. If one is left stored when an age limit is later
  *added*, `resolveFor` falls back to Genesis and that type's slice is cleared +
  rebuilt (§5.5). This mirrors the existing `catalogs.ageAppropriate` gate that
  hides age-band catalogs from low-age profiles. **The NSFW/porn blacklist stays
  absolute for every engine**, unrestricted included — "open" means no age
  *classification*, not adult/NSFW content. (Opting a specific engine into an
  NSFW/adult pathway would be a separate, explicitly-hardened decision — see §8,
  open item Q1.)

---

## 4. The engine contract

### 4.1 Engine descriptor + interface (see `01` for the full spec)

```js
// src/engines/<id>.js  — module.exports shape
{
  id: 'genesis',                       // stable slug, stored in profile config
  name: 'Genesis Engine',              // display name
  description: '…how it picks titles…',// user-facing, shown in both UIs
  supportedTypes: ['movie', 'series'], // ['movie','series'] | ['movie'] | ['series']
                                       // → "Movies+Shows" / "Only Movies" / "Only Shows" (D1).
                                       // A type's dropdown lists only engines that support it.
  requirements(profile) -> {           // is this engine usable for this profile?
    ok: boolean, missing: string[], note?: string
  },
  capabilities: {                      // serve hints + safety (see 4.3)
    providesRankScore: true,
    preResolved: false,                // false → pipeline resolves tt/poster/genres
    serveOrder: 'affinity',            // 'affinity' (balance) | 'preserve' (keep engine order)
    unrestricted: false,               // true = "all ages"/fully open, NO age classification;
                                       // available ONLY to profiles with age_limit === 0 (I7)
  },
  async generate(profile, type, ctx, onProgress) -> NormalizedCandidate[]
}
```

### 4.2 NormalizedCandidate DTO — the canonical output

| Field | Req? | Maps to pool column | Notes |
|---|---|---|---|
| `type` | ✅ | `type` | must equal the `type` being built |
| `tmdb_id` | ✅ | `tmdb_id` | canonical key (string). v1 pool is TMDB-keyed |
| `rankScore` | ✅ | `affinity` | higher = stronger; drives order + genre-balance (I6) |
| `imdb_id` | ⬜ | `imdb_id` | if absent, pipeline resolves via `tmdb.imdbFor`; no tt → dropped |
| `title` / `year` | ⬜ | `title` / `year` | pipeline can backfill on resolve |
| `poster` | ⬜ | `poster` | path or full URL; pipeline normalizes |
| `genre_ids` **or** `genres` | ⬜ | `primary_genre` + `genres` | pipeline resolves ids→names, tags `Anime` |
| `vote_average` | ⬜ | `vote_average` | rating-floor fallback |
| `vote_count` | ⬜ | `vote_count` | vote-floor purge (I3) |
| `popularity` | ⬜ | `popularity` | tie-break |
| `adult` | ⬜ | (drop) | porn dropped at build |
| `reason` | ⬜ | `because_title` | "because you watched X"; null-tolerant |
| `recCount` | ⬜ | `rec_count` | informational |

**Pipeline-owned, engines never set:** `imdb_rating`, `imdb_rating_at`,
`age_classification`, `first_shown_at`, `times_shown*`, `streak_*`,
`last_shown_at`, `engaged_at`, `created_at`.

### 4.3 Capabilities (serve hints + safety)
- `serveOrder` (mostly latent in v1) lets a future engine whose rank is a
  hand-ordered list (e.g. an LLM) opt out of genre-balancing. In v1 only
  `'affinity'` is used and the serve path is unchanged.
- `preResolved` declares whether candidates already carry `imdb_id`+poster+genres
  (see §5 pipeline). Genesis: `false`.
- **`unrestricted` (D1) — the "all ages" / fully-open safety flag.** `true` means
  the engine applies **no** age classification and may surface titles of any age
  rating. Effect (enforced everywhere, not by the engine itself):
  - Registry `availableFor(profile, type)` **excludes** unrestricted engines when
    `profile.filters.age_limit > 0`, so they never appear in that profile's
    dropdowns (portal **or** companion).
  - Config validation coerces an unrestricted selection to Genesis for an
    age-limited profile; and **raising** a profile's age limit revokes any
    unrestricted engine already chosen (§5.5).
  - `resolveFor(profile, type)` **never returns** an unrestricted engine for an
    age-limited profile — it falls back to Genesis — so even a hand-edited
    `profiles.json` cannot serve open content to a kids profile.
  - The **NSFW/porn blacklist is unaffected** (absolute for all engines, I7).
  - Genesis is `unrestricted: false` (gated — safe for any profile via the shared
    age gate).

---

## 5. Configuration model

### 5.1 Placement — per-profile filter, edited in BOTH surfaces (derived, not chosen)
Requirement #2 says the companion must be able to set the engine. The companion
**only ever edits per-profile `filters`** (via the `COMPANION_FILTERS`
whitelist); it never touches global Server Config. Therefore engine selection is
a **per-profile `filters` field**, exactly like `list_size` and `title_decay`.
This is forced by the requirement, not a free choice.

### 5.2 Shape — two flat scalars (recommended)
```jsonc
filters: {
  …,
  engine_movie:  'genesis',   // engine id for the Movies catalog
  engine_series: 'genesis',   // engine id for the Series catalog
}
```
Flat scalars match the existing flat `filters` validation/clamping pattern in
`config.updateProfile` and the per-type asymmetry already in the codebase
(vote-floor, recency). A nested `filters.engines = { movie, series }` is the
alternative; flat is recommended for consistency. **Decision D1 (below).**

### 5.3 Migration (mirrors how `rating_source` was retired)
In `config.applyMigrations`:
- Drop the vestigial scalar `engine` (and retire `ENGINES = ['trakt','ai']`).
- Add `engine_movie: 'genesis'`, `engine_series: 'genesis'` when absent.
- Any unknown/invalid id (incl. old `'trakt'`/`'ai'`) → coerced to `'genesis'`.
- `DEFAULT_FILTERS` gains both fields defaulting to `'genesis'` (requirement #5).

### 5.4 Changing an engine triggers a rebuild of that type's slice
Filter changes normally don't trigger rebuilds, but the engine **defines what the
pool should contain**. On change of `engine_<type>`, the app must clear that
type's pool slice and rebuild it (see card `03`). This is the one filter that is
build-affecting, like `vote_count_floor`/`age_limit` — but stronger (it replaces
the producer, so stale rows from the old engine must be purged, not just
re-filtered).

### 5.5 Age-eligibility gating of engine selection (D1 / I7)
Because an engine can be `unrestricted` (§4.3), selection is filtered by the
profile's age limit — the same shape as `catalogs.ageAppropriate`:

```js
// registry helper (card 01)
function availableFor(profile, type) {
  const limited = (profile?.filters?.age_limit || 0) > 0;
  return listForType(type).filter((e) => !(limited && e.capabilities.unrestricted));
}
```

Enforced at four points so it can't be bypassed:
1. **Dropdowns** (portal `04` + companion `05`) list `availableFor(profile,type)`,
   not the whole registry. On the companion this happens **server-side** in
   `companionSettings` — the age limit filters the list without ever being exposed
   (same discipline the companion already uses for age-band catalogs).
2. **Write validation** (`updateProfile`, card `02`): an unrestricted id from an
   age-limited profile is coerced to `'genesis'`.
3. **`age_limit` raised** (a profile gains/tightens a limit while an unrestricted
   engine is selected): the engine choice for that type is **revoked → Genesis**,
   and the slice is cleared + rebuilt (card `03`). Note `age_limit` is *not* a
   companion field, so this transition originates only in the portal — but the
   revocation must run wherever `age_limit` is written.
4. **`resolveFor`** (serve/build, card `01`) never returns an unrestricted engine
   for an age-limited profile — Genesis is the guaranteed safe floor.

Genesis (`unrestricted: false`, supports both types) is therefore **always**
available to every profile, so a dropdown is never empty.

---

## 6. Naming — "Genesis Engine"

- **id:** `genesis`  ·  **name:** `Genesis Engine`
- **Description (user-facing, both UIs):**
  > *Builds from your Simkl watch history. For every title you've watched it pulls
  > TMDB's "more like this" recommendations, weights them so what you watched
  > recently counts for more, and blends them into one ranked, genre-balanced
  > list. Recency-weighted collaborative filtering — the original engine.*
- Short tagline (dropdown helper): *"From your watch history (TMDB similar +
  recency weighting)."*
- **Capabilities:** `supportedTypes: ['movie','series']` (Movies + Shows),
  `unrestricted: false` (age-**gated** — safe for any profile, including kids, via
  the shared age gate), `preResolved: false`, `serveOrder: 'affinity'`.

---

## 7. Scope cards & dependency graph

| Card | Title | Layer | Depends on |
|---|---|---|---|
| `01` | Engine interface, registry & Genesis extraction | backend core | — |
| `02` | Per-type engine config: data model, migration, validation, API | backend/config | `01` |
| `03` | Build dispatch by selected engine + rebuild-on-change | backend | `01`, `02` |
| `04` | Portal UI — engine selectors (main config) | frontend (portal) | `02` |
| `05` | Companion UI — engine selectors (mobile) | frontend (mobile) | `02` |
| `06` | Conformance spec + second-engine template | doc/validation | `01`–`03` |

```
        01 ──► 02 ──► 03
                │  ╲
                ▼   ╲──► 06 (validates 01–03)
          04 (portal)
          05 (mobile)   (04 and 05 both need 02; independent of each other)
```

**Suggested delivery order:** `01` → `02` → `03` (the latent multi-engine
capability, still Genesis-only) → `04` + `05` in parallel (surface the selectors)
→ `06` when/if a real second engine is on the table.

**Behaviorally, `01`–`05` are a no-op for users** until a second engine is
registered: both dropdowns show only "Genesis Engine" and everyone keeps today's
results byte-for-byte. That is the safety property that makes this shippable in
stages.

---

## 8. Decisions — RESOLVED (2026-09-05)

All three framing decisions are settled. Recorded here as the authority for the
cards; one child-safety sub-question (Q1) is deliberately left open.

- **D1 — Engine type-support + the "all ages" flag. RESOLVED.**
  - Type support is `supportedTypes`: `['movie','series']` (Movies + Shows),
    `['movie']` (Only Movies), or `['series']` (Only Shows). A type's dropdown
    lists only engines supporting it.
  - **New:** engines may be **`unrestricted`** ("all ages" / fully open, no age
    classification). These are **selection-gated away from any profile with age
    gating enabled** (`age_limit > 0`) at all four enforcement points (§5.5), and
    `resolveFor` never returns one for an age-limited profile (I7). Config shape
    stays **two flat scalars** `engine_movie`/`engine_series`.
- **D2 — Second engine is a mock/stub only. RESOLVED.** Card `06` ships a
  conformance checklist + a **test-only fake/stub engine** (including an
  `unrestricted:true` stub to exercise the age-gating path), and a template. No
  real second engine is built here; any real new-source engine is a later,
  source-gated James decision.
- **D3 — Versioning. RESOLVED.** The **current v6 build moves to the stable
  `main` line** (it *is* Genesis Engine); the **`-beta` tag now tracks the engine
  work as a new `v7.0.0-beta` line** on a fresh v7 branch (see §9). Docs live in
  `docs/engine-abstraction/`.

### Open sub-question (needs an explicit call before any `unrestricted` engine ships)
- **Q1 — Does "fully open" include NSFW/porn?** Default in this design: **no.**
  `unrestricted` skips *age classification* only; the NSFW/porn blacklist
  (`isBlacklistedTitle`, applied to everyone at build/serve/search/meta today)
  **stays absolute for all engines** (I7). If James ever wants a genuinely
  adults-only engine that surfaces NSFW content, that is a separate, explicitly-
  hardened pathway (its own card): it would need its own blacklist-bypass scope,
  guaranteed isolation from any age-limited profile, and likely a distinct
  content-policy review. Not in scope for these cards.

Nothing here changes recommendation *quality* for existing users on day one; the
quality-sensitive moment is when a second engine is introduced, which is exactly
why `06` is a conformance gate and D2 keeps the real source choice for later.

---

## 9. Branch / tag / release strategy (D3) — design note only, no git actions here

- **Promote current build to stable main.** The current `v6` line (`6.38.0-beta`,
  the TMDB-affinity engine = Genesis) graduates to the `main` line as the stable
  release / `:latest`. Practically: merge `v6` → `main` and drop the `-beta`
  suffix on that release. This happens **independently of** and **before** the
  engine work, and carries no engine-abstraction code.
- **Engine work = new beta line.** Start the multi-engine architecture on a fresh
  **`v7`** branch, versioned **`v7.0.0-beta`**, and the `-beta`/non-`:latest` tag
  now tracks it (same discipline as v3/v6 betas shipped without moving `:latest`).
- **Naming coherence:** "Genesis Engine" is simply what the now-stable main-line
  engine is *called* once the abstraction lands — the promotion and the naming are
  the same engine, so there is no behavior change for stable-line users.
- These are release/branching actions for James to run when ready; the cards
  themselves are code-neutral on git.
