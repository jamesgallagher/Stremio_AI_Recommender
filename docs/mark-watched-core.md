# MW-00 — Mark-as-watched core (shared action + Simkl history write + API)

**Layer:** backend — new shared action module (`src/markWatched.js`) + Simkl
history-write helper + one companion endpoint (portal endpoint optional, see
[MW-02](mark-watched-catalog.md)) · **Depends on:** `simkl.addToHistory`
(already exists), `watchedStore`, `recommendationStore` · **Blocks:**
[MW-01 — recs actions](mark-watched-recs.md) and
[MW-02 — catalog preview overlays](mark-watched-catalog.md) (both call the
endpoint this card defines) · **Behavioral change for users:** a user can now
mark a title **watched** from the phone, which scrobbles it to Simkl. "Not
interested" is a **rename only** of the existing Remove action — no new logic.

> This is the backend seam the two UI cards share. Read
> [`src/dontRecommend.js`](../src/dontRecommend.js) (the "not interested" side —
> already built, transport-agnostic, reused verbatim), then
> [`src/services/simkl.js:178-194`](../src/services/simkl.js) (`addToHistory`,
> POST `/sync/history`) and its sibling builder `buildAddToListBody`
> ([`simkl.js:211-228`](../src/services/simkl.js)) as the pattern to copy for a
> watched-history body. The endpoint mirrors
> [`suppressHandler`](../mobile/server/handlers.js) at
> [`handlers.js:155-163`](../mobile/server/handlers.js), routed at
> [`router.js:123`](../mobile/server/router.js).

---

## Why this card exists

The feature is two verbs on a title: **watched** and **not interested**. One of
them already exists end-to-end; the other does not. Splitting the backend into
its own card keeps the two UI cards (recs list, catalog preview) thin — they both
POST to the same one endpoint and never duplicate the Simkl/pool logic, exactly
the way the portal, in-player link, and Companion already share
`dontRecommend.suppress()`.

- **"Not interested" is already done.** Every reject surface funnels through
  `dontRecommend.suppress()` — records a permanent user rejection (reason
  `'user'`) and drops the title from the pool
  ([`dontRecommend.js:63-76`](../src/dontRecommend.js),
  [`recommendationStore.addDontRecommend`](../src/recommendationStore.js)). The
  recs X button already calls it ([`handlers.js:155`](../mobile/server/handlers.js)).
  MW-01/02 only relabel the button and add a second entry point; **no backend
  change** for "not interested".
- **"Mark as watched" is new.** Simkl can already *receive* a watched write —
  `simkl.addToHistory` POSTs `/sync/history` and is used today by the
  auto-scrobble path ([`scrobble.js:101`](../src/services/scrobble.js)). No code
  yet exposes a *user-initiated, title-level* watched mark. This card adds it.

Marking watched is the highest-quality training signal the app has: a watched
title becomes a taste seed and a de-dupe on the next Simkl sync
([`watchedStore.syncFromSimkl`](../src/watchedStore.js)) — the same pipeline that
already turns Simkl history into better recommendations. So "mark watched" needs
to do exactly one authoritative thing — **write to Simkl** — and let the existing
sync pull the consequences through.

---

## Context primer (current state)

- **`simkl.addToHistory(profile, body)`** — [`simkl.js:184`](../src/services/simkl.js):
  POST `/sync/history`, rate-governed at Simkl's 1-POST/s write cap, token/clientId
  required, Simkl de-dupes re-marks (a double-tap is harmless). Body shape:
  `{ movies:[{ ids:{imdb}, watched_at? }], shows:[{ ids:{imdb}, seasons?:[…] }] }`.
- **`watched_at` is optional.** `scrobble.computeDelta`
  ([`scrobble.js:38-60`](../src/services/scrobble.js)) only sets `watched_at` when
  it has a real timestamp and **omits it otherwise** — Simkl then defaults to now.
  This is exactly the user's ask ("do not add a date watched; if required, use
  current date"): we **omit** `watched_at` and let Simkl stamp it.
- **Series = whole show.** `computeDelta` builds per-episode `seasons/episodes`.
  A title-level "I watched this show" mark instead sends the show **id with no
  `seasons`**, which Simkl treats as "mark the whole show watched". MW's builder is
  therefore simpler than `computeDelta` and must not reuse it.
- **Simkl connection gate:** `addToHistory` throws "Simkl is not connected" without
  a client id + token — same precondition `watchlistHandler` already enforces with a
  400 ([`handlers.js:75-77`](../mobile/server/handlers.js)).
- **How a watched title reaches recs/catalogs:** recs are watched-pruned at serve
  via `watchedStore.watchedIdSets(profile.id).imdb`
  ([`handlers.js:145-148`](../mobile/server/handlers.js)); curated/AI catalogs prune
  watched at serve in `catalogServe.servedCatalog`. The local `watched` table is
  keyed by **`simkl_id`** ([`watchedStore.js:33`](../src/watchedStore.js)) — which we
  do NOT have at mark-time — and is filled by the **activities-gated** sync
  ([`watchedStore.js:200-235`](../src/watchedStore.js)). Posting to `/sync/history`
  bumps Simkl's `activities.all` timestamp, so the next scheduled sync **will** pull
  the mark back with its real `simkl_id`. This is the reconciliation path.

---

## Goal

1. A single **transport-agnostic action** — `markWatched(profile, { type, imdbId,
   tmdbId, title })` — that writes the title to the profile's Simkl watched history
   with **no `watched_at`**, movie-or-whole-show, and returns a plain result the
   callers format (mirrors `dontRecommend.suppress`'s shape).
2. One **companion endpoint** — `POST /api/watched` — used by both MW-01 (recs) and
   MW-02 (companion catalog preview).
3. A **pure body builder** (`buildWatchedHistoryBody`) exported for tests, matching
   the `buildAddToListBody` pattern.
4. **No new "not interested" backend** — MW-01/02 reuse `dontRecommend.suppress`.

---

## Design

### 1. `src/markWatched.js` — the shared action

New module, deliberately shaped like `dontRecommend.js` (no req/res, no HTML):

```js
// PURE: build the /sync/history body for ONE title. Movie → movies[{ids:{imdb|tmdb}}];
// series → shows[{ids:{…}}] with NO seasons (Simkl marks the whole show watched).
// watched_at is intentionally omitted so Simkl stamps "now" (MW: no explicit date).
function buildWatchedHistoryBody({ type, imdbId, tmdbId }) {
  const ids = {};
  if (imdbId) ids.imdb = String(imdbId);
  if (tmdbId != null && tmdbId !== '') ids.tmdb = String(tmdbId);
  if (!ids.imdb && !ids.tmdb) return { movies: [], shows: [] };   // nothing to match on
  return type === 'series'
    ? { movies: [], shows: [{ ids }] }
    : { movies: [{ ids }], shows: [] };
}

async function markWatched(profile, { type, imdbId = null, tmdbId = null, title = null } = {}, log = console) {
  if (type !== 'movie' && type !== 'series') return { ok: false, reason: 'bad-type', title };
  if (!imdbId && tmdbId == null)            return { ok: false, reason: 'no-id', title };
  if (!profile.keys?.simkl_client_id || !profile.simkl_auth?.access_token) {
    return { ok: false, reason: 'no-simkl', title };
  }
  const body = buildWatchedHistoryBody({ type, imdbId, tmdbId });
  if (!body.movies.length && !body.shows.length) return { ok: false, reason: 'no-id', title };
  await simkl.addToHistory(profile, body);                              // authoritative
  watchedStore.addPendingWatched(profile.id, { type, imdbId, tmdbId }); // immediate serve-prune (§3)
  log.log(`[watched] ${profile.name}: "${title || imdbId || tmdbId}" (${type}) → Simkl history`);
  return { ok: true, type, imdbId, tmdbId, title };
}
```

- **Simkl is authoritative**; the pending-watched record is a local shim only, so the
  title leaves the served lists before the next sync (§3). It carries no `simkl_id`,
  so it never collides with the real `watched` row the sync later upserts.

### 2. `POST /api/watched` (companion) — new handler + route

Alongside `suppressHandler`, targeting `req.profile` (never a body id):

```
POST /api/watched   { type, imdb_id?, tmdb_id?, title? }
-> 200 { ok:true }
-> 400 bad-type / no-id / Simkl not connected   (mirror watchlistHandler's 400 copy)
-> 502 { error: 'Could not mark watched — <msg>' }   (Simkl error / token rejected)
```

```js
async function watchedHandler(req, res) {
  const { type, tmdb_id, imdb_id, title } = req.body || {};
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'type must be movie or series' });
  if (tmdb_id == null && !imdb_id) return res.status(400).json({ error: 'tmdb_id or imdb_id is required' });
  if (!req.profile.simkl_auth?.access_token) {
    return res.status(400).json({ error: 'Simkl is not connected — connect it in the portal first' });
  }
  try {
    const out = await markWatched(req.profile, { type, imdbId: imdb_id, tmdbId: tmdb_id, title }, console);
    if (!out.ok) return res.status(400).json({ error: `Could not mark watched (${out.reason})` });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Could not mark watched — ${err.message}` });
  }
}
```

Route (session-guarded, no `:id`):
`router.post('/api/watched', requireSession, handlers.watchedHandler);`

### 3. Reflection — both actions leave the served lists immediately (James, 2026-09-09)

**Decision:** both Watched and Not Interested remove the title from the served
catalog **immediately, server-side**. The Stremio/Nuvio client may still show a
cached row until its own `cacheMaxAge` expires — inherent to Stremio, not ours to
fix (James: *"it may be cached on the client, but we can't control that"*). Each verb
uses its own natural domain:

- **Not interested** → `dontRecommend.suppress` (reason `'user'`), unchanged for the
  AI pool and now **extended to every curated catalog** by
  [MW-03](not-interested-all-catalogs.md). A rejected title never appears in the AI
  lists **or** any catalog — authoritative and immediate, no sync wait.
- **Watched** → the Simkl history write above **plus** an immediate local record in
  the watched store, so serve-time watched-pruning drops it **now** rather than after
  the next Simkl sync. Because it flows through the existing watched-prune path, it
  automatically respects `dedupe_watched:false` — Watch Later and Christmas keep the
  title ([WL-KW](watch-later-keep-watched.md)); every other catalog drops it, exactly
  as a Simkl-synced watch would.
- Both UIs ([MW-01](mark-watched-recs.md)/[MW-02](mark-watched-catalog.md)) also
  remove the row optimistically for instant on-device feedback.

**Watched immediacy — the mechanism.** The local `watched` table is keyed by
`simkl_id` ([`watchedStore.js:33`](../src/watchedStore.js)), which we don't have at
tap-time, so we can't upsert a real row yet. This card adds a tiny per-profile
**pending-watched set** (imdb + tmdb + type) that `watchedStore.watchedIdSets`
**unions into** its returned id sets. Every serve path that already prunes watched
(recs in [`handlers.js:145`](../mobile/server/handlers.js); AI + extras in
[`catalogServe.js:67,86`](../src/catalogServe.js)) then drops the title with **no
change to those call sites** — they just see a bigger watched set. The next
activities-gated `syncFromSimkl` (triggered by the bumped `activities.all`) fills the
real row; the pending entry is a harmless shim until then. **Clear it only when
superseded** — i.e. a real `watched` row with the same imdb now exists (or on profile
reset) — **never on a timer**, or the title would flash back into the lists between
expiry and the next sync ([MW-05 I4](mark-watched-review.md)).

This keeps the two domains clean: **watched** stays in the watched-prune domain
(respects keep-watched lists), **not interested** stays in the suppression domain —
which [MW-03](not-interested-all-catalogs.md) extends to every catalog **except the
two Watch Later rows** (a plan-to-watch title supersedes both watched and
not-interested; the Watch Later ✕ is instead a list-removal,
[MW-04](remove-from-watchlist.md)). The *training* outcome for watched is unchanged
either way: it flows from the Simkl write via the existing sync into seeds + de-dupe.

---

## Tasks

- [ ] `src/markWatched.js`: `buildWatchedHistoryBody` (pure, exported) + `markWatched`
      (Simkl-only, no `watched_at`, series→whole-show, transport-agnostic result).
- [ ] `mobile/server/handlers.js`: `watchedHandler` (targets `req.profile`, 400
      Simkl-not-connected copy matching `watchlistHandler`, 502 on Simkl error);
      export it.
- [ ] `mobile/server/router.js`: `POST /api/watched` behind `requireSession`.
- [ ] `watchedStore`: a per-profile **pending-watched set** (imdb + tmdb + type)
      recorded by `markWatched`, **unioned into `watchedIdSets`** so every existing
      watched-prune site drops the title immediately (no change at those call sites);
      cleared/superseded when the real Simkl-synced row lands.
- [ ] Tests — see Test notes.

## Acceptance criteria

- **Watched write is correct:** `buildWatchedHistoryBody` sends a **movie** as
  `movies:[{ids:{imdb}}]` and a **series** as `shows:[{ids:{imdb}}]` with **no
  `seasons`** and **no `watched_at`** in either.
- **Endpoint is session-scoped:** `POST /api/watched` acts on `req.profile` only;
  there is no id in the path/body to abuse.
- **Simkl-not-connected** returns 400 with the same guidance as the watchlist add,
  never a 500.
- **De-dupe safe:** marking the same title twice is harmless (Simkl de-dupes;
  endpoint returns ok both times).
- **Immediate serve-prune:** right after a mark, `watchedStore.watchedIdSets`
  includes the title's imdb, so recs and catalogs stop serving it **before** any
  Simkl sync runs — while keep-watched lists (Watch Later/Christmas) still keep it.
- **"Not interested" is unchanged server-side** — it is still exactly
  `dontRecommend.suppress`; this card adds no second rejection path (its reach into
  catalogs is [MW-03](not-interested-all-catalogs.md)).

## Test notes

- Pure builder unit tests (no network): movie vs series shape, imdb-only, tmdb-only,
  neither-id → empty body, and **assert `watched_at` is absent** and a series body has
  **no `seasons`** key.
- `markWatched`: stub `simkl.addToHistory`; assert it's called with the built body,
  and the `no-simkl` / `bad-type` / `no-id` early returns (no POST fired).
- Handler/route test in the mobile smoke suite
  ([`mobile/test/mobile.smoke.js`](../mobile/test/mobile.smoke.js)): 401 without a
  session, 400 without Simkl connected, 200 happy path (stubbed Simkl), 502 on a
  thrown Simkl error.
- Pending-watched: after `markWatched` (stubbed Simkl), assert the imdb is in
  `watchedStore.watchedIdSets(profile.id).imdb`, that `servedCatalog` drops it from a
  watched-pruning catalog but **keeps** it in a `dedupe_watched:false` list (Watch
  Later), and that a later real sync row doesn't duplicate it.

## Out of scope

- The button/overlay UI — [MW-01](mark-watched-recs.md) (recs) and
  [MW-02](mark-watched-catalog.md) (catalog preview).
- Extending **not interested** to curated catalogs — [MW-03](not-interested-all-catalogs.md)
  owns that (the suppression-filter + schema change); this card only wires the
  watched action and its immediate watched-prune shim.
- Per-episode / season-level watched marking — MW marks whole titles only.
- Removing a title from Simkl history (an "un-watch") — not requested; a separate
  card if ever wanted.
