# SC-07 — Global engine enablement (admin Server Config toggle)

**Layer:** backend/config + frontend (portal, admin) · **Depends on:** `01`
(registry), `02` (config + `/api/engines`), `03` (`clearType` + rebuild-on-change)
· **Blocks:** the practical use of any real/stub second engine (`06`)
· **Behavioral change for users:** none while Genesis is the only engine (Genesis
is always enabled).

> Read `00-overview.md` §3–5 and card `03` §2 (the `clearType` + rebuild hook this
> card reuses). SC-01/02 gave the registry its per-type + age gating and per-profile
> selection. This card adds the **global, admin-only on/off** layer *above* them: an
> engine must be **enabled in Server Config** before any profile can select, resolve,
> or be served by it. **Genesis is permanently enabled** — the guaranteed default and
> safe floor — and cannot be turned off.

---

## Why this card exists

After `01`–`06` the registry has exactly two gates: `supportedTypes` (a code fact)
and `unrestricted` + `age_limit` (a per-profile, per-title-safety fact, I7). There is
**no way for the admin to control which engines exist for the whole install.** A
second engine, the moment it is code-registered, would immediately appear in every
profile's dropdowns. James wants the opposite: a new engine ships **dark**, and the
admin flips it on deliberately from the main app's config — "toggle on / toggle off,
and right now only Genesis is enabled." This card is that layer.

It also completes the SC-02 property "a second engine shows in a profile's dropdown
only once it is **both** code-registered **and** admin-enabled."

---

## Context primer (current state after `01`–`03`)

- **Registry** (`src/engines/index.js`): `get/list/listForType/has/availableFor/
  resolveFor/_register`. Gates today: `supportedTypes` and (in `availableFor`/
  `resolveFor`) `unrestricted` + `age_limit`. No enablement.
- **Server Config** lives in [`src/settings.js`](../../src/settings.js) /
  `settings.json` — global infra (the LLM chain, the TMDB/MDBList/RPDB keys). Read
  via `settings.getSettings()`, written through the portal `PUT /api/settings` path.
  It sits behind admin auth (Cloudflare Access in prod); the **companion never
  touches Server Config** (it only edits per-profile `filters`).
- **`GET /api/engines`** (SC-02) returns the static registry; `publicProfile.engines
  .available` is sourced from `availableFor`.
- **SC-03** added `recommendationStore.clearType(profileId, type)` + `ensureBuilt`,
  fired from the portal/companion save hooks when a profile's `engine_<type>`
  changes (before/after diff). This card fans that same path out across profiles.

---

## Goal

1. Persist an **admin-only enabled/disabled** state per engine in Server Config.
2. **Genesis is always enabled** and cannot be disabled (default + safe floor).
3. A non-Genesis engine defaults **disabled** — code-registered ≠ available.
4. Gate selection / resolution / serve on enablement: only enabled engines appear
   in dropdowns and resolve; a disabled engine reverts affected profiles to Genesis.
5. Admin UI: an **"Engines" section in the portal's Server Config**.
6. Disabling an engine **reverts every profile using it to Genesis** for that type
   and rebuilds that slice, reusing SC-03's mechanism.

---

## Design

### 1. Storage — `settings.engines` (Server Config, admin-only)

```jsonc
// settings.json — global; never per-profile, never companion.
engines: {
  genesis: true,          // always true; the UI renders this toggle locked-on
  // "<other-id>": true|false   // absent key → disabled (non-Genesis default OFF)
}
```

- Add `engines: {}` to the settings defaults + a one-line idempotent migration in
  `settings.js` (mirror the existing field-seeding migrations there).
- **Resolution rule:** an engine is enabled iff `id === 'genesis'` **OR**
  `settings.engines[id] === true`. Absent map / absent key ⇒ Genesis on, everything
  else off. So no per-engine migration is needed when a new engine is later added —
  it is simply off until the map says otherwise.
- Not a secret; stored plaintext like the rest of the Server Config metadata (the
  seal path in `config.js`/`settings.js` is untouched).

### 2. Registry — `isEnabled` + enabled-aware gating

```js
// src/engines/index.js — enablement reads Server Config. settings.js has no
// dependency on engines, so a lazy require here is cycle-free; lazy also keeps
// the registry loadable before settings is initialised.
function isEnabled(id) {
  if (id === DEFAULT_ID) return true;                 // Genesis: permanently on
  if (!has(id)) return false;
  const cfg = require('../settings').getSettings()?.engines || {};
  return cfg[id] === true;                            // non-Genesis default OFF
}
function listEnabled()        { return list().filter((e) => isEnabled(e.id)); }
function listEnabledFor(type) { return listForType(type).filter((e) => isEnabled(e.id)); }
```

Thread it through the two gating helpers SC-01/02 already own:

- **`availableFor(profile, type)`** — add `&& isEnabled(e.id)` to the filter, so the
  dropdowns (portal **and** companion) never offer a disabled engine. Genesis always
  survives (`isEnabled` true, `unrestricted:false`), so a dropdown is never empty.
- **`resolveFor(profile, type)`** — add **disabled** to the fallback-to-Genesis
  conditions, alongside unknown / type-unsupported / unrestricted-on-age-limited: if
  the stored engine is `!isEnabled`, return Genesis. A disabled engine can therefore
  never build or serve, even if `engine_<type>` still names it or a `profiles.json`
  was hand-edited — the same safe-floor discipline the age gate uses (I7).

### 3. Admin API

- **`GET /api/engines`** (SC-02) gains `enabled` + `locked` per engine so the admin
  section can render toggles and lock Genesis:

```js
engines: engines.list().map((e) => ({
  id: e.id, name: e.name, description: e.description,
  supported_types: e.supportedTypes, capabilities: e.capabilities,
  enabled: engines.isEnabled(e.id),
  locked:  e.id === engines.DEFAULT_ID,   // Genesis can't be turned off
})),
default: engines.DEFAULT_ID,
```

- **Toggle** rides the existing **`PUT /api/settings`** write path (admin-authed by
  virtue of the portal). Add `engines` to the accepted Server Config fields and
  validate it: coerce to `{ knownRegisteredId: boolean }`, **drop unknown ids**, and
  **force `genesis: true`** (Genesis is not disableable — a body asking to disable it
  is silently corrected, never an error). Keep the map minimal (store only the ids
  the admin actually set, or the full known set — either is fine; `isEnabled` treats
  absent as off for non-Genesis).
- On a **disable transition** (an id enabled before this write, disabled after), run
  the fan-out in §5.

### 4. Portal UI — Server Config "Engines" section

- A new section in Server Config listing every **registered** engine: name,
  description (the user-facing blurb from `00` §6), a supported-types badge
  (Movies+Shows / Only Movies / Only Shows), and an **enabled toggle**.
- **Genesis's toggle is disabled (locked-on)** with a "Default engine — always on"
  note, matching `locked:true` from the API.
- Saving posts the `engines` map through `PUT /api/settings`. After the save every
  profile's per-type engine dropdown (SC-04) reflects the new availability — a
  disabled engine simply disappears from them (they read `availableFor`).
- **Admin only.** Server Config already sits behind admin auth; the companion has no
  view of this and is never told which engines are disabled.

### 5. Disable → revert affected profiles to Genesis (reuse SC-03)

When the admin disables engine `X`, for **every** profile and each type where
`engine_<type> === X`:

1. Rewrite `engine_<type>` → `'genesis'` (a **persisted** revert, via
   `config.updateProfile`, so dropdowns and the companion DTO show Genesis — this is
   "revert to default" made real, not just a lazy serve-time fallback).
2. `recommendationStore.clearType(profile.id, type)` — drop `X`'s now-stale slice.
   **Do not touch `dont_recommend`** (rejections/decays are engine-independent).
3. `recommendationStore.ensureBuilt(profile)` (fire-and-forget) → Genesis rebuilds
   that slice on the next tick/serve.

This is exactly SC-03's per-profile engine-change path, **fanned out across profiles**
by a single global toggle instead of one profile's save. Do the fan-out in the
**settings save handler** (`portal.js`), which knows the before/after `engines` map —
keep the DB writes out of `settings.js` (same layering rule SC-03 states: config /
settings must not depend on `recommendationStore`).

- **Enabling** an engine needs no rebuild — no profile selects it yet, nothing is
  stale.
- `resolveFor`'s disabled→Genesis fallback (§2) is belt-and-suspenders: even in the
  window before the fan-out finishes, a disabled engine never builds or serves.

### 6. Interaction notes

- **Enablement vs requirements are orthogonal.** Enablement is *global admin
  availability*; `requirements(profile)` is *per-profile readiness* (keys /
  connection). A **disabled** engine is not offered at all; an **enabled-but-unmet**
  engine is offered with a "needs Simkl / needs a key" warning (SC-02/03).
- **Companion is covered for free.** Its settings list already comes from
  `availableFor` server-side (SC-05), so gating `availableFor` on `isEnabled` hides
  disabled engines from the phone without any companion-specific code.
- **Age gate is untouched.** Enablement is a separate axis from I7; both apply
  (`availableFor`/`resolveFor` AND the whole-pool age gate). The NSFW blacklist stays
  absolute regardless.

---

## Tasks

- [ ] `settings.js`: add `engines` (default `{}`) + idempotent migration; accept and
      validate `engines` in the settings write path (coerce to `{knownId:bool}`, drop
      unknowns, force `genesis:true`).
- [ ] `engines/index.js`: `isEnabled(id)` (Genesis always true; non-Genesis default
      off; reads Server Config) + `listEnabled`/`listEnabledFor`; gate `availableFor`
      and `resolveFor` on it (disabled → Genesis).
- [ ] `portal.js`: `GET /api/engines` adds `enabled` + `locked`; the settings save
      handler fans out a disable transition (rewrite `engine_<type>`→genesis +
      `clearType` + `ensureBuilt` across affected profiles).
- [ ] Portal UI: Server Config "Engines" section with per-engine toggles, Genesis
      locked-on.
- [ ] Tests (below).

## Acceptance criteria

- **Genesis-only (today):** `GET /api/engines` shows `genesis` with
  `enabled:true, locked:true`; every dropdown still shows exactly Genesis; toggling
  is a no-op. No behavior change.
- **Registered-but-disabled stub (default):** a `fake`/stub engine registered in
  code but not enabled is **absent** from `GET /api/profiles/:id`'s
  `engines.available.{movie,series}` and from the companion settings list;
  `resolveFor` returns Genesis even if `engine_movie` is hand-set to it; it can
  neither build nor serve.
- **Enable** it via `PUT /api/settings {engines:{fake:true}}`: it now appears in
  `availableFor` (still subject to age/type gates), is selectable, and `resolveFor`
  returns it.
- **Disable** it while a profile has it on Series: that profile's `engine_series`
  reverts to `'genesis'`, the Series slice is cleared and rebuilt by Genesis, Movies
  untouched, `dont_recommend` preserved.
- **Genesis cannot be disabled:** `PUT /api/settings {engines:{genesis:false}}` is
  coerced back to `genesis:true`; Genesis stays available and resolvable everywhere.
- **No secret regressions:** `engines` is plaintext; the settings seal path is
  unchanged.

## Test notes

- Extend the settings roundtrip/migration test: `engines` seeds to `{}`; a write
  forcing `genesis:false` is coerced true and unknown ids are dropped.
- Registry unit test: `isEnabled` (Genesis true regardless of config; a non-Genesis
  stub false until Server Config enables it); `availableFor`/`resolveFor` honour it
  (disabled → Genesis), composed with the existing age gate (I7).
- Reuse the `_register` fake-engine harness (SC-01/03) for the disable→revert+rebuild
  fan-out; assert `clearType` fires for the affected type only and `dont_recommend`
  survives.
- Portal HTTP: `GET /api/engines` `enabled`/`locked` shape; `PUT /api/settings`
  toggle + Genesis-lock coercion + unknown-id drop.
- **Update the SC-01/02 stub tests.** Those cards' tests register an unrestricted
  stub and assert `availableFor` **includes** it for an adult profile. Once this
  card gates `availableFor` on `isEnabled`, a `_register`-ed stub is **disabled by
  default**, so those assertions must first enable it in Server Config
  (`settings.engines[stubId] = true`, or a test helper) — otherwise `availableFor`
  now correctly excludes it. `resolveFor`'s disabled→Genesis and age→Genesis
  fallbacks compose; test both axes together (an enabled-but-unrestricted stub is
  still gated away from an age-limited profile).

## Out of scope

- Any concrete second engine (`06` ships the stub this card's gate switches on).
- Per-profile engine *requirements* UI (SC-02/03/04) — a separate axis from global
  enablement.
- Per-engine global config **beyond** on/off (engine-specific tunables) — a later
  card if a real engine ever needs it.
