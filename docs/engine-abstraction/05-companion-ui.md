# SC-05 — Companion UI: per-type engine selectors (mobile)

**Layer:** frontend (mobile SPA) · **Depends on:** `02` (whitelist + settings
payload). `03` provides rebuild-on-save. Independent of `04`.
**Behavioral change for users:** two dropdowns on the companion Filters tab;
single, locked option while only Genesis exists.

> The Mobile Companion is a small vanilla SPA:
> [`mobile/public/index.html`](../../mobile/public/index.html) +
> [`mobile/public/app.js`](../../mobile/public/app.js), served under `/mobile`,
> talking to [`mobile/server/handlers.js`](../../mobile/server/handlers.js). It
> edits **only** the `COMPANION_FILTERS`-whitelisted per-profile filters — never
> the age gate.

---

## Context primer (current state)

- The Settings view has two tabs (`Filters`, `Catalogs`) — `index.html` lines
  ~96–196. Filter controls are `<select>`s with ids like `set-min-rating`
  (line 106), `set-list-size` (134), `set-vote-floor` (146), the title-decay box
  (163–172).
- `app.js` `setEls` (lines ~398–406) maps those ids; `loadSettings` (487–507)
  populates them from `GET /mobile/api/settings`; `saveSettings` (509–529) POSTs
  the payload.
- Server side: `companionSettings(profile)` (handlers.js ~202–209) returns
  `{ filters, catalog_only, genres, catalogs }`. `settingsPostHandler` (224–248)
  forwards only whitelisted fields.
- **`02` already added** `engine_movie`/`engine_series` to `COMPANION_FILTERS`,
  so the server will accept + persist them. This card adds the **payload shape**
  the phone needs (engine list) and the **UI**.

---

## Goal

Mirror `04` on the phone:
- Two dropdowns (Movies engine / Series engine) on the Filters tab.
- Populated from the settings payload; single/locked when only Genesis exists.
- Show the selected engine's description.
- Persist via `saveSettings`.
- **Never** expose the age gate (unchanged guarantee).

---

## Design

### 1. Server: include engines in the settings payload

Extend `companionSettings(profile)` in `handlers.js`:

```js
const engines = require('../../src/engines');
// PURE: a phone-safe engine descriptor (no capabilities/internal flags leaked).
const engDTO = (e) => ({ id: e.id, name: e.name, description: e.description });

function companionSettings(profile) {
  return {
    filters: toCompanionFilters(profile.filters || {}), // already includes engine_movie/series via COMPANION_FILTERS
    catalog_only: catalogOnlyOf(profile),
    genres: Object.keys(tmdb.GENRE_ALIASES).sort(),
    catalogs: companionCatalogs(profile),
    // NEW: per-type engine choices, AGE-FILTERED SERVER-SIDE (I7). `available` is
    // engines.availableFor(profile,type) — so an `unrestricted` engine is simply
    // never sent to an age-limited profile's phone. The age limit does the
    // filtering but is NEVER exposed (same discipline as companionCatalogs, which
    // uses catalogs.ageAppropriate without surfacing the limit).
    engines: {
      available: {
        movie:  engines.availableFor(profile, 'movie').map(engDTO),
        series: engines.availableFor(profile, 'series').map(engDTO),
      },
      requirements: {
        movie:  engines.resolveFor(profile, 'movie').requirements(profile),
        series: engines.resolveFor(profile, 'series').requirements(profile),
      },
    },
  };
}
```

`toCompanionFilters` already emits every `COMPANION_FILTERS` key, so
`filters.engine_movie`/`engine_series` are present with safe fallbacks. (Confirm
`toCompanionFilters` returns them as `null` when unset — the client should treat
`null` as `'genesis'`.)

> **Why `availableFor`, not `list()`:** returning the whole registry would ship an
> `unrestricted` engine's existence to a kids profile's phone (and let a crafted
> POST select it — though `updateProfile` would still coerce it). Filtering here
> keeps the open engine invisible on age-gated devices, and the age limit never
> leaves the server. `engDTO` also strips `capabilities`/`supported_types` so no
> internal flag leaks; the client keys each list by the type it fetched for.

> Requirement wording on the phone should stay generic (no age mention) — e.g.
> "needs Simkl connected" / "needs an LLM key (set in the portal)". Do not leak
> `age_limit`-related requirements (Genesis has none; a future age-aware engine
> must phrase its requirement without exposing the limit).

### 2. Markup — two selects at the top of the Filters tab

In `mobile/public/index.html`, add above `set-min-rating` (inside the
`data-settab="filters"` panel, ~line 102):

```html
<div class="field">
  <label for="set-engine-movie">Movies engine</label>
  <select id="set-engine-movie"></select>
  <p class="hint" id="set-engine-movie-desc"></p>
</div>
<div class="field">
  <label for="set-engine-series">Series engine</label>
  <select id="set-engine-series"></select>
  <p class="hint" id="set-engine-series-desc"></p>
</div>
```

(Use the existing `.field`/`.hint` classes the other controls use.)

### 3. `app.js` wiring

Add to `setEls`:

```js
engineMovie: $('set-engine-movie'), engineMovieDesc: $('set-engine-movie-desc'),
engineSeries: $('set-engine-series'), engineSeriesDesc: $('set-engine-series-desc'),
```

Populate in `loadSettings` (after reading `data`):

```js
const eng = data.engines || { available: {}, requirements: {} };
function fillEngine(sel, descEl, type) {
  // Server already type-scoped AND age-filtered this list (I7) — use it as-is.
  const opts = (eng.available?.[type]) || [];
  const chosen = (data.filters?.[`engine_${type}`]) || 'genesis';
  const only = opts.length <= 1;
  sel.innerHTML = opts.map((e) =>
    `<option value="${e.id}">${e.name}${only ? ' (only engine)' : ''}</option>`).join('');
  setSelect(sel, chosen);
  sel.disabled = only;
  const cur = opts.find((e) => e.id === sel.value) || opts[0];
  descEl.textContent = cur?.description || '';
  const req = eng.requirements?.[type];
  if (req && !req.ok) descEl.textContent += ` — needs ${req.missing.join(', ')}`;
  sel.onchange = () => { const c = opts.find((e) => e.id === sel.value); descEl.textContent = c?.description || ''; };
}
fillEngine(setEls.engineMovie, setEls.engineMovieDesc, 'movie');
fillEngine(setEls.engineSeries, setEls.engineSeriesDesc, 'series');
```

Add to the `saveSettings` payload (lines ~511–520):

```js
engine_movie:  setEls.engineMovie.value,
engine_series: setEls.engineSeries.value,
```

The existing `recs.loaded = false` (line 526) already forces the Recommendations
tab to refetch after a save — good, an engine change should refresh the list once
the rebuild lands. Consider a copy tweak to the save toast: *"Saved. Changing the
engine rebuilds that list — it may take a minute."*

### 4. Single-engine appearance (req #3)

With only Genesis: each select shows one disabled option "Genesis Engine (only
engine)" and the description below. Lights up automatically when a second engine
is registered.

---

## Tasks

- [ ] `handlers.js`: add the `engines` block to `companionSettings`; keep the
      age gate out of requirement wording.
- [ ] `index.html`: two `.field` engine selects atop the Filters tab.
- [ ] `app.js`: `setEls` entries, `fillEngine` in `loadSettings`, payload keys in
      `saveSettings`.
- [ ] Save toast mentions the rebuild.

## Acceptance criteria

- `GET /mobile/api/settings` returns `engines.available.{movie,series}` (each
  `[genesis]`) + `engines.requirements.{movie,series}`, and
  `filters.engine_movie/series`. No `capabilities`/`supported_types` leak in the
  DTO.
- The Filters tab shows two engine dropdowns, defaulting to Genesis, disabled
  (single option), with descriptions.
- Saving forwards `engine_movie`/`engine_series`; a body with `age_limit` is
  still stripped (whitelist intact — assert in `mobile.smoke.js`).
- With a fake second engine registered (test), the dropdowns enable and a
  selection persists.
- **Age gating (I7):** with a registered `unrestricted:true` stub,
  `engines.available.{movie,series}` **include** it for an adult profile and
  **omit** it for an age-limited profile — and the payload contains no age value
  either way (verify no `age_limit` field anywhere in the settings response).

## Test notes

- `mobile/test/mobile.smoke.js`:
  - assert `companionSettings` includes `engines.available` with `genesis` and
    `engines.requirements.movie/series`;
  - assert `settingsPostHandler` accepts `engine_series` and never persists
    `age_limit`;
  - assert requirement wording contains no age reference.
- Visual check via Browser pane under `/mobile` (needs an OTP session; or unit-test
  `companionSettings` shape directly, which the smoke suite already does for other
  fields).

## Out of scope

- Portal mirror (`04`).
- Backend dispatch/rebuild (`03`).
