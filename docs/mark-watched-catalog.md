# MW-02 — Catalog preview: "mark as watched" + "not interested" per title

**Layer:** frontend (portal preview modal + Companion preview sheet) + a small
portal endpoint · **Depends on:** [MW-00](mark-watched-core.md) (`POST /api/watched`
+ shared `markWatched`), [MW-04](remove-from-watchlist.md) (the Watch Later ✕ remove
endpoints); serve-side reach from [MW-03](not-interested-all-catalogs.md); surfaces
from [CP-01](catalog-preview-portal.md) / [CP-02](catalog-preview-companion.md) ·
**Behavioral change for users:** each title cell in a catalog preview gains two
corner actions — **mark as watched** (top-left) and, top-right, either **not
interested** or, on the two Watch Later rows, **remove from Watch Later**.

> Read the two preview renderers this card decorates:
> **portal** `_cpvRender` → `.cpv-cell` at
> [`public/index.html:612-632`](../public/index.html) (cell CSS ~
> [`index.html:84`](../public/index.html)); **companion** `renderPreview` →
> `.pv-cell` at [`mobile/public/app.js:557-576`](../mobile/public/app.js). Each cell
> already has a positioned `.poster`/`.pv-poster` wrapper carrying an overlay rating
> badge — the two new icons hang in the same wrapper's top corners.

---

## Why this card exists

CP-01/CP-02 made a catalog's served titles visible; this card makes them
**actionable**. Browsing a catalog is exactly when a user notices "I've already
seen that" or "not for me" — and the two verbs from [MW-00](mark-watched-core.md)
(watched / not interested) are the training signals that answer both. Same actions
as the recs list ([MW-01](mark-watched-recs.md)), reached from a different surface,
reusing the identical endpoints so behaviour can't drift.

---

## Context primer (current state)

- **Portal preview cell** — [`index.html:623-631`](../public/index.html): per meta,
  `<div class="cpv-cell"><div class="poster"><img|no-poster> <rating></div><span
  class="cap">…</span></div>`. `.poster` is `position:relative` and already anchors
  the `.rating` overlay ([`index.html:84`](../public/index.html)). Portal talks to
  `/api/profiles/:id/…`; the **suppress** endpoint already exists —
  `POST /api/profiles/:id/recommend/suppress` ([`portal.js:559`](../src/portal.js)) —
  and there's already a `/profiles/:id/watched/simkl` route
  ([`portal.js:537`](../src/portal.js)), so a `POST /profiles/:id/watched` sits in an
  established namespace.
- **Companion preview cell** — [`app.js:562-573`](../mobile/public/app.js): per meta,
  `.pv-cell > .pv-poster (img|.pv-noposter + .pv-rating) + .pv-cap`. Companion talks
  to `/api/…` session-scoped; it already has `POST /api/recommend/suppress`
  ([`router.js:123`](../mobile/server/router.js)) and — via
  [MW-00](mark-watched-core.md) — `POST /api/watched`.
- **Per-cell identity available:** the served meta carries `id` (imdb `tt…`) and
  `name`; the media **type** is the catalog's `data.type` (movie/series), not per
  meta. That's enough for both actions (watched by imdb; suppress by imdb, which
  resolves tmdb server-side — [`dontRecommend.resolveTmdbId`](../src/dontRecommend.js)).
  The preview metas do **not** currently include `tmdb_id` (see Open question).
- **Age invariant (Companion only):** the preview sheet shows nothing about age
  ([CP-02](catalog-preview-companion.md)); these actions add no age surface — they
  send only `type` + `imdb_id` + `title`.

---

## Goal

1. Two **corner overlay actions** on every preview cell, on **both** surfaces:
   **top-left** eye = "Mark as watched"; **top-right** ✕.
2. **The ✕ is context-dependent on the catalog** (James, 2026-09-09):
   - On the two **Watch Later** rows (`source === 'simkl_plantowatch'`) it means
     **"Remove from Watch Later"** → the Simkl list-removal action
     ([MW-04](remove-from-watchlist.md)). NOT a suppression.
   - On **every other** catalog (Christmas included) it means **"Not interested"** →
     the existing suppress endpoint ([MW-03](not-interested-all-catalogs.md) makes
     that reach the catalog serve).
3. **Always visible — one solution for all.** No hover-reveal and no device
   detection: the icons show at all times, portal and companion alike. Tap/click
   targets ≥ 32px, keyboard-focusable.
4. On success, **grey out / remove** that cell from the preview — **except** the eye
   on a Watch Later cell, which leaves it in place (see §0).
5. Endpoints so both surfaces have targets: portal `POST /api/profiles/:id/watched`
   (companion reuses MW-00's `/api/watched`); the Watch Later ✕ uses MW-04's
   remove endpoints.

---

## Design

### 0. One flag drives both actions: `isWatchLater = data.source === 'simkl_plantowatch'`

`servedCatalog` already computes `source`, but **neither preview endpoint currently
forwards it** — the companion payload is `{ id, name, type, requirement_met, state,
count, metas }` ([`handlers.js:234-249`](../mobile/server/handlers.js)) and the portal
mirror is the same. So this card must **add `source` to both preview payloads** (it
leaks nothing about age — `source` is already in the `companionCatalogs` DTO at
[`handlers.js:201`](../mobile/server/handlers.js)). The companion could instead match
the two known Watch Later ids (`trakt-watchlist-movies/-series`, already special-cased
at [`app.js:509`](../mobile/public/app.js)), but forwarding `source` is uniform across
both surfaces — prefer it. That single flag sets the ✕ **and** tunes the eye:

| cell | eye (top-left) | ✕ (top-right) |
|---|---|---|
| **Watch Later** (`simkl_plantowatch`) | "Mark as watched" → scrobble to Simkl; **cell stays** (Watch Later keeps watched — WL-KW/supersede), snackbar "Marked watched — kept in Watch Later" | **"Remove from Watch Later"** → MW-04 remove endpoint; **cell drops** |
| **any other** (AI, Christmas, curated) | "Mark as watched" → scrobble; **cell drops** | **"Not interested"** → suppress endpoint; **cell drops** |

Why the eye doesn't drop a Watch Later cell: a plan-to-watch title stays in Watch
Later even once watched ([WL-KW](watch-later-keep-watched.md)), so removing the cell
would just have it reappear on the next fetch — misleading. On Watch Later the eye is
a pure "I've seen it" scrobble; the ✕ is the thing that takes it off the list. Set the
eye's `title`/`aria-label` accordingly on Watch Later cells.

### 1. Portal cell — always-visible corner actions

In `_cpvRender` ([`index.html:623-631`](../public/index.html)), add two buttons
inside `.poster` (which is already the positioned overlay context):

```js
// Follow the existing single-quote + esc() onclick pattern (index.html:554).
// isWatchLater = (data.source === 'simkl_plantowatch') — chosen once per render.
const xLabel = isWatchLater ? 'Remove from Watch Later' : 'Not interested';
const xFn    = isWatchLater ? 'cpvRemoveFromWatchlist'  : 'cpvNotInterested';
const eyeLbl = isWatchLater ? 'Mark as watched (kept in Watch Later)' : 'Mark as watched';
const acts =
  '<button type="button" class="cpv-act cpv-watch" title="' + esc(eyeLbl) + '" aria-label="' + esc(eyeLbl) + ': ' + esc(m.name||'') + '" '
  + 'onclick="cpvMarkWatched(event, \'' + esc(data.type) + '\', \'' + esc(m.id) + '\', \'' + esc(m.name||'') + '\', ' + isWatchLater + ')">' + EYE_ICON + '</button>'
  + '<button type="button" class="cpv-act cpv-nope" title="' + esc(xLabel) + '" aria-label="' + esc(xLabel) + ': ' + esc(m.name||'') + '" '
  + 'onclick="' + xFn + '(event, \'' + esc(data.type) + '\', \'' + esc(m.id) + '\', \'' + esc(m.name||'') + '\')">✕</button>';
// …'<div class="poster">' + poster + rating + acts + '</div>'…
```

- `.cpv-act` absolutely positioned: `.cpv-watch{top/left}`, `.cpv-nope{top/right}`;
  **always visible** (no hover gate — §Goal 3), keyboard-focusable, with a small
  circular scrim for contrast over posters. The rating badge stays where it is
  (bottom corner) — don't collide.
- `cpvMarkWatched` → `POST /api/profiles/:id/watched` `{ type, imdb_id, title }`; on
  2xx it fades the cell out **unless `isWatchLater`** (then it stays; snackbar only).
- `cpvNotInterested` → `POST /api/profiles/:id/recommend/suppress`
  ([`portal.js:559`](../src/portal.js)); `cpvRemoveFromWatchlist` → MW-04's
  `POST /api/profiles/:id/watchlist/remove`. Both take `{ type, imdb_id, title }` and
  fade the cell + decrement the header count on 2xx.
- On Simkl-not-connected (400), show the inline `.cpv-msg` copy and don't remove the
  cell.

### 2. Companion cell — corner actions (same treatment)

In `renderPreview` ([`app.js:562-573`](../mobile/public/app.js)), append two buttons
to `.pv-poster` — identical always-visible treatment to §1:

```js
const isWatchLater = data.source === 'simkl_plantowatch';   // once per render
const eye = document.createElement('button'); eye.type='button'; eye.className='pv-act pv-watch';
const eyeLbl = isWatchLater ? 'Mark as watched (kept in Watch Later)' : 'Mark as watched';
eye.title=eyeLbl; eye.setAttribute('aria-label',eyeLbl); eye.innerHTML = EYE_ICON;
eye.addEventListener('click', (e)=>{ e.stopPropagation(); pvMarkWatched(m, data.type, cell, isWatchLater); });
const nope = document.createElement('button'); nope.type='button'; nope.className='pv-act pv-nope';
const xLbl = isWatchLater ? 'Remove from Watch Later' : 'Not interested';
nope.title=xLbl; nope.setAttribute('aria-label',xLbl); nope.textContent='✕';
nope.addEventListener('click', (e)=>{ e.stopPropagation();
  isWatchLater ? pvRemoveFromWatchlist(m, data.type, cell) : pvNotInterested(m, data.type, cell); });
wrap.appendChild(eye); wrap.appendChild(nope);
```

- `.pv-act` absolutely positioned in `.pv-poster`'s corners (top-left eye, top-right
  ✕), **always visible**, with a scrim; ≥32px hit area; safe from the `.pv-rating`
  badge's corner.
- `pvMarkWatched` → `POST /api/watched` `{ type, imdb_id: m.id, title: m.name }`; on ok
  it removes the cell **unless `isWatchLater`** (then it stays; snackbar only).
- `pvNotInterested` → `POST /api/recommend/suppress`; `pvRemoveFromWatchlist` → MW-04's
  `POST /api/watchlist/remove` (same body). On ok, remove/grey the cell + decrement
  `pvEls.count`; on 400 (no Simkl), a small inline message via `pvMsg` — never surface
  age.

### 3. Portal endpoint — `POST /api/profiles/:id/watched`

The one backend addition this card needs (companion already has `/api/watched` from
MW-00). Resolve the profile from `:id` (as the other portal profile routes do),
then delegate to the shared `markWatched(profile, …)` from
[MW-00](mark-watched-core.md). Portal suppress already exists — reuse it unchanged.

### 4. Shared eye icon

Reuse the `EYE_ICON` constant introduced in [MW-01](mark-watched-recs.md) so the
recs eye and both preview eyes are the same glyph, distinct from the
document-with-eye `PREVIEW_ICON` used to *open* a preview.

---

## Resolved decisions (James, 2026-09-09)

- **Both surfaces, one treatment.** Portal preview **and** companion sheet, with the
  two icons **always visible** — no hover-reveal, no device detection.
- **The ✕ diverges on Watch Later** (§0). On `simkl_plantowatch` it is
  *remove-from-list* ([MW-04](remove-from-watchlist.md)), not suppression; the eye
  there scrobbles but keeps the cell (Watch Later supersedes watched). On every other
  list the ✕ is *not interested*.
- **"Not interested" must reach the catalogs, not just the AI pool.** The suppress
  endpoint this card calls is unchanged, but the *serve-side* filtering that makes a
  rejected title vanish from every non-Watch-Later catalog is
  [MW-03](not-interested-all-catalogs.md). Without MW-03 the ✕ here would still only
  clear the AI rows.
- **"Mark as watched"** removal from catalogs flows through the pending-watched shim
  in [MW-00 §3](mark-watched-core.md) — no work in this card beyond calling the
  endpoint and dropping the cell locally (and not dropping it on Watch Later).

## Open question (minor)

Add `tmdb_id` to the preview metas? "Not interested" resolves tmdb from imdb
server-side already, but for a **curated** catalog title not in the pool that means a
TMDB find-by-imdb per reject ([`resolveTmdbId`](../src/dontRecommend.js)). Including
`tmdb_id` in the CP served meta would skip that lookup. Minor; only worth it if reject
latency on curated lists is noticeable. (MW-03 persists the imdb id regardless, so
correctness doesn't depend on this.)

---

## Tasks

- [x] Add `source` to both preview payloads (companion
      [`catalogPreviewHandler`](../mobile/server/handlers.js) and the portal mirror) —
      no age leak.
- [x] Compute `isWatchLater = data.source === 'simkl_plantowatch'` once per render in
      both `_cpvRender` and `renderPreview`; drive the ✕ handler/label and the eye's
      keep-vs-drop from it (§0 table).
- [x] Portal `_cpvRender`: two `.cpv-act` corner buttons in `.poster`, always visible;
      eye → `cpvMarkWatched` (drops cell unless Watch Later); ✕ → `cpvNotInterested`
      **or** `cpvRemoveFromWatchlist` by `isWatchLater`; count decrement; inline
      Simkl-not-connected message.
- [x] Portal endpoint `POST /api/profiles/:id/watched` → shared `markWatched`. (The
      Watch Later remove endpoint is [MW-04](remove-from-watchlist.md).)
- [x] Companion `renderPreview`: two `.pv-act` always-visible corner buttons; eye →
      `pvMarkWatched`; ✕ → `pvNotInterested` **or** `pvRemoveFromWatchlist` by
      `isWatchLater`; cell removal/keep + count decrement; no age surface.
- [x] CSS: `.cpv-act`/`.pv-act` corner positioning + scrim, **always visible on both
      surfaces**, ≥32px targets, keyboard-focusable, clear of the rating badge.
- [x] Reuse `EYE_ICON` (MW-01) for both eyes.
- [x] Live check + tests — see Test notes.

## Acceptance criteria

- **Every preview cell** (portal **and** companion) has a top-left eye and a
  top-right ✕, always visible, with matching `title`/`aria-label`.
- **Watch Later cells** (`source:'simkl_plantowatch'`): the ✕ reads "Remove from
  Watch Later" and hits the [MW-04](remove-from-watchlist.md) remove endpoint (drops
  the cell, writes no suppression); the eye scrobbles and **keeps** the cell.
- **All other cells** (Christmas, curated, AI): the ✕ reads "Not interested" and hits
  the suppress endpoint (drops the cell); the eye scrobbles and drops the cell.
- **Both surfaces:** icons always visible (no hover gate), tap-sized,
  keyboard-focusable; the companion reveals **nothing about age**.
- **Mark as watched** hits the watched endpoint (portal `/profiles/:id/watched`,
  companion `/watched`) with `{ type, imdb_id, title }`; the count updates on any
  cell that drops.
- **Simkl-not-connected** shows an inline message and leaves the cell in place.
- No new server logic for "not interested" — the suppress endpoints are reused
  verbatim; the only new endpoints are the watched (MW-00/here) and Watch-Later-remove
  (MW-04) ones.

## Test notes

- **Preview a non-Watch-Later catalog** (e.g. Christmas): ✕ reads "Not interested"
  and fires the suppress call; eye fires the watched call; both drop the cell.
- **Preview a Watch Later row:** ✕ reads "Remove from Watch Later" and fires MW-04's
  remove endpoint (cell drops); the eye fires the watched call and the cell **stays**.
  Confirm no suppress call goes out from a Watch Later ✕.
- Portal + Companion live-check in the browser — icons always visible on every cell,
  right endpoint per network panel, count updates, no age text on companion,
  keyboard-focusable; screenshot for the PR (mobile viewport for companion).
- Endpoint coverage: portal `/watched` handler follows MW-00's `watchedHandler` tests
  (400 no-Simkl, 200 happy, 502 on Simkl error).

## Out of scope

- The watched action + companion `/api/watched` endpoint — [MW-00](mark-watched-core.md).
- The Watch Later remove action + endpoints — [MW-04](remove-from-watchlist.md).
- The serve-side suppression filter for catalogs — [MW-03](not-interested-all-catalogs.md).
- Recs-list buttons — [MW-01](mark-watched-recs.md).
- Bulk / select-multiple actions in a preview — a separate card if wanted.
