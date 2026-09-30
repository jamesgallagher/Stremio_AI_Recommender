# ME-09 — Descriptor, registry, Tier-2 config, CONFORMANCE

**Depends on:** ME-07, ME-08 · **Blocks:** ME-10 · Spec: §9, §10

## Deliverable
1. `src/engines/marquee/config.js`: `ALGORITHM_VERSION='marquee-m1'`, `DEFAULTS` (every number
   named in the spec: weights, trending_gate, seed_cap, lookup_cap, store_cap, franchise_cap,
   min_supply, supply_factor, rating_weights, llm_fit.*, suggest.*, and the Glass-shaped
   taste fields), plus `resolveConfig(settings)` merging `settings.marquee`. Copy the
   Glass `resolveConfig` pattern exactly.
2. `src/engines/marquee.js`: the descriptor (§9) + `generate(profile, type, ctx, onProgress)`
   orchestrating ME-04 → ME-05 → ME-06 → ME-07 → ME-08, with progress bands and `ctx.stats`.
   Test seams: `ctx.marqueeFetchers`, `ctx.marqueeChat`.
3. Register in `src/engines/index.js` next to Glass. It must be **disabled by default** (SC-07,
   `isEnabled` already does this for non-Genesis).
4. Tier-2 admin config in the portal, copying Glass's settings/portal wiring. Saving changes
   calls `clearType(profileId,'movie')` + rebuild for profiles whose `engine_movie === 'marquee'`.
5. Bump `package.json` version.

## CONFORMANCE (every box in `docs/engine-abstraction/CONFORMANCE.md`), proved in integration.js
- The movie slice is produced by Marquee while series stays on Genesis (per-type isolation).
- Returns `[]` with no seeds and no trending.
- `requirements` is false without a Simkl connection, and the slice is not wiped.
- **I1:** an age-limited profile, whose stubbed Marquee output includes a title the stubbed shared
  gate vetoes, never has it served.
- **I7:** `unrestricted:false`, so the engine is offered to kids profiles.
- It's not in `availableFor` until enabled in settings, and `resolveFor` falls back to Genesis while disabled.
- **End-to-end filter guarantee:** a profile with `min_rating 7, max_age_years 10, age_limit 10,
  excluded_genres ['Horror']` has every served movie passing every filter, and the served count
  equals `list_size` given enough fixture supply.

## Acceptance
`npm test` is green, and the CONFORMANCE checklist is copied into the hand-back with every box ticked.
