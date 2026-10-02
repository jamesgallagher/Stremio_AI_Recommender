# Marquee Cinema — scope cards

**Status:** **Built (v7.16.5-beta, algorithm `marquee-m2`), ships globally disabled.** Backtest + m2 tuning: spec §14–§15. A **movie-only**
candidate-producer engine behind the engine abstraction. It fixes four gaps shared by Genesis/Glass: filters are
enforced only at serve, movies reach the age gate without a real classification,
trending lists include titles not yet streamable, and the LLM only re-orders.

Start with **[`00-design-spec.md`](00-design-spec.md)**. It covers the research, the
filter envelope, candidate sources, scoring, LLM use and invariants. Then read
[`01-build-sequence.md`](01-build-sequence.md) for dependencies and waves, then the cards.

| Card | Title | Depends on |
|---|---|---|
| [ME-00](cards/ME-00-live-verify.md) | Live-verify gate (Simkl ratings + `users_recommendations`, TMDB discover certs, trending) | — |
| [ME-01](cards/ME-01-filter-envelope.md) | FilterEnvelope (pure) + serve-parity tests + kids cert mapping | — |
| [ME-02](cards/ME-02-tmdb-additions.md) | TMDB service additions + `release_dates` in deep meta | — |
| [ME-03](cards/ME-03-simkl-additions.md) | Simkl ratings + `users_recommendations` + engine caches | ME-00 |
| [ME-04](cards/ME-04-taste-model.md) | Rating-weighted taste model + LLM taste brief | ME-03 |
| [ME-05](cards/ME-05-candidate-sources.md) | Candidate sources S1–S7 + dedupe + prefilter + truncate | ME-01..04 |
| [ME-06](cards/ME-06-hydrate-filter-score.md) | Metadata lookup + hard filter + deterministic scoring | ME-05 |
| [ME-07](cards/ME-07-llm-fit.md) | LLM pointwise fit scoring + reasons + cache | ME-06 |
| [ME-08](cards/ME-08-output-shaping.md) | Franchise cap, oversupply, shortfall logging | ME-06 |
| [ME-09](cards/ME-09-descriptor-registry.md) | Descriptor + registry (disabled) + Tier-2 config + CONFORMANCE | ME-07, ME-08 |
| [ME-10](cards/ME-10-backtest.md) | Offline backtest harness (Marquee vs Genesis vs Glass) | ME-09 |
| [SH-01](cards/SH-01-cert-to-age-gate.md) | Shared: real movie classifications reach the age gate | — |

**Decisions (confirmed by James, 2026-09-26):**
- **MD-1:** The local LLM is fast (≥30 tok/s). The LLM suggests titles *and* scores every
  shortlisted candidate.
- **MD-2:** Trending is a meaningful boost, about 20% of the score. It's **gated by taste
  match**, so it only lifts films that already fit the viewer.
- **MD-3:** On kids profiles, a movie with **no AU/US classification is excluded** before
  the shared age gate.
- **MD-4:** This is a **new** movie-only engine. It reuses Glass's data layers and leaves
  Glass untouched.

**Key property:** Marquee ships **globally disabled** (SC-07). Until an admin enables it,
nothing changes for users.
