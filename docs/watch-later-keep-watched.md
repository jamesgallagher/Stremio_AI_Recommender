# WL-KW — Watch Later keeps watched titles (reverse watched-pruning)

**Layer:** backend/config (catalog registry + build/serve) · **Depends on:** the
existing `dedupe_watched` opt-out (Christmas, SC/v6) · **Blocks:** nothing
· **Behavioral change for users:** yes — the two **Watch Later** rows (movies +
series) stop hiding titles you've already watched. Every other catalog is
unchanged.

> Read `src/catalogs.js` (registry), `src/rebuild.js` `buildWatchlistCatalog`
> (the Watch-Later build), and `src/addon.js` catalog serve path. Watch Later is
> the only extra whose **build** prunes watched titles; every other watched-prune
> in the app is serve-time and already honours the `dedupe_watched:false` flag.
> This card makes Watch Later honour that same flag and turns it on.

---

## Why this card exists

Watch Later mirrors the profile's **Simkl plan-to-watch** list — a list the user
curated by hand. Today the addon strips any entry that also appears in the
watched store, on the theory that "watched" means "no longer to-watch." That was
a deliberate call originally, but it's the wrong default here: **if the user
explicitly added a title to their list, automation shouldn't quietly remove it.**
A re-watch, a film seen years ago and queued again, or a partially-watched show
still on the plan-to-watch list all vanish from the row with no way to keep them.

The fix reuses the mechanism Christmas already uses (`dedupe_watched:false`) —
"this list keeps watched titles on purpose" — but Watch Later currently prunes in
a second place the flag doesn't reach.

---

## Context primer (current state)

Watch Later prunes watched titles in **three** places; only the third honours the
existing flag:

1. **Build, pre-enrich skip** — [`src/rebuild.js:276`](../src/rebuild.js) in
   `buildWatchlistCatalog`: `if (it.imdb_id && watched.imdb.has(it.imdb_id)) return null;`
2. **Build, post-filter** — [`src/rebuild.js:287`](../src/rebuild.js):
   `return metas.filter((m) => m && !watched.imdb.has(m.id));`
3. **Serve-time** — [`src/addon.js:385`](../src/addon.js): guarded by
   `if (extraDef.dedupe_watched !== false)`, so it **already** respects the flag.

The `dedupe_watched:false` opt-out is a solved pattern:
- Set on Christmas: [`src/catalogs.js:37`](../src/catalogs.js).
- Honoured at serve time ([`addon.js:385`](../src/addon.js)) — but **NOT** in the
  Watch-Later build branch (1 and 2 above are unconditional).
- Surfaced read-only in the portal catalog DTO ([`src/portal.js:164-166`](../src/portal.js))
  and the Companion, which renders a **"keeps watched"** badge
  ([`mobile/public/app.js:479`](../mobile/public/app.js),
  [`mobile/server/handlers.js:203`](../mobile/server/handlers.js)).

Untouched by this card:
- **Manifest drop of an empty Watch Later** ([`addon.js:55-58`](../src/addon.js)) —
  keeping watched titles can only make the row *less* empty; no change.
- **`store.pruneWatched`** ([`store.js:97`](../src/store.js)) is the AI-catalog
  promote-on-watch path (`cache[type]`), not extras — it never touches Watch Later.
- Curated genre lists, Popular, AI recommendations — all keep their current
  watched behaviour.

---

## Goal

1. The two Watch Later rows (`trakt-watchlist-movies`, `trakt-watchlist-series`)
   **retain** titles the user has watched, for as long as they remain on the
   Simkl plan-to-watch list.
2. Do it through the **existing `dedupe_watched:false` flag** — no new flag, no
   per-profile toggle. It's a fixed property of the Watch Later catalog, exactly
   like Christmas.
3. Make the Watch-Later **build** honour that flag (serve-time already does).

---

## Design

### 1. Registry — flag both Watch Later defs

[`src/catalogs.js:19-20`](../src/catalogs.js):

```js
{ id: 'trakt-watchlist-movies', type: 'movie',  name: 'Watch Later', source: 'simkl_plantowatch', default_on: true, dedupe_watched: false },
{ id: 'trakt-watchlist-series', type: 'series', name: 'Watch Later', source: 'simkl_plantowatch', default_on: true, dedupe_watched: false },
```

Update the file header comment (the `simkl_plantowatch` bullet currently says
"watched titles ARE pruned") to record the reversal and the reason.

### 2. Build — honour the flag in `buildWatchlistCatalog`

[`src/rebuild.js:264-288`](../src/rebuild.js). Gate the two prune points on the
def so `dedupe_watched:false` keeps watched titles, while a future watchlist-style
catalog without the flag still prunes:

```js
async function buildWatchlistCatalog(profile, def, log = console) {
  ...
  const keepWatched = def.dedupe_watched === false;
  const watched = watchedStore.watchedIdSets(profile.id);
  ...
  metas.push(...await Promise.all(chunk.map(async (it) => {
    if (!keepWatched && it.imdb_id && watched.imdb.has(it.imdb_id)) return null;   // (was line 276)
    ...
  })));
  ...
  return keepWatched
    ? metas.filter(Boolean)
    : metas.filter((m) => m && !watched.imdb.has(m.id));                            // (was line 287)
}
```

`watchedIdSets` can stay (cheap; still needed when the flag is absent). Order is
otherwise preserved — Watch Later stays in the user's own Simkl order, unshuffled.

### 3. Serve — no change

[`addon.js:385`](../src/addon.js) already skips pruning when
`dedupe_watched !== false`. With the def flagged, the served list is no longer
filtered against the watched store. The Companion/portal "keeps watched" badge now
also shows on Watch Later — accurate and desirable.

---

## Open question (needs James's call)

**This reverses *our* pruning, not Simkl's list management.** The row is a mirror
of the Simkl plan-to-watch list. If Simkl itself drops a title from plan-to-watch
when you mark it watched, `getPlanToWatch` won't return it and it can't reappear —
that's Simkl's list, not our automation. So the guarantee this card delivers is
precise: **a watched title stays in Watch Later as long as it remains on the Simkl
plan-to-watch list.** If the desired behaviour is "keep it even after Simkl has
moved it to Completed," that's a bigger change (locally persisting the user's adds
independent of Simkl status) and a separate card — flagging so we don't silently
under-deliver on "if I added it, don't remove it."

---

## Tasks

- [ ] `catalogs.js`: add `dedupe_watched:false` to both Watch Later defs; update
      the header-comment bullet to reflect "watched titles are KEPT."
- [ ] `rebuild.js` `buildWatchlistCatalog`: gate both watched-prune points on
      `def.dedupe_watched === false`.
- [ ] Confirm serve-time ([`addon.js:385`](../src/addon.js)) needs no change.
- [ ] Tests (below).

## Acceptance criteria

- **Adult profile, movie + series:** a title on the Simkl plan-to-watch list that
  is ALSO in the watched store is **present** in the Watch Later row (both build
  and serve). Previously it was removed.
- **Order preserved:** Watch Later still serves in Simkl plan-to-watch order, no
  shuffle, capped at 100 (`WATCHLIST_CAP`).
- **Scope is tight:** curated genre lists, Popular, and AI recommendations still
  prune watched exactly as before. Christmas still keeps watched (unchanged).
- **UI reflects it:** portal DTO and Companion show `dedupe_watched:false` /
  "keeps watched" for Watch Later.
- **Empty state unchanged:** an empty Watch Later is still dropped from the
  manifest and answers `[]` (not a warming card).

## Test notes

- **Invert the existing assertion.** [`test/smoke.js:1965-1975`](../test/smoke.js)
  currently swaps a watched "Seen Pick" into Watch Later and asserts it's pruned
  (`['tt0068646']`). After this card it must assert **both** ids survive
  (`['tt0111161','tt0068646']`), and the comment/log line flip from "prunes
  watched" to "keeps watched." (Mirror the Christmas exemption note at
  [`smoke.js:2004`](../test/smoke.js).)
- Add a **build-path** case: stub `simkl.getPlanToWatch` to return a title that is
  in the watched store; assert `buildWatchlistCatalog` (or a rebuild → `swapExtra`)
  retains it. This is the gap serve-time tests miss today.
- Registry test: both Watch Later defs report `dedupe_watched:false`
  (the `EXTRA_CATALOGS` shape test near [`smoke.js:70`](../test/smoke.js)).

## Out of scope

- Any per-profile toggle for keep/prune on Watch Later — it's a fixed property.
- Persisting user adds independently of Simkl status (see Open question) — separate
  card if wanted.
- Watched behaviour of any other catalog.
