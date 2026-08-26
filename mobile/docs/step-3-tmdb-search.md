# Step 3 — TMDB search → add to Simkl watchlist

**Status:** ✅ BUILT (2026-08-26). `simkl.addToPlanToWatch()` + pure
`buildAddToListBody()` added to [src/services/simkl.js](../../src/services/simkl.js);
`searchHandler`/`watchlistHandler`/`toTitleDTO` in
[mobile/server/handlers.js](../../mobile/server/handlers.js); routes wired
session-guarded; search UI + detail sheet in the SPA. Tests: `28 unit + http`.

**e2e-verified in a real browser (2026-08-26):** search view → typing fires the
debounced request → results render as cards (title/year/★rating) → tap opens the
detail sheet (poster/synopsis) → **Add to watchlist** shows the realistic "Simkl
not connected" error for a Simkl-less profile, and the success state ("Added to
your Simkl Watch Later") when the write succeeds. Live TMDB results used a
fetch-boundary stub (no TMDB key in the throwaway test server); the handler's
real TMDB path is covered by the search 400/503 checks.

> **Not shipped (deferred):** the optional `GET /api/title/:type/:imdbId` richer
> detail endpoint — `searchTitles` already returns poster + synopsis, which the
> sheet uses, so it wasn't needed for v1.

**Depends on:** Step 1 (session guard), Step 2 (shell). **Introduces:** the one
new function in `src/` — `simkl.addToPlanToWatch()`.

> ⚠️ **Live-verify the Simkl write shape** against the real API before relying on
> it in production (the read side was verified against James's account; the write
> side's `/sync/add-to-list` body is isolated in the tested `buildAddToListBody`).

## Goal

The user searches for a title, sees a **poster and synopsis**, and adds it to
**their own** Simkl watchlist (plan-to-watch). Search uses TMDB (the app's
existing lookup infrastructure); the add targets the session's profile only.

## Design

### New routes (session-guarded, in `mobile/server/router.js` + `handlers.js`)

| Method & path | Body / query | Response |
|---|---|---|
| `GET /mobile/api/search` | `?q=<text>&type=movie\|series` | `200 { results: [ Title ] }` |
| `GET /mobile/api/title/:type/:imdbId` *(optional)* | — | `200 { meta }` (richer detail: cast, trailer) |
| `POST /mobile/api/watchlist` | `{ type, tmdb_id? , imdb_id?, title?, year? }` | `200 { ok, added, existing }` / `400 { error }` |

`Title` DTO (mapped from the service, only what the UI needs):
```json
{ "id": "tt1375666", "type": "movie", "title": "Inception", "year": 2010,
  "poster": "https://image.tmdb.org/t/p/w500/…", "synopsis": "…", "rating": "8.4" }
```

### Search — reuse `tmdb.searchTitles`

[src/services/tmdb.js:101](../../src/services/tmdb.js) already does exactly what
Step 3 needs: `searchTitles(apiKey, type, query, limit)` runs the search plus one
details call per hit and returns full metas with `poster`, `description`
(synopsis), `releaseInfo`, `imdbRating`, and the `tt` id. **No change to the
service.** The handler:

1. Validate: `q` present and `.trim().length >= 2` → else `400`; `type` defaults
   to `movie`, whitelisted to `movie|series`; `limit` clamped (default 10, max 12
   — search is the only request-path external work, keep it light, same cap the
   addon's search catalogs use).
2. Key: `const key = settings.keyFor(req.profile, 'tmdb_api_key')`
   ([src/settings.js:155](../../src/settings.js)) — global TMDB key first (v6
   architecture: TMDB is shared infrastructure), per-profile fallback for legacy.
   No key configured → `503 { error:'TMDB not configured' }`.
3. `const metas = await tmdb.searchTitles(key, type, q, limit)` (already rate-
   governed via `governor.schedule('tmdb', …)`).
4. Map each meta → the `Title` DTO with a **pure** `toTitleDTO(meta)` (drops
   nulls, no mutation of the service output). Return `{ results }`.

### Add to watchlist — the new Simkl write

**Gap:** Simkl currently writes only watched history (`addToHistory`,
[src/services/simkl.js:184](../../src/services/simkl.js)) and *reads* plan-to-watch
(`getPlanToWatch`, :201). There is no plan-to-watch **write**. Add one function
next to them (the correct home — one rate-governed Simkl client, no forked copy):

```js
// src/services/simkl.js — build the /sync/add-to-list body (PURE, exported for tests)
function buildAddToListBody(items) {
  const movies = [], shows = [];
  for (const it of items) {
    if (!it || (it.tmdb_id == null && !it.imdb_id)) continue;   // need at least one id
    const ids = {};
    if (it.imdb_id) ids.imdb = it.imdb_id;
    if (it.tmdb_id != null) ids.tmdb = String(it.tmdb_id);
    const entry = { to: 'plantowatch', ids };                    // Simkl list target
    (it.type === 'series' ? shows : movies).push(entry);
  }
  return { movies, shows };
}

// POST it — rate-governed at the hard 1-POST/s Simkl write cap, like addToHistory
async function addToPlanToWatch(profile, items) {
  const clientId = profile.keys.simkl_client_id;
  const token = profile.simkl_auth?.access_token;
  if (!clientId || !token) throw new Error('Simkl is not connected for this profile');
  const body = buildAddToListBody(Array.isArray(items) ? items : [items]);
  if (!body.movies.length && !body.shows.length) return { added: {}, skipped: true };
  const res = await governor.schedule('simkl_post', () => fetch(
    withParams(clientId, '/sync/add-to-list'),
    { method:'POST', headers: headers(token), body: JSON.stringify(body) }));
  if (res.status === 401 || res.status === 403) throw new Error('Simkl token rejected — reconnect the account');
  if (!res.ok) throw new Error(`Simkl POST /sync/add-to-list failed (${res.status})`);
  return res.json().catch(() => ({}));
}
```
Export both from `simkl.js`. Simkl de-dupes re-adds (same guarantee `addToHistory`
relies on), so a double-tap is harmless.

The `POST /mobile/api/watchlist` handler:
1. Validate `type` (`movie|series`) and at least one of `tmdb_id` / `imdb_id` →
   else `400`.
2. `req.profile.simkl_auth?.access_token` missing → `400 { error:'Simkl is not
   connected for this profile' }` (connecting Simkl is a portal action — out of
   scope for v1, see the README).
3. `const out = await simkl.addToPlanToWatch(req.profile, { type, tmdb_id, imdb_id, title, year })`.
   Simkl upstream error → `502 { error }`.
4. Respond `{ ok:true, added: out.added || {}, existing: out.existing || {} }`.

**Isolation:** the write always targets `req.profile` (the session's profile).
The handler never reads a profile id from the request — a cross-profile write is
structurally impossible.

### UI (in the Step 2 shell)

- Search view: debounced input (≥300 ms), min 2 chars, type toggle
  (Movies/Shows). Results as poster cards; tapping one opens a detail sheet with
  the larger poster + full synopsis + an **"Add to watchlist"** button.
- Button states: idle → loading → "Added ✓" (or "Already on watchlist"); Simkl-
  not-connected → a clear "Connect Simkl in the portal first" message.

### Implementation checklist

- [ ] `src/services/simkl.js` — add `buildAddToListBody` (pure) + `addToPlanToWatch`; export both.
- [ ] `mobile/server/handlers.js` — `searchHandler`, `watchlistHandler`, pure `toTitleDTO`.
- [ ] `mobile/server/router.js` — wire `GET /search`, `POST /watchlist` behind `requireSession` (+ optional `GET /title/:type/:imdbId` via `tmdb.fullMeta`).
- [ ] SPA search view + detail sheet + add button.

---

## Unit tests (`mobile/test/mobile.smoke.js`)

Pure/offline. TMDB and Simkl are injected/mocked; no real network.

1. **`simkl: buildAddToListBody routes movies vs shows, sets plantowatch`** — a
   mixed list yields `{movies:[…], shows:[…]}`, each entry `to:'plantowatch'`,
   series → `shows`, movie → `movies`.
2. **`simkl: buildAddToListBody id preference + skips id-less items`** — includes
   `ids.imdb` and/or `ids.tmdb` (tmdb stringified); an item with neither id is
   dropped; `[]` in → empty movies/shows.
3. **`simkl: addToPlanToWatch throws when not connected`** — profile with no
   `simkl_auth` → throws "not connected" (no fetch attempted).
4. **`simkl: addToPlanToWatch short-circuits an empty body`** — all-id-less input
   → `{skipped:true}`, transport never called.
5. **`simkl: addToPlanToWatch paces on simkl_post`** — with a spy governor,
   assert the POST is scheduled on the `'simkl_post'` service (the <1/s write cap).
6. **`search: toTitleDTO maps meta → DTO, drops nulls, no mutation`** — a fake
   `searchTitles` meta maps to `{id,type,title,year,poster,synopsis,rating}`; a
   meta with null poster/description omits/*empties* them; the input object is
   unchanged (`Object.freeze` the fixture to prove no mutation).
7. **`search: query validation`** — `q` empty or 1 char → `400`; `type` not in
   `{movie,series}` → coerced to `movie`; `limit` clamped to the max.
8. **`search: no TMDB key → 503`** — settings without a TMDB key → handler returns
   the "not configured" error, no fetch.
9. **`watchlist: validation`** — missing `type` or both ids → `400`; Simkl not
   connected → `400` with the connect message.

## Regression tests

1. **`regression: tmdb.searchTitles / metaByTmdbId unchanged`** — the existing
   TMDB unit assertions ([test/smoke.js](../../test/smoke.js) `tmdb:` cases) still
   pass; Step 3 only *reads* the service. Assert `toTitleDTO` does not mutate the
   service's meta (search is reused by the addon's live search catalogs too).
2. **`regression: existing Simkl functions intact`** — `parseWatchedItems`,
   `getPlanToWatch`, `addToHistory` behave exactly as before (re-run the existing
   `simkl: parseWatchedItems` case); adding two new exports doesn't shadow them.
3. **`regression: simkl_post cap still honoured`** — the new write goes through
   `governor.schedule('simkl_post', …)` like `addToHistory`, so the 1-POST/s cap
   that protects the client_id from suspension still holds for all Simkl writes.
4. **`regression: watchlist write is profile-scoped`** — a body carrying a
   `profile_id` for a *different* profile is ignored; the write targets the
   session's profile (assert with two seeded profiles + one session).
5. **`regression: read-your-own — Watch Later catalog still sources plantowatch`** —
   the addon's Watch Later catalog (`source:'simkl_plantowatch'`,
   [test/smoke.js](../../test/smoke.js) `catalogs:` case) is unaffected; a title
   added via the phone would appear there on the next sync (same list, one source
   of truth).

## Acceptance criteria

- Typing a title returns poster + synopsis results within a moment; tapping shows
  the full synopsis.
- "Add to watchlist" puts the title on **that profile's** Simkl plan-to-watch and
  reflects added/already-present; it shows up in the profile's Watch Later.
- A user with a valid session for profile A cannot add to profile B's watchlist.

## Risks / notes

- **Simkl `/sync/add-to-list` body shape:** verify the exact payload against the
  live API before shipping (the read side was verified against James's account on
  2026-08-18; the write side should get the same treatment). `buildAddToListBody`
  isolates the shape so a correction is a one-function change with its unit test.
- **Search cost:** `searchTitles` does 1 + N detail calls; keep the limit ≤ 12
  and debounce client-side so a fast typist doesn't spray TMDB (the governor also
  paces it).
