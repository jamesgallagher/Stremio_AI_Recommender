# ME-08 — Output shaping

**Depends on:** ME-06 · **Blocks:** ME-09 · Spec: §8

## Deliverable
`src/engines/marquee/shape.js`: `shapeOutput(scored, { cfg, listSize, envelopeStats, log, profileName })`
1. Franchise cap: at most `cfg.franchise_cap` (2) per `collection.id` (from `score_components.inputs.collection_id`).
2. Truncate to `cfg.store_cap` (300).
3. Oversupply check: `target = max(cfg.min_supply (150), listSize × cfg.supply_factor (6))`.
   On a shortfall, `log.warn('[marquee] <profile>: shortfall N/target — blockers: rating X, recency Y, cert_unknown Z, …')`
   using the top 4 `envelopeStats` counts.
4. Return the final array (still rankScore desc).

`listSize` = `recommendationStore.listSizeFor(profile)`, passed in by `generate`.

## Tests
Franchise cap, store cap, and that the shortfall warning names the dominant blocker.

## Acceptance
Tests pass.
