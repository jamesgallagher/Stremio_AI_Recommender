# MW-05 — Cluster review + integration suite (mark-watched / not-interested)

**Layer:** test + pre-release review · **Depends on:** [MW-00](mark-watched-core.md),
[MW-01](mark-watched-recs.md), [MW-02](mark-watched-catalog.md),
[MW-03](not-interested-all-catalogs.md), [MW-04](remove-from-watchlist.md) (reviews
and integration-tests all five as one feature) · **Behavioral change for users:**
none — this card only reviews the cluster and adds tests; any behaviour fix it turns
up is applied in the **owning** card.

> The same closing move the other clusters made: the catalog-preview cluster shipped
> `test/integration.js` sections **G–I** ([`test/integration.js:269-395`](../test/integration.js))
> and the engine-abstraction cluster had a pre-release review that fixed an age-gate
> seam (I1) before promotion. This card does both for MW: a full cross-card read for
> seams/contradictions, then an end-to-end suite (sections **J–N**) driven through the
> **real** modules with no network — mirroring the existing harness (`it()`,
> `fakeRes()`, offline anime map, seeded caches).

---

## Why this card exists

Five cards touch one flow from three directions — a Simkl write, a local suppression
table, and a shared serve seam that feeds both Nuvio and two preview surfaces. Unit
tests in each card prove the pieces; they don't prove the pieces **compose**: that a
watched mark actually leaves the AI list but is *kept* in Watch Later, that "not
interested" reaches Christmas but *not* Watch Later, that the Watch Later ✕ writes a
Simkl removal and *not* a suppression. Those are cross-card invariants, and they're
exactly where a cluster breaks. This card is the gate that holds them.

---

## Review findings (read pass, 2026-09-09)

Severity: **must-fix** before build · **verify** at build against the live Simkl API ·
**doc** consistency. Each finding names the card that owns the fix.

### I1 — `dont_recommend` is tmdb-keyed, so "imdb-only suppression" can't insert (must-fix, MW-03)
MW-03 promises a curated title with **no resolvable tmdb** is still suppressed by imdb.
But `addDontRecommend` writes `(profile_id, type, tmdb_id, …)` keyed by tmdb, and
`dontRecommend.suppress` already returns `{ok:false, reason:'unresolved'}` when it
can't resolve a tmdb ([`dontRecommend.js:69-70`](../src/dontRecommend.js)) — so there
is nothing to hang an imdb-only row on. **Resolution:** scope it honestly — suppression
still *requires* a resolvable tmdb (TMDB key is normally configured, and `resolveTmdbId`
does a find-by-imdb), and MW-03 adds `imdb_id` to the row **only as the serve-time
match key**, not as an alternate identity. Drop MW-03's "no-tmdb still filters" claim
(a title with neither id genuinely can't be actioned). If imdb-only suppression is
ever wanted, it's a schema change (key on `COALESCE`), a separate card. *Applied: MW-03
acceptance/test wording corrected to require a resolvable tmdb.*

### I2 — whole-show watched via `/sync/history` is unverified (verify, MW-00)
MW-00 sends a **series** as `shows:[{ids:{imdb}}]` with no `seasons`, assuming Simkl
marks the entire show watched. Every existing history write goes per-episode
([`scrobble.computeDelta`](../src/services/scrobble.js)), so this shape is untested in
our code. **Resolution:** verify against the live API before build (like the existing
"verified live" calls, [`simkl.js:93-97`](../src/services/simkl.js)); if Simkl needs
episodes, MW-00's series path must fetch the show's aired episodes (or use the
show-level endpoint Simkl documents). Do not ship the assumption unchecked.

### I3 — Simkl plan-to-watch **remove** endpoint is unverified (verify, MW-04)
Already flagged inside MW-04 — elevated here as a cluster gate: `removeFromPlanToWatch`
has no confirmed endpoint (only `addToPlanToWatch` via `/sync/add-to-list` exists). The
suite stubs it, so tests pass regardless; **a build task must confirm the real path**
or the feature silently no-ops in production.

### I4 — pending-watched must be cleared by supersession, never a timer (must-fix, MW-00)
MW-00 says the pending-watched shim is "optionally cleared once the real row lands." If
it's cleared on a timer instead, a title reappears in the window before the Simkl sync
pulls the real watched row. **Resolution:** the pending entry is removed **only** when a
real `watched` row with the same imdb exists (or on profile reset) — so the union in
`watchedIdSets` is continuous. Pin this with test **J**. *Applied: MW-00 §3
clear-condition tightened (supersede-only, never a timer).*

### I5 — "if portal in scope" conditionals are stale (doc, MW-02/MW-04)
The portal-scope question was resolved to **both surfaces** ([MW-02] Resolved
decisions), but MW-02 and MW-04 still carry "(if the portal preview is in scope)"
hedges for the portal `/watched` and `/watchlist/remove` endpoints. **Resolution:**
de-conditionalise — both portal endpoints are in scope. *Applied to MW-02/MW-04.*

### I6 — preview payloads don't carry `source` yet (must-fix, MW-02)
The whole ✕/eye branch keys on `data.source === 'simkl_plantowatch'`, but neither
preview endpoint forwards `source` today ([`handlers.js:234-249`](../mobile/server/handlers.js)).
Already a task in MW-02; the suite's section **N** asserts it, so the branch can't be
built against a field that isn't there. No age leak (source is already in the settings
DTO).

### I7 — no reject/undo for a Watch Later removal is by design, but the ✕ is destructive-looking (doc/UX, MW-02/MW-04)
Removing from Watch Later has no in-app undo (re-add is the ＋ button). That's fine, but
the ✕ glyph reads like the same destructive control as "not interested". **Resolution
(minor):** rely on the distinct helper text ("Remove from Watch Later" vs "Not
interested") already specified; no code change. Noted so it isn't mistaken for a bug.

**Net:** two must-fix doc/correctness items (I1, I4) and one payload wiring (I6) land in
their owning cards; two verifications (I2, I3) are build-time gates; I5 is applied; I7
is acknowledged. Nothing blocks the cluster's shape — the seams are sound.

---

## Integration suite — sections J–N (append to `test/integration.js`)

Same doctrine as G–I: real modules, **no network**. Stub the two Simkl writes
(`simkl.addToHistory`, `simkl.removeFromPlanToWatch`) with capture spies; seed the pool
/ extras cache / watched store exactly as G–I do; drive companion handlers with
`fakeRes()`.

- **J. Watched removes from AI + curated, KEEPS in Watch Later (MW-00 × WL-KW × MW-03).**
  Seed a title into the AI pool, a curated extra, and the Watch Later plan-to-watch
  list. `markWatched` it (spy captures the `/sync/history` body → assert **no
  `watched_at`**, movie shape). Assert: gone from `servedCatalog('ai-recs-movies')` and
  the curated extra (pending-watched union), **present** in
  `servedCatalog('trakt-watchlist-movies')`. Then insert the "real" synced watched row
  and assert the pending shim is superseded, not duplicated (I4).
- **K. Series whole-show body shape (MW-00, I2 guard).** `markWatched` a series;
  assert the captured body is `shows:[{ids:{imdb}}]` with **no `seasons`** and no
  `watched_at`. (Documents the contract the live-API verification must satisfy.)
- **L. Not interested: Christmas filtered, Watch Later exempt (MW-03, the source key).**
  Suppress a title that appears in **both** the Christmas extra and the Watch Later
  list. Assert absent from `servedCatalog('mdb-christmas-movies')` and the AI list,
  **present** in `servedCatalog('trakt-watchlist-movies')` — proving the exemption is
  keyed on `source`, not `dedupe_watched` (both are `dedupe_watched:false`).
- **M. Watch Later ✕ writes a removal, not a suppression (MW-04).** Call
  `removeFromPlanToWatch` (spy captures the Simkl call); assert **nothing** was written
  to `dont_recommend` and the title is still returned by a subsequent AI serve.
- **N. Preview payload carries `source`; age invariant intact (MW-02 × CP-02).** The
  companion preview handler over a Watch Later catalog returns
  `source:'simkl_plantowatch'` and **no age field**; over a kids profile an over-band
  extra is still 404 with no age reason (regression of I from the CP cluster).

Plus **mobile smoke** ([`mobile/test/mobile.smoke.js`](../mobile/test/mobile.smoke.js))
route coverage for the new endpoints — `POST /api/watched` and `POST /api/watchlist/remove`:
401 (no session), 400 (no Simkl), 200 (stubbed happy), 502 (Simkl throws).

---

## Tasks

- [x] Apply the must-fix findings in their owning cards: **I1** (MW-03 wording),
      **I4** (MW-00 pending-watched lifecycle — `clearSupersededPending`, supersede-only),
      **I5** (de-conditionalise MW-02/MW-04), confirm **I6** task present in MW-02
      (`catalogPreviewHandler` forwards `source`). Landed in the MW-00/03/04 and
      MW-01/02 commits; verified here.
- [x] Record the build-time verifications **I2** (whole-show history) and **I3**
      (Simkl remove endpoint) as explicit checklist items on MW-00 / MW-04
      (`mark-watched-core.md` build note; `remove-from-watchlist.md` I3 gate).
- [x] `test/integration.js`: sections **J–N** added with a Simkl-write capture spy,
      continuing the lettered harness after I.
- [x] `mobile/test/mobile.smoke.js`: route tests for `/api/watched` and
      `/api/watchlist/remove` — now cover 401 / 400 / **200 (stubbed happy)** /
      **502 (Simkl throws)** for both.
- [x] `npm test` green (smoke + integration + mobile) on `v7`.

> **Build note (v7, 2026-09-09):** built on `v7`, local commit only. The review's
> must-fix items (I1/I4/I6) and I5 were already applied in the owning-card commits;
> this card verifies them and adds the cross-card gate — integration **J–N** and the
> two connected-route smoke cases — all green. The two live-API gates stay open until
> a real Simkl account run: **I2** (whole-show `/sync/history` write — J/K pin the
> body shape only) and **I3** (`/sync/history/remove` for a plan-to-watch-only title).

## Acceptance criteria

- **J–N pass through real modules** with no network, and each pins a *cross-card*
  invariant (watched-keeps-in-WL, source-keyed exemption, remove-≠-suppress,
  source-in-payload, age invariant) — not a single card's unit behaviour.
- Every must-fix finding (I1, I4, I6) is resolved in its owning card and has a test
  that would fail if it regressed.
- Build-time verifications (I2, I3) are captured as checklist items so they can't be
  silently skipped; the suite documents the exact contract each must satisfy.
- `npm test` is green; the new sections follow the existing `it()`/`fakeRes()` style
  and clean up their per-test state (as G–I do).

## Test notes

- Reuse G–I's setup helpers (offline anime map, seeded IMDb-rating cache, profile
  fixtures). The only new machinery is the two Simkl-write spies — a capture that
  records the body and returns `{}` (Simkl's de-dupe-safe success), so no network and
  the body shape is assertable (J/K).
- Keep the port distinct if any section stands up the mobile app; otherwise drive
  handlers directly with `fakeRes()` as G–I do.
- Assert **absence** as carefully as presence — several findings are "the title must
  be GONE from X but PRESENT in Watch Later"; test both sides.

## Out of scope

- Implementing the features — owned by MW-00..04; this card reviews and tests them.
- New behaviour beyond the five cards.
- Live-API calls in tests — the whole-show (I2) and remove-endpoint (I3) verifications
  are manual/build-time against the real Simkl API, not part of the offline suite.
