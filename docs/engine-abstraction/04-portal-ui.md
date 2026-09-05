# SC-04 — Portal UI: per-type engine selectors (main config)

**Layer:** frontend (portal) · **Depends on:** `02` (config + `/api/engines` + the
`engines` block on the profile). `03` provides the rebuild-on-save behavior the
POST triggers, but this card can be built against `02` alone.
**Behavioral change for users:** two new dropdowns on the Filters tab; with one
engine they show a single, locked option.

> The portal is a single static SPA: [`public/index.html`](../../public/index.html)
> (~1060 lines, inline template-string rendering) talking to
> [`src/portal.js`](../../src/portal.js). This card is HTML/JS in `index.html`
> plus reading the `/api/engines` endpoint added in `02`.

---

## Context primer (current state)

- The Filters tab markup is rendered inside the profile-card template, lines
  ~266–321 of `index.html`. Each control is a `<select data-filter="…">` (e.g.
  `min_rating` line ~270, `list_size` line ~286, the `title_decay` box lines
  ~306–318). A leading `.muted` note (line 267) explains serve-time vs build-time.
- Saving is `saveFilters(id)` (lines ~675–691): it reads each `data-filter`
  control and `PUT`s `{ filters: {…} }`. Add the two engine fields here.
- The profile object `p` in the template already carries `p.filters` and (after
  `02`) `p.engines = { movie, series, requirements:{movie,series} }`.
- There is no global engine list loaded yet — fetch `/api/engines` once at load,
  like `GENRES` is fetched for the genre checkboxes.

---

## Goal

Add **Movies engine** and **Series engine** dropdowns to the Filters tab:
- Populated from `/api/engines`, filtered by `supported_types` per dropdown.
- Show the selected engine's **description** beneath the dropdown.
- With a single supported engine, render a **single, disabled** option (req #3) —
  visibly "Genesis Engine (only engine)".
- Show a **requirement warning** when the chosen engine isn't usable for the
  profile (e.g. "needs Simkl connected"), reusing the existing `⚠` note styling.
- Persist via `saveFilters`.

---

## Design

### 1. Load the engine catalog once

Alongside the existing genre load, fetch and cache:

```js
let ENGINES = [];              // [{id,name,description,supported_types,capabilities}]
// during init (where GENRES is loaded):
ENGINES = (await (await fetch('/api/engines')).json()).engines || [];
const enginesForType = (t) => ENGINES.filter((e) => e.supported_types.includes(t));
```

### 2. Markup — two selects at the top of the Filters tab

Insert a new `.cols` row **above** the existing filters row (engine choice is the
most fundamental thing on the tab — it decides what the other filters act on).
Render per type with a small helper:

```js
function engineField(p, type) {
  // Only engines this profile may CHOOSE for this type — the age-filtered list
  // the API computed (p.engines.available[type], from availableFor / I7). An
  // `unrestricted` engine is simply absent for an age-limited profile, so it's
  // never offered. Intersect the global catalog (for name/description) with it.
  const allow = new Set((p.engines?.available?.[type]) || ['genesis']);
  const opts  = enginesForType(type).filter((e) => allow.has(e.id));
  const sel   = p.filters[`engine_${type}`] || 'genesis';
  const cur   = opts.find((e) => e.id === sel) || opts[0];
  const only  = opts.length <= 1;
  const req  = p.engines?.requirements?.[type];
  const warn = req && !req.ok
    ? `<div style="color:var(--err);font-size:12px;margin-top:4px">⚠ ${esc(cur?.name || 'This engine')} needs ${esc(req.missing.join(', '))}.</div>`
    : '';
  return `<div>
    <label>${type === 'movie' ? 'Movies' : 'Series'} engine</label>
    <select data-filter="engine_${type}" ${only ? 'disabled' : ''}
            onchange="/* update the description inline */ updateEngineDesc(this,'${type}')">
      ${opts.map((e) => `<option value="${esc(e.id)}" ${e.id === sel ? 'selected' : ''}>${esc(e.name)}${only ? ' (only engine)' : ''}</option>`).join('')}
    </select>
    <div class="muted" data-engine-desc="${type}" style="font-size:11px;margin-top:3px">${esc(cur?.description || '')}</div>
    ${warn}
  </div>`;
}
```

- `updateEngineDesc(sel, type)` swaps the `[data-engine-desc]` text to the newly
  selected engine's description (look it up in `ENGINES`). Pure client-side, no
  fetch.
- A disabled `<select>` isn't submitted by forms, but `saveFilters` reads
  `.value` directly (not a form submit), so a disabled single-option select still
  yields `'genesis'`. Confirm `saveFilters` reads `card.querySelector('[data-filter=engine_movie]').value` even when disabled — it does (JS reads value regardless of disabled). Good.

### 3. Note copy

Update the Filters `.muted` intro (line ~267) to mention that **engine choice
takes effect on the next rebuild** (it's build-affecting, like vote count / age
limit), so users aren't surprised the list doesn't change instantly.

Suggested addition: *"The **engine** decides how each list is generated; changing
it rebuilds that catalog."*

### 4. Save wiring (`saveFilters`)

Add to the payload built in `saveFilters` (lines ~680–688):

```js
engine_movie:  card.querySelector('[data-filter=engine_movie]').value,
engine_series: card.querySelector('[data-filter=engine_series]').value,
```

Keep the existing toast, but when an engine changed, the message should hint at a
rebuild: e.g. append *"— engine change rebuilds that catalog"*. (The backend
`03` hook clears + rebuilds; the portal already polls `status.job` and shows the
progress bar, so no extra polling code is needed — just don't claim "applies
immediately" for the engine.)

### 5. Single-engine appearance (req #3)

With only Genesis: both selects render one `<option>Genesis Engine (only
engine)</option>`, `disabled`, with the description below. This is the intended
"locked" look. When a second engine is registered later, the selects light up
automatically — no UI change needed.

---

## Tasks

- [ ] Fetch `/api/engines` at portal init; cache as `ENGINES`.
- [ ] Add `engineField(p,'movie')` + `engineField(p,'series')` as a new `.cols`
      row atop the Filters tab.
- [ ] `updateEngineDesc(sel,type)` inline description swap.
- [ ] Add both fields to the `saveFilters` payload.
- [ ] Update the Filters intro note + save toast to mention engine → rebuild.

## Acceptance criteria

- The Filters tab shows **Movies engine** and **Series engine**, each defaulting
  to "Genesis Engine", disabled (single option), with the Genesis description
  under each.
- Changing a genre/rating still saves as before (no regression in `saveFilters`).
- With a fake second engine added to the registry (test build), the dropdowns
  become enabled and list both; selecting it and saving persists
  `engine_<type>` and the portal shows a rebuild in progress via the existing
  status poll.
- When Simkl is disconnected, the requirement `⚠` note appears under the relevant
  dropdown.
- **Age gating (I7):** with a registered `unrestricted:true` stub, it appears in
  the dropdowns for an **adult** profile (`age_limit:0`) but is **absent** for a
  profile with an age limit (the API's `engines.available` omitted it). No age
  value is needed client-side — the server already filtered the list.

## Test notes

- Mostly manual/visual (the portal has no JS test harness). Verify with the
  Browser pane against a running server: `preview_start {name:'ai-recommender'}`,
  open `/configure/`, Filters tab, screenshot the two selects.
- Backend contract for this card (`/api/engines`, `publicProfile.engines`) is
  covered by `02`'s tests.

## Out of scope

- The companion mirror (`05`).
- Backend dispatch/rebuild (`03`) — this card only POSTs the values.
