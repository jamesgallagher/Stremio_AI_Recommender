# CP-02 — Catalog title preview (Mobile Companion)

**Layer:** backend (companion server) + frontend (mobile) · **Depends on:**
[CP-01](catalog-preview-portal.md) (`servedCatalog` shared function, preview
response shape, `PREVIEW_ICON`) · **Behavioral change for users:** the Companion
Catalogs tab gains a per-catalog preview; catalog rows simplify to title-only.

> Read [CP-01](catalog-preview-portal.md) first — this card is the same feature on
> the phone and deliberately reuses its shared serve function and modal. Then the
> companion Catalogs code: [`mobile/server/handlers.js:192-206`](../mobile/server/handlers.js)
> (`companionCatalogs`), [`mobile/public/app.js:472-499`](../mobile/public/app.js)
> (`catMeta`/`catRow`/`renderCatalogs`), and the existing poster rendering
> ([`app.js:135`, `app.js:284`](../mobile/public/app.js)) + detail sheet
> ([`app.js:108,153`](../mobile/public/app.js)).

---

## Why this card exists

CP-01 lets an admin preview a catalog's served titles in the portal. The Companion
is the phone-side of the same configurator (per-profile filters + catalogs), and the
design note on CP-01 always intended this to reach it. Same value: see what AI
Recommender is actually serving, on the device, next to Nuvio.

**Key difference from CP-01 (confirmed by James 2026-09-09):** the Companion is a
family-facing surface that **never reveals age information** (bands, limits, gate) —
an explicit invariant ([`app.js:473`](../mobile/public/app.js), SC-05). The age gate
is already assumed from the profile, so restrictions are not shown in subtext. This
card carries the preview and the title-only simplification across, but **shows no
restriction line**. The age *enforcement* is unchanged and already server-side.

---

## Context primer (current state)

- **`companionCatalogs(profile)`** — [`handlers.js:192-206`](../mobile/server/handlers.js):
  DTO per catalog `{ id, name, type, enabled, source, min_imdb, target,
  dedupe_watched, requirement_met }`. Already **age-filtered** via
  `catalogs.ageAppropriate` and, by design, carries **no age band/limit** field. Part
  of `companionSettings` ([`handlers.js:215`](../mobile/server/handlers.js)).
- **`catMeta(c)`** — [`app.js:474-481`](../mobile/public/app.js): builds a subtext
  line (type · source · IMDb · size · keeps-watched). Comment at
  [`app.js:473`](../mobile/public/app.js): *"Age-band notes are intentionally omitted
  — the Companion never surfaces age."*
- **`catRow`/`renderCatalogs`** — [`app.js:483-499`](../mobile/public/app.js): each
  row is a `<label class="cat-row">` (checkbox + `cat-name` + `cat-meta`); the two AI
  lists are locked rows.
- **Poster rendering already exists** on the phone: `result-poster`
  ([`app.js:135`](../mobile/public/app.js)), `rec-poster`
  ([`app.js:284`](../mobile/public/app.js)), and a bottom **detail sheet**
  (`detail-sheet`, [`app.js:108`](../mobile/public/app.js)) — reuse these patterns for
  the preview surface rather than inventing new poster CSS.
- **Companion auth**: the companion server resolves the profile from its session/OTP
  (see `mobile/server`), so the preview endpoint is per-profile and scoped to the
  authenticated companion user — it must **not** accept an arbitrary `:id`.

---

## Goal

1. A **preview affordance** on every Companion catalog row (AI + extras) using the
   shared `PREVIEW_ICON`.
2. A companion preview **endpoint** that returns the served list via CP-01's
   `servedCatalog` — scoped to the authenticated profile.
3. A **preview surface** (modal or bottom sheet, matching the app's existing sheet)
   of poster + title + IMDb rating.
4. **Title-only** catalog rows (mirror CP-01's simplification) — but **no restriction
   line** (age stays hidden).
5. Rows read as `"<name> — <Type>"` (type appended by the companion from `def.type`),
   matching CP-01's naming so "Watch Later" and "Recommended for you" disambiguate
   without a type word baked into the name.

---

## Design

### 1. Companion preview endpoint (server)

Add to the companion server, alongside `companionSettings`:

```
GET  <companion>/api/catalogs/:catalogId/preview      (profile = authenticated session; NO :id in path)
-> 200 { id, name, type, count, requirement_met, metas: [{ id, name, poster, imdbRating, releaseInfo }] }
-> 200 { ..., count: 0, state: 'empty'|'not_built'|'needs_simkl'|'needs_mdblist_key' }
-> 404 unknown id / not age-appropriate for this profile
```

- Delegates to CP-01 `servedCatalog(profile, catalogId)` — identical served list to
  the portal and to what Nuvio receives; RPDB applied with the profile's key.
- **Reuse `companionCatalogs`' age gate:** only ids that survive
  `catalogs.ageAppropriate(profile, ·)` are previewable; anything else is 404. Never
  return, or hint at, why (no age reason in the payload — same discipline as the
  settings DTO).
- The response purposely contains **no age field** — just titles/posters/ratings,
  which the cache has already age-filtered.

### 2. Companion UI — icon + preview sheet

- **Row simplification:** reduce `catRow` to the **title only** plus a right-aligned
  `PREVIEW_ICON` button (the shared SVG from CP-01). Remove the `cat-meta` subtext
  entirely. **No restriction line** — unlike CP-01, the companion shows nothing about
  age. (`catMeta` can be deleted or reduced.)
- The icon button must not toggle the enable checkbox (separate element / stop
  propagation), same as CP-01.
- **Preview surface:** prefer the app's existing **bottom detail sheet** pattern
  (`detail-sheet`) or a centered modal lifted from CP-01 — whichever fits the phone
  layout — showing a scrollable poster grid: served **poster** (`rec-poster`/
  `result-poster` styling, lazy, `no-poster` fallback), **title**, and **IMDb rating**
  badge when present. Header = catalog name + count. Dismiss via the sheet's existing
  close affordance + backdrop; respect safe-area insets.
- Loading + empty/not-built/needs-key states from the endpoint's `state` field, with
  companion-appropriate copy (still nothing about age).

### 3. Consistency with CP-01

- Same served list, same rating semantics (RPDB posters already carry the rating;
  the numeric badge reads `imdbRating`, populated for AI + Watch Later by
  [CP-03](catalog-rating-cache.md)).
- Naming follows CP-01 §4: manifest names are type-free (AI = "Recommended for you",
  Watch Later = "Watch Later"); the **companion appends `— Movies`/`— Series`** from
  `def.type` in its own row rendering (it gets no client auto-suffix). So the two
  same-named rows disambiguate in the companion list exactly as in the portal.

---

## Tasks

- [ ] Companion server: `GET /api/catalogs/:catalogId/preview` (session-scoped
      profile, `servedCatalog`, `ageAppropriate` 404 gate, empty-state reasons, **no
      age field**).
- [ ] Companion UI: simplify `catRow` to title-only + shared `PREVIEW_ICON` button;
      remove `cat-meta`/restriction text.
- [ ] Companion UI: preview sheet/modal (poster grid + rating), reusing the app's
      poster + sheet patterns; states + dismiss + safe-area.
- [ ] Tests (below).

## Acceptance criteria

- **Preview matches serve:** companion preview ids/order equal the addon's served
  list for the same profile (same `servedCatalog`, so equal by construction).
- **Every row** (AI + age-appropriate extras) has the preview icon; tapping it opens
  the sheet and does not toggle the enable checkbox.
- **Rows are title-only with NO age/restriction text anywhere** — the companion
  invariant holds; an over-band catalog is simply absent (as today), and previewing
  one by id is 404 with no age reason leaked.
- **Rows read `"<name> — <Type>"`**; "Watch Later" and "Recommended for you"
  disambiguate by the appended type, no type word in the def name.
- **Empty/not-built/needs-key** states render cleanly on the phone.

## Test notes

- Companion handler test: preview payload shape; **no age field** present; 404 for an
  over-band catalog on an age-limited profile and for unknown ids; session scoping
  (a profile cannot preview another profile's catalog — there is no `:id` to abuse).
- Reuse CP-01's `servedCatalog` equivalence test; assert the companion route returns
  the same metas the portal route does for the same profile/catalog.
- Extend the companion settings/smoke suite
  ([`mobile/test/mobile.smoke.js`](../mobile/test/mobile.smoke.js)) for the new route
  and the title-only rows (no `cat-meta`).

## Out of scope

- Portal preview — [CP-01](catalog-preview-portal.md).
- Surfacing any age/band/limit on the companion — explicitly excluded (invariant).
- The manifest name changes (AI → "Recommended for you"; Watch Later unchanged) —
  owned by CP-01 §4; the companion only appends the type in its own rendering.
