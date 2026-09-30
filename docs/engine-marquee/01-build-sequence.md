# Marquee Engine — Build Sequence

**Status:** DESIGN ONLY · companion to [`00-design-spec.md`](00-design-spec.md).
**Baseline:** the engine abstraction (SC-01…07) and the Glass data layers (GE-01/02/03/04)
already exist on `v7`. No Marquee card rebuilds any of them.

## Dependency graph

```
 Wave 0 (parallel)   ME-00 live-verify     ME-01 FilterEnvelope    ME-02 TMDB additions    SH-01 (shared, optional)
                          │                       │                       │
 Wave 1              ME-03 Simkl ratings + recs   │                       │
                          │                       │                       │
 Wave 2              ME-04 taste model + brief    │                       │
                          └──────────────┬────────┴───────────────────────┘
 Wave 3                          ME-05 candidate sources
                                         │
 Wave 4                          ME-06 lookup + hard filter + scoring
                                  ┌──────┴──────┐
 Wave 5                     ME-07 LLM fit   ME-08 output shaping
                                  └──────┬──────┘
 Wave 6                          ME-09 descriptor + registry + CONFORMANCE   ◀── MVP (dark until enabled)
                                         │
 Wave 7                          ME-10 backtest harness                      ◀── enable-for-family gate
```

## Waves

| Wave | Cards | Milestone |
|---|---|---|
| 0 | ME-00, ME-01, ME-02, SH-01 | Foundations; shapes verified live |
| 1 | ME-03 | Simkl ratings + collaborative recs cached |
| 2 | ME-04 | Rating-weighted taste + LLM brief |
| 3 | ME-05 | Candidate set produced |
| 4 | ME-06 | Filtered, scored, preResolved candidates |
| 5 | ME-07 ∥ ME-08 | LLM fit + final shaping |
| 6 | ME-09 | **MVP:** registered, conformant, globally disabled |
| 7 | ME-10 | Quality evidence. Enable for the family only if it beats Genesis. |

## Cross-cutting rules for every card
- **Version bumps** follow the repo convention (`vX.Y.Z-beta: ME-nn — …`). The branch is off `v7`.
- **Tests** go in `test/smoke.js` (pure/unit) and `test/integration.js` (pipeline/conformance)
  in the existing style. `npm test` must stay green.
- **Hermetic tests:** every network call has an injectable seam (`ctx.marquee*` or an options
  fetcher), as Glass does with `ctx.glassRecsFetcher` / `ctx.glassChat`.
- **Nothing is user-visible** until ME-09 registers the engine and an admin enables it.
- **Hand-back report per card:** files changed, tests added (names), `npm test` summary line,
  deviations from the card with reasons, and open questions.
