# MW-03 — "Not interested" suppression reaches every catalog (not just AI)

**Layer:** backend — suppression store (schema) + shared catalog serve · **Depends
on:** `dontRecommend.suppress` / `recommendationStore` (the suppression table,
exists), `catalogServe.servedCatalog` ([CP-01](catalog-preview-portal.md), the one
serve path Nuvio + previews share) · **Pairs with:** [MW-01](mark-watched-recs.md)
/ [MW-02](mark-watched-catalog.md) (the UIs that trigger "not interested") and
[MW-04](remove-from-watchlist.md) (the *different* Watch Later ✕ action) ·
**Behavioral change for users:** a title marked **Not interested** now disappears
from **every** catalog — the curated MDBList lists too — not only the AI
"Recommended for you" rows.

> James's call (2026-09-09): *"Don't add a not interested title to AI lists or
> catalogs… if this logic doesn't exist in the catalogs, we should definitely add
> these titles to the filter list."* Today suppression only reaches the AI pool.
> Read `dontRecommend.suppress` ([`src/dontRecommend.js`](../src/dontRecommend.js)),
> `recommendationStore.addDontRecommend` / `dontRecommendKeys`
> ([`src/recommendationStore.js:128-147`](../src/recommendationStore.js)), and the
> extras branch of `catalogServe.servedCatalog`
> ([`src/catalogServe.js:72-90`](../src/catalogServe.js)) — which prunes watched but
> **never consults the suppression list**. This card closes that gap.

---

## Why this card exists

"Not interested" is meant to say *never show me this*. It half-works: the AI
recommendation pool honours it, but the **curated catalogs don't**. A user can
reject a title on the AI row and still meet it in the War / Popular / Kids list,
because those lists are built from MDBList/Simkl and pruned only against the
**watched** store — the suppression list is invisible to them.

Extending the suppression filter to the shared serve path fixes it in **one place**:
`catalogServe.servedCatalog` is what feeds both Nuvio and the previews
([CP-01/02](catalog-preview-portal.md)), so a rejected title vanishes from the real
Stremio catalogs and every preview at once.

---

## Context primer (current state)

- **Suppression table** — `dont_recommend (profile_id, type, tmdb_id, reason, at)`,
  keyed by **tmdb id** ([`recommendationStore.js:139-147`](../src/recommendationStore.js)).
  `dontRecommendKeys` returns a `type:tmdb` key set; `'user'` is permanent, `'decayed'`
  expires ([`recommendationStore.js:128-137`](../src/recommendationStore.js)).
- **AI serve already honours it:** the pool build/serve excludes suppressed titles,
  so the AI branch of `servedCatalog`
  ([`catalogServe.js:55-69`](../src/catalogServe.js)) is already clean. **No change
  needed for AI.**
- **Extras serve does NOT** — [`catalogServe.js:72-90`](../src/catalogServe.js): loads
  cached metas, prunes **watched** (gated by `dedupe_watched`), applies RPDB. The
  suppression list is never consulted. This is the gap.
- **Key-space mismatch:** curated/Watch-Later metas are keyed by **imdb** (`m.id` =
  `tt…`), but the suppression table stores **tmdb**. `dontRecommend.suppress`
  *receives* an imdb id ([`dontRecommend.js:63`](../src/dontRecommend.js)) but only
  persists the resolved tmdb. So filtering imdb-keyed catalog metas needs an
  **imdb-keyed** suppression set, which doesn't exist yet.

---

## Goal

1. A **not-interested title never appears in a served catalog** — AI (already) and
   every curated list (new: Popular, the genre lists, **Christmas**, Kids, Anime …),
   via the single `servedCatalog` path.
2. **Watch Later is exempt** (James, 2026-09-09). The two `simkl_plantowatch` rows
   mirror the user's own hand-curated plan-to-watch list, and *adding a title to
   Watch Later supersedes watched or not-interested*. So the suppression filter
   **skips `source === 'simkl_plantowatch'`** — a suppressed-elsewhere title still
   shows in Watch Later if it's on the list. The ✕ on a Watch Later cell is a
   different action entirely (remove-from-list, [MW-04](remove-from-watchlist.md)),
   not a suppression.
   > **Key:** the exemption is keyed on **`source`, not `dedupe_watched`**. Christmas
   > is also `dedupe_watched:false` but is `source:'mdblist'` — it is **not** exempt;
   > "not interested" suppresses a Christmas title normally.
3. Match imdb-keyed catalog metas against suppression **without a per-title TMDB
   lookup at serve time** — persist the imdb id at suppress time.

---

## Design

### 1. Persist the imdb id on suppression

Add a nullable `imdb_id` column to `dont_recommend`; store it in `addDontRecommend`
(and thread it through `dontRecommend.suppress`, which already has `imdbId` in hand
at [`dontRecommend.js:63`](../src/dontRecommend.js)). Backfill is unnecessary — a
missing `imdb_id` on old rows simply means that title isn't imdb-filterable from
curated lists until it's re-suppressed (it's still tmdb-suppressed from the AI pool,
as today). Note this in the migration comment.

### 2. An imdb suppression set

New `recommendationStore.dontRecommendImdbSet(profileId, nowMs)` — the imdb siblings
of `dontRecommendKeys`, honouring the same reason/decay rules, returning a `Set` of
`tt…` ids (skip rows with a null `imdb_id`). Cheap; one indexed read.

### 3. Filter extras in `servedCatalog` — every list except Watch Later

In the extras branch ([`catalogServe.js:84-89`](../src/catalogServe.js)), after the
watched prune, drop suppressed titles — for **every extra except the
`simkl_plantowatch` (Watch Later) rows**:

```js
let served = entry.metas;
if (extraDef.dedupe_watched !== false) {
  served = served.filter((m) => !watchedStore.watchedIdSets(profile.id).imdb.has(m.id));
}
if (extraDef.source !== 'simkl_plantowatch') {                             // Watch Later is exempt
  const suppressed = recommendationStore.dontRecommendImdbSet(profile.id); // NEW
  served = served.filter((m) => !suppressed.has(m.id));                    // NEW
}
const metas = applyRpdb(served, rpdbKey);
```

The AI branch is untouched (already suppression-clean). Because this lives in the
shared serve function, it covers Nuvio's live catalogs and the CP previews together.
Christmas (`source:'mdblist'`) is filtered like any other list; only the two
`simkl_plantowatch` rows are skipped, so a not-interested title the user has *also*
put on their plan-to-watch list still surfaces in Watch Later.

---

## Resolved decision (James, 2026-09-09)

**Watch Later supersedes; Christmas does not.** "Not interested" is a hard,
permanent exclusion from **every** list **except** the two `simkl_plantowatch` rows.
The plan-to-watch list is the user's own curation, and *"adding it to a Watch Later
list always supersedes watched or not interested"* — so a title on that list shows in
Watch Later regardless of suppression (and regardless of watched, per
[WL-KW](watch-later-keep-watched.md)). Christmas, though also `dedupe_watched:false`,
is a curated list, not the user's plan-to-watch — "not interested" suppresses a
Christmas title like any other.

This is a **Watch Later-scoped** override: it makes the title reappear in Watch Later,
it does **not** clear the suppression flag globally (the title stays out of AI recs
and the other catalogs). Re-adding to plan-to-watch is the user's explicit "actually,
I do want this" — surfaced where they put it, nowhere else.

---

## Tasks

- [x] `recommendationStore`: add nullable `imdb_id` to `dont_recommend` (idempotent
      migration); persist it in `addDontRecommend`; thread `imdbId` through
      `dontRecommend.suppress`. (Also threaded through the decay path so a decayed
      title is imdb-filterable from curated lists too.)
- [x] `recommendationStore.dontRecommendImdbSet(profileId)` — imdb id set honouring
      reason/decay, null-imdb rows skipped. (Backed by a new `ix_dnr_profile` index.)
- [x] `catalogServe.servedCatalog` extras branch: filter out `dontRecommendImdbSet`
      titles for every extra **except `source === 'simkl_plantowatch'`** (Watch Later
      exempt; Christmas and all others filtered).
- [x] Tests — see Test notes.

> **Build note (v7, 2026-09-09):** built on `v7`, local commit only. Suppression
> still requires a resolvable tmdb (I1) — the `imdb_id` column is the serve-time
> match key only, as scoped.

## Acceptance criteria

- A title suppressed via `dontRecommend.suppress` (imdb known) is **absent** from a
  curated catalog's `servedCatalog` metas — and therefore from Nuvio and the CP
  preview — not just from the AI rows.
- The AI branch behaviour is unchanged (already suppression-clean).
- Suppression still **requires a resolvable tmdb** (the table is tmdb-keyed;
  `resolveTmdbId` does a find-by-imdb when a TMDB key is set). The new `imdb_id` is the
  serve-time **match key** for curated metas, not an alternate identity — a title with
  neither a pooled tmdb nor a TMDB-resolvable one still can't be actioned (rare; see
  [MW-05 I1](mark-watched-review.md)). Imdb-only suppression would be a schema change,
  a separate card.
- **Christmas is filtered; Watch Later is not.** A suppressed title is absent from
  the Christmas list but **present** in Watch Later if it's on the plan-to-watch list
  (exemption keyed on `source`, not `dedupe_watched`).

## Test notes

- `smoke.js` catalog-serve tests: suppress a title that is present in a curated
  MDBList extra; assert it's gone from `servedCatalog(...).metas`. Assert the stored
  row carries `imdb_id` (so the serve-time match works without a per-title lookup).
- `dontRecommendImdbSet`: reason `'user'` present, `'decayed'` past cooldown absent,
  null-imdb rows skipped.
- Watch Later exemption: a suppressed title that is also on the plan-to-watch list
  is **present** in `servedCatalog('trakt-watchlist-…')`; the same title is **absent**
  from `servedCatalog('mdb-christmas-movies')`. Pin both.

## Out of scope

- The watched-title removal from catalogs — that flows through the watched-prune
  path via a pending-watched set in [MW-00](mark-watched-core.md), respecting
  `dedupe_watched`; this card is only about **not interested**.
- The **Watch Later ✕ = remove-from-list** action — that is
  [MW-04](remove-from-watchlist.md); it is not a suppression and writes nothing to
  this table.
- The reject UIs — [MW-01](mark-watched-recs.md) / [MW-02](mark-watched-catalog.md).
- Changing decay/undo semantics of suppression — reused as-is.
