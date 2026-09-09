# CP-01 — Catalog title preview (portal configurator)

**Layer:** backend (shared serve extract + portal API) + frontend (portal) ·
**Depends on:** the addon serve path (`src/addon.js`), `recommendationStore.serveRecommendations`
· **Blocks:** [CP-02 — companion preview](catalog-preview-companion.md) (reuses the
shared serve function + response shape this card defines)
· **Behavioral change for users:** portal Catalogs tab gains a per-catalog preview;
Watch Later rows are renamed (see §4 — affects the served manifest, needs sign-off).

> Read the portal Catalogs panel [`public/index.html:329-342`](../public/index.html)
> (item render is line 334), the addon catalog route
> [`src/addon.js:300-397`](../src/addon.js), and
> [`src/portal.js:160-170`](../src/portal.js) (`GET /catalogs`). The goal is to let
> an admin see the **actual served contents** of any catalog for a profile, so
> "what AI Recommender has" can be compared against what Nuvio is showing.

---

## Why this card exists

The configurator shows *which* catalogs are on, never *what's in them*. To debug a
mismatch ("Nuvio's War row looks stale / different from what I expect"), you have
to install the addon in a client and eyeball it. This card puts the served list —
posters, titles, IMDb ratings — one click away in the portal, rendered from the
**same serve path the addon feeds Nuvio**, so the two are directly comparable.

It also simplifies the catalog rows (title-only) and adds a preview affordance,
and — because the type subtext is being removed — disambiguates the two identically
named Watch Later rows.

---

## Context primer (current state)

- **Portal Catalogs panel** — [`public/index.html:329-342`](../public/index.html).
  Each catalog is a `<label>` flex row: checkbox + `c.name` + a `<span class="muted">`
  subtext that today concatenates type · source · age band · `IMDb ≥ n` · title
  count · "keeps watched" (line 334). `.cats` is a responsive grid
  ([`index.html:48-52`](../public/index.html)). Helpers: `catsFor`/`catOn`
  (~[`index.html:476-482`](../public/index.html)), `saveCatalogs`
  (~[`index.html:786`](../public/index.html)), defs loaded once into `CATALOG_DEFS`
  from `GET /catalogs` (~[`index.html:686`](../public/index.html)).
- **`GET /api/catalogs`** — [`portal.js:161-170`](../src/portal.js): static def
  metadata only (no per-profile contents).
- **Served contents live in two places, assembled inline in the addon route**
  ([`addon.js:300-397`](../src/addon.js)):
  - **Extras** (Watch Later + curated): `store.loadCache(id).extras[catalogId].metas`
    → serve-time watched prune (unless `dedupe_watched:false`) → `applyRpdb`
    ([`addon.js:358-396`](../src/addon.js)).
  - **AI catalogs**: `recommendationStore.serveRecommendations(profile, type)`
    ([`recommendationStore.js:598`](../src/recommendationStore.js)) → watched prune →
    `applyRpdb` ([`addon.js:330-354`](../src/addon.js)).
  - `applyRpdb` ([`addon.js:40-45`](../src/addon.js)) swaps in RatingPosterDB
    posters (rating baked onto the image) when the profile has an RPDB key.
- **Meta fields** available per served title: `{ id, type, name, poster, description,
  releaseInfo, imdbRating }`. `imdbRating` is set for MDBList curated lists
  ([`rebuild.js:340`](../src/rebuild.js)); Watch Later and AI metas may lack it
  (see Open questions).
- **Watch Later naming** — both rows are `name: 'Watch Later'`
  ([`catalogs.js:19-20`](../src/catalogs.js)); the type subtext is the only thing
  distinguishing them in the UI, and `d.name` is also the **Stremio manifest**
  catalog name ([`addon.js:128`](../src/addon.js)).

---

## Goal

1. **One shared serve function** produces a catalog's served titles for a profile —
   consumed by the addon route, this card's preview API, and CP-02 (companion).
2. **`GET /api/profiles/:id/catalogs/:catalogId/preview`** returns that served list
   as JSON for the modal.
3. **Portal UI:** a preview icon (right-aligned) on every catalog row → a centered
   modal of poster + title + IMDb rating.
4. **Simplify rows to title-only**; move age restrictions to a second line so title +
   icon stay aligned; keep restriction visibility (Anime / Kids).
5. **Rename Watch Later** rows to include type (needs sign-off, §4).

---

## Design

### 1. Extract one shared serve function (backend)

Pull the per-catalog assembly out of the addon route into a reusable function so the
preview is provably identical to what Nuvio receives. Proposed home: a small
`src/catalogServe.js` (or exported from `addon.js`), depending only on
`store`/`recommendationStore`/`watchedStore`/`settings`/`catalogs`:

```js
// Returns the served list for one catalog + profile, or null for an unknown/
// disabled catalog. metas are post-watched-prune and post-RPDB — exactly what the
// addon returns to a client (minus the Stremio envelope). type/name for headers.
function servedCatalog(profile, catalogId) { /* ... */ }
// -> { id, name, type, source, metas: [{ id, name, poster, imdbRating, releaseInfo }] }
```

- Move the extras branch ([`addon.js:358-396`](../src/addon.js)) and the AI branch
  ([`addon.js:330-354`](../src/addon.js)) into it; the addon route becomes a thin
  wrapper that adds `cacheMaxAge`/`skip`/error-card behaviour around it. **No
  behaviour change to the addon** — same metas, same order, same prune, same RPDB.
- This is the crux of the comparison feature: preview == serve, by construction.

### 2. Preview API (portal)

```
GET /api/profiles/:id/catalogs/:catalogId/preview
-> 200 { id, name, type, count, requirement_met, metas: [{ id, name, poster, imdbRating, releaseInfo }] }
-> 200 { ..., count: 0, state: 'empty'|'not_built'|'needs_simkl'|'needs_mdblist_key' }   // distinguish the empty reasons the addon already knows
-> 404 unknown catalog id / not age-appropriate for this profile
```

- Reuses `servedCatalog`. Applies the profile's RPDB key exactly as the addon does,
  so posters match the client. Include the two AI catalog ids
  (`ai-recs-movies`/`-series`) and every `EXTRA_CATALOGS` id.
- Age gating: honour `catalogs.ageAppropriate` — never preview an over-band catalog
  for an age-limited profile (the cache is already age-filtered, but refuse at the
  route too, matching [`addon.js:317-320`](../src/addon.js)).
- Admin-authed by virtue of the portal (same as the rest of `/api`).

### 3. Portal UI — per-row preview icon + modal

**Row restructure** (each catalog item), keeping title + icon on row 1:

```
[✓] Catalog Name                                   [👁 preview icon]
    age-gated 13+                          ← row 2, only when restricted
```

- The **preview control is a `<button>` OUTSIDE the `<label>`** (or calls
  `event.stopPropagation()`), so clicking it opens the modal without toggling the
  enable checkbox.
- **Icon:** inline SVG (portal ships no image assets) — a document glyph with a
  small **eye** badge at the bottom-right. `title="preview catalog titles"` +
  `aria-label`. Factor it into one `PREVIEW_ICON` string so CP-02 reuses the same
  mark. ~16px, `color: var(--muted)`, `--ok` on hover.
- **Subtext removed:** drop the whole type · source · IMDb · size · keeps-watched
  span. The row shows the **title with the type appended** — `"<name> — Movies"` /
  `"<name> — Series"`, derived from `def.type` (see §4), so the two `"Watch Later"`
  rows (and the two `"Recommended for you"` rows) read distinctly without the old
  metadata clutter. **Keep only restriction info**, moved to row 2: `min_profile_age`
  → "13+ only", `age_band` → "age-gated 13+". Rows with no restriction show only the
  title line. (Enforcement is unchanged — this is display only.)

**Modal** (centered, self-contained, portal CSS vars, theme-aware):

- Backdrop overlay; centered dialog; header = catalog name + `count` ("War Movies —
  20 titles"); scrollable **poster grid**.
- Each cell: served **poster** (`<img loading="lazy">`, `no-poster` fallback),
  **title**, and an **IMDb rating** badge from `imdbRating` when present. When RPDB
  is active the poster already carries the rating (badge is then supplementary, not
  a contradiction — note in a tooltip/legend).
- States: loading spinner while fetching; empty/not-built/needs-key messages from the
  `state` field (reuse the addon's wording).
- Dismiss: ✕ button, backdrop click, and **Esc**. Focus-trap + return focus to the
  triggering icon (a11y). This modal markup/CSS should be generic enough to lift
  into the companion (CP-02) with minimal change.

### 4. Naming — type-free manifest names, type appended by the surface (signed off 2026-09-09)

**Key fact (confirmed on both clients):** the client **auto-appends the type** to a
catalog's name — `"Movies recommended for you"` renders as "Movies recommended for
you — Movies". The appended label is **client-owned and inconsistently worded**:
Nuvio shows "— Movies" (plural), Stremio "— Movie" (singular). So (a) baking the type
into a manifest name double-prints it, and (b) we must not try to match a specific
client's suffix — the manifest name stays type-free and each surface appends its own
label. The rule, applied to all always-on rows:

**Manifest names carry no type word; the type is appended by whoever renders the row**
(the client on the board; our portal/companion in their own lists).

- **AI catalogs** — [`addon.js:24-25`](../src/addon.js): rename
  `"Movies recommended for you"` / `"Series recommended for you"` → **`"Recommended
  for you"`** (both). Nuvio then shows "Recommended for you — Movies" / "— Series";
  the current redundant "… recommended for you — Movies" is gone.
- **Watch Later** — [`catalogs.js:19-20`](../src/catalogs.js): **keep** `name:
  'Watch Later'` on both (do **not** add the type). Nuvio shows "Watch Later —
  Movies" / "— Series", already disambiguated by the client's suffix. (This replaces
  the earlier "rename to Watch Later Movies" proposal, which would have produced
  "Watch Later Movies — Movies".)
- **Our portal + companion UI** don't get the client's auto-suffix, so **they append
  `— Movies`/`— Series` themselves** from `def.type` (§3). That's what
  disambiguates the two `"Watch Later"` and two `"Recommended for you"` rows in our
  own lists after the subtext removal — a type label derived from data, not a second
  name stored in the def.

This is a change to served output (the AI manifest names change in Nuvio after the
manifest refreshes) — **signed off by James 2026-09-09**. Update copy that spells the
old names: portal intro [`index.html:330`](../public/index.html) and the two locked AI
rows [`index.html:332-333`](../public/index.html); no logic keys off the display name.

**Minor caveat:** a hypothetical client that does *not* append the type would show two
bare "Recommended for you" / "Watch Later" rows. Nuvio (the target client) does append
it; accepted.

---

## Tasks

- [ ] Backend: extract `servedCatalog(profile, catalogId)` (shared); refactor the
      addon route to use it with **no behavioural change** (assert via existing
      addon smoke tests).
- [ ] `portal.js`: `GET /api/profiles/:id/catalogs/:catalogId/preview` (age-gated,
      empty-state reasons, RPDB applied).
- [ ] Portal UI: row restructure (title + `— <Type>` appended from `def.type`, on
      row 1; restriction on line 2), reusable `PREVIEW_ICON` SVG button (right-aligned,
      doesn't toggle the checkbox), and the centered preview modal (poster grid, rating
      badge, states, Esc/backdrop close, focus handling).
- [ ] Naming (§4): `addon.js:24-25` AI names → `"Recommended for you"` (both);
      **leave** `catalogs.js` Watch Later names as `"Watch Later"`; update copy at
      [`index.html:330,332-333`](../public/index.html).
- [ ] Tests (below).

## Acceptance criteria

- **Preview matches serve:** for a built catalog, the preview modal's ids/order equal
  what `GET /addon/:token/catalog/:type/:id.json` returns for the same profile
  (post-prune, post-RPDB). This is asserted directly against the shared function.
- **Every row has the icon**, right-aligned, tooltip "preview catalog titles";
  clicking it opens the modal and does **not** toggle the enable checkbox.
- **Rows read as `"<name> — <Type>"`** (type from `def.type`); a restricted catalog
  (Kids 12, Anime TV-14) still shows its band on a second line; title + icon remain
  aligned on row 1.
- **Names are type-free in the manifest:** AI rows serve as "Recommended for you"
  (Nuvio shows "Recommended for you — Movies/Series", no redundancy); Watch Later
  stays "Watch Later" (Nuvio shows "Watch Later — Movies/Series"). Our portal/companion
  rows append the type themselves.
- **Empty/not-built** catalogs show the right message, not a broken grid.
- **Age safety:** previewing an over-band catalog for an age-limited profile is 404;
  a kids profile's previewed list contains only age-passed titles (already true of
  the cache).
- **Modal a11y:** Esc and backdrop close; focus returns to the icon.

## Test notes

- **Shared-serve equivalence:** unit test `servedCatalog` returns the same array the
  addon route serializes (extras + AI paths, watched-prune on/off via
  `dedupe_watched`, RPDB on/off). Guard the "no behaviour change" refactor with the
  existing addon catalog smoke assertions ([`test/smoke.js`](../test/smoke.js) around
  the Watch Later / curated serve cases ~1958-1989).
- Portal HTTP: preview endpoint shape; 404 for unknown id and for an over-band
  catalog on an age-limited profile; empty-state `state` values.
- Naming: assert the AI manifest names are now `"Recommended for you"` (both types)
  and Watch Later stays `"Watch Later"`; update any test asserting the old
  `"Movies recommended for you"` / `"Series recommended for you"` manifest names
  (e.g. the manifest assertions ~[`smoke.js:1653-1679`](../test/smoke.js)). UI: rows
  render `"<name> — <Type>"`.

## Decisions

- **Scope = every catalog (resolved, James 2026-09-09):** the preview icon and modal
  apply to **all** catalog rows, including the two always-on AI recommendation lists
  (`ai-recs-movies`/`-series`), not just the extras. §2/§3 already reflect this.
- **Naming (resolved, James 2026-09-09):** manifest names are type-free — AI rows →
  "Recommended for you", Watch Later stays "Watch Later"; the client and our UI append
  the type (§4). This kills the "Movies recommended for you — Movies" redundancy James
  flagged.
- **Rating display for AI / Watch Later (resolved 2026-09-09):** handled by a shared
  server-side rating cache — see [CP-03](catalog-rating-cache.md). This card's modal
  reads `imdbRating` from the served meta; CP-03 makes sure that value is populated
  (cached, 2-week TTL) for the sources that don't carry one today. Until CP-03 lands,
  the badge is simply omitted when absent (the RPDB poster still shows the rating).

## Out of scope

- The Mobile Companion preview — [CP-02](catalog-preview-companion.md) (reuses
  `servedCatalog` + the modal, but **hides age** per the companion invariant).
- Editing/reordering catalog contents from the preview — read-only.
- Changing what any catalog serves (this card only surfaces it) — except the manifest
  name changes in §4 (AI → "Recommended for you"; Watch Later unchanged).
