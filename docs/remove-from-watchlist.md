# MW-04 — Remove from Watch Later (Simkl plan-to-watch removal)

**Layer:** backend — new Simkl client method + endpoint(s) · **Depends on:**
`simkl.addToPlanToWatch` (the add counterpart, exists), the Watch Later catalog
(`source:'simkl_plantowatch'`) · **Used by:** [MW-02](mark-watched-catalog.md) (the
✕ on a Watch Later preview cell) · **Behavioral change for users:** the ✕ on a
**Watch Later** title now **removes it from the Simkl plan-to-watch list** — plain
list management, NOT a "not interested" suppression.

> James's call (2026-09-09): *"On Watch Later… remove from watchlist does not mean
> suppress this forever. It just needs to call Simkl and remove the item from Watch
> Later."* Read the add path this mirrors:
> [`simkl.addToPlanToWatch` / `buildAddToListBody`](../src/services/simkl.js)
> ([`simkl.js:211-245`](../src/services/simkl.js), POST `/sync/add-to-list`,
> `to:'plantowatch'`), the companion add handler
> [`watchlistHandler`](../mobile/server/handlers.js) at
> [`handlers.js:69-85`](../mobile/server/handlers.js), and the Watch Later serve/build
> ([`catalogServe.js:72-90`](../src/catalogServe.js), `buildWatchlistCatalog`).

---

## Why this card exists

The ✕ has **two different meanings** depending on the list, and this card owns the
Watch Later one:

- On **Watch Later** (`simkl_plantowatch`) the list is the user's own Simkl
  plan-to-watch. Taking a title off it is ordinary curation — "not now", "changed my
  mind", "grabbed it elsewhere" — and must **not** suppress the title from
  recommendations. It should just be removed from the Simkl list (and thus from the
  row).
- On **every other list** the ✕ means *not interested* = suppress
  ([MW-03](not-interested-all-catalogs.md)).

Those are opposite intents (one is reversible list-editing, the other a permanent
"don't recommend"), so the Watch Later ✕ gets its own action rather than overloading
suppress. It's the exact inverse of the existing "＋ Add to Watch Later"
(`addToPlanToWatch`), which strengthens the case for a dedicated, symmetric method.

---

## Context primer (current state)

- **Add exists, remove does not.** `simkl.addToPlanToWatch(profile, items)` POSTs
  `/sync/add-to-list` with `to:'plantowatch'` ([`simkl.js:233-245`](../src/services/simkl.js)),
  built by the pure `buildAddToListBody` ([`simkl.js:216-228`](../src/services/simkl.js)).
  There is **no** removal method on the client.
- **Simkl removal endpoint — VERIFY before building.** The Simkl write endpoints in
  use are `/sync/add-to-list` (add) and `/sync/history` (watched). The exact endpoint
  to **remove** an item from a user's list must be confirmed against the live Simkl
  API — likely `POST /sync/history/remove` (for the completed list) is *not* it; the
  plan-to-watch removal is a distinct call. Treat the endpoint as unverified until
  checked against the docs/live API, the same way the existing client calls were
  ("Verified live against the real API", [`simkl.js:93-97`](../src/services/simkl.js)).
  Do not ship a guessed path.
- **Watch Later build** — `buildWatchlistCatalog` reads `getPlanToWatch`
  ([`simkl.js:201-209`](../src/services/simkl.js)) and caches metas; the daily refresh
  rebuilds from the (now shorter) Simkl list. So a Simkl removal self-heals the row on
  the next rebuild; see §3 for immediate reflection.
- **Rate cap:** Simkl writes are governed at 1 POST/s
  ([`governor`](../src/services/governor.js)) — the removal uses the same
  `simkl_post` lane.

---

## Goal

1. A Simkl client method `removeFromPlanToWatch(profile, item)` — the inverse of
   `addToPlanToWatch`, same id-matching, same rate lane, **verified endpoint**.
2. Endpoint(s) for the UI: companion `POST /api/watchlist/remove` (session-scoped)
   and portal `POST /api/profiles/:id/watchlist/remove` — both surfaces are in scope
   ([MW-02](mark-watched-catalog.md) Resolved decisions).
3. **No suppression.** This path writes nothing to `dont_recommend`; a removed title
   can still appear in AI recs and other catalogs (that's the point).
4. The title leaves the **Watch Later** row promptly (§3).

---

## Design

### 1. Simkl client — `removeFromPlanToWatch`

Mirror `addToPlanToWatch` ([`simkl.js:233-245`](../src/services/simkl.js)): reuse the
`{ ids:{ imdb?, tmdb? } }` matching (a pure `buildRemoveFromListBody`, or reuse
`buildAddToListBody`'s id logic), post to the **verified** Simkl removal endpoint on
the `simkl_post` lane, map 401/403 → "token rejected — reconnect", de-dupe-safe
(removing something already gone is a no-op). Export the pure builder for tests.

### 2. Endpoint(s)

```
POST /api/watchlist/remove   { type, imdb_id?, tmdb_id?, title? }   (companion, session-scoped)
-> 200 { ok:true }
-> 400 bad-type / no-id / Simkl not connected      (copy matches watchlistHandler)
-> 502 { error: 'Could not remove from Watch Later — <msg>' }
```

Handler mirrors `watchlistHandler` ([`handlers.js:69-85`](../mobile/server/handlers.js))
but calls `simkl.removeFromPlanToWatch`. Portal variant under
`/profiles/:id/watchlist/remove` (both surfaces in scope).

### 3. Immediate reflection in the Watch Later row

The Simkl removal is authoritative; the cached Watch Later metas still hold the title
until the daily rebuild. James is fine with that (*"refresh will likely clean up
regardless"*), and the UI drops the cell optimistically. For crisper behaviour,
optionally prune the id from the cached extras entry now —
`store.loadCache(profile.id).extras['trakt-watchlist-…'].metas` filtered and written
back (a targeted version of [`store.pruneWatched`](../src/store.js)) — so a server
re-fetch before the rebuild also reflects it. **Optional**, not required for
correctness.

### 4. Explicitly NOT suppression

`removeFromPlanToWatch` must not touch `dont_recommend`. A title removed from Watch
Later is not "not interested" — it can still be recommended, and re-adding it to
Watch Later later is the user's prerogative (and, per
[MW-03](not-interested-all-catalogs.md), re-adding supersedes any prior watched /
not-interested state for the Watch Later row).

---

## Tasks

- [x] **Verify** the Simkl plan-to-watch removal endpoint against the live API / docs
      (do not guess). Record it in a `simkl.js` comment like the other verified calls.
      → Verified against the Simkl API spec (github.com/SIMKL/API `apiary.apib`
      § *"Remove Items from History and from Lists"*): **`POST /sync/history/remove`**
      with no `seasons` removes the whole title from history AND lists (plan-to-watch
      included). Recorded in the `simkl.js` comment. **I3 live-API gate CLOSED
      (2026-09-09):** verified live against Simkl account "James" via
      [`test/verify-simkl-live.js`](../test/verify-simkl-live.js) `--confirm` — a seeded
      plan-to-watch title was gone after the remove. PASS.
- [x] `simkl.js`: `buildRemoveFromListBody` (pure, exported) + `removeFromPlanToWatch`
      (rate-lane, token handling, de-dupe-safe).
- [x] `mobile/server`: `POST /api/watchlist/remove` handler + route (session-scoped).
- [x] `POST /api/profiles/:id/watchlist/remove` (portal — in scope).
- [ ] (Optional) immediate cached-metas prune for the Watch Later extra. — deferred
      (optional; the daily rebuild + optimistic UI cover it, per §3).
- [x] Tests — see Test notes.

> **Build note (v7, 2026-09-09):** built on `v7`. I3 live-API gate **verified +
> closed** (2026-09-09) — see the Tasks note above.

## Acceptance criteria

- The ✕ on a **Watch Later** title calls `removeFromPlanToWatch` and the title leaves
  the row; it is **not** added to `dont_recommend` (still eligible for AI recs / other
  catalogs).
- **Only** the two `simkl_plantowatch` rows use this action; every other list's ✕ is
  suppression ([MW-03](not-interested-all-catalogs.md)) — the UI branch lives in
  [MW-02](mark-watched-catalog.md).
- Simkl-not-connected returns 400 with the same guidance as the watchlist add.
- Removing a title already off the list is harmless (idempotent).

## Test notes

- Pure builder: movie vs series id matching, imdb-only / tmdb-only / neither.
- `removeFromPlanToWatch`: stub fetch, assert the verified endpoint + body + rate lane;
  401 → reconnect error.
- Handler/route in the mobile smoke suite: 401 no session, 400 no Simkl, 200 happy
  (stubbed), 502 on Simkl error.
- Regression: assert the removal writes **nothing** to `dont_recommend` (the title is
  still returned by a subsequent AI serve).

## Out of scope

- The catalog-preview UI branch that decides "this is a Watch Later cell, use remove
  not suppress" — [MW-02](mark-watched-catalog.md).
- Suppression / not-interested — [MW-03](not-interested-all-catalogs.md).
- Re-add / undo of a removal — the existing ＋ "Add to Watch Later" already re-adds.
