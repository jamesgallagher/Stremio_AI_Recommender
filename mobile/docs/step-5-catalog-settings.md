# Step 5 — Catalog mirror, one-in-one-out, settings cog

**Status:** ✅ BUILT (2026-08-28). Companion recs now mirror the served Stremio
catalog (with a hidden bench for instant promotion), a settings cog exposes the
backend filters for editing (the age gate excepted), and an advanced toggle
switches between the catalog and the entire recommendation pool. Tests: `46 unit + http`.

**e2e-verified in a real browser (2026-08-28):** authed shell shows
`profile · ⚙ · Log out`; the Movies row renders exactly `list_size` (10) titles;
removing the top row keeps the list at 10 with the next bench title promoted in,
and **Undo** restores it; the settings screen loads populated from the backend
(rating ≥6.0, recency, list size, vote floor, Horror pre-ticked) with **no age
control**; saving with "Only my catalog items" off flips the default view to the
whole pool (18) and persists. `GET /mobile/api/settings` never returns
`age_limit`; a POST carrying `age_limit` leaves it unchanged.

**Depends on:** Steps 1–4 (session, shell, search, recs + swipe). **Reuses:**
`recommendationStore.selectServe` (serve engine), `dontRecommend.suppress`
(remove), `config.updateProfile` (write path).

## The two product decisions (signed off before build)

1. **Promotion is Lean, not a queue.** The whole pool is already LLM age-gated at
   build (`ageGatePool` runs over every row, verdicts cached per TMDB id), so the
   "bench" beyond the visible list is already vetted. Removing a title just
   promotes the next already-vetted bench title — no rebuild, no per-promotion
   LLM, no queue. James confirmed: *"If the list is already gated and checked then
   that is perfect, we just use the one in, one out model."*
2. **The age gate is invisible to the Companion.** Filters are editable from the
   phone **except** `age_limit`, which is never returned, never rendered, and never
   writable there (`COMPANION_FILTERS` whitelist). The server still *uses* it
   internally for the vetted-only "entire list" view — it just never leaves the
   server.

## Design

### Catalog view = the served selection (+ a hidden bench)

`GET /mobile/api/recommendations?type=…[&view=catalog|all]`

| field | meaning |
|---|---|
| `view` | `catalog` (default, or the profile's `companion.catalog_only` pref) \| `all` |
| `items` | the visible `display_count` titles **plus** a hidden on-deck bench (catalog view) |
| `display_count` | how many the phone shows = the profile's `list_size` |

- **catalog:** `selectServe(pool, filters, { limit: list_size + CATALOG_BENCH })`,
  watched-pruned like the addon. Because `balanceByGenre` makes `selectServe(N)` a
  strict **prefix** of `selectServe(N+k)`, the first `list_size` rows **are** the
  Stremio row; the rest are the promotion buffer. `selectServe` (not
  `serveRecommendations`) is used deliberately — no impression recording, so
  browsing the phone doesn't fuel decay.
- **all:** the whole pool, passed through `passesAgeBand` so an age-limited
  profile still sees only vetted titles (adult → always true). No genre-balance,
  no size cap — the honest full set.

### One in, one out (client, `app.js`)

`recs.data[type] = { view, items, display, benchExhausted }`. The list renders
`items.slice(0, display)`. On remove: splice the title, and in catalog view
append `items[display-1]` (the title that just slid up from the top of the
bench); when the bench is spent, `refillBench` refetches. Undo unshifts the title
back and re-renders (a promoted bench title slides back down). Stremio back-fills
on its own next fetch — the client-cache lag is inherent and unchanged.

### Settings cog (`⚙`, between the profile name and Log out)

- `GET /mobile/api/settings` → `{ filters, catalog_only, genres }` — the five
  editable filters (`min_rating`, `vote_count_floor`, `max_age_years`,
  `excluded_genres`, `list_size`), never `age_limit`.
- `POST /mobile/api/settings` → strict whitelist of those five + `catalog_only`,
  routed through `config.updateProfile` (which validates/clamps). `age_limit` is
  dropped even if a crafted body includes it. Serve-time filters apply on the next
  fetch; `vote_count_floor` applies on the next rebuild (as in the portal). Saving
  marks the recs tab dirty so it refetches with the new filters/view.
- The `companion` prefs object is **separate from `filters`** (config.js) so a
  view toggle can never leak into recommendation logic.

## Tests (`mobile/test/mobile.smoke.js`, `+9 unit / +2 http`)

`passesAgeBand` bands; catalog view == Stremio prefix with `display_count =
list_size` + a bench; entire-list view = whole pool (adult) / age-band-filtered
(kids); default view follows `catalog_only` with `?view` override; one-in-one-out
promotion at the data layer; `toCompanionFilters`/GET/POST never expose or write
`age_limit`; POST of only forbidden keys → 400.

## Acceptance criteria

- The Companion recs list is a faithful mirror of the served Stremio catalog
  (`list_size` titles), or the whole pool when "Only my catalog items" is off.
- Removing a title promotes the next bench title with no rebuild; the list holds
  its size; a mis-remove is undoable.
- The settings cog edits the backend filters and the view pref; the age gate is
  never shown, returned, or writable through the phone.
- An age-limited profile's "entire list" stays vetted-only.
