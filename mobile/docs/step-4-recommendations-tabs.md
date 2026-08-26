# Step 4 — Recommendations: Movies / Shows tabs + swipe

**Status:** ✅ BUILT (2026-08-26). `recommendationsHandler`/`suppressHandler`/
`unsuppressHandler`/`toRecDTO` in [handlers.js](../../mobile/server/handlers.js);
`recommendationStore.removeDontRecommend()` (user-only, decay-safe) added;
pure swipe math in [swipe.js](../../mobile/public/swipe.js); Movies/Shows tabs,
rows, swipe + action buttons, and an Undo snackbar in the SPA. Tests: `37 unit + http`.

**e2e-verified in a real browser (2026-08-26):** tabs load with count badges
(Movies 2 / Shows 1), rows show poster/title/year·genre·★rating/"because you
watched"; tab switch works; **swipe-right** → red underlay + "Remove" → row
removed + Undo snackbar; **swipe-left** → green underlay + "Add to watch later"
→ save (row kept); Remove/Add **buttons** mirror the gestures; **Undo** restores
the row (unsuppress). Add showed the realistic "Simkl not connected" message for a
Simkl-less profile (the success path was verified in Step 3). Swipe was driven via
synthetic pointer events (this host can't composite screenshots).

**Depends on:** Step 1 (session), Step 2 (shell), Step 3 (watchlist write, reused
for swipe-left). **Reuses:** `dontRecommend.suppress()` for swipe-right.

> **Interpretation note (confirmed by build):** the brief's "the tab text will
> change to Remove / Add to watch later" is implemented as a **label revealed on
> the swiped row** (the standard swipe-action affordance), not a change to the
> Movies/Shows tab caption. Easy to switch if you meant the tab caption.
> **Deferred:** the per-row detail sheet — inline Add/Remove buttons on each row
> cover the non-gesture path (and the desktop path) more directly.

## Goal

A tabbed list of the user's current recommendations — one tab **Movies**, one tab
**Shows** — showing **all items**. Nice-to-have: **swipe a row** to act on it.

- **Swipe right → remove** the item. As the swipe starts, the row turns **light
  red** and reveals the action label **"Remove"**.
- **Swipe left → save to watchlist**. The row turns **light green** and reveals
  **"Add to watch later"**.

## Design

### New routes (session-guarded)

| Method & path | Query / body | Response |
|---|---|---|
| `GET /mobile/api/recommendations` | `?type=movie\|series` | `200 { type, items: [ Rec ] }` |
| `POST /mobile/api/recommend/suppress` | `{ type, imdb_id? , tmdb_id?, title? }` | `200 { ok, title, total }` (swipe-right) |
| `POST /mobile/api/watchlist` | *(from Step 3)* | swipe-left reuses it verbatim |
| `POST /mobile/api/recommend/unsuppress` *(optional, for Undo)* | `{ type, tmdb_id }` | `200 { ok }` |

`Rec` DTO (from `recommendationStore.getRecommended` rows):
```json
{ "id":"tt0325980", "tmdb_id":"22", "type":"movie", "title":"Pirates of the Caribbean",
  "year":2003, "poster":"…", "genre":"Adventure", "rating":8.0,
  "because":"Pirates of the Caribbean: Dead Man's Chest" }
```

### Recommendations — reuse `recommendationStore.getRecommended`

[src/recommendationStore.js:177](../../src/recommendationStore.js) already returns
a profile's pool rows for a given `type`, ordered by affinity. The handler:

1. `type` whitelisted to `movie|series` (default `movie`).
2. `const rows = recommendationStore.getRecommended(req.profile.id, { type, limit })`.
3. Map rows → `Rec` DTO with a **pure** `toRecDTO(row)` (`primary_genre → genre`,
   `vote_average → rating`, `because_title → because`, poster passthrough).
4. Return `{ type, items }`.

**"All items" decision:** return the **raw stored pool** per type (like the
portal's Advanced tab, [src/portal.js:434](../../src/portal.js), which dumps the
same table), **not** the serve-time genre-balanced/decayed subset that the Stremio
catalog uses. The mobile app is a *management/curation* surface — the user wants
to see and act on everything they've been recommended, so show the whole pool
(paginate with `?limit`/`?offset` if it grows large). This is a deliberate split
from the addon's serve path; documented here for sign-off.

The client requests both types (movie + series) — either eagerly on entry or
lazily per tab — and a tab badge shows each count. Empty pool → an honest empty
state ("No recommendations yet — watch something and they'll appear"), never
padded rows (the engine's quality-over-quantity principle).

### Swipe-right (remove) — reuse the shared suppress path

`dontRecommend.suppress()` is *already written* to be the one code path for every
remove surface — its header names "the Mobile Companion app" explicitly
([src/dontRecommend.js:5](../../src/dontRecommend.js)). The handler is a thin
wrapper (the portal's is the template, [src/portal.js:470](../../src/portal.js)):

```js
const result = await dontRecommend.suppress(
  req.profile, { type, imdbId: imdb_id, tmdbId: tmdb_id, title }, console);
if (!result.ok) return res.status(result.reason === 'bad-type' ? 400 : 422).json({ error: `could not suppress (${result.reason})` });
res.json({ ok: true, title: result.title, total: recommendationStore.countRecommended(req.profile.id) });
```
No rebuild needed — recommendations are filtered from the pool at serve time, so
the removal is effectively instant across every surface (phone, portal, Stremio).

### Swipe-left (save) — reuse Step 3's watchlist write

Swipe-left calls `POST /mobile/api/watchlist` (Step 3) with the row's
`{ type, tmdb_id, imdb_id, title, year }`. One watchlist path for the search view
and the swipe gesture.

### Optional Undo (recommended for a swipe UI)

`suppress` is reversible only by a full reset today. A mis-swiped remove deserves
an Undo, so add a small **`removeDontRecommend(profileId, type, tmdbId)`** to
`recommendationStore` (deletes the `dont_recommend` row) behind
`POST /mobile/api/recommend/unsuppress`, and show a 5-second "Removed · **Undo**"
snackbar. **Scope it to `reason='user'` rows only** so it can never resurrect a
`reason='decayed'` entry mid-cooldown (keeps the decay lifecycle,
[src/recommendationStore.js:156](../../src/recommendationStore.js), intact).

### Swipe interaction — pure core in `mobile/public/swipe.js`

Gesture via pointer events (`pointerdown/move/up`) translating the row on X; the
**decision math is a pure function** so it's unit-testable without a DOM:

```js
// dx: horizontal drag (px, + = right). width: row width. Returns the live state.
function swipeOutcome(dx, width, { threshold = 0.28 } = {}) {
  const ratio = width ? dx / width : 0;
  const past = Math.abs(ratio) >= threshold;
  if (dx > 0) return { direction:'right', action: past ? 'remove' : 'none',
                       color:'#f8d7da' /* light red */, label:'Remove', progress: Math.min(1, ratio/threshold) };
  if (dx < 0) return { direction:'left',  action: past ? 'save'   : 'none',
                       color:'#d4edda' /* light green */, label:'Add to watch later', progress: Math.min(1, -ratio/threshold) };
  return { direction:'none', action:'none', color:null, label:'', progress:0 };
}
```
- As soon as `dx ≠ 0`, the row background is set to the returned `color` and the
  `label` is revealed under the row (this satisfies "as they start to swipe … the
  row changes to light red/green and the text changes to Remove / Add to watch
  later"). `progress` drives opacity/reveal.
- Release: `action:'remove'` → suppress + snackbar; `action:'save'` → watchlist
  add; `action:'none'` → animate snap-back.
- Committing removes the row from the list optimistically; on API error, re-insert
  and toast the failure.

> **Note on wording:** the brief says "the tab text will change to Remove / Add to
> watch later". A global tab caption changing mid-swipe is unusual; this plan
> reveals the label on the **swiped row** (standard swipe-action affordance).
> Flag for confirmation — trivial to point at the tab caption instead if that's
> the intent.

### Nice-to-have status

Per the brief, swipe is a **nice-to-have**. Ship order within the step: (a) tabs +
list + tap-to-open (buttons for Remove / Add on the detail sheet) first — fully
functional without gestures; (b) layer swipe on top. Buttons remain as the
accessible, non-gesture path (and the desktop path, where swipe is awkward).

### Implementation checklist

- [ ] `mobile/server/handlers.js` — `recommendationsHandler` + pure `toRecDTO`; `suppressHandler` (wraps `dontRecommend.suppress`); optional `unsuppressHandler`.
- [ ] `mobile/server/router.js` — wire the routes behind `requireSession`.
- [ ] (optional) `recommendationStore.removeDontRecommend` (+ export).
- [ ] `mobile/public/swipe.js` — pure `swipeOutcome`; gesture binding in `app.js`.
- [ ] SPA: tab bar (Movies/Shows) + count badges, poster rows, detail sheet with Remove / Add buttons, swipe layer, Undo snackbar, honest empty states.

---

## Unit tests (`mobile/test/mobile.smoke.js`)

Pure/offline. Seed the pool with `recommendationStore.upsertCandidates` (as
[test/smoke.js](../../test/smoke.js) already does), inject fakes for suppress/
watchlist where needed.

1. **`recs: toRecDTO maps a pool row → DTO`** — `primary_genre→genre`,
   `vote_average→rating`, `because_title→because`, `imdb_id→id`, poster passes
   through; input row not mutated.
2. **`recs: handler returns items per type from the session profile`** — seed a
   pool for profile A (movies + series); `GET /recommendations?type=movie` returns
   only movies; `type=series` only series.
3. **`recs: empty pool → empty items (no padding)`** — a profile with no pool
   returns `{ items: [] }`, not placeholders.
4. **`recs: type validation`** — an unknown `type` coerces to `movie`.
5. **`swipe: swipeOutcome right past threshold → remove/red`** — `dx = 0.3*width`
   → `{action:'remove', color: light-red, label:'Remove'}`.
6. **`swipe: swipeOutcome left past threshold → save/green`** — `dx = -0.3*width`
   → `{action:'save', color: light-green, label:'Add to watch later'}`.
7. **`swipe: under threshold → none (snap-back), but color shows on any dx`** — a
   small `dx` → `action:'none'` yet `color`/`label` already set (the "as they
   start to swipe" affordance); `dx=0` → all-neutral.
8. **`swipe: progress is clamped 0..1`** — a huge `dx` still returns `progress:1`.
9. **`suppress: mobile handler removes from the pool`** — after `suppressHandler`,
   `countRecommended` drops by one and `dontRecommendKeys` contains the id.
10. **`unsuppress (optional): restores a user rejection, not a decayed one`** —
    `removeDontRecommend` deletes a `reason:'user'` row; a `reason:'decayed'` row
    is left intact.

## Regression tests

1. **`regression: getRecommended / upsertCandidates unchanged`** — the existing
   `recommendationStore:` cases in [test/smoke.js](../../test/smoke.js) still pass;
   Step 4 only reads + reuses.
2. **`regression: remove parity across all three surfaces`** — removing a title
   via the **mobile** handler produces the *same* state as the portal
   `/api/.../recommend/suppress` and the in-player `/dnr` route, because all three
   call `dontRecommend.suppress`. Assert: after mobile-remove, the same
   `dont_recommend` row + pool deletion exist that a portal-remove would produce.
3. **`regression: remove needs no rebuild`** — after a mobile suppress, the next
   `getRecommended`/`serveRecommendations` for that profile omits the title with
   no build step.
4. **`regression: decay lifecycle intact`** — with the optional unsuppress added,
   the decay tests (`impressionStep`/`shouldDecay`/cooldown,
   [test/smoke.js](../../test/smoke.js)) still pass; unsuppress touches only
   `reason:'user'` rows, so decayed-title cooldown behaviour is unchanged.
5. **`regression: cross-profile isolation`** — a session for profile A calling
   `GET /recommendations` never returns profile B's pool rows, and a mobile
   suppress/watchlist only mutates profile A (seed both, one session, assert B
   untouched).
6. **`regression: swipe-left uses the Step 3 watchlist path`** — the save action
   posts to `/mobile/api/watchlist`, so the Simkl-write regression guards from
   Step 3 (profile-scoped, `simkl_post`-paced) also cover swipe-left.

## Acceptance criteria

- Two tabs, Movies and Shows, each listing that profile's full recommendation
  pool with poster, title, year, genre, and "because you watched…".
- (Nice-to-have) Swiping a row right removes it (light red, "Remove"); left saves
  it to the watchlist (light green, "Add to watch later"); the colour/label
  appear as soon as the swipe begins; an under-threshold release snaps back.
- Remove is instant everywhere (phone, portal, Stremio) with no rebuild; a mis-
  swipe is undoable (if the optional Undo ships).
- Nothing a user does touches another profile's data.

## Risks / notes

- **Destructive-feeling gesture:** swipe-right removal is reversible only via the
  portal today — the Undo snackbar (optional but recommended) closes that gap on
  the phone; ship it with the swipe layer.
- **Swipe on desktop:** pointer-drag works with a mouse but is awkward; keep the
  Remove / Add **buttons** on the detail sheet as the primary desktop path and
  the accessible fallback everywhere.
- **"All items" vs serve-filtered** is a deliberate product choice (raw pool for
  curation) — see the design note; flip to `serveRecommendations` if you'd rather
  the phone mirror exactly what Stremio shows.
