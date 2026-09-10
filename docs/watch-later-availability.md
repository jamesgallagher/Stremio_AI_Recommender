# WL-AV — Watch Later suppresses not-yet-streamable titles (until they're available)

**Layer:** backend — Watch Later build enrichment (`src/rebuild.js`
`buildWatchlistCatalog`) + a small TMDB availability helper (`src/services/tmdb.js`)
· **Depends on:** the existing per-item TMDB enrichment already made for every Watch
Later title (`tmdb.metaByTmdbId`) · **Blocks:** nothing · **Behavioral change for
users:** yes — the two **Watch Later** rows stop *showing* titles that aren't
digitally available to stream yet (a film still in its theatrical/pre-digital window,
a show that hasn't started airing). The title **stays on the list** and **reappears
by itself** once it's available. Every other catalog is unchanged.

> Read `src/rebuild.js` `buildWatchlistCatalog` (the Watch-Later build, where each
> plan-to-watch item is already enriched with one TMDB details call),
> `src/services/tmdb.js` `metaByTmdbId` / `fullMeta` / `pickCertification` (TMDB
> enrichment; `fullMeta` and `pickCertification` already read the `release_dates`
> block this card needs), and `src/services/simkl.js` `getPlanToWatch` (the Simkl
> read that backs the row — **never written to by this card**). Serve path is
> `catalogServe.servedCatalog` — **no change** (see §5).

---

## The one invariant that governs everything: suppress, never remove

**This is a display suppression, not a list change.** (James, emphatic.) The title
is **never** removed from the Simkl plan-to-watch list, and nothing is written to
Simkl. We simply omit it from the *built* row while it isn't streamable. Because the
Watch Later row is rebuilt from the live Simkl list on every rebuild, a suppressed
title **reappears automatically** the first rebuild after it becomes available — no
user action, no re-add, no Simkl call. This is an emergent property of build-time
filtering + the daily rebuild, not extra machinery.

Contrast, so there's no confusion with the neighbouring cards:

| | Writes to Simkl? | Reversible automatically? |
|---|---|---|
| **WL-AV** (this card) — availability suppression | **No** | **Yes** — reappears when available |
| [MW-04](remove-from-watchlist.md) — "Remove from Watch Later" (the ✕) | Yes (`removeFromPlanToWatch`) | No — user must re-add |
| [WL-KW](watch-later-keep-watched.md) — keep watched titles | No | n/a (keeps, doesn't hide) |

A user who queued an upcoming film "on hype" keeps it — they just don't see an
unwatchable entry cluttering the row until it lands.

---

## Why this card exists

Watch Later mirrors the profile's **Simkl plan-to-watch** list. For an app whose
whole point is "here's what I can watch now," a not-yet-streamable title is noise: it
can't be played, so it just pushes the watchable ones down. This card suppresses
those until they're actually available to stream.

**Sourcing note (settled — recorded so the build doesn't re-litigate it).** The
original request assumed *"Simkl has filters that suppress titles without a digital
release."* It doesn't, in the shape needed: `getPlanToWatch` calls
`/sync/all-items/.../plantowatch` ([`simkl.js:201`](../src/services/simkl.js)), and
per Simkl's own guide `extended=full` there adds only `runtime` — no release/status
field — and even Simkl's `status` (`released`/`upcoming`) means *theatrical/aired*,
not *streamable*. The true "available to stream at home" signal is **TMDB
`release_dates`**, which tags each release with a **type** (`1` Premiere, `2`/`3`
Theatrical, `4` **Digital**, `5` Physical, `6` TV). We already make a TMDB details
call for **every** Watch Later item ([`rebuild.js:284`](../src/rebuild.js)), so this
is one appended field at build — no new dependency, no extra round-trip, no Simkl
unknown.

---

## Decisions locked in by James (2026-09-10)

1. **"Available" = available digitally to stream.** Usually after the
   DVD/Blu-ray/streaming-site release, *but not always* — so the primary signal is a
   past **Digital** release (TMDB type `4`), with **Physical** (`5`) and **TV** (`6`)
   also counting as "it's out at home" (see §3 for why, and the one-line way to
   tighten to Digital-only).
2. **Applies to both TV and Movies.** Movies use `release_dates`; series use
   "has it started airing" (`first_air_date` in the past) — TMDB has no per-series
   digital-release concept, so airing is the availability signal for series.
2a. **Region-agnostic.** A home release in **any country** counts as available — do
   **not** make digital availability AU-specific. (James, 2026-09-10.) "Available
   somewhere" is findable; this also leans fail-open, matching §3.
3. **Soft gate (fail open on missing data).** If we can't determine availability —
   TMDB can't resolve the title, or it has no usable release rows — **show** it.
   *"Worst case the user tries to watch it and it isn't there."* The filter is a
   **soft gate**: it only ever hides a title we can positively see isn't out yet, and
   never assumes; anything undeterminable falls through and displays. (See §3a.)
   Note the deliberate consequence: a title with only a theatrical date and no home
   release stays suppressed (not "assumed out") until TMDB logs the digital date —
   which, per James, it will; the soft gate is the backstop for the genuinely
   metadata-less, not a timer.
4. **Freshness via the daily rebuild.** Availability changes over time (a theatrical/
   pre-release item goes digital later), so it must be re-evaluated on the daily
   rebuild — see §4.
5. **Only re-check *non-released* titles.** (James, 2026-09-10.) "Released" is a
   one-way, terminal state — a title that's out can't become un-released — so
   re-running the availability check on it every rebuild is wasted compute and a
   wasted (heavier) TMDB call. Once a title is confirmed `AVAILABLE` we **memoize
   that fact and never check it again**; only `NOT_YET`/`UNKNOWN` titles are
   re-checked. This is safe *because* the state is monotonic, and it's the key that
   makes freshness (§4) cheap. See §4a.
6. **Always-on.** (James, 2026-09-10.) A fixed property of both Watch Later rows — no
   per-profile toggle, no `hide_unreleased` flag, no portal control. Safe as a default
   precisely because suppression is temporary and self-reversing (§"suppress, never
   remove").

---

## Context primer (current state)

- **Build.** `buildWatchlistCatalog` ([`rebuild.js:264-317`](../src/rebuild.js))
  pulls the plan-to-watch list, then enriches each item in chunks of 25 via
  `tmdb.metaByTmdbId(...)` ([`rebuild.js:284`](../src/rebuild.js)), returning `null`
  to drop an item (already the pattern for the watched-prune at
  [`rebuild.js:282`](../src/rebuild.js)). This is the natural — and only — place the
  availability gate belongs: the TMDB call is already here.
- **What `metaByTmdbId` returns today** ([`tmdb.js:80-96`](../src/services/tmdb.js)):
  appends `external_ids,images` — **not** `release_dates`. It already sets internal
  **`_release_date`** ([`tmdb.js:65`](../src/services/tmdb.js)) = the movie's primary
  `release_date` (or a series' `first_air_date`). That covers the series rule and the
  "no past release at all" movie case with **no extra data**; the digital check needs
  `release_dates` appended.
- **We already parse `release_dates`.** `fullMeta`'s movie path appends it
  ([`tmdb.js:228-242`](../src/services/tmdb.js)) and `pickCertification`
  ([`tmdb.js:324-336`](../src/services/tmdb.js)) already walks
  `release_dates[].release_dates[]`. This card reuses that shape.
- **`metaByTmdbId` is not cached.** `tmdb.get()` fetches live every call — so every
  rebuild recomputes availability from current TMDB data. (Unlike CP-03's 2-week
  rating cache — which this card must *not* piggyback on; see §4.)
- **Serve** ([`catalogServe.js:72-102`](../src/catalogServe.js)) is cache-only — it
  serves exactly what the build swapped in, so a build-time suppression needs no serve
  change; the row simply contains fewer titles.
- **Watch Later always swaps, even when smaller/empty**
  ([`rebuild.js:402`](../src/rebuild.js)): `source === 'simkl_plantowatch'` bypasses
  the `MIN_METAS` floor, so a suppressed (shorter, possibly empty) row publishes as-is.
  No change needed; noted so we don't trip the quality gate.

---

## Goal

1. The two Watch Later rows omit titles that are **not yet streamable at home**, per
   §Decisions.
2. Source the signal from **TMDB `release_dates`** (movies) + `first_air_date`
   (series) — data we already fetch per item.
3. Apply it at **build**, inside `buildWatchlistCatalog`, so **serve is untouched** and
   a suppressed title **reappears automatically** on the rebuild after it's available.
4. **Fail open:** unknown/unresolved ⇒ keep the title.

---

## Design (proposed)

### 1. A pure availability verdict in `tmdb.js`

Returns one of `AVAILABLE` / `NOT_YET` / `UNKNOWN`; the caller shows on anything but
`NOT_YET` (fail-open).

```js
const HOME_RELEASE_TYPES = new Set([4, 5, 6]); // 4 Digital, 5 Physical, 6 TV

// releaseDatesResults = data.release_dates.results (append_to_response:'release_dates').
// Region-agnostic: a home release in ANY country counts (James, 2026-09-10).
// We DON'T assume: a title with only a theatrical/premiere release (no home release
// yet) stays NOT_YET — however long ago it was in cinemas — until TMDB actually logs
// a Digital/Physical/TV date. That metadata reliably lands for real titles, flipping
// it to AVAILABLE on the next rebuild. The ONLY escape from suppression without a
// home date is the soft gate: no usable release rows at all -> UNKNOWN -> shown (§3a).
function movieAvailability(releaseDatesResults, { nowMs = Date.now() } = {}) {
  const rows = Array.isArray(releaseDatesResults) ? releaseDatesResults : null;
  if (!rows || !rows.length) return 'UNKNOWN';                 // no data -> soft gate
  for (const country of rows) {                                // scan every country
    for (const rel of country.release_dates || []) {
      const t = rel.release_date ? Date.parse(rel.release_date) : NaN;
      if (!Number.isNaN(t) && HOME_RELEASE_TYPES.has(rel.type) && t <= nowMs) {
        return 'AVAILABLE';                                    // out at home somewhere
      }
    }
  }
  return 'NOT_YET';   // has release data but no past home release -> not streamable yet
}
```

Series need no new block — available once it has aired:

```js
function seriesAvailability(firstAirDateIso, { nowMs = Date.now() } = {}) {
  const t = firstAirDateIso ? Date.parse(firstAirDateIso) : NaN;
  if (Number.isNaN(t)) return 'UNKNOWN';                       // no date -> fail open
  return t <= nowMs ? 'AVAILABLE' : 'NOT_YET';
}
```

### 2. Fold it into the Watch Later enrichment (skipping known-released titles)

Check the **released memo** first (§4a). Only for a title *not* already confirmed
released do we append `release_dates` and compute a verdict; a confirmed-released title
skips both the append and the check. Drop on `NOT_YET`
([`rebuild.js:283-291`](../src/rebuild.js)):

```js
const released = store.loadReleasedCache();               // global, monotonic (§4a)
const keyOf = (it) => `${def.type}:${it.imdb_id || it.tmdb_id}`;
const newlyReleased = [];
...
if (it.tmdb_id) {
  const known = released[keyOf(it)] === true;             // terminal: never re-checked
  const m = await tmdb.metaByTmdbId(profile.keys.tmdb_api_key, def.type, it.tmdb_id, log,
    { append: (!known && def.type === 'movie') ? 'release_dates' : null }); // skip the append when known
  if (m) {
    if (known) return m;                                   // already released -> show, no verdict
    const verdict = def.type === 'series'
      ? tmdb.seriesAvailability(m._release_date)
      : tmdb.movieAvailability(m._release_dates_results);   // any-country
    if (verdict === 'NOT_YET') return null;                // suppress (fail-open on UNKNOWN)
    if (verdict === 'AVAILABLE') newlyReleased.push(keyOf(it)); // memoize the terminal state
    return m;                                              // AVAILABLE or UNKNOWN -> show
  }
}
// tt-id fallback (TMDB couldn't resolve) -> UNKNOWN -> kept, per fail-open (not memoized).
...
// after the loop, persist any newly-confirmed releases in ONE write (like CP-03 ratings):
if (newlyReleased.length) { for (const k of newlyReleased) released[k] = true; store.saveReleasedCache(released); }
```

`metaByTmdbId` needs to expose `data.release_dates?.results` (as `_release_dates_results`)
when asked — a small addition mirroring how it already carries `_release_date`.

Note the asymmetry: **movies** are where the saving lands (the `release_dates` append
is skipped for known-released titles). **Series** availability (`first_air_date`) is
already in the base meta, so the memo only skips a trivial date compare for them — kept
uniform for clarity, but the real "wasted call" it eliminates is the movie append.

### 3. Why Physical/TV count, and how to tighten

James: streaming availability *"usually comes after the DVD/Blu-ray/stream release,
but not always."* A logged Physical (5) or TV (6) release is strong evidence the title
is out at home, and counting them is the **fail-open-leaning** choice that matches the
stated risk tolerance. If you'd rather be strict — suppress until a genuine **Digital**
date — change `HOME_RELEASE_TYPES` to `new Set([4])`. One line, no other change.

### 3a. The soft gate — we don't assume, and nothing gets stranded

There is **no time-window assumption** (James: *"we don't assume"*). A movie is shown
only when TMDB shows a real past home release; otherwise it's `NOT_YET` and suppressed.
Two things keep that from stranding a title as permanently hidden:

- **Metadata lands.** For any real release, TMDB gets the Digital/Physical/TV date,
  usually well ahead of or at the home-release moment. The next daily rebuild (§4) then
  sees it and the title flips `NOT_YET → AVAILABLE` on its own.
- **The soft gate catches the rest.** A title TMDB can't resolve, or one with no usable
  release rows at all, returns `UNKNOWN` and is **displayed anyway**. So the filter can
  only ever hide something it can positively see is unreleased — it never hides on
  absence of information.

The one accepted edge: a title that *does* carry a theatrical row but whose home date
never appears in TMDB stays suppressed. That's the correct outcome under "don't
assume," it's rare, and it's a data gap that self-heals the moment TMDB is corrected —
no guess, no timer, no stranded-forever-on-a-hunch.

### 4. Cache freshness — re-checked on the daily rebuild (James's §4)

Availability is a **changing** status *in one direction only* (a theatre/hype item
goes digital weeks later; it never goes back). So the rule is: **re-check the
not-yet-available; memoize the available.**

- **The Watch Later row is rebuilt on the 24h SWR cadence** (`STALE_MS`,
  [`rebuild.js:40`](../src/rebuild.js); `ensureFresh`/`isStale`
  [`rebuild.js:428-439`](../src/rebuild.js)). Each rebuild re-pulls the Simkl list and
  **recomputes availability for every still-`NOT_YET`/`UNKNOWN` title**, so a suppressed
  title flips to shown by itself the first rebuild after it lands.
- **Never cache a `NOT_YET`/`UNKNOWN` verdict.** Those are transient, so caching them is
  the one dangerous move (it would strand a title as permanently hidden). They ride the
  live TMDB fetch every rebuild. This card **must not** route a *not-yet* decision
  through `mdblist.cachedImdbRatings` (2-week) or any TTL store.
- **Latency:** worst case one rebuild cycle (~24h, or `STALE_HOURS`) between a title
  going digital and reappearing; a manual portal rebuild makes it immediate. Acceptable
  per James ("checked on the daily rebuild for freshness").

### 4a. The released memo — only check non-released items (James's §5)

The counterpart to "never cache not-yet": **do** cache the terminal `AVAILABLE` fact,
so a released title is checked exactly once, ever — no repeated `release_dates` append
or verdict on every rebuild for titles that can't change.

- **Home:** a new global fact-cache in `store.js`, `released-titles.json`, entries
  `{ "movie:tt0111161": true }` — the *exact* pattern already used by the CSM cache,
  the CP-03 IMDb-rating cache, and the age-gate verdicts
  ([`store.js:139-237`](../src/store.js)): facts about titles, not profiles, shared
  across profiles, keyed by `type:id`. `loadReleasedCache()` / `saveReleasedCache()`
  mirror `loadImdbRatingCache` / `saveImdbRatingCache`.
- **Global on purpose:** release is a title fact, not a per-profile one — a title
  confirmed released for one profile is released for all, so five watchlists resolve it
  once. (It's monotonic *under a fixed availability config*; if the
  `HOME_RELEASE_TYPES` set is ever changed, clear this file — a one-liner, same as any
  config-driven cache.)
- **Only `AVAILABLE` is written; `NOT_YET`/`UNKNOWN` are never recorded** (§4). That's
  what keeps re-checking correct for exactly the titles that can still change.
- **Effect:** for a known-released title the build skips the `release_dates` append and
  the verdict entirely (§2) — it just enriches and shows. The check runs only on the
  shrinking set of not-yet-released items.

### 5. Serve — no change

`servedCatalog` serves the cache verbatim; a smaller built list means a smaller row.
`dedupe_watched:false` (WL-KW) and the MW-03 suppression exemption are untouched.

---

## Open decisions — all resolved

- ~~**Region.**~~ **Decided (§Decisions 2a): any country counts — not AU-specific.**
- ~~**Always-on vs. per-profile toggle.**~~ **Decided (James, 2026-09-10): always-on.**
  A fixed property of the two Watch Later rows (like WL-KW's `dedupe_watched:false`) —
  no `hide_unreleased` flag, no profile-filter schema change, no portal toggle. The
  suppression is temporary and self-reversing, so the WL-KW "don't quietly remove what
  I added" concern doesn't apply (nothing is removed; it comes back).
- ~~**`ASSUME_DIGITAL_AFTER_DAYS` window.**~~ **Removed (§Decisions 3 / §3a): we don't
  assume from theatrical age — no window. A title stays suppressed until a real home
  date lands; the soft gate covers the metadata-less.**

**Nothing blocks the build.**

---

## Tasks (BUILT — 2026-09-10)

- [x] `tmdb.js`: `movieAvailability` + `seriesAvailability` (pure, exported); taught
      `metaByTmdbId` an optional `append` arg that surfaces `_release_dates_results` when
      `release_dates` is appended (default callers unchanged).
- [x] `store.js`: `loadReleasedCache()` / `saveReleasedCache()` — a global
      `released-titles.json` fact-cache keyed `type:id`, mirroring the CP-03 IMDb-rating
      cache pair (§4a).
- [x] `rebuild.js` `buildWatchlistCatalog`: checks the released memo first — skips the
      `release_dates` append + verdict for known-released titles; otherwise computes the
      verdict, `return null` on `NOT_YET`, keeps on `AVAILABLE`/`UNKNOWN` (fail-open), and
      records newly-`AVAILABLE` keys in ONE `saveReleasedCache` write after the loop.
      Order, `WATCHLIST_CAP`, and always-swap preserved; header comment records the rule.
- [x] Freshness: covered by tests + comments — a `NOT_YET`/`UNKNOWN` verdict is recomputed
      each rebuild and never persisted, while an `AVAILABLE` verdict is memoized and not
      re-checked.
- [x] Always-on: a fixed behaviour of the two `simkl_plantowatch` rows — no new profile
      flag or portal control; recorded in the `catalogs.js` header comment beside WL-KW.
- [x] Tests — unit (`test/smoke.js`: pure verdicts, released-cache roundtrip, the
      `metaByTmdbId` append wiring, and the build suppress/keep/self-reverse/memo path for
      movies + series) and integration (`test/integration.js` G-AV: suppress→build→cache→
      served preview, no Simkl write, released memo, and end-to-end self-reversal).

## Acceptance criteria

- **Suppressed, not removed:** a not-yet-available plan-to-watch title is **absent**
  from the built/served row, but **still on the Simkl list** and written nowhere — no
  `/sync/*` call fires from this path.
- **Self-reversing:** re-running the build after the title's availability flips
  (mock `now`/dates) makes it **reappear** with no other change.
- **Movies:** a title with a past Digital/Physical/TV release (any country) is present;
  one whose only releases are future — or **theatrical-only, no home release, of any
  age** — is absent (no time-window assumption); a title with **no usable release rows**
  is present (soft gate).
- **Series:** a show with `first_air_date` in the past is present; in the future,
  absent.
- **Fail-open:** a TMDB-unresolved title, or one with no release data, is **kept**.
- **Freshness:** a still-`NOT_YET`/`UNKNOWN` title is re-evaluated from a live TMDB fetch
  each rebuild (never served from a stale not-yet verdict).
- **No wasted re-checks:** a title recorded `AVAILABLE` skips the `release_dates` append
  and the verdict on every subsequent rebuild; the released memo persists across rebuilds
  and is shared across profiles; a `NOT_YET`/`UNKNOWN` title is never written to it.
- **Scope tight & serve unchanged:** only the two Watch Later rows change; serve is
  cache-only; empty-row publishes `[]`; WL-KW / MW-03 behaviour intact.
- **Always-on:** the gate applies to both Watch Later rows for every profile, with no
  toggle or profile flag involved.

## Test notes

- Pure `movieAvailability`: past Digital → `AVAILABLE`; past Physical/TV only →
  `AVAILABLE`; a home release in a **non-AU country only** still → `AVAILABLE`
  (any-country); future-only Digital → `NOT_YET`; theatrical-only, **recent** → `NOT_YET`;
  theatrical-only, **years ago** → `NOT_YET` (no window assumption); no rows / null →
  `UNKNOWN` (soft gate).
- Pure `seriesAvailability`: past `first_air_date` → `AVAILABLE`; future → `NOT_YET`;
  missing → `UNKNOWN`.
- `buildWatchlistCatalog` with stubbed `simkl.getPlanToWatch` + stubbed
  `metaByTmdbId`: an unreleased movie/series dropped, an available one kept, a
  TMDB-unresolved item kept (fail-open), order preserved. Then flip the mocked dates and
  assert the dropped title now builds in (**self-reversal**).
- Released memo: after a build where a movie resolves `AVAILABLE`, assert its key is in
  `released-titles.json`; on the **next** build assert `metaByTmdbId` is called **without**
  the `release_dates` append for that title (spy on the `append` arg) and the verdict fn
  is not invoked for it. Assert a `NOT_YET`/`UNKNOWN` title is **absent** from the memo
  and IS re-checked next build.
- Freshness guard: assert a `NOT_YET` decision is **not** persisted anywhere (memo or TTL
  cache) — it must ride the live TMDB fetch each build.
- Regression: a title already streamable behaves exactly as today.

## Out of scope

- Any Simkl-status-based gate (the request's original assumption) — Simkl doesn't
  expose a streamable signal on the plan-to-watch read; TMDB is the source.
- "Coming soon" styling that *shows* unreleased titles with a badge instead of
  suppressing them — a different feature; separate card if wanted.
- Which *service* has it (Netflix vs. Prime) or true per-region streaming rights — TMDB
  `release_dates` answers "has it hit digital," not "is it on your subscription."
- Per-episode availability for returning series (the show is "available" once it has
  aired at all; `fullMeta` already marks unaired episodes `available:false`).
